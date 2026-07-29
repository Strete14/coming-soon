// api/redeem-promo.js
// Redeems a promo code: atomically claims it (so two people can't use the
// same code in a race), then grants Standard-tier access the same way a
// real Stripe purchase does -- by writing subscription: "standard" onto
// the user's row, exactly like updateSupabaseSubscription() does in
// stripe-webhook.js. This does NOT touch the `subscriptions` table (that
// one specifically logs real Stripe payments with a stripe_session_id and
// amount, neither of which exist for a free promo redemption).

const SUPABASE_URL = "https://kgtheattqsyelayqjueh.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function updateUserSubscription(userId, userEmail, userName) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/users?on_conflict=id`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify({
      id: userId,
      email: userEmail || "",
      name: userName || "",
      subscription: "standard",
    }),
  });

  const text = await r.text();
  console.log("Supabase subscription upsert (promo) status:", r.status, "response:", text);
  return r.ok;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "Server is not configured" });
  }

  const { code, userId, userEmail, userName } = req.body;

  if (!code || !userId || !userEmail) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const cleanCode = String(code).trim().toUpperCase();

  try {
    // Atomic claim: this UPDATE only affects a row if it exists AND is
    // still redeemed=false at the moment Postgres processes it. If two
    // requests race for the same code, only one can win -- the second
    // request's WHERE clause (redeemed=eq.false) will match zero rows
    // once the first has committed, the same way Postgres normally
    // serializes concurrent UPDATE...WHERE statements on one row.
    const claimRes = await fetch(
      `${SUPABASE_URL}/rest/v1/promo_codes?code=eq.${encodeURIComponent(cleanCode)}&redeemed=eq.false`,
      {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          redeemed: true,
          redeemed_by_user_id: userId,
          redeemed_by_email: userEmail,
          redeemed_at: new Date().toISOString(),
        }),
      }
    );

    if (!claimRes.ok) {
      console.error("Promo claim request failed:", claimRes.status);
      return res.status(500).json({ error: "Server error, please try again" });
    }

    const claimedRows = await claimRes.json();

    if (!Array.isArray(claimedRows) || claimedRows.length === 0) {
      return res.status(400).json({ error: "Invalid or already-used promo code" });
    }

    const subOk = await updateUserSubscription(userId, userEmail, userName);
    if (!subOk) {
      // The code is already claimed at this point (can't be un-claimed
      // automatically without risking a double-claim race on retry), so
      // this is logged clearly for manual follow-up rather than failing
      // the request the user is currently waiting on.
      console.error("Promo code claimed but subscription update failed for user:", userId, "code:", cleanCode);
    }

    return res.status(200).json({ success: true, plan: "standard" });
  } catch (e) {
    console.error("redeem-promo error:", e);
    return res.status(500).json({ error: "Server error" });
  }
}
