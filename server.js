/*
 * EZKOAL TRADE SL — Server with Revolut Payment Integration
 * 
 * Endpoints:
 *   GET  /api/config          — Returns public config for frontend (public key, mode)
 *   POST /api/create-order    — Creates a Revolut order, returns token for embedded checkout
 *   POST /api/webhook         — Receives Revolut webhook notifications
 *   GET  /api/order/:id       — Check order status (polling fallback)
 *   GET  /success             — Thank you page
 *   GET  /failed              — Order failed page
 *   GET  /*                   — Static files (the storefront)
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ── Load .env manually (no dotenv dependency) ──
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...vals] = trimmed.split('=');
      process.env[key.trim()] = vals.join('=').trim();
    }
  });
}

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const REVOLUT_SECRET_KEY = process.env.REVOLUT_SECRET_KEY;
const REVOLUT_PUBLIC_KEY = process.env.REVOLUT_PUBLIC_KEY;
const REVOLUT_API_URL = process.env.REVOLUT_API_URL || 'https://merchant.revolut.com/api';
const REVOLUT_API_VERSION = process.env.REVOLUT_API_VERSION || '2024-09-01';

// ── In-memory order store (use a DB in production) ──
const orders = new Map();

// ── Webhook signing secret (set after webhook creation) ──
let webhookSigningSecret = null;

// ── Middleware ──
// Raw body for webhook signature verification
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── GET /api/config — Public configuration for frontend ──
app.get('/api/config', (req, res) => {
  res.json({
    publicKey: REVOLUT_PUBLIC_KEY,
    mode: REVOLUT_API_URL.includes('sandbox') ? 'sandbox' : 'prod',
  });
});

// ── Helper: call Revolut API ──
async function revolutAPI(method, endpoint, body = null) {
  const url = `${REVOLUT_API_URL}${endpoint}`;
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${REVOLUT_SECRET_KEY}`,
      'Revolut-Api-Version': REVOLUT_API_VERSION,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);

  console.log(`[Revolut] ${method} ${url}`);
  const res = await fetch(url, options);
  const text = await res.text();
  
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  
  if (!res.ok) {
    console.error(`[Revolut] Error ${res.status}:`, data);
    throw { status: res.status, data };
  }
  
  console.log(`[Revolut] OK:`, typeof data === 'object' ? JSON.stringify(data).slice(0, 200) : data);
  return data;
}

// ── POST /api/create-order ──
// Frontend sends cart items; server creates Revolut order and returns token for embedded checkout
app.post('/api/create-order', async (req, res) => {
  try {
    const { items, customer, locale } = req.body;

    if (!items || !items.length) {
      return res.status(400).json({ error: 'No items in cart' });
    }

    // Calculate total in minor units (cents)
    let subtotal = 0;
    const lineItems = items.map(item => {
      const lineTotal = Math.round(item.price * item.quantity * 100);
      subtotal += lineTotal;
      return {
        name: item.name,
        type: 'physical',
        quantity: { value: item.quantity },
        unit_price_amount: Math.round(item.price * 100),
        total_amount: lineTotal,
      };
    });

    // VAT 21%
    const vatAmount = Math.round(subtotal * 0.21);
    const totalAmount = subtotal + vatAmount;

    // Generate a reference
    const orderRef = `EZKOAL-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

    // Build order payload
    const orderPayload = {
      type: 'payment',
      amount: totalAmount,
      currency: 'EUR',
      description: `EZKOAL Order ${orderRef}`,
      merchant_order_ext_ref: orderRef,
      customer_email: customer?.email || undefined,
      line_items: lineItems,
    };

    // No redirect_url needed — embedded checkout uses SDK onSuccess callback

    // Add shipping address if provided
    if (customer?.address && customer?.countryCode) {
      orderPayload.shipping_address = {
        street_line_1: customer.address,
        city: customer.city || '',
        postcode: customer.postcode || '',
        country_code: customer.countryCode,
      };
    }

    // Create Revolut order
    const revolutOrder = await revolutAPI('POST', '/orders', orderPayload);

    // Store order locally
    orders.set(orderRef, {
      ref: orderRef,
      revolutOrderId: revolutOrder.id,
      status: revolutOrder.state || 'pending',
      items,
      subtotal,
      vatAmount,
      totalAmount,
      customer,
      createdAt: new Date().toISOString(),
    });

    console.log(`[Order] Created ${orderRef} -> Revolut ${revolutOrder.id}`);

    // Return token for embedded checkout + fallback checkout URL
    res.json({
      success: true,
      orderRef,
      token: revolutOrder.public_id || revolutOrder.token,
      checkoutUrl: revolutOrder.checkout_url,
      orderId: revolutOrder.id,
    });

  } catch (err) {
    console.error('[Order] Creation failed:', err.message || err);
    if (err.response) {
      try { const body = await err.response.text(); console.error('[Order] Revolut response:', body); } catch(e) {}
    }
    const details = err.data ? JSON.stringify(err.data) : err.message;
    res.status(err.status || 500).json({
      error: 'Failed to create order',
      details: details,
    });
  }
});

// ── GET /api/order/:ref — Check order status (polling fallback) ──
app.get('/api/order/:ref', async (req, res) => {
  const order = orders.get(req.params.ref);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  // Fetch latest status from Revolut
  try {
    const revolutOrder = await revolutAPI('GET', `/orders/${order.revolutOrderId}`);
    order.status = revolutOrder.state;
    orders.set(req.params.ref, order);
    
    res.json({
      ref: order.ref,
      status: order.status,
      totalAmount: order.totalAmount,
      items: order.items,
    });
  } catch (err) {
    // Return cached status if Revolut API fails
    res.json({
      ref: order.ref,
      status: order.status,
      totalAmount: order.totalAmount,
    });
  }
});

// ── POST /api/webhook — Revolut webhook receiver ──
app.post('/api/webhook', (req, res) => {
  const rawBody = req.body.toString('utf8');
  console.log('[Webhook] Received:', rawBody);

  // Verify signature if we have the signing secret
  if (webhookSigningSecret) {
    const signature = req.headers['revolut-signature'];
    const timestamp = req.headers['revolut-request-timestamp'];
    if (signature && timestamp) {
      const payload = `v1.${timestamp}.${rawBody}`;
      const expected = 'v1=' + crypto.createHmac('sha256', webhookSigningSecret)
        .update(payload).digest('hex');
      
      const signatures = signature.split(',');
      const valid = signatures.some(sig => sig.trim() === expected);
      if (!valid) {
        console.warn('[Webhook] Invalid signature');
        // Still process but log warning
      }
    }
  }

  try {
    const event = JSON.parse(rawBody);
    console.log(`[Webhook] Event: ${event.event}, Order: ${event.order_id}`);

    // Find our order by Revolut order ID
    for (const [ref, order] of orders) {
      if (order.revolutOrderId === event.order_id) {
        const oldStatus = order.status;
        
        switch (event.event) {
          case 'ORDER_COMPLETED':
            order.status = 'completed';
            console.log(`[Webhook] ✓ Order ${ref} COMPLETED`);
            break;
          case 'ORDER_AUTHORISED':
            order.status = 'authorised';
            console.log(`[Webhook] Order ${ref} AUTHORISED`);
            break;
          case 'ORDER_FAILED':
            order.status = 'failed';
            console.log(`[Webhook] ✗ Order ${ref} FAILED`);
            break;
          case 'ORDER_CANCELLED':
            order.status = 'cancelled';
            console.log(`[Webhook] Order ${ref} CANCELLED`);
            break;
          default:
            console.log(`[Webhook] Order ${ref}: ${event.event}`);
        }

        if (oldStatus !== order.status) {
          orders.set(ref, order);
        }
        break;
      }
    }
  } catch (err) {
    console.error('[Webhook] Parse error:', err.message);
  }

  // Always respond 200 to acknowledge receipt
  res.status(200).json({ received: true });
});

// ── Success page ──
app.get('/success', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'success.html'));
});

// ── Failed page ──
app.get('/failed', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'failed.html'));
});

// ── Catch-all: serve the storefront ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start server ──
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   EZKOAL TRADE SL — Server Running      ║
║──────────────────────────────────────────║
║   URL:      ${BASE_URL.padEnd(28)}║
║   Webhook:  ${(BASE_URL + '/api/webhook').padEnd(28)}║
║   Revolut:  Production                  ║
╚══════════════════════════════════════════╝
  `);
  
  if (!REVOLUT_SECRET_KEY) {
    console.error('⚠ WARNING: REVOLUT_SECRET_KEY not set!');
  }

  // Auto-setup webhook (run once)
  setupWebhook().catch(err => {
    console.log('[Webhook] Auto-setup skipped:', err.data?.message || err.message || 'Set BASE_URL to a public HTTPS URL');
  });
});

// ── Auto-register webhook with Revolut ──
async function setupWebhook() {
  // Only setup if BASE_URL is a real public URL (not localhost)
  if (BASE_URL.includes('localhost') || BASE_URL.includes('127.0.0.1')) {
    console.log('[Webhook] Skipping auto-setup (localhost). Set BASE_URL to your public domain.');
    console.log('[Webhook] Then register manually or restart the server.');
    return;
  }

  const webhookUrl = `${BASE_URL}/api/webhook`;
  
  // Check existing webhooks
  try {
    const existing = await revolutAPI('GET', '/webhooks');
    if (Array.isArray(existing)) {
      const found = existing.find(w => w.url === webhookUrl);
      if (found) {
        console.log(`[Webhook] Already registered: ${found.id}`);
        // Get signing secret
        const details = await revolutAPI('GET', `/webhooks/${found.id}`);
        webhookSigningSecret = details.signing_secret;
        return;
      }
    }
  } catch (e) {
    // Ignore - will try to create
  }

  // Create webhook
  const webhook = await revolutAPI('POST', '/webhooks', {
    url: webhookUrl,
    events: [
      'ORDER_COMPLETED',
      'ORDER_AUTHORISED', 
      'ORDER_FAILED',
      'ORDER_CANCELLED',
    ],
  });

  webhookSigningSecret = webhook.signing_secret;
  console.log(`[Webhook] Registered: ${webhook.id}`);
  console.log(`[Webhook] Signing secret: ${webhookSigningSecret}`);
}
