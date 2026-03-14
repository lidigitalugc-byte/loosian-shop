require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const app = express();

// ─── MIDDLEWARE ─────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false })); // allow inline scripts in HTML
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

// Rate limit: max 20 payment requests per 15 minutes per IP
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: "Too many requests. Please try again later." },
});

// ─── SERVE FRONTEND ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));

// ─── IN-MEMORY ORDER STORE ───────────────────────────────────────────────────
// For production, replace with a real database (MongoDB, PostgreSQL, etc.)
const orders = new Map();

// ─── M-PESA CONFIG ───────────────────────────────────────────────────────────
const MPESA_CONFIG = {
  consumerKey: process.env.MPESA_CONSUMER_KEY,
  consumerSecret: process.env.MPESA_CONSUMER_SECRET,
  shortcode: process.env.MPESA_SHORTCODE || "174379",
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

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/** Get OAuth access token from Safaricom */
async function getMpesaToken() {
  const credentials = Buffer.from(
    `${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`
  ).toString("base64");

  const response = await axios.get(urls.auth, {
    headers: { Authorization: `Basic ${credentials}` },
  });

  return response.data.access_token;
}

/** Generate Base64 timestamp password */
function generatePassword() {
  const timestamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  const password = Buffer.from(
    `${MPESA_CONFIG.shortcode}${MPESA_CONFIG.passkey}${timestamp}`
  ).toString("base64");
  return { password, timestamp };
}

/** Format phone: 0723851228 → 254723851228 */
function formatPhone(phone) {
  const cleaned = phone.replace(/\s+/g, "").replace(/^0/, "254");
  if (!/^254[0-9]{9}$/.test(cleaned)) {
    throw new Error("Invalid phone number. Use format: 07XXXXXXXX");
  }
  return cleaned;
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

/**
 * POST /api/mpesa/stkpush
 * Initiates M-Pesa STK Push to customer's phone
 */
app.post("/api/mpesa/stkpush", paymentLimiter, async (req, res) => {
  try {
    const { phone, amount, customerName, size, quantity, deliveryType } = req.body;

    // Validate inputs
    if (!phone || !amount || !customerName) {
      return res.status(400).json({
        success: false,
        message: "Phone, amount and customer name are required",
      });
    }

    if (amount < 1 || amount > 150000) {
      return res.status(400).json({
        success: false,
        message: "Amount must be between KSh 1 and KSh 150,000",
      });
    }

    const formattedPhone = formatPhone(phone);
    const orderId = uuidv4();
    const token = await getMpesaToken();
    const { password, timestamp } = generatePassword();

    const stkPayload = {
      BusinessShortCode: MPESA_CONFIG.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      // For Till (Buy Goods), use: "CustomerBuyGoodsOnline"
      Amount: Math.round(amount),
      PartyA: formattedPhone,
      PartyB: MPESA_CONFIG.shortcode,
      PhoneNumber: formattedPhone,
      CallBackURL: MPESA_CONFIG.callbackUrl,
      AccountReference: `LG-${orderId.slice(0, 8).toUpperCase()}`,
      TransactionDesc: `Loosian Grocers - ${size} Passion Fruit Pulp x${quantity}`,
    };

    const response = await axios.post(urls.stkpush, stkPayload, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    const { CheckoutRequestID, MerchantRequestID, ResponseCode, ResponseDescription } =
      response.data;

    if (ResponseCode !== "0") {
      return res.status(400).json({
        success: false,
        message: ResponseDescription || "Failed to initiate payment",
      });
    }

    // Store order for callback matching
    orders.set(CheckoutRequestID, {
      orderId,
      checkoutRequestId: CheckoutRequestID,
      merchantRequestId: MerchantRequestID,
      phone: formattedPhone,
      amount,
      customerName,
      size,
      quantity,
      deliveryType,
      status: "PENDING",
      createdAt: new Date().toISOString(),
    });

    console.log(`✅ STK Push sent | Order: ${orderId} | Phone: ${formattedPhone} | KSh ${amount}`);

    res.json({
      success: true,
      message: "STK Push sent. Please check your phone.",
      checkoutRequestId: CheckoutRequestID,
      orderId,
    });
  } catch (error) {
    console.error("STK Push error:", error?.response?.data || error.message);

    if (error.message.includes("Invalid phone")) {
      return res.status(400).json({ success: false, message: error.message });
    }

    res.status(500).json({
      success: false,
      message: "Payment initiation failed. Please try again.",
      detail: error?.response?.data?.errorMessage || error.message,
    });
  }
});

/**
 * POST /api/mpesa/callback
 * Safaricom sends payment confirmation here
 */
app.post("/api/mpesa/callback", (req, res) => {
  try {
    const { Body } = req.body;
    const { stkCallback } = Body;
    const { MerchantRequestID, CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } =
      stkCallback;

    console.log(`📩 Callback received | CheckoutID: ${CheckoutRequestID} | Result: ${ResultCode}`);

    const order = orders.get(CheckoutRequestID);

    if (!order) {
      console.warn(`⚠️  Order not found for CheckoutRequestID: ${CheckoutRequestID}`);
      return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    if (ResultCode === 0) {
      // Payment successful — extract M-Pesa details
      const meta = {};
      if (CallbackMetadata?.Item) {
        CallbackMetadata.Item.forEach((item) => {
          meta[item.Name] = item.Value;
        });
      }

      order.status = "PAID";
      order.mpesaReceiptNumber = meta.MpesaReceiptNumber;
      order.transactionDate = meta.TransactionDate;
      order.paidAmount = meta.Amount;
      order.paidAt = new Date().toISOString();

      console.log(
        `🎉 PAYMENT SUCCESS | Order: ${order.orderId} | Receipt: ${meta.MpesaReceiptNumber} | KSh ${meta.Amount}`
      );

      // TODO: Send confirmation SMS, update database, notify warehouse, etc.
    } else {
      order.status = "FAILED";
      order.failureReason = ResultDesc;
      console.log(`❌ Payment failed | Order: ${order.orderId} | Reason: ${ResultDesc}`);
    }

    orders.set(CheckoutRequestID, order);

    // Always respond 200 to Safaricom
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (error) {
    console.error("Callback error:", error.message);
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
});

/**
 * GET /api/mpesa/status/:checkoutRequestId
 * Frontend polls this to check if payment was confirmed
 */
app.get("/api/mpesa/status/:checkoutRequestId", async (req, res) => {
  const { checkoutRequestId } = req.params;

  const order = orders.get(checkoutRequestId);

  if (!order) {
    return res.status(404).json({ success: false, message: "Order not found" });
  }

  // If still pending after 30s, query Safaricom directly
  if (order.status === "PENDING") {
    try {
      const token = await getMpesaToken();
      const { password, timestamp } = generatePassword();

      const queryRes = await axios.post(
        urls.query,
        {
          BusinessShortCode: MPESA_CONFIG.shortcode,
          Password: password,
          Timestamp: timestamp,
          CheckoutRequestID: checkoutRequestId,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );

      const { ResultCode, ResultDesc } = queryRes.data;

      if (ResultCode === "0") {
        order.status = "PAID";
        orders.set(checkoutRequestId, order);
      } else if (ResultCode !== "1032") {
        // 1032 = still waiting for user input
        order.status = "FAILED";
        order.failureReason = ResultDesc;
        orders.set(checkoutRequestId, order);
      }
    } catch (queryError) {
      // Query failed — keep as pending, let polling continue
      console.warn("STK query error:", queryError?.response?.data || queryError.message);
    }
  }

  res.json({
    success: true,
    status: order.status,
    orderId: order.orderId,
    mpesaReceiptNumber: order.mpesaReceiptNumber || null,
    amount: order.paidAmount || order.amount,
    customerName: order.customerName,
  });
});

/**
 * GET /api/orders
 * View all orders (admin — secure this in production!)
 */
app.get("/api/orders", (req, res) => {
  const allOrders = Array.from(orders.values()).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  res.json({ success: true, total: allOrders.length, orders: allOrders });
});

/**
 * GET /api/health
 * Health check
 */
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    business: process.env.BUSINESS_NAME || "Loosian Grocers",
    env: MPESA_CONFIG.env,
    timestamp: new Date().toISOString(),
  });
});

// ─── START ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   🌿 LOOSIAN GROCERS SHOP SERVER         ║
║      Running on http://localhost:${PORT}    ║
║      M-Pesa ENV: ${(MPESA_CONFIG.env + "          ").slice(0,10)}         ║
╚══════════════════════════════════════════╝
  `);
});

module.exports = app;
