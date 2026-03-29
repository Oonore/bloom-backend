const express  = require("express");
const cors     = require("cors");
const crypto   = require("crypto");
const fetch    = require("node-fetch");

const app = express();

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// All secrets come from Render environment variables — never hardcoded
const CF_APP_ID    = process.env.CF_APP_ID;
const CF_SECRET    = process.env.CF_SECRET;
const BACKEND_URL  = process.env.BACKEND_URL  || "https://bloom-backend-v55a.onrender.com";
const CF_BASE      = process.env.CF_ENV === "prod"
  ? "https://api.cashfree.com/pg"
  : "https://sandbox.cashfree.com/pg";
const FRONTEND_URL = process.env.FRONTEND_URL || "https://bloom-store-ochre.vercel.app";
const PORT         = process.env.PORT         || 3001;

const CF_HEADERS = {
  "Content-Type":    "application/json",
  "x-client-id":     CF_APP_ID,
  "x-client-secret": CF_SECRET,
  "x-api-version":   "2023-08-01",
};

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({ origin: "*" }));

// Raw body needed for webhook signature verification
app.use((req, res, next) => {
  if (req.path === "/api/webhook") {
    let raw = "";
    req.on("data", chunk => raw += chunk);
    req.on("end", () => { req.rawBody = raw; next(); });
  } else {
    express.json()(req, res, next);
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "Bloom Backend running 🌸" }));

// ─── CREATE ORDER ─────────────────────────────────────────────────────────────
// Called by frontend when customer clicks Pay
// Creates a Cashfree order and returns payment_session_id
app.post("/api/create-order", async (req, res) => {
  try {
    const {
      amount,       // number in INR e.g. 799
      orderId,      // unique order ID from frontend e.g. BL-XXXXX
      customerName,
      customerEmail,
      customerPhone,
      storeName,
      storeSlug,
    } = req.body;

    if (!amount || !orderId || !customerEmail) {
      return res.status(400).json({ error: "amount, orderId and customerEmail are required" });
    }

    const payload = {
      order_id:     orderId,
      order_amount: Number(amount),
      order_currency: "INR",
      order_note:   `Bloom Store — ${storeName || "Purchase"}`,
      customer_details: {
        customer_id:    `cust_${Date.now()}`,
        customer_name:  customerName  || "Customer",
        customer_email: customerEmail,
        customer_phone: customerPhone || "9999999999",
      },
      order_meta: {
        return_url: `${FRONTEND_URL}/payment-status?order_id={order_id}&store=${storeSlug||""}`,
        notify_url: `${process.env.BACKEND_URL || "https://your-railway-app.up.railway.app"}/api/webhook`,
      },
    };

    const cfRes = await fetch(`${CF_BASE}/orders`, {
      method:  "POST",
      headers: CF_HEADERS,
      body:    JSON.stringify(payload),
    });

    const data = await cfRes.json();

    if (!cfRes.ok) {
      console.error("Cashfree create order error:", data);
      return res.status(500).json({ error: data.message || "Failed to create order" });
    }

    return res.json({
      orderId:          data.order_id,
      paymentSessionId: data.payment_session_id,
      orderStatus:      data.order_status,
    });
  } catch (err) {
    console.error("Create order error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET PAYMENT STATUS ───────────────────────────────────────────────────────
// Frontend polls this after redirect to confirm payment
app.get("/api/payment-status/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    const cfRes = await fetch(`${CF_BASE}/orders/${orderId}`, {
      method:  "GET",
      headers: CF_HEADERS,
    });
    const data = await cfRes.json();
    if (!cfRes.ok) return res.status(500).json({ error: data.message });

    // order_status: PAID | ACTIVE | EXPIRED
    return res.json({
      orderId:     data.order_id,
      status:      data.order_status,       // "PAID" means success
      amount:      data.order_amount,
      currency:    data.order_currency,
      paidAt:      data.order_tags?.paid_at || null,
    });
  } catch (err) {
    console.error("Status check error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────
// Cashfree calls this automatically after every payment
// Verifies signature and confirms the order in Supabase
app.post("/api/webhook", async (req, res) => {
  try {
    const signature  = req.headers["x-webhook-signature"];
    const timestamp  = req.headers["x-webhook-timestamp"];
    const rawBody    = req.rawBody || "";

    // ── Verify signature ──────────────────────────────────────────────────────
    const signedPayload = timestamp + rawBody;
    const expected = crypto
      .createHmac("sha256", CF_SECRET)
      .update(signedPayload)
      .digest("base64");

    if (signature !== expected) {
      console.warn("Invalid webhook signature");
      return res.status(401).json({ error: "Invalid signature" });
    }

    const event = JSON.parse(rawBody);
    const { type, data } = event;

    console.log("Webhook event:", type, data?.order?.order_id);

    // ── Handle payment success ─────────────────────────────────────────────────
    if (type === "PAYMENT_SUCCESS_WEBHOOK") {
      const orderId = data?.order?.order_id;
      const amount  = data?.order?.order_amount;
      const paymentId = data?.payment?.cf_payment_id;

      if (orderId) {
        // Update order status in Supabase
        await updateOrderInSupabase(orderId, {
          status:     "confirmed",
          payment_id: String(paymentId || ""),
          amount:     amount,
        });
        console.log(`✅ Order ${orderId} confirmed — ₹${amount}`);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

// ─── SUPABASE UPDATE ──────────────────────────────────────────────────────────
async function updateOrderInSupabase(bloomOrderId, updates) {
  const SUPA_URL = process.env.SUPA_URL;
  const SUPA_KEY = process.env.SUPA_KEY;
  if (!SUPA_URL || !SUPA_KEY) { console.error("Supabase env vars missing"); return; }
  try {
    const res = await fetch(
      `${SUPA_URL}/rest/v1/bloom_orders?id=eq.${encodeURIComponent(bloomOrderId)}`,
      {
        method:  "PATCH",
        headers: {
          "apikey":        SUPA_KEY,
          "Authorization": `Bearer ${SUPA_KEY}`,
          "Content-Type":  "application/json",
          "Prefer":        "return=representation",
        },
        body: JSON.stringify(updates),
      }
    );
    if (!res.ok) console.error("Supabase update failed:", await res.text());
  } catch (e) {
    console.error("Supabase update error:", e);
  }
}

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🌸 Bloom Backend running on port ${PORT}`);
  console.log(`   Cashfree: ${CF_BASE}`);
  console.log(`   Frontend: ${FRONTEND_URL}`);
});
