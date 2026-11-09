// Upstox login for TraderStack.
//
// GET with no parameters -> sends you to Upstox's login page.
// GET ?code=...          -> Upstox sends you back here after login; we swap the
//                           code for an access token, store it in the private
//                           upstox_session table and return you to the site.
//
// Only the Upstox account named in UPSTOX_USER_ID can connect. Register this
// function's URL (…/functions/v1/upstox-callback) as the app's Redirect URL.
//
// Secrets: UPSTOX_API_KEY, UPSTOX_API_SECRET, UPSTOX_USER_ID, SITE_URL (optional,
// default https://traderstack.top). SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
// provided by Supabase.

const env = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`Server is missing the ${k} secret.`);
  return v;
};

const redirectUri = () => `${env("SUPABASE_URL")}/functions/v1/upstox-callback`;

function backToSite(params: Record<string, string>) {
  const url = new URL(Deno.env.get("SITE_URL") ?? "https://traderstack.top");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return Response.redirect(url.toString(), 302);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");

  try {
    if (!code) {
      if (url.searchParams.get("error")) {
        return backToSite({ upstox: "error", reason: url.searchParams.get("error_description") || "Upstox login was cancelled" });
      }
      const login = new URL("https://api.upstox.com/v2/login/authorization/dialog");
      login.searchParams.set("response_type", "code");
      login.searchParams.set("client_id", env("UPSTOX_API_KEY"));
      login.searchParams.set("redirect_uri", redirectUri());
      return Response.redirect(login.toString(), 302);
    }

    const res = await fetch("https://api.upstox.com/v2/login/authorization/token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env("UPSTOX_API_KEY"),
        client_secret: env("UPSTOX_API_SECRET"),
        redirect_uri: redirectUri(),
        grant_type: "authorization_code",
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      const reason = json.errors?.[0]?.message || json.message || `Token exchange failed (${res.status})`;
      return backToSite({ upstox: "error", reason });
    }
    if (String(json.user_id).toUpperCase() !== env("UPSTOX_USER_ID").toUpperCase()) {
      return backToSite({ upstox: "error", reason: "That Upstox account is not allowed on this site" });
    }

    const key = env("SUPABASE_SERVICE_ROLE_KEY");
    const db = await fetch(`${env("SUPABASE_URL")}/rest/v1/upstox_session`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({ id: 1, user_id: json.user_id, access_token: json.access_token, created_at: new Date().toISOString() }),
    });
    if (!db.ok) {
      console.error("Saving session failed", db.status, await db.text());
      return backToSite({ upstox: "error", reason: "Could not save the Upstox session" });
    }
    return backToSite({ upstox: "connected" });
  } catch (e) {
    console.error(e);
    return backToSite({ upstox: "error", reason: e instanceof Error ? e.message : String(e) });
  }
});
