// /api/delete-account.js
//
// Deletes a user's account entirely: their Supabase Auth identity plus all
// rows they own across the users/plans/checkins/reviews tables.
//
// SECURITY: this endpoint must run server-side only. It uses the Supabase
// SERVICE ROLE key, which can bypass all row-level security and must never
// be exposed to the browser. Set it as a server-only environment variable
// in your hosting platform (e.g. Vercel Project Settings -> Environment
// Variables), named SUPABASE_SERVICE_ROLE_KEY. Do NOT prefix it with VITE_
// or anything else that would cause a bundler to inline it into client code.
//
// The request must include the user's own Supabase access token (the same
// token already stored in their session after login). This endpoint verifies
// that token against Supabase Auth first, and only ever deletes the account
// that the token actually belongs to -- a user can never delete someone
// else's account by passing a different id.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || "https://kgtheattqsyelayqjueh.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!SERVICE_ROLE_KEY) {
    console.error("SUPABASE_SERVICE_ROLE_KEY is not set");
    res.status(500).json({ error: "Server is not configured for account deletion" });
    return;
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: "Missing access token" });
    return;
  }

  try {
    // 1. Verify the token and find out which user it actually belongs to.
    //    We never trust a user id sent in the request body -- only the
    //    identity proven by this token.
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${token}`
      }
    });

    if (!userRes.ok) {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }

    const userData = await userRes.json();
    const userId = userData?.id;

    if (!userId) {
      res.status(401).json({ error: "Could not resolve user from token" });
      return;
    }

    // 2. Delete the user's rows from every table that stores their data.
    //    Done with the service role key so it works regardless of RLS,
    //    and scoped strictly to this user's id.
    const tables = ["checkins", "reviews", "plans", "users"];
    const tableErrors = [];

    for (const table of tables) {
      const idColumn = table === "users" ? "id" : "user_id";
      const delRes = await fetch(
        `${SUPABASE_URL}/rest/v1/${table}?${idColumn}=eq.${userId}`,
        {
          method: "DELETE",
          headers: {
            apikey: SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
            Prefer: "return=minimal"
          }
        }
      );
      if (!delRes.ok) {
        tableErrors.push(table);
      }
    }

    // 3. Delete the actual Supabase Auth identity. This is the step that
    //    genuinely prevents the user from logging in again with these
    //    credentials -- everything above only removes their data.
    const authDelRes = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users/${userId}`,
      {
        method: "DELETE",
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`
        }
      }
    );

    if (!authDelRes.ok) {
      const errText = await authDelRes.text().catch(() => "");
      console.error("Auth user deletion failed:", errText);
      res.status(500).json({
        error: "Account data was removed but the login itself could not be deleted. Please contact support.",
        tableErrors
      });
      return;
    }

    res.status(200).json({ success: true, tableErrors: tableErrors.length ? tableErrors : undefined });
  } catch (e) {
    console.error("Account deletion error:", e);
    res.status(500).json({ error: "Something went wrong while deleting the account" });
  }
}
