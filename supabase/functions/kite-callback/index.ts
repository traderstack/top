// Zerodha Kite Connect login for TraderStack.
//
// GET with no parameters  -> sends you to Zerodha's login page.
// GET ?request_token=...   -> Zerodha sends you back here after login; we swap the
//                             request token for an access token, store it in the
//                             private kite_session table and return you to the site.
//
// Only the Zerodha account named in KITE_USER_ID can connect.
//
// Secrets: KITE_API_KEY, KITE_API_SECRET, KITE_USER_ID, SITE_URL (optional,
// default https://traderstack.top). SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
// are provided by Supabase.

const env = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`Server is missing the ${k} secret.`);
  return v;
};

async function sha256Hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function backToSite(params: Record<string, string>) {
  const site = Deno.env.get("SITE_URL") ?? "https://traderstack.top";
  const url = new URL(site);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return Response.redirect(url.toString(), 302);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const requestToken = url.searchParams.get("request_token");

  try {
    if (!requestToken) {
      const login = `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(env("KITE_API_KEY"))}`;
      return Response.redirect(login, 302);
    }
    if (url.searchParams.get("status") !== "success") {
      return backToSite({ kite: "error", reason: "Zerodha login was cancelled" });
    }

    const apiKey = env("KITE_API_KEY");
    const checksum = await sha256Hex(apiKey + requestToken + env("KITE_API_SECRET"));
    const res = await fetch("https://api.kite.trade/session/token", {
      method: "POST",
      headers: { "X-Kite-Version": "3", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ api_key: apiKey, request_token: requestToken, checksum }),
    });
    const json = await res.json().catch(() => ({}));
    if (json.status !== "success" || !json.data?.access_token) {
      return backToSite({ kite: "error", reason: json.message || `Token exchange failed (${res.status})` });
    }
    if (json.data.user_id !== env("KITE_USER_ID")) {
      return backToSite({ kite: "error", reason: "That Zerodha account is not allowed on this site" });
    }

    const db = await fetch(`${env("SUPABASE_URL")}/rest/v1/kite_session`, {
      method: "POST",
      headers: {
        apikey: env("SUPABASE_SERVICE_ROLE_KEY"),
        Authorization: `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({ id: 1, user_id: json.data.user_id, access_token: json.data.access_token, created_at: new Date().toISOString() }),
    });
    if (!db.ok) {
      console.error("Saving session failed", db.status, await db.text());
      return backToSite({ kite: "error", reason: "Could not save the Zerodha session" });
    }
    return backToSite({ kite: "connected" });
  } catch (e) {
    console.error(e);
    return backToSite({ kite: "error", reason: e instanceof Error ? e.message : String(e) });
  }
});
