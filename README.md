# EZKOAL TRADE SL — E-commerce with Revolut Payments

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Edit .env with your keys and domain
nano .env

# 3. Start the server
npm start
```

Server runs at `http://localhost:3000`

## .env Configuration

```env
REVOLUT_SECRET_KEY=sk_your_secret_key
REVOLUT_PUBLIC_KEY=pk_your_public_key
PORT=3000
BASE_URL=https://yourdomain.com    # Must be HTTPS for webhooks
REVOLUT_API_URL=https://merchant.revolut.com/api
REVOLUT_API_VERSION=2024-09-01
```

## How It Works

### Payment Flow
1. Customer adds items to cart and clicks "Place Order"
2. Server creates a Revolut order via Merchant API (`POST /api/create-order`)
3. Customer is redirected to Revolut's hosted checkout page
4. After payment, customer returns to `/success?ref=ORDER_REF`
5. Success page polls `/api/order/:ref` to verify payment status
6. Revolut sends webhook to `/api/webhook` confirming payment

### API Endpoints
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/create-order` | Creates Revolut order, returns checkout URL |
| GET | `/api/order/:ref` | Check order status |
| POST | `/api/webhook` | Revolut webhook receiver |
| GET | `/success` | Thank you page |
| GET | `/failed` | Payment failed page |

## Deploy to Production

### Requirements
- Node.js 18+
- HTTPS domain (required for Revolut webhooks)
- Revolut Business account with Merchant API enabled

### Deploy Steps
1. Upload files to your server
2. Set `BASE_URL` in `.env` to your HTTPS domain
3. Run `npm install && npm start`
4. Webhook auto-registers on first start (requires public HTTPS URL)

### Reverse Proxy (nginx example)
```nginx
server {
    listen 443 ssl;
    server_name shop.ezkoal.com;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Project Structure
```
ezkoal/
├── server.js          # Express server + Revolut API integration
├── package.json
├── .env               # API keys (DO NOT commit)
├── .gitignore
├── README.md
└── public/
    ├── index.html     # Storefront (trilingual, cart, checkout)
    ├── success.html   # Thank you page with order verification
    └── failed.html    # Payment failed page
```

## Security Notes
- Secret key is server-side only (never exposed to browser)
- Webhook signatures are verified using HMAC SHA-256
- Move to environment variables or secrets manager in production
- Add `.env` to `.gitignore`
- Use a proper database instead of in-memory store for production
