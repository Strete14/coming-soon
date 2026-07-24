// api/stripe-webhook.js

import crypto from "crypto";

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SUPABASE_URL = "https://kgtheattqsyelayqjueh.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const config = {
  api: {
    bodyParser: false,
  },
};

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function verifyStripeSignature(payload, signature, secret) {
  const parts = signature.split(",").reduce((acc, part) => {
    const [key, value] = part.split("=");
    acc[key] = value;
    return acc;
  }, {});

  const timestamp = parts["t"];
  const receivedSig = parts["v1"];

  if (!timestamp || !receivedSig) return false;

  const tolerance = 300;
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > tolerance) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(signedPayload)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(receivedSig, "hex"),
      Buffer.from(expectedSig, "hex")
    );
  } catch (e) {
    return false;
  }
}

async function updateSupabaseSubscription(userId, plan) {
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error("SUPABASE_SERVICE_ROLE_KEY is missing");
    return false;
  }

  const r = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${userId}`, {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({ subscription: plan }),
  });

  const text = await r.text();
  console.log("Supabase update status:", r.status, "response:", text);
  return r.ok;
}

async function hasExistingPayment(stripeSessionId) {
  if (!SUPABASE_SERVICE_ROLE_KEY) return false;

  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/subscriptions?stripe_session_id=eq.${stripeSessionId}&select=id`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );

  if (!r.ok) return false;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
}

async function logPaymentToSupabase(userId, userEmail, plan, stripeSessionId, amountEur) {
  if (!SUPABASE_SERVICE_ROLE_KEY) return;

  const r = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      user_id: userId,
      user_email: userEmail,
      plan: plan,
      stripe_session_id: stripeSessionId,
      amount_eur: amountEur,
    }),
  });

  if (!r.ok) {
    console.error("Failed to log payment:", await r.text());
  }
}

async function triggerOblioInvoice(userId, userEmail, userName, plan, amountTotal, currency) {
  try {
    const oblioRes = await fetch("https://physioroutine.com/api/oblio-invoice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, userEmail, userName, plan, amountTotal, currency }),
    });
    if (!oblioRes.ok) {
      console.error("Oblio invoice failed:", await oblioRes.text());
    }
  } catch (e) {
    console.error("Oblio trigger error:", e);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawBody = await getRawBody(req);
  const payload = rawBody.toString("utf8");
  const signature = req.headers["stripe-signature"];

  if (!signature || !STRIPE_WEBHOOK_SECRET) {
    return res.status(400).json({ error: "Missing signature or webhook secret" });
  }

  let valid;
  try {
    valid = verifyStripeSignature(payload, signature, STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).json({ error: "Signature verification failed" });
  }

  if (!valid) {
    return res.status(400).json({ error: "Invalid signature" });
  }

  let event;
  try {
    event = JSON.parse(payload);
  } catch (e) {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    if (session.payment_status !== "paid") {
      return res.status(200).json({ received: true });
    }

    const userId = session.metadata?.userId;
    const userEmail = session.metadata?.userEmail || session.customer_email;
    const userName = session.metadata?.userName || "";
    const plan = session.metadata?.plan;
    const amountTotal = session.amount_total;
    const currency = session.currency;
    const amountEur = amountTotal ? amountTotal / 100 : null;

    if (!userId || !plan) {
      console.error("Missing metadata - userId:", userId, "plan:", plan);
      return res.status(200).json({ received: true });
    }

    // Check if this session was already processed (idempotency)
    const alreadyProcessed = await hasExistingPayment(session.id);

    // Always update subscription (idempotent - safe to run multiple times)
    await updateSupabaseSubscription(userId, plan);

    if (!alreadyProcessed) {
      // Only log payment and send invoice once
      await logPaymentToSupabase(userId, userEmail, plan, session.id, amountEur);
      await triggerOblioInvoice(userId, userEmail, userName, plan, amountTotal, currency);
      console.log("Payment processed for user:", userId, "plan:", plan);
    } else {
      console.log("Duplicate webhook - skipping invoice for session:", session.id);
    }
  }

  return res.status(200).json({ received: true });
}
