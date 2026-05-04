const express    = require("express");
const cors       = require("cors");
const crypto     = require("crypto");
const fetch      = require("node-fetch");
// nodemailer removed — Render blocks outbound SMTP ports

const app = express();

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// All secrets come from Render environment variables — never hardcoded
const CF_APP_ID    = process.env.CF_APP_ID;
const CF_SECRET    = process.env.CF_SECRET;
const BACKEND_URL  = process.env.BACKEND_URL  || "https://bloom-backend-v55a.onrender.com";
const CF_BASE      = process.env.CF_ENV === "prod"
  ? "https://api.cashfree.com/pg"
  : "https://sandbox.cashfree.com/pg";
const FRONTEND_URL = process.env.FRONTEND_URL || "https://bloomhq.in";
const PORT         = process.env.PORT         || 3001;

// ─── RAZORPAY CONFIG ──────────────────────────────────────────────────────────
const RZP_KEY_ID     = process.env.RAZORPAY_KEY_ID     || process.env.RZP_KEY_ID;
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || process.env.RZP_KEY_SECRET;
const RZP_WEBHOOK_SECRET = process.env.RZP_WEBHOOK_SECRET || RZP_KEY_SECRET;
const RZP_BASE       = "https://api.razorpay.com/v1";

// ─── RESEND CONFIG ────────────────────────────────────────────────────────────
// Resend uses HTTPS (port 443) — works on Render, no domain verification needed
// Sign up free at resend.com → get API key → add RESEND_KEY on Render
// Free tier: 3,000 emails/month, 100/day
const RESEND_KEY = process.env.RESEND_KEY;

const CF_HEADERS = {
  "Content-Type":    "application/json",
  "x-client-id":     CF_APP_ID,
  "x-client-secret": CF_SECRET,
  "x-api-version":   "2023-08-01",
};

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({ origin: "*" }));

// Raw body needed for webhook signature verification (Cashfree + Razorpay)
app.use((req, res, next) => {
  if (req.path === "/api/webhook" || req.path === "/api/rzp-webhook") {
    let raw = "";
    req.on("data", chunk => raw += chunk);
    req.on("end", () => { req.rawBody = raw; next(); });
  } else {
    express.json()(req, res, next);
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "Bloom Backend running 🌸" }));

// ══════════════════════════════════════════════════════════════════════════════
//  CASHFREE ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// ─── CREATE ORDER (Cashfree) ──────────────────────────────────────────────────
app.post("/api/create-order", async (req, res) => {
  try {
    const {
      amount, orderId, customerName, customerEmail,
      customerPhone, storeName, storeSlug,
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
        notify_url: `${BACKEND_URL}/api/webhook`,
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

// ─── GET PAYMENT STATUS (Cashfree) ───────────────────────────────────────────
app.get("/api/payment-status/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    const cfRes = await fetch(`${CF_BASE}/orders/${orderId}`, {
      method:  "GET",
      headers: CF_HEADERS,
    });
    const data = await cfRes.json();
    if (!cfRes.ok) return res.status(500).json({ error: data.message });

    return res.json({
      orderId:  data.order_id,
      status:   data.order_status,
      amount:   data.order_amount,
      currency: data.order_currency,
      paidAt:   data.order_tags?.paid_at || null,
    });
  } catch (err) {
    console.error("Status check error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── WEBHOOK (Cashfree) ───────────────────────────────────────────────────────
app.post("/api/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-webhook-signature"];
    const timestamp = req.headers["x-webhook-timestamp"];
    const rawBody   = req.rawBody || "";

    const signedPayload = timestamp + rawBody;
    const expected = crypto
      .createHmac("sha256", CF_SECRET)
      .update(signedPayload)
      .digest("base64");

    if (signature !== expected) {
      console.warn("Invalid Cashfree webhook signature");
      return res.status(401).json({ error: "Invalid signature" });
    }

    const event = JSON.parse(rawBody);
    const { type, data } = event;
    console.log("Cashfree webhook event:", type, data?.order?.order_id);

    if (type === "PAYMENT_SUCCESS_WEBHOOK") {
      const orderId   = data?.order?.order_id;
      const amount    = data?.order?.order_amount;
      const paymentId = data?.payment?.cf_payment_id;
      if (orderId) {
        await updateOrderInSupabase(orderId, {
          status:     "confirmed",
          payment_id: String(paymentId || ""),
          amount,
        });
        console.log(`✅ Cashfree: Order ${orderId} confirmed — ₹${amount}`);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Cashfree webhook error:", err);
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  RAZORPAY ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// ─── CREATE ORDER (Razorpay) ──────────────────────────────────────────────────
// Frontend calls this → gets rzpOrderId + keyId to open checkout
app.post("/api/rzp-create-order", async (req, res) => {
  try {
    const {
      amount, orderId, storeName,
    } = req.body;

    if (!amount || !orderId) {
      return res.status(400).json({ error: "amount and orderId are required" });
    }

    if (!RZP_KEY_ID || !RZP_KEY_SECRET) {
      return res.status(503).json({ error: "Razorpay not configured on server" });
    }

    // Razorpay expects amount in paise (INR × 100)
    const payload = {
      amount:   Math.round(Number(amount) * 100),
      currency: "INR",
      receipt:  orderId,                            // maps back to our bloom order ID
      notes:    { storeName: storeName || "Bloom Store", bloomOrderId: orderId },
    };

    const auth   = Buffer.from(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`).toString("base64");
    const rzpRes = await fetch(`${RZP_BASE}/orders`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Basic ${auth}` },
      body:    JSON.stringify(payload),
    });

    const data = await rzpRes.json();

    if (!rzpRes.ok) {
      console.error("Razorpay create order error:", data);
      return res.status(500).json({ error: data.error?.description || "Failed to create Razorpay order" });
    }

    console.log(`🟡 Razorpay order created: ${data.id} for ₹${amount}`);

    return res.json({
      rzpOrderId: data.id,
      amount:     data.amount,      // in paise
      currency:   data.currency,
      keyId:      RZP_KEY_ID,       // safe to expose — it's the public key
    });
  } catch (err) {
    console.error("Razorpay create order error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── VERIFY PAYMENT (Razorpay) ────────────────────────────────────────────────
// After checkout succeeds, frontend sends the 3 IDs here to verify signature
app.post("/api/rzp-verify", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      bloomOrderId,      // our internal BL-XXXX order ID
      amount,            // in paise
      storeEmail,        // store owner email — passed directly from frontend
      storeName,         // store name — for the notification email
      ownerName,         // store owner name
      customerName,      // customer name — for email body
      items,             // ordered items array
      deliveryAddress,   // customer's shipping address (optional)
    } = req.body;

    console.log(`📨 rzp-verify received: orderId=${bloomOrderId} | storeEmail=${storeEmail || "NOT PROVIDED"} | storeName=${storeName || "—"}`);

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing Razorpay payment details" });
    }

    // Verify HMAC-SHA256 signature: key_secret( order_id + "|" + payment_id )
    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expected = crypto
      .createHmac("sha256", RZP_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expected !== razorpay_signature) {
      console.warn("⚠️  Invalid Razorpay payment signature for order:", bloomOrderId);
      return res.status(400).json({ error: "Payment signature verification failed" });
    }

    const amountINR = Math.round(amount / 100);

    // Signature valid — confirm order in Supabase
    if (bloomOrderId) {
      await updateOrderInSupabase(bloomOrderId, {
        status:     "confirmed",
        payment_id: razorpay_payment_id,
        amount:     amountINR,
      });

      // Decrement stock for every purchased item
      if (items?.length) {
        await decrementProductStock(items);
      }

      // Send email notification to store owner
      // Prefer store info passed directly from frontend (avoids extra DB call)
      if (storeEmail) {
        await sendOrderNotificationEmail({
          toEmail:   storeEmail,
          toName:    ownerName || storeName,
          storeName: storeName || "Bloom Store",
          deliveryAddress: deliveryAddress || null,
          order: {
            id:            bloomOrderId,
            customer_name: customerName || "Customer",
            amount:        amountINR,
            items:         items || [],
          },
        });
      } else {
        console.warn("⚠️  storeEmail not provided — falling back to Supabase lookup");
        // Fallback: fetch store info from Supabase if frontend didn't send it
        const info = await getStoreByOrderId(bloomOrderId);
        if (info?.store?.email) {
          await sendOrderNotificationEmail({
            toEmail:         info.store.email,
            toName:          info.store.name,
            storeName:       info.store.store_name,
            deliveryAddress: deliveryAddress || null,
            order:           { ...info.order, id: bloomOrderId },
          });
        } else {
          console.error("❌ Could not find store email — no email sent for order", bloomOrderId);
        }
      }
    }

    console.log(`✅ Razorpay: Payment verified — ${razorpay_payment_id} for order ${bloomOrderId}`);
    return res.json({ success: true, paymentId: razorpay_payment_id });
  } catch (err) {
    console.error("Razorpay verify error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── WEBHOOK (Razorpay) ───────────────────────────────────────────────────────
// Razorpay calls this automatically on payment.captured
app.post("/api/rzp-webhook", async (req, res) => {
  try {
    const signature = req.headers["x-razorpay-signature"];
    const rawBody   = req.rawBody || "";

    const expected = crypto
      .createHmac("sha256", RZP_WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");

    if (signature !== expected) {
      console.warn("Invalid Razorpay webhook signature");
      return res.status(401).json({ error: "Invalid signature" });
    }

    const event = JSON.parse(rawBody);
    console.log("Razorpay webhook event:", event.event);

    if (event.event === "payment.captured") {
      const payment       = event.payload.payment.entity;
      const paymentId     = payment.id;
      const amountPaise   = payment.amount;
      // bloomOrderId stored in notes at order creation time
      const bloomOrderId  = payment.notes?.bloomOrderId || payment.receipt;

      if (bloomOrderId) {
        await updateOrderInSupabase(bloomOrderId, {
          status:     "confirmed",
          payment_id: paymentId,
          amount:     Math.round(amountPaise / 100),
        });

        // Decrement stock from webhook too (covers edge cases)
        const orderItems = payment.notes?.items ? JSON.parse(payment.notes.items) : null;
        if (orderItems?.length) await decrementProductStock(orderItems);

        // Email store owner
        const info = await getStoreByOrderId(bloomOrderId);
        if (info?.store?.email) {
          await sendOrderNotificationEmail({
            toEmail:   info.store.email,
            toName:    info.store.name,
            storeName: info.store.store_name,
            order:     { ...info.order, id: bloomOrderId },
          });
        }
        console.log(`✅ Razorpay webhook: Order ${bloomOrderId} confirmed — ₹${amountPaise / 100}`);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Razorpay webhook error:", err);
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  SHARED HELPERS
// ══════════════════════════════════════════════════════════════════════════════

// ─── FETCH STORE OWNER FROM SUPABASE ─────────────────────────────────────────
async function getStoreByOrderId(bloomOrderId) {
  const SUPA_URL = process.env.SUPA_URL;
  const SUPA_KEY = process.env.SUPA_KEY;
  if (!SUPA_URL || !SUPA_KEY) return null;
  try {
    // Get the order first to find store_id
    const orderRes = await fetch(
      `${SUPA_URL}/rest/v1/bloom_orders?id=eq.${encodeURIComponent(bloomOrderId)}&select=store_id,customer_name,amount,items,order_date`,
      { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } }
    );
    const orders = await orderRes.json();
    if (!orders?.length) return null;
    const order = orders[0];

    // Get the store owner's details
    const storeRes = await fetch(
      `${SUPA_URL}/rest/v1/bloom_users?id=eq.${encodeURIComponent(order.store_id)}&select=email,name,store_name`,
      { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } }
    );
    const stores = await storeRes.json();
    if (!stores?.length) return null;
    return { store: stores[0], order };
  } catch (e) {
    console.error("getStoreByOrderId error:", e);
    return null;
  }
}

// ─── BUILD EMAIL HTML ─────────────────────────────────────────────────────────
function buildOrderEmailHtml({ storeName, order, deliveryAddress }) {
  const itemList = Array.isArray(order.items)
    ? order.items.map(i =>
        `<tr>
          <td style="padding:8px 0;font-size:14px;color:#2D1F2B;">${i.name} × ${i.qty}</td>
          <td style="padding:8px 0;font-size:14px;font-weight:700;text-align:right;color:#2D1F2B;">
            ₹${(Number(i.price || 0) * i.qty).toLocaleString("en-IN")}
          </td>
        </tr>`).join("")
    : `<tr><td colspan="2" style="font-size:14px;padding:8px 0;">See order details</td></tr>`;

  const addrBlock = deliveryAddress
    ? `<div style="background:#F0F9FF;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
        <p style="margin:0 0 8px;font-size:12px;color:#888;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">📦 Delivery Address</p>
        <p style="margin:0;font-size:14px;line-height:1.8;color:#2D1F2B;">${deliveryAddress}</p>
       </div>`
    : "";

  return `
    <div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;background:#fff;">
      <div style="background:linear-gradient(135deg,#FFD6E7,#FFF3CD);padding:24px;border-radius:14px;text-align:center;margin-bottom:24px;">
        <h1 style="margin:0;font-size:26px;color:#2D1F2B;">🌸 New Order!</h1>
        <p style="margin:10px 0 0;color:#7C5C72;font-size:15px;">
          You have a new order on <strong>${storeName}</strong>
        </p>
      </div>
      <div style="background:#F9F5FF;border-radius:10px;padding:20px;margin-bottom:20px;">
        <p style="margin:0 0 10px;font-size:12px;color:#888;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">🧾 Order Details</p>
        <p style="margin:0 0 4px;font-size:14px;"><strong>Order ID:</strong> ${order.id || "—"}</p>
        <p style="margin:0 0 16px;font-size:14px;"><strong>Customer:</strong> ${order.customer_name || "—"}</p>
        <table style="width:100%;border-collapse:collapse;border-top:1px solid #e0d0f0;">
          ${itemList}
          <tr style="border-top:2px solid #E8A0BE;">
            <td style="padding:10px 0;font-size:15px;font-weight:700;">Total</td>
            <td style="padding:10px 0;font-size:20px;font-weight:700;color:#C85A8A;text-align:right;">
              ₹${Number(order.amount || 0).toLocaleString("en-IN")}
            </td>
          </tr>
        </table>
      </div>
      ${addrBlock}
      <p style="font-size:13px;color:#aaa;text-align:center;margin-top:24px;">
        Log in to your <a href="https://bloomhq.in" style="color:#C85A8A;">Bloom dashboard</a> to manage this order.
      </p>
    </div>`;
}

// ─── SEND ORDER EMAIL via Resend (HTTPS — works on Render) ───────────────────
async function sendOrderNotificationEmail({ toEmail, toName, storeName, order, deliveryAddress }) {
  console.log(`📧 Email → to: ${toEmail || "❌ MISSING"} | resend key: ${RESEND_KEY ? "SET" : "❌ NOT SET"}`);

  if (!toEmail) { console.error("❌ No recipient email"); return; }
  if (!RESEND_KEY) { console.error("❌ RESEND_KEY not set on Render"); return; }

  try {
    const html    = buildOrderEmailHtml({ storeName, order, deliveryAddress });
    const subject = `🌸 New order on ${storeName} — ₹${Number(order.amount || 0).toLocaleString("en-IN")}`;

    const res = await fetch("https://api.resend.com/emails", {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from:    "Bloom Orders <orders@bloomhq.in>",
        to:      [toEmail],
        subject,
        html,
      }),
    });

    const body = await res.json();
    if (res.ok) {
      console.log(`✅ Email sent to ${toEmail} | id: ${body.id}`);
    } else {
      console.error(`❌ Resend error ${res.status}:`, JSON.stringify(body));
    }
  } catch (e) {
    console.error(`❌ Email failed: ${e.message}`);
  }
}

// ─── TEST EMAIL ENDPOINT ───────────────────────────────────────────────────────
app.post("/api/test-email", async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: "Provide 'to' in body" });

  if (!RESEND_KEY) {
    return res.status(500).json({
      error: "RESEND_KEY not set",
      fix:   "Sign up at resend.com → get API key → add RESEND_KEY on Render",
    });
  }

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from:    "Bloom Orders <orders@bloomhq.in>",
        to:      [to],
        subject: "🌸 Bloom Email Test",
        html:    `<p style="font-family:sans-serif;font-size:15px;">✅ Bloom email is working! Order notifications will arrive here.</p>`,
      }),
    });
    const body = await r.json();
    if (r.ok) {
      console.log(`🧪 Test email sent to ${to} | id: ${body.id}`);
      return res.json({ success: true, id: body.id, note: "Check inbox + spam" });
    } else {
      return res.status(r.status).json({ success: false, error: body });
    }
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ─── DECREMENT PRODUCT STOCK ──────────────────────────────────────────────────
// Called after payment confirmed — reduces stock for each purchased item
async function decrementProductStock(items) {
  const SUPA_URL = process.env.SUPA_URL;
  const SUPA_KEY = process.env.SUPA_KEY;
  if (!SUPA_URL || !SUPA_KEY || !items?.length) return;
  for (const item of items) {
    if (!item.id || !item.qty) continue;
    try {
      const r = await fetch(
        `${SUPA_URL}/rest/v1/bloom_products?id=eq.${encodeURIComponent(item.id)}&select=id,stock`,
        { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } }
      );
      const rows = await r.json();
      if (!rows?.length) continue;
      const newStock = Math.max(0, (rows[0].stock || 0) - (item.qty || 1));
      await fetch(
        `${SUPA_URL}/rest/v1/bloom_products?id=eq.${encodeURIComponent(item.id)}`,
        {
          method:  "PATCH",
          headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ stock: newStock }),
        }
      );
      console.log(`📦 Stock: ${item.name || item.id} → ${newStock} remaining`);
    } catch (e) {
      console.error("Stock decrement error:", e.message);
    }
  }
}

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
  console.log(`   Razorpay: ${RZP_KEY_ID ? "✅ configured" : "❌ RZP_KEY_ID missing"}`);
  console.log(`   Frontend: ${FRONTEND_URL}`);
  console.log(`   Resend key: ${RESEND_KEY ? "✅ RESEND_KEY set" : "❌ RESEND_KEY missing — emails will not send"}`);
  console.log(`   Supabase: ${process.env.SUPA_URL ? "✅ SUPA_URL set" : "❌ SUPA_URL missing"}`);
});
