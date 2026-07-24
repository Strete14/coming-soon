// api/stripe-webhook.js
// Receives Stripe webhook events after a payment completes.
// Verifies the webhook signature, updates Supabase subscription,
// and triggers Oblio invoice generation.
//
// IMPORTANT: Add to vercel.json to disable body parsing for this route:
// { "functions": { "api/stripe-webhook.js": { "bodyParser": false } } }
// See the vercel.json file included in this deployment.

import crypto from "crypto";

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || "https://kgtheattqsyelayqjueh.supabase.co";
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

  // Reject webhooks older than 5 minutes
  const tolerance = 300;
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > tolerance) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(signedPayload)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(receivedSig, "hex"),
    Buffer.from(expectedSig, "hex")
  );
}

async function updateSupabaseSubscription(userId, plan) {
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error("SUPABASE_SERVICE_ROLE_KEY not set");
    return false;
  }

  const r = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${userId}`, {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ subscription: plan }),
  });

  return r.ok;
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

    // Only process paid sessions
    if (session.payment_status !== "paid") {
      return res.status(200).json({ received: true });
    }

    const userId = session.metadata?.userId;
    const userEmail = session.metadata?.userEmail || session.customer_email;
    const userName = session.metadata?.userName || "";
    const plan = session.metadata?.plan;
    const amountTotal = session.amount_total; // in cents
    const currency = session.currency;

    if (!userId || !plan) {
      console.error("Missing metadata:", session.metadata);
      return res.status(200).json({ received: true });
    }

    // Update Supabase
    const updated = await updateSupabaseSubscription(userId, plan);
    if (!updated) {
      console.error("Failed to update Supabase subscription for user:", userId);
    }

    // Trigger Oblio invoice (non-blocking - don't fail webhook if invoice fails)
    await triggerOblioInvoice(userId, userEmail, userName, plan, amountTotal, currency);
  }

  return res.status(200).json({ received: true });
}
