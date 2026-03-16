# 🌿 Loosian Grocers — Shop with M-Pesa Integration

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```
Edit `.env` with your real credentials (see below).

### 3. Run the server
```bash
# Development (auto-restart on changes)
npm run dev

# Production
npm start
```

Open: **http://localhost:3000**

---

## 🔑 Getting M-Pesa Daraja Credentials

### Step 1 — Create a Safaricom Developer Account
1. Go to **https://developer.safaricom.co.ke**
2. Sign up / Log in
3. Click **"My Apps"** → **"Add a new App"**
4. Enable **"Lipa Na M-Pesa Sandbox"**
5. Copy your **Consumer Key** and **Consumer Secret**

### Step 2 — Get your LNM Passkey
- In your app dashboard, go to **"LNM Passkey"**
- Copy the passkey (long string starting with `bfb279f...`)

### Step 3 — Set your Shortcode
- **Sandbox testing**: Use `174379` (Safaricom's test shortcode)
- **Live/Production**: Use your actual Paybill or Till number

---

## 🌍 Exposing Your Callback URL (for local testing)

M-Pesa needs a **public HTTPS URL** to send payment confirmations.
Use **ngrok** for local development:

```bash
# Install ngrok from https://ngrok.com
ngrok http 3000
```

Copy the HTTPS URL it gives you (e.g. `https://abc123.ngrok.io`)
Set in `.env`:
```
CALLBACK_URL=https://abc123.ngrok.io/api/mpesa/callback
```

---

## 📋 Environment Variables

| Variable | Description | Example |
|---|---|---|
| `MPESA_CONSUMER_KEY` | From Daraja portal | `wKXXXXXXXXX` |
| `MPESA_CONSUMER_SECRET` | From Daraja portal | `zYXXXXXXXXX` |
| `MPESA_SHORTCODE` | Your Paybill/Till | `174379` |
| `MPESA_PASSKEY` | LNM Passkey from Daraja | `bfb279f9...` |
| `CALLBACK_URL` | Your public HTTPS URL | `https://yourdomain.com/api/mpesa/callback` |
| `MPESA_ENV` | `sandbox` or `live` | `sandbox` |
| `PORT` | Server port | `3000` |

---

## 🧪 Testing in Sandbox

Use these Safaricom sandbox test numbers:
- **Phone**: `254708374149` (triggers success)
- **PIN**: Any 4 digits
- **Amount**: Any amount

---

## 🚀 Going Live (Production)

1. Change `MPESA_ENV=live` in `.env`
2. Replace sandbox credentials with your **live** Consumer Key/Secret
3. Set your real **Paybill or Till number** as `MPESA_SHORTCODE`
4. Set your production domain as `CALLBACK_URL`
5. Deploy to a server (Railway, Render, DigitalOcean, etc.)

---

## 📡 API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/mpesa/stkpush` | Initiate STK Push |
| `POST` | `/api/mpesa/callback` | Safaricom payment callback |
| `GET` | `/api/mpesa/status/:checkoutRequestId` | Poll payment status |
| `GET` | `/api/orders` | View all orders (admin) |
| `GET` | `/api/health` | Server health check |

---

## 🏗️ Production Recommendations

- Replace the in-memory `orders` Map with **MongoDB** or **PostgreSQL**
- Add authentication to `/api/orders`
- Send order confirmation via **Africa's Talking SMS API**
- Set up **email notifications** with Nodemailer
- Deploy behind **Nginx** with SSL certificate (Let's Encrypt)

---

## 📞 Support
**Loosian Grocers** · 0723 851 228 · Westlands, Nairobi
