const express    = require("express");
const cors       = require("cors");
const crypto     = require("crypto");
const fetch      = require("node-fetch");

const app = express();

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const BACKEND_URL  = process.env.BACKEND_URL  || "https://bloom-backend-v55a.onrender.com";
const FRONTEND_URL = process.env.FRONTEND_URL || "https://bloomhq.in";
const PORT         = process.env.PORT         || 3001;

// ─── RAZORPAY CONFIG ──────────────────────────────────────────────────────────
const RZP_KEY_ID         = process.env.RAZORPAY_KEY_ID     || process.env.RZP_KEY_ID;
const RZP_KEY_SECRET     = process.env.RAZORPAY_KEY_SECRET || process.env.RZP_KEY_SECRET;
const RZP_WEBHOOK_SECRET = process.env.RZP_WEBHOOK_SECRET  || RZP_KEY_SECRET;
const RZP_BASE           = "https://api.razorpay.com/v1";

// ─── RESEND CONFIG ────────────────────────────────────────────────────────────
// Free tier: 3,000 emails/month — sign up at resend.com
const RESEND_KEY = process.env.RESEND_KEY;

// ─── FAST2SMS CONFIG (Indian SMS) ────────────────────────────────────────────
// Sign up free at fast2sms.com → get API key → add FAST2SMS_KEY on Render
// Free credits on signup; DLT registration required for production transactional SMS
const FAST2SMS_KEY = process.env.FAST2SMS_KEY;

// ─── DB AUTO-MIGRATION ────────────────────────────────────────────────────────
// PRIMARY: DATABASE_URL (direct postgres) — set on Render from Supabase connection string
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    pool.query(`
      ALTER TABLE bloom_users ADD COLUMN IF NOT EXISTS instagram      text;
      ALTER TABLE bloom_users ADD COLUMN IF NOT EXISTS phone          text;
      ALTER TABLE bloom_users ADD COLUMN IF NOT EXISTS shipping_cost  integer DEFAULT 0;
      ALTER TABLE bloom_users ADD COLUMN IF NOT EXISTS dispatch_days  text    DEFAULT '3-5 days';
      ALTER TABLE bloom_users ADD COLUMN IF NOT EXISTS mailersend_key text;
      ALTER TABLE bloom_users ADD COLUMN IF NOT EXISTS store_image    text;
      ALTER TABLE bloom_products ADD COLUMN IF NOT EXISTS is_pinned   boolean DEFAULT false;
      ALTER TABLE bloom_customers ADD COLUMN IF NOT EXISTS instagram     text;
      ALTER TABLE bloom_customers ADD COLUMN IF NOT EXISTS profile_image text;
      ALTER TABLE bloom_customers ADD COLUMN IF NOT EXISTS upi_id       text;
      ALTER TABLE bloom_customers ADD COLUMN IF NOT EXISTS password_hash text;
      CREATE TABLE IF NOT EXISTS bloom_payouts (
        id       text PRIMARY KEY,
        store_id text NOT NULL,
        amount   numeric NOT NULL DEFAULT 0,
        note     text,
        paid_at  timestamptz DEFAULT now()
      );
    `)
      .then(() => { console.log("✅ Schema migration (DATABASE_URL) complete"); pool.end(); })
      .catch(e  => { console.error("⚠️  DB migration failed:", e.message); pool.end(); });
  } catch (e) {
    console.error("⚠️  pg not available:", e.message);
  }
} else {
  console.warn("⚠️  DATABASE_URL not set — will use pg-meta fallback");
}

// FALLBACK: Supabase pg-meta API — runs on every startup, no DATABASE_URL needed
async function ensureSchemaViaPgMeta() {
  const SUPA_URL = process.env.SUPA_URL;
  const SUPA_KEY = process.env.SUPA_KEY;
  if (!SUPA_URL || !SUPA_KEY) return;
  const base = `${SUPA_URL}/pg-meta/v1`;
  const hdr  = { "Authorization": `Bearer ${SUPA_KEY}`, "Content-Type": "application/json" };

  try {
    // ── 1. Fetch all tables ──────────────────────────────────────────────────
    const tabRes = await fetch(`${base}/tables?limit=500`, { headers: hdr });
    if (!tabRes.ok) { console.warn("pg-meta /tables failed:", tabRes.status); return; }
    const tables = await tabRes.json();
    if (!Array.isArray(tables)) return;

    // ── 2. Ensure bloom_payouts exists ───────────────────────────────────────
    const payoutsTable = tables.find(t => t.name === "bloom_payouts");
    if (!payoutsTable) {
      const r = await fetch(`${base}/tables`, {
        method: "POST", headers: hdr,
        body: JSON.stringify({ name: "bloom_payouts", schema: "public" }),
      });
      if (r.ok) {
        const created = await r.json();
        // Add columns to newly created table
        for (const col of [
          { name:"id",       type:"text",    is_nullable:false, is_primary_key:true },
          { name:"store_id", type:"text",    is_nullable:false },
          { name:"amount",   type:"numeric", is_nullable:false, default_value:"0" },
          { name:"note",     type:"text",    is_nullable:true  },
          { name:"paid_at",  type:"timestamptz", is_nullable:true, default_value:"now()" },
        ]) {
          await fetch(`${base}/columns`, {
            method:"POST", headers:hdr,
            body: JSON.stringify({ table_id: created.id, ...col }),
          });
        }
        console.log("✅ pg-meta: bloom_payouts table created");
      }
    }

    // Helper: add missing text columns to a table
    async function ensureCols(table, needed, extraTypes = {}) {
      if (!table) return;
      const res = await fetch(`${base}/columns?table_id=${table.id}`, { headers: hdr });
      if (!res.ok) return;
      const cols = await res.json();
      const existing = new Set(Array.isArray(cols) ? cols.map(c => c.name) : []);
      for (const name of needed) {
        if (!existing.has(name)) {
          const r = await fetch(`${base}/columns`, {
            method:"POST", headers:hdr,
            body: JSON.stringify({ table_id: table.id, name, type: extraTypes[name] || "text", is_nullable:true }),
          });
          console.log(r.ok ? `✅ pg-meta: added '${name}' to ${table.name}` : `⚠️  pg-meta: failed '${name}' on ${table.name} (${r.status})`);
        }
      }
    }

    // ── 3. Ensure bloom_users has all needed columns ──────────────────────────
    const usersTable = tables.find(t => t.name === "bloom_users");
    await ensureCols(usersTable,
      ["instagram", "phone", "store_image", "store_desc", "mailersend_key", "dispatch_days", "collections"],
      { shipping_cost: "integer", collections: "jsonb" }
    );
    // shipping_cost needs integer type — handle separately
    if (usersTable) {
      const scRes = await fetch(`${base}/columns?table_id=${usersTable.id}`, { headers: hdr });
      if (scRes.ok) {
        const scCols = await scRes.json();
        if (Array.isArray(scCols) && !scCols.find(c => c.name === "shipping_cost")) {
          const r = await fetch(`${base}/columns`, {
            method:"POST", headers:hdr,
            body: JSON.stringify({ table_id: usersTable.id, name:"shipping_cost", type:"integer", is_nullable:true, default_value:"0" }),
          });
          console.log(r.ok ? `✅ pg-meta: added 'shipping_cost' to bloom_users` : `⚠️  pg-meta: failed 'shipping_cost' (${r.status})`);
        }
      }
    }

    // ── 4. Ensure bloom_customers has needed columns ──────────────────────────
    const custTable = tables.find(t => t.name === "bloom_customers");
    await ensureCols(custTable, ["instagram", "profile_image", "upi_id", "password_hash"]);

    // ── 5. Reload PostgREST schema cache so new columns are visible immediately
    try {
      await fetch(`${base}/query`, {
        method: "POST", headers: hdr,
        body: JSON.stringify({ query: "SELECT pg_notify('pgrst', 'reload schema')" }),
      });
      console.log("✅ pg-meta: PostgREST schema cache reloaded");
    } catch(_) { /* non-fatal — PostgREST reloads on its own interval anyway */ }

    console.log("✅ pg-meta schema check complete");
  } catch(e) {
    console.error("⚠️  pg-meta migration error:", e.message);
  }
}
ensureSchemaViaPgMeta();

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({ origin: "*" }));

// Raw body needed for Razorpay webhook signature verification
app.use((req, res, next) => {
  if (req.path === "/api/rzp-webhook") {
    let raw = "";
    req.on("data", chunk => raw += chunk);
    req.on("end", () => { req.rawBody = raw; next(); });
  } else {
    express.json({ limit: "10mb" })(req, res, next);
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "Bloom Backend running 🌸" }));

// ══════════════════════════════════════════════════════════════════════════════
//  RAZORPAY ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// ─── CREATE ORDER (Razorpay) ──────────────────────────────────────────────────
app.post("/api/rzp-create-order", async (req, res) => {
  try {
    const { amount, orderId, storeName } = req.body;

    if (!amount || !orderId) {
      return res.status(400).json({ error: "amount and orderId are required" });
    }
    if (!RZP_KEY_ID || !RZP_KEY_SECRET) {
      return res.status(503).json({ error: "Razorpay not configured on server" });
    }

    const payload = {
      amount:   Math.round(Number(amount) * 100),  // paise
      currency: "INR",
      receipt:  orderId,
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
    return res.json({ rzpOrderId: data.id, amount: data.amount, currency: data.currency, keyId: RZP_KEY_ID });
  } catch (err) {
    console.error("Razorpay create order error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── VERIFY PAYMENT (Razorpay) ────────────────────────────────────────────────
app.post("/api/rzp-verify", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      bloomOrderId,
      amount,           // in paise
      storeEmail,
      storeName,
      ownerName,
      customerName,
      customerPhone,    // customer's phone for SMS
      storePhone,       // business owner's phone for SMS
      items,
      deliveryAddress,
    } = req.body;

    console.log(`📨 rzp-verify: orderId=${bloomOrderId} | store=${storeName || "—"}`);

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing Razorpay payment details" });
    }

    // Verify HMAC-SHA256 signature
    const body     = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expected = crypto.createHmac("sha256", RZP_KEY_SECRET).update(body).digest("hex");

    if (expected !== razorpay_signature) {
      console.warn("⚠️  Invalid Razorpay signature for order:", bloomOrderId);
      return res.status(400).json({ error: "Payment signature verification failed" });
    }

    const amountINR = Math.round(amount / 100);

    if (bloomOrderId) {
      // 1. Confirm order in Supabase
      await updateOrderInSupabase(bloomOrderId, {
        status:     "confirmed",
        payment_id: razorpay_payment_id,
        amount:     amountINR,
      });

      // 2. Decrement stock
      if (items?.length) await decrementProductStock(items);

      // 3. Email to store owner
      const orderPayload = {
        id:            bloomOrderId,
        customer_name: customerName || "Customer",
        amount:        amountINR,
        items:         items || [],
      };

      if (storeEmail) {
        await sendOrderNotificationEmail({
          toEmail: storeEmail, toName: ownerName || storeName,
          storeName: storeName || "Bloom Store",
          deliveryAddress: deliveryAddress || null,
          order: orderPayload,
        });
      } else {
        const info = await getStoreByOrderId(bloomOrderId);
        if (info?.store?.email) {
          await sendOrderNotificationEmail({
            toEmail: info.store.email, toName: info.store.name,
            storeName: info.store.store_name,
            deliveryAddress: deliveryAddress || null,
            order: { ...info.order, id: bloomOrderId },
          });
        }
      }

      // 4. SMS notifications
      const itemSummary = (items||[]).map(i=>`${i.name} ×${i.qty}`).join(", ") || "items";
      // → Business owner
      const bizPhone = storePhone || null;
      if (bizPhone) {
        await sendSMS(bizPhone,
          `New Bloom order! ${customerName||"A customer"} ordered ${itemSummary} for Rs.${amountINR} on ${storeName||"your store"}. Login to bloomhq.in to manage it.`
        );
      }
      // → Customer
      if (customerPhone) {
        await sendSMS(customerPhone,
          `Order confirmed! Your order (${bloomOrderId}) at ${storeName||"Bloom Store"} for Rs.${amountINR} is confirmed. Thank you for shopping on Bloom!`
        );
      }
    }

    console.log(`✅ Payment verified — ${razorpay_payment_id} | order ${bloomOrderId}`);
    return res.json({ success: true, paymentId: razorpay_payment_id });
  } catch (err) {
    console.error("Razorpay verify error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── WEBHOOK (Razorpay) ───────────────────────────────────────────────────────
app.post("/api/rzp-webhook", async (req, res) => {
  try {
    const signature = req.headers["x-razorpay-signature"];
    const rawBody   = req.rawBody || "";

    const expected = crypto.createHmac("sha256", RZP_WEBHOOK_SECRET).update(rawBody).digest("hex");
    if (signature !== expected) {
      console.warn("Invalid Razorpay webhook signature");
      return res.status(401).json({ error: "Invalid signature" });
    }

    const event = JSON.parse(rawBody);
    console.log("Razorpay webhook event:", event.event);

    if (event.event === "payment.captured") {
      const payment      = event.payload.payment.entity;
      const paymentId    = payment.id;
      const amountPaise  = payment.amount;
      const bloomOrderId = payment.notes?.bloomOrderId || payment.receipt;

      if (bloomOrderId) {
        const amountINR = Math.round(amountPaise / 100);

        await updateOrderInSupabase(bloomOrderId, {
          status:     "confirmed",
          payment_id: paymentId,
          amount:     amountINR,
        });

        const orderItems = payment.notes?.items ? JSON.parse(payment.notes.items) : null;
        if (orderItems?.length) await decrementProductStock(orderItems);

        const info = await getStoreByOrderId(bloomOrderId);
        if (info?.store?.email) {
          await sendOrderNotificationEmail({
            toEmail: info.store.email, toName: info.store.name,
            storeName: info.store.store_name,
            order: { ...info.order, id: bloomOrderId },
          });
        }
        // SMS to business from webhook (best-effort, phone from Supabase)
        if (info?.store?.phone) {
          const itemSummary = Array.isArray(info.order?.items)
            ? info.order.items.map(i=>`${i.name} ×${i.qty}`).join(", ")
            : "items";
          await sendSMS(info.store.phone,
            `New Bloom order! ${info.order?.customer_name||"A customer"} ordered ${itemSummary} for Rs.${amountINR} on ${info.store.store_name}. Login to bloomhq.in to manage it.`
          );
        }

        console.log(`✅ Razorpay webhook: Order ${bloomOrderId} confirmed — ₹${amountINR}`);
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

// ─── SEND SMS via Fast2SMS ────────────────────────────────────────────────────
// Docs: https://docs.fast2sms.com/
// Free signup at fast2sms.com → API key → add FAST2SMS_KEY on Render
// Note: For production transactional SMS in India, DLT registration is required.
// Until then, use Quick SMS (route "q") which works without a registered sender ID.
async function sendSMS(phone, message) {
  if (!FAST2SMS_KEY) {
    console.log("📱 SMS skipped — FAST2SMS_KEY not set");
    return;
  }
  if (!phone) return;
  try {
    // Normalize to 10-digit Indian mobile number
    const cleaned = String(phone).replace(/\D/g, "").replace(/^0+/, "").replace(/^91/, "").slice(-10);
    if (cleaned.length !== 10) {
      console.warn(`📱 SMS skipped — invalid phone: ${phone}`);
      return;
    }
    const res = await fetch("https://www.fast2sms.com/dev/bulkV2", {
      method:  "POST",
      headers: { "authorization": FAST2SMS_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        route:    "q",           // Quick SMS — works without DLT registration
        message,
        language: "english",
        flash:    0,
        numbers:  cleaned,
      }),
    });
    const data = await res.json();
    if (data.return) {
      console.log(`📱 SMS sent to ${cleaned}`);
    } else {
      console.error("📱 SMS error:", JSON.stringify(data.message || data));
    }
  } catch (e) {
    console.error("📱 SMS send error:", e.message);
  }
}

// ─── FETCH STORE OWNER FROM SUPABASE ─────────────────────────────────────────
async function getStoreByOrderId(bloomOrderId) {
  const SUPA_URL = process.env.SUPA_URL;
  const SUPA_KEY = process.env.SUPA_KEY;
  if (!SUPA_URL || !SUPA_KEY) return null;
  try {
    const orderRes = await fetch(
      `${SUPA_URL}/rest/v1/bloom_orders?id=eq.${encodeURIComponent(bloomOrderId)}&select=store_id,customer_name,amount,items,order_date`,
      { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } }
    );
    const orders = await orderRes.json();
    if (!orders?.length) return null;
    const order = orders[0];

    const storeRes = await fetch(
      `${SUPA_URL}/rest/v1/bloom_users?id=eq.${encodeURIComponent(order.store_id)}&select=email,name,store_name,phone`,
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
    ? order.items.map(i => {
        const varName = i.selectedVariation?.name || i.selectedOption || null;
        const varBadge = varName
          ? `<span style="display:inline-block;background:#E0F9F6;color:#0D8E82;border-radius:5px;padding:1px 7px;font-size:11px;font-weight:700;margin-left:6px;">${varName}</span>`
          : "";
        return `<tr>
          <td style="padding:8px 0;font-size:14px;color:#39393F;border-bottom:1px solid #f0f0f0;">
            ${i.name}${varBadge} <span style="color:#888;">× ${i.qty}</span>
          </td>
          <td style="padding:8px 0;font-size:14px;font-weight:700;text-align:right;color:#39393F;border-bottom:1px solid #f0f0f0;">
            ₹${(Number(i.price || 0) * i.qty).toLocaleString("en-IN")}
          </td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="2" style="font-size:14px;padding:8px 0;">See order details</td></tr>`;

  // Parse Instagram out of the delivery address string if present
  let addrDisplay = deliveryAddress || "";
  let igLine = "";
  if (addrDisplay) {
    const igMatch = addrDisplay.match(/Instagram:\s*(@?\S+)/i);
    if (igMatch) {
      const handle = igMatch[1].replace(/^@/,"");
      igLine = `<p style="margin:6px 0 0;font-size:13px;color:#555;">
        📸 Instagram: <a href="https://instagram.com/${handle}" style="color:#17C3B2;font-weight:700;">@${handle}</a>
      </p>`;
    }
  }

  const addrBlock = addrDisplay
    ? `<div style="background:#F0FCF9;border-radius:10px;padding:16px 20px;margin-bottom:20px;border-left:4px solid #17C3B2;">
        <p style="margin:0 0 8px;font-size:12px;color:#888;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">📦 Delivery Details</p>
        <p style="margin:0;font-size:14px;line-height:1.9;color:#39393F;white-space:pre-line;">${addrDisplay}</p>
        ${igLine}
       </div>`
    : "";

  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#fff;">
      <div style="background:linear-gradient(135deg,#17C3B2,#13AFA0);padding:28px 24px;border-radius:16px;text-align:center;margin-bottom:24px;">
        <img src="https://bloomhq.in/bloom-logo.png" alt="Bloom" style="height:48px;margin-bottom:12px;filter:brightness(0) invert(1);"/>
        <h1 style="margin:0;font-size:28px;color:#fff;font-family:Arial,sans-serif;font-weight:700;letter-spacing:-0.5px;">New Order!</h1>
        <p style="margin:10px 0 0;color:rgba(255,255,255,0.85);font-size:15px;">
          You have a new order on <strong>${storeName}</strong>
        </p>
      </div>
      <div style="background:#F9FFFE;border-radius:12px;padding:20px;margin-bottom:20px;border:1px solid #E0F9F6;">
        <p style="margin:0 0 10px;font-size:12px;color:#888;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">🧾 Order Details</p>
        <p style="margin:0 0 4px;font-size:14px;color:#39393F;"><strong>Order ID:</strong> ${order.id || "—"}</p>
        <p style="margin:0 0 16px;font-size:14px;color:#39393F;"><strong>Customer:</strong> ${order.customer_name || "—"}</p>
        <table style="width:100%;border-collapse:collapse;">
          ${itemList}
          <tr>
            <td style="padding:12px 0 0;font-size:15px;font-weight:700;color:#39393F;">Total</td>
            <td style="padding:12px 0 0;font-size:22px;font-weight:700;color:#17C3B2;text-align:right;">
              ₹${Number(order.amount || 0).toLocaleString("en-IN")}
            </td>
          </tr>
        </table>
      </div>
      ${addrBlock}
      <p style="font-size:13px;color:#aaa;text-align:center;margin-top:24px;">
        Log in to your <a href="https://bloomhq.in" style="color:#17C3B2;font-weight:700;">Bloom dashboard</a> to manage this order.
      </p>
      <p style="font-size:11px;color:#ccc;text-align:center;margin-top:8px;">bloomhq.in · Made with 🌸 in India</p>
    </div>`;
}

// ─── SEND ORDER EMAIL via Resend ──────────────────────────────────────────────
async function sendOrderNotificationEmail({ toEmail, toName, storeName, order, deliveryAddress }) {
  console.log(`📧 Email → ${toEmail || "❌ MISSING"} | key: ${RESEND_KEY ? "SET" : "❌ NOT SET"}`);
  if (!toEmail || !RESEND_KEY) return;
  try {
    const html    = buildOrderEmailHtml({ storeName, order, deliveryAddress });
    const subject = `New order on ${storeName} — ₹${Number(order.amount || 0).toLocaleString("en-IN")}`;
    const res = await fetch("https://api.resend.com/emails", {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({ from: "Bloom Orders <orders@bloomhq.in>", to: [toEmail], subject, html }),
    });
    const body = await res.json();
    if (res.ok) console.log(`✅ Email sent to ${toEmail} | id: ${body.id}`);
    else        console.error(`❌ Resend ${res.status}:`, JSON.stringify(body));
  } catch (e) {
    console.error(`❌ Email failed: ${e.message}`);
  }
}

// ─── TEST EMAIL ENDPOINT ──────────────────────────────────────────────────────
app.post("/api/test-email", async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: "Provide 'to' in body" });
  if (!RESEND_KEY) return res.status(500).json({ error: "RESEND_KEY not set on Render" });
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
    if (r.ok) return res.json({ success: true, id: body.id, note: "Check inbox + spam" });
    else      return res.status(r.status).json({ success: false, error: body });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ─── TEST SMS ENDPOINT ────────────────────────────────────────────────────────
app.post("/api/test-sms", async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "Provide 'phone' in body (10-digit)" });
  if (!FAST2SMS_KEY) return res.status(500).json({ error: "FAST2SMS_KEY not set on Render", fix: "Sign up at fast2sms.com → get API key → add FAST2SMS_KEY on Render" });
  await sendSMS(phone, "Test from Bloom! Your SMS notifications are working correctly. 🌸");
  return res.json({ success: true, note: `SMS sent to ${phone}` });
});

// ─── DECREMENT PRODUCT STOCK ──────────────────────────────────────────────────
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
      await fetch(`${SUPA_URL}/rest/v1/bloom_products?id=eq.${encodeURIComponent(item.id)}`, {
        method:  "PATCH",
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ stock: newStock }),
      });
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
    const res = await fetch(`${SUPA_URL}/rest/v1/bloom_orders?id=eq.${encodeURIComponent(bloomOrderId)}`, {
      method:  "PATCH",
      headers: {
        "apikey": SUPA_KEY, "Authorization": `Bearer ${SUPA_KEY}`,
        "Content-Type": "application/json", "Prefer": "return=representation",
      },
      body: JSON.stringify(updates),
    });
    if (!res.ok) console.error("Supabase update failed:", await res.text());
  } catch (e) {
    console.error("Supabase update error:", e);
  }
}

// ─── PING (used by frontend to wake Render before saving) ────────────────────
app.get("/ping", (_req, res) => res.json({ ok: true }));

// ══════════════════════════════════════════════════════════════════════════════
//  DATA PROXY — all writes go through here so the service-role key bypasses RLS
// ══════════════════════════════════════════════════════════════════════════════

function sh() {
  const key = process.env.SUPA_KEY;
  return {
    apikey:        key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}
function su() { return process.env.SUPA_URL; }

// ─── PATCH bloom_users ────────────────────────────────────────────────────────
// Three-layer fallback: PostgREST → pg-meta raw SQL → direct pg (DATABASE_URL)
function buildUpdateSQL(table, id, data) {
  const keys = Object.keys(data);
  if (!keys.length) return null;
  const setParts = keys.map(k => {
    const v = data[k];
    if (v === null || v === undefined) return `"${k}" = NULL`;
    if (typeof v === "number") return `"${k}" = ${Number(v)}`;
    if (typeof v === "object") return `"${k}" = '${JSON.stringify(v).replace(/'/g,"''")}'::jsonb`;
    return `"${k}" = '${String(v).replace(/'/g,"''")}'`;
  });
  const safeId = String(id).replace(/'/g,"''");
  return `UPDATE public.${table} SET ${setParts.join(", ")} WHERE id = '${safeId}'`;
}

app.patch("/api/user/:id", async (req, res) => {
  if (!su() || !process.env.SUPA_KEY) return res.status(503).json({ error: "Supabase not configured on server" });
  const id   = req.params.id;
  const body = req.body;

  // ── Layer 1: PostgREST (fast, works once schema cache is fresh) ───────────
  try {
    const r = await fetch(
      `${su()}/rest/v1/bloom_users?id=eq.${encodeURIComponent(id)}`,
      { method:"PATCH", headers:{...sh(),"Prefer":"return=minimal"}, body:JSON.stringify(body) }
    );
    if (r.ok) return res.json({ success: true });
    const errText = await r.text();
    if (!errText.includes("schema cache") && !errText.includes("PGRST204")) {
      return res.status(r.status).json({ error: errText });
    }
    console.warn("⚠️  PostgREST schema cache stale — trying raw SQL fallback");
  } catch(e) { return res.status(500).json({ error: e.message }); }

  // ── Layer 2: pg-meta /query raw SQL (bypasses PostgREST schema cache) ─────
  const sql = buildUpdateSQL("bloom_users", id, body);
  if (sql) {
    try {
      const pgMetaHdr = { "Authorization": `Bearer ${process.env.SUPA_KEY}`, "Content-Type": "application/json" };
      const qRes = await fetch(`${su()}/pg-meta/v1/query`, {
        method:"POST", headers: pgMetaHdr,
        body: JSON.stringify({ query: sql + "; NOTIFY pgrst, 'reload schema'" }),
      });
      if (qRes.ok) {
        console.log("✅ pg-meta raw SQL PATCH succeeded");
        return res.json({ success: true });
      }
      console.warn("⚠️  pg-meta /query failed:", qRes.status, await qRes.text());
    } catch(e) { console.warn("⚠️  pg-meta /query error:", e.message); }
  }

  // ── Layer 3: Direct pg connection via DATABASE_URL ────────────────────────
  if (process.env.DATABASE_URL) {
    try {
      const { Pool } = require("pg");
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      const keys = Object.keys(body);
      const vals = Object.values(body);
      const setClause = keys.map((k, i) => `"${k}" = $${i + 1}`).join(", ");
      await pool.query(`UPDATE bloom_users SET ${setClause} WHERE id = $${keys.length + 1}`, [...vals, id]);
      await pool.query("SELECT pg_notify('pgrst', 'reload schema')");
      pool.end();
      console.log("✅ DATABASE_URL direct PATCH succeeded");
      return res.json({ success: true });
    } catch(e) { console.error("⚠️  DATABASE_URL PATCH failed:", e.message); }
  }

  return res.status(500).json({ error: "All save methods exhausted — schema cache is stale and no direct DB access." });
});

// ─── POST bloom_users (signup) ────────────────────────────────────────────────
app.post("/api/user", async (req, res) => {
  if (!su() || !process.env.SUPA_KEY) return res.status(503).json({ error: "Supabase not configured on server" });
  try {
    const r = await fetch(
      `${su()}/rest/v1/bloom_users`,
      { method:"POST", headers:{...sh(),"Prefer":"return=representation"}, body:JSON.stringify(req.body) }
    );
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: JSON.stringify(data) });
    return res.json(Array.isArray(data) ? (data[0] || req.body) : data);
  } catch(e) { return res.status(500).json({ error: e.message }); }
});

// ─── POST bloom_products ──────────────────────────────────────────────────────
app.post("/api/product", async (req, res) => {
  if (!su() || !process.env.SUPA_KEY) return res.status(503).json({ error: "Supabase not configured on server" });
  try {
    const r = await fetch(
      `${su()}/rest/v1/bloom_products`,
      { method:"POST", headers:{...sh(),"Prefer":"return=representation"}, body:JSON.stringify(req.body) }
    );
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: JSON.stringify(data) });
    return res.json(Array.isArray(data) ? (data[0] || req.body) : data);
  } catch(e) { return res.status(500).json({ error: e.message }); }
});

// ─── PATCH bloom_products ─────────────────────────────────────────────────────
app.patch("/api/product/:id", async (req, res) => {
  if (!su() || !process.env.SUPA_KEY) return res.status(503).json({ error: "Supabase not configured on server" });
  try {
    const r = await fetch(
      `${su()}/rest/v1/bloom_products?id=eq.${encodeURIComponent(req.params.id)}`,
      { method:"PATCH", headers:{...sh(),"Prefer":"return=minimal"}, body:JSON.stringify(req.body) }
    );
    if (!r.ok) return res.status(r.status).json({ error: await r.text() });
    return res.json({ success: true });
  } catch(e) { return res.status(500).json({ error: e.message }); }
});

// ─── DELETE bloom_products ────────────────────────────────────────────────────
app.delete("/api/product/:id", async (req, res) => {
  if (!su() || !process.env.SUPA_KEY) return res.status(503).json({ error: "Supabase not configured on server" });
  try {
    const r = await fetch(
      `${su()}/rest/v1/bloom_products?id=eq.${encodeURIComponent(req.params.id)}`,
      { method:"DELETE", headers:sh() }
    );
    if (!r.ok) return res.status(r.status).json({ error: await r.text() });
    return res.json({ success: true });
  } catch(e) { return res.status(500).json({ error: e.message }); }
});

// ─── POST bloom_orders ────────────────────────────────────────────────────────
app.post("/api/order", async (req, res) => {
  if (!su() || !process.env.SUPA_KEY) return res.status(503).json({ error: "Supabase not configured on server" });
  try {
    const r = await fetch(
      `${su()}/rest/v1/bloom_orders`,
      { method:"POST", headers:{...sh(),"Prefer":"return=representation"}, body:JSON.stringify(req.body) }
    );
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: JSON.stringify(data) });
    return res.json(Array.isArray(data) ? (data[0] || req.body) : data);
  } catch(e) { return res.status(500).json({ error: e.message }); }
});

// ─── PATCH bloom_orders ───────────────────────────────────────────────────────
app.patch("/api/order/:id", async (req, res) => {
  if (!su() || !process.env.SUPA_KEY) return res.status(503).json({ error: "Supabase not configured on server" });
  try {
    const r = await fetch(
      `${su()}/rest/v1/bloom_orders?id=eq.${encodeURIComponent(req.params.id)}`,
      { method:"PATCH", headers:{...sh(),"Prefer":"return=minimal"}, body:JSON.stringify(req.body) }
    );
    if (!r.ok) return res.status(r.status).json({ error: await r.text() });
    return res.json({ success: true });
  } catch(e) { return res.status(500).json({ error: e.message }); }
});

// ─── GET bloom_customers by email (used for login + duplicate check) ──────────
app.get("/api/customer/find", async (req, res) => {
  if (!su() || !process.env.SUPA_KEY) return res.status(503).json({ error: "Supabase not configured" });
  const email = (req.query.email || "").toLowerCase().trim();
  if (!email) return res.status(400).json({ error: "email required" });
  try {
    const r = await fetch(
      `${su()}/rest/v1/bloom_customers?email=eq.${encodeURIComponent(email)}&limit=1`,
      { headers: sh() }
    );
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: JSON.stringify(data) });
    return res.json(Array.isArray(data) ? data : []);
  } catch(e) { return res.status(500).json({ error: e.message }); }
});

// ─── PATCH bloom_customers ────────────────────────────────────────────────────
// Three-layer fallback: PostgREST → pg-meta raw SQL → direct pg (DATABASE_URL)
app.patch("/api/customer/:id", async (req, res) => {
  if (!su() || !process.env.SUPA_KEY) return res.status(503).json({ error: "Supabase not configured" });
  const id   = req.params.id;
  const body = req.body;

  // ── Layer 1: PostgREST (fast, works once schema cache is fresh) ───────────
  try {
    const r = await fetch(
      `${su()}/rest/v1/bloom_customers?id=eq.${encodeURIComponent(id)}`,
      { method:"PATCH", headers:{...sh(),"Prefer":"return=minimal"}, body:JSON.stringify(body) }
    );
    if (r.ok) return res.json({ ok: true });
    const errText = await r.text();
    if (!errText.includes("schema cache") && !errText.includes("PGRST204")) {
      return res.status(r.status).json({ error: errText });
    }
    console.warn("⚠️  PostgREST schema cache stale (customers) — trying raw SQL fallback");
  } catch(e) { return res.status(500).json({ error: e.message }); }

  // ── Layer 2: pg-meta /query raw SQL (bypasses PostgREST schema cache) ─────
  const sql = buildUpdateSQL("bloom_customers", id, body);
  if (sql) {
    try {
      const pgMetaHdr = { "Authorization": `Bearer ${process.env.SUPA_KEY}`, "Content-Type": "application/json" };
      const qRes = await fetch(`${su()}/pg-meta/v1/query`, {
        method:"POST", headers: pgMetaHdr,
        body: JSON.stringify({ query: sql + "; NOTIFY pgrst, 'reload schema'" }),
      });
      if (qRes.ok) {
        console.log("✅ pg-meta raw SQL PATCH (customers) succeeded");
        return res.json({ ok: true });
      }
      console.warn("⚠️  pg-meta /query failed:", qRes.status, await qRes.text());
    } catch(e) { console.warn("⚠️  pg-meta /query error:", e.message); }
  }

  // ── Layer 3: Direct pg connection via DATABASE_URL ────────────────────────
  if (process.env.DATABASE_URL) {
    try {
      const { Pool } = require("pg");
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      const keys = Object.keys(body);
      const vals = Object.values(body);
      const setClause = keys.map((k, i) => `"${k}" = $${i + 1}`).join(", ");
      await pool.query(`UPDATE bloom_customers SET ${setClause} WHERE id = $${keys.length + 1}`, [...vals, id]);
      await pool.query("SELECT pg_notify('pgrst', 'reload schema')");
      pool.end();
      console.log("✅ DATABASE_URL direct PATCH (customers) succeeded");
      return res.json({ ok: true });
    } catch(e) { console.error("⚠️  DATABASE_URL PATCH (customers) failed:", e.message); }
  }

  return res.status(500).json({ error: "All save methods exhausted — schema cache is stale and no direct DB access." });
});

// ─── GET bloom_customers (admin fetch via service key) ────────────────────────
app.get("/api/customers", async (req, res) => {
  if (!su() || !process.env.SUPA_KEY) return res.status(503).json({ error: "Supabase not configured" });
  try {
    const r = await fetch(`${su()}/rest/v1/bloom_customers?order=created_at.asc`, { headers: sh() });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: JSON.stringify(data) });
    return res.json(Array.isArray(data) ? data : []);
  } catch(e) { return res.status(500).json({ error: e.message }); }
});

// ─── DELETE bloom_customers ───────────────────────────────────────────────────
// Deletes orders first (FK constraint), then the customer row
app.delete("/api/customer/:id", async (req, res) => {
  if (!su() || !process.env.SUPA_KEY) return res.status(503).json({ error: "Supabase not configured" });
  const id = req.params.id;
  try {
    // Step 1: delete all orders belonging to this customer
    await fetch(
      `${su()}/rest/v1/bloom_orders?customer_id=eq.${encodeURIComponent(id)}`,
      { method:"DELETE", headers: sh() }
    );
    // Step 2: delete the customer row
    const r = await fetch(
      `${su()}/rest/v1/bloom_customers?id=eq.${encodeURIComponent(id)}`,
      { method:"DELETE", headers: sh() }
    );
    if (!r.ok) { const d = await r.text(); return res.status(r.status).json({ error: d }); }
    return res.json({ ok: true });
  } catch(e) { return res.status(500).json({ error: e.message }); }
});

// ─── POST bloom_customers ─────────────────────────────────────────────────────
app.post("/api/customer", async (req, res) => {
  if (!su() || !process.env.SUPA_KEY) return res.status(503).json({ error: "Supabase not configured on server" });
  try {
    const r = await fetch(
      `${su()}/rest/v1/bloom_customers`,
      { method:"POST", headers:{...sh(),"Prefer":"return=representation"}, body:JSON.stringify(req.body) }
    );
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: JSON.stringify(data) });
    return res.json(Array.isArray(data) ? (data[0] || req.body) : data);
  } catch(e) { return res.status(500).json({ error: e.message }); }
});

// ─── GET bloom_payouts (admin fetch via service key) ─────────────────────────
app.get("/api/payouts", async (req, res) => {
  if (!su() || !process.env.SUPA_KEY) return res.status(503).json({ error: "Supabase not configured" });
  try {
    const r = await fetch(
      `${su()}/rest/v1/bloom_payouts?order=paid_at.desc`,
      { headers: sh() }
    );
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: JSON.stringify(data) });
    return res.json(Array.isArray(data) ? data : []);
  } catch(e) { return res.status(500).json({ error: e.message }); }
});

// ─── POST bloom_payouts (mark as paid) ───────────────────────────────────────
app.post("/api/payout", async (req, res) => {
  if (!su() || !process.env.SUPA_KEY) return res.status(503).json({ error: "Supabase not configured" });
  try {
    const r = await fetch(
      `${su()}/rest/v1/bloom_payouts`,
      { method:"POST", headers:{...sh(),"Prefer":"return=representation"}, body:JSON.stringify(req.body) }
    );
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: JSON.stringify(data) });
    return res.json(Array.isArray(data) ? (data[0] || req.body) : data);
  } catch(e) { return res.status(500).json({ error: e.message }); }
});

// ─── DELETE bloom_payouts ─────────────────────────────────────────────────────
app.delete("/api/payout/:id", async (req, res) => {
  if (!su() || !process.env.SUPA_KEY) return res.status(503).json({ error: "Supabase not configured" });
  try {
    const r = await fetch(
      `${su()}/rest/v1/bloom_payouts?id=eq.${encodeURIComponent(req.params.id)}`,
      { method:"DELETE", headers:sh() }
    );
    if (!r.ok) { const d = await r.text(); return res.status(r.status).json({ error: d }); }
    return res.json({ ok: true });
  } catch(e) { return res.status(500).json({ error: e.message }); }
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🌸 Bloom Backend running on port ${PORT}`);
  console.log(`   Razorpay:  ${RZP_KEY_ID ? "✅ configured" : "❌ RZP_KEY_ID missing"}`);
  console.log(`   Resend:    ${RESEND_KEY    ? "✅ RESEND_KEY set"    : "❌ missing — emails will not send"}`);
  console.log(`   Fast2SMS:  ${FAST2SMS_KEY  ? "✅ FAST2SMS_KEY set"  : "⚠️  missing — SMS will not send"}`);
  console.log(`   Supabase:  ${process.env.SUPA_URL ? "✅ SUPA_URL set" : "❌ missing"}`);
  console.log(`   Frontend:  ${FRONTEND_URL}`);
});
