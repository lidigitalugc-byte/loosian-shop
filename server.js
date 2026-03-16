require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const { v4: uuidv4 } = require("uuid");
const { Pool } = require("pg");
const path = require("path");

const app = express();

// ─── STARTUP CHECKS ──────────────────────────────────────────────────────────
const REQUIRED_ENV = [
  "MPESA_CONSUMER_KEY",
  "MPESA_CONSUMER_SECRET",
  "MPESA_SHORTCODE",
  "MPESA_PASSKEY",
  "CALLBACK_URL",
  "DATABASE_URL",
  "ADMIN_SECRET",
];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error("❌ Missing env vars:", missing.join(", "));
  process.exit(1);
}

const callbackUrl = process.env.CALLBACK_URL;
if (!callbackUrl.startsWith("https://")) {
  console.error("❌ CALLBACK_URL must start with https://"); process.exit(1);
}
if (!callbackUrl.includes("/api/mpesa/callback")) {
  console.error("❌ CALLBACK_URL must end with /api/mpesa/callback"); process.exit(1);
}
console.log("✅ CALLBACK_URL:", callbackUrl);

// ─── DATABASE ─────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id                   SERIAL PRIMARY KEY,
      order_id             UUID NOT NULL UNIQUE,
      checkout_request_id  TEXT UNIQUE,
      merchant_request_id  TEXT,
      phone                TEXT NOT NULL,
      amount               INTEGER NOT NULL,
      customer_name        TEXT NOT NULL,
      size                 TEXT,
      quantity             INTEGER,
      delivery_type        TEXT,
      status               TEXT NOT NULL DEFAULT 'PENDING',
      mpesa_receipt        TEXT,
      transaction_date     TEXT,
      paid_amount          INTEGER,
      failure_reason       TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at              TIMESTAMPTZ
    )
  `);
  console.log("✅ Database ready");
}

async function createOrder(d) {
  const { rows } = await pool.query(
    `INSERT INTO orders (order_id,checkout_request_id,merchant_request_id,phone,amount,customer_name,size,quantity,delivery_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [d.orderId,d.checkoutRequestId,d.merchantRequestId,d.phone,d.amount,d.customerName,d.size,d.quantity,d.deliveryType]
  );
  return rows[0];
}

async function getOrderByCheckout(id) {
  const { rows } = await pool.query("SELECT * FROM orders WHERE checkout_request_id=$1",[id]);
  return rows[0] || null;
}

async function markOrderPaid(id, receipt, txDate, paidAmount) {
  await pool.query(
    "UPDATE orders SET status='PAID',mpesa_receipt=$2,transaction_date=$3,paid_amount=$4,paid_at=NOW() WHERE checkout_request_id=$1",
    [id, receipt, txDate, paidAmount]
  );
}

async function markOrderFailed(id, reason) {
  await pool.query("UPDATE orders SET status='FAILED',failure_reason=$2 WHERE checkout_request_id=$1",[id,reason]);
}

async function updateOrderStatus(id, status) {
  await pool.query("UPDATE orders SET status=$2 WHERE checkout_request_id=$1",[id,status]);
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  message: { success: false, message: "Too many requests. Please try again later." },
});

// ✅ FIX 3 — Admin auth middleware
function requireAdminAuth(req, res, next) {
  const token = (req.headers["authorization"] || "").split(" ")[1];
  if (!token || token !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ success: false, message: "Unauthorized. Pass header: Authorization: Bearer <ADMIN_SECRET>" });
  }
  next();
}

app.use(express.static(path.join(__dirname)));

// ─── M-PESA CONFIG ────────────────────────────────────────────────────────────
const MPESA_CONFIG = {
  consumerKey: process.env.MPESA_CONSUMER_KEY,
  consumerSecret: process.env.MPESA_CONSUMER_SECRET,
  shortcode: process.env.MPESA_SHORTCODE,
  passkey: process.env.MPESA_PASSKEY,
  callbackUrl: process.env.CALLBACK_URL,
  env: process.env.MPESA_ENV || "sandbox",
};

const MPESA_URLS = {
  sandbox: {
    auth: "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
    stkpush: "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
    query: "https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query",
  },
  live: {
    auth: "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
    stkpush: "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
    query: "https://api.safaricom.co.ke/mpesa/stkpushquery/v1/query",
  },
};
const urls = MPESA_URLS[MPESA_CONFIG.env];

async function getMpesaToken() {
  const creds = Buffer.from(`${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`).toString("base64");
  const r = await axios.get(urls.auth, { headers: { Authorization: `Basic ${creds}` } });
  return r.data.access_token;
}

function generatePassword() {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g,"").slice(0,14);
  const password = Buffer.from(`${MPESA_CONFIG.shortcode}${MPESA_CONFIG.passkey}${timestamp}`).toString("base64");
  return { password, timestamp };
}

function formatPhone(phone) {
  const cleaned = phone.replace(/\s+/g,"").replace(/^0/,"254");
  if (!/^254[0-9]{9}$/.test(cleaned)) throw new Error("Invalid phone number. Use format: 07XXXXXXXX");
  return cleaned;
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.post("/api/mpesa/stkpush", paymentLimiter, async (req, res) => {
  try {
    const { phone, amount, customerName, size, quantity, deliveryType } = req.body;
    if (!phone || !amount || !customerName)
      return res.status(400).json({ success: false, message: "Phone, amount and name are required" });
    if (amount < 1 || amount > 150000)
      return res.status(400).json({ success: false, message: "Amount must be between KSh 1 and KSh 150,000" });

    const formattedPhone = formatPhone(phone);
    const orderId = uuidv4();
    const token = await getMpesaToken();
    const { password, timestamp } = generatePassword();

    const response = await axios.post(urls.stkpush, {
      BusinessShortCode: MPESA_CONFIG.shortcode,
      Password: password, Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: Math.round(amount),
      PartyA: formattedPhone, PartyB: MPESA_CONFIG.shortcode,
      PhoneNumber: formattedPhone,
      CallBackURL: MPESA_CONFIG.callbackUrl,
      AccountReference: `LG-${orderId.slice(0,8).toUpperCase()}`,
      TransactionDesc: `Loosian Grocers - ${size} x${quantity}`,
    }, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });

    const { CheckoutRequestID, MerchantRequestID, ResponseCode, ResponseDescription } = response.data;
    if (ResponseCode !== "0")
      return res.status(400).json({ success: false, message: ResponseDescription || "Failed to initiate payment" });

    // ✅ FIX 1 — Save to PostgreSQL, not in-memory
    await createOrder({
      orderId, checkoutRequestId: CheckoutRequestID, merchantRequestId: MerchantRequestID,
      phone: formattedPhone, amount, customerName, size, quantity, deliveryType,
    });

    console.log(`✅ STK Push sent | ${orderId} | ${formattedPhone} | KSh ${amount}`);
    res.json({ success: true, message: "STK Push sent. Please check your phone.", checkoutRequestId: CheckoutRequestID, orderId });
  } catch (err) {
    console.error("STK Push error:", err?.response?.data || err.message);
    if (err.message.includes("Invalid phone"))
      return res.status(400).json({ success: false, message: err.message });
    res.status(500).json({ success: false, message: "Payment initiation failed. Please try again.", detail: err?.response?.data?.errorMessage || err.message });
  }
});

app.post("/api/mpesa/callback", async (req, res) => {
  try {
    const { stkCallback } = req.body.Body;
    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = stkCallback;
    console.log(`📩 Callback | ${CheckoutRequestID} | Result: ${ResultCode}`);

    if (ResultCode === 0) {
      const meta = {};
      CallbackMetadata?.Item?.forEach(i => { meta[i.Name] = i.Value; });
      await markOrderPaid(CheckoutRequestID, meta.MpesaReceiptNumber, String(meta.TransactionDate), meta.Amount);
      console.log(`🎉 PAID | Receipt: ${meta.MpesaReceiptNumber} | KSh ${meta.Amount}`);
    } else {
      await markOrderFailed(CheckoutRequestID, ResultDesc);
      console.log(`❌ Failed | ${ResultDesc}`);
    }
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (err) {
    console.error("Callback error:", err.message);
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
});

app.get("/api/mpesa/status/:checkoutRequestId", async (req, res) => {
  const { checkoutRequestId } = req.params;
  const order = await getOrderByCheckout(checkoutRequestId);
  if (!order) return res.status(404).json({ success: false, message: "Order not found" });

  if (order.status === "PENDING") {
    try {
      const token = await getMpesaToken();
      const { password, timestamp } = generatePassword();
      const qr = await axios.post(urls.query,
        { BusinessShortCode: MPESA_CONFIG.shortcode, Password: password, Timestamp: timestamp, CheckoutRequestID: checkoutRequestId },
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
      );
      const { ResultCode, ResultDesc } = qr.data;
      if (ResultCode === "0") { await updateOrderStatus(checkoutRequestId,"PAID"); order.status="PAID"; }
      else if (ResultCode !== "1032") { await markOrderFailed(checkoutRequestId, ResultDesc); order.status="FAILED"; }
    } catch (e) {
      console.warn("Query error:", e?.response?.data || e.message);
    }
  }

  res.json({
    success: true, status: order.status,
    orderId: order.order_id,
    mpesaReceiptNumber: order.mpesa_receipt || null,
    amount: order.paid_amount || order.amount,
    customerName: order.customer_name,
  });
});

// ✅ FIX 3 — /api/orders is now protected with requireAdminAuth
app.get("/api/orders", requireAdminAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM orders ORDER BY created_at DESC");
  res.json({ success: true, total: rows.length, orders: rows });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    business: process.env.BUSINESS_NAME || "Loosian Grocers",
    env: MPESA_CONFIG.env,
    callbackUrl: MPESA_CONFIG.callbackUrl,  // ✅ FIX 2 — visible in health check
    timestamp: new Date().toISOString(),
  });
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════╗
║   🌿 LOOSIAN GROCERS SHOP SERVER         ║
║   http://localhost:${PORT}                  ║
║   M-Pesa : ${(MPESA_CONFIG.env+"        ").slice(0,8)}  Database: PostgreSQL ✅  ║
║   Admin  : Bearer token secured ✅        ║
╚══════════════════════════════════════════╝
    `);
  });
}).catch(err => {
  console.error("❌ DB connection failed:", err.message);
  process.exit(1);
});

module.exports = app;
