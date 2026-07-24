// api/create-checkout.js
// Creates a Stripe Checkout Session for Standard or Premium plan purchase.
// Called from the frontend when user clicks Pay.
// Returns a checkout URL that redirects the user to Stripe's hosted payment page.

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PRICE_STANDARD = process.env.STRIPE_PRICE_STANDARD;
const STRIPE_PRICE_PREMIUM = process.env.STRIPE_PRICE_PREMIUM;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: "Stripe is not configured" });
  }

  const { plan, userId, userEmail, userName } = req.body;

  if (!plan || !userId || !userEmail) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (plan !== "standard" && plan !== "premium") {
    return res.status(400).json({ error: "Invalid plan" });
  }

  const priceId = plan === "premium" ? STRIPE_PRICE_PREMIUM : STRIPE_PRICE_STANDARD;

  if (!priceId) {
    return res.status(500).json({ error: "Price not configured for this plan" });
  }

  try {
    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        "payment_method_types[0]": "card",
        "line_items[0][price]": priceId,
        "line_items[0][quantity]": "1",
        mode: "payment",
        customer_email: userEmail,
        "metadata[userId]": userId,
        "metadata[userEmail]": userEmail,
        "metadata[userName]": userName || "",
        "metadata[plan]": plan,
        success_url: "https://physioroutine.com?payment=success&plan=" + plan,
        cancel_url: "https://physioroutine.com?payment=cancelled",
        "payment_intent_data[metadata][userId]": userId,
        "payment_intent_data[metadata][plan]": plan,
      }).toString(),
    });

    const session = await response.json();

    if (!response.ok) {
      console.error("Stripe error:", session);
      return res.status(500).json({ error: session.error?.message || "Failed to create checkout session" });
    }

    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error("create-checkout error:", e);
    return res.status(500).json({ error: "Server error" });
  }
}
