// TraderStack market data from the Upstox API.
//
// Reads the day's access token (saved by upstox-callback) from the private
// upstox_session table and serves candles and quotes. It never places orders and
// never returns the access token. Callers must be signed in with an account listed
// in app_users (Authorization: Bearer <session token>), or send the ACCESS_KEY in
// the x-access-key header.
//
// Secrets: ACCESS_KEY, UPSTOX_ANALYTICS_TOKEN (recommended: read-only, valid ~1 year,
// no daily login), ALLOWED_ORIGINS (optional).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

const API = "https://api.upstox.com";

class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

const env = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) throw new HttpError(500, `Server is missing the ${k} secret.`);
  return v;
};

function corsHeaders(req: Request): Record<string, string> {
  const allowed = (Deno.env.get("ALLOWED_ORIGINS") ?? "https://traderstack.top,https://www.traderstack.top")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get("origin") ?? "";
  const ok = allowed.includes("*") || allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowed[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-access-key, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

// ---------------------------------------------------------------------------
// Session token (cached briefly; re-read when Upstox rejects it)

let cached: { token: string; userId: string; createdAt: string; at: number } | null = null;

/** A read-only Upstox Analytics token (valid ~1 year) skips the daily login entirely. */
const analyticsToken = () => Deno.env.get("UPSTOX_ANALYTICS_TOKEN") || "";

async function loadSession(force = false) {
  if (analyticsToken()) return { token: analyticsToken(), userId: "analytics", createdAt: "", at: Date.now() };
  if (!force && cached && Date.now() - cached.at < 60_000) return cached;
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const res = await fetch(`${env("SUPABASE_URL")}/rest/v1/upstox_session?id=eq.1&select=user_id,access_token,created_at`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const rows = await res.json().catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : null;
  cached = row ? { token: row.access_token, userId: row.user_id, createdAt: row.created_at, at: Date.now() } : null;
  return cached;
}

const needsLogin = (msg: string) => new HttpError(401, msg, { needsLogin: true });

/** GET an Upstox endpoint. `optionalAuth` lets public endpoints work before today's login. */
async function upstox(path: string, { optionalAuth = false, retried = false } = {}): Promise<any> {
  const s = await loadSession(retried);
  if (!s && !optionalAuth) throw needsLogin("Log in with Upstox to load live NSE/BSE prices.");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (s) headers.Authorization = `Bearer ${s.token}`;
  const res = await fetch(`${API}${path}`, { headers });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) {
    if (analyticsToken()) throw new HttpError(502, "Upstox rejected the Analytics token. Generate a new one and update the UPSTOX_ANALYTICS_TOKEN secret.");
    if (!retried) return upstox(path, { optionalAuth, retried: true }); // maybe a fresh login just happened
    throw needsLogin("Your Upstox session has expired. Log in again (sessions end every night).");
  }
  if (json.status !== "success") {
    const msg = json.errors?.[0]?.message || json.message || res.status;
    throw new HttpError(502, `Upstox: ${msg}`);
  }
  return json.data;
}

// ---------------------------------------------------------------------------
// Actions

const KEY_RE = /^(NSE|BSE)_(EQ|INDEX|FO)\|[A-Za-z0-9 &.\-]{1,40}$/;
const UNDERLYING_RE = /^(NSE|BSE)_(EQ|INDEX)\|[A-Za-z0-9 &.\-]{1,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UNITS = new Set(["minutes", "hours", "days", "weeks", "months"]);

/** Largest range Upstox serves in one historical request, in days. */
function chunkDays(unit: string, interval: number) {
  if (unit === "minutes") return interval <= 15 ? 28 : 88;
  if (unit === "hours") return 88;
  if (unit === "days") return 3600;
  return 36500;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const todayIst = () => day(Date.now() + 19800_000);

async function candles(p: any) {
  const key = String(p.key ?? "");
  const unit = String(p.unit ?? "");
  const interval = Number(p.interval);
  if (!KEY_RE.test(key)) throw new HttpError(400, "Bad instrument key");
  if (!UNITS.has(unit) || !Number.isInteger(interval) || interval < 1 || interval > 300) throw new HttpError(400, "Bad interval");
  if (!DATE_RE.test(p.from) || !DATE_RE.test(p.to)) throw new HttpError(400, "Dates must be yyyy-MM-dd");

  const k = encodeURIComponent(key);
  const step = chunkDays(unit, interval) * 86400_000;
  const end = Date.parse(p.to + "T00:00:00Z");
  let start = Date.parse(p.from + "T00:00:00Z");
  const rows: any[] = [];
  const requests: Promise<any>[] = [];
  while (start <= end) {
    const stop = Math.min(end, start + step - 86400_000);
    requests.push(upstox(`/v3/historical-candle/${k}/${unit}/${interval}/${day(stop)}/${day(start)}`, { optionalAuth: true }));
    start = stop + 86400_000;
  }
  for (const data of await Promise.all(requests)) rows.push(...(data?.candles ?? []));

  // Today's bars come from the intraday endpoint (needs a session; skip quietly without one).
  if ((unit === "minutes" || unit === "hours" || unit === "days") && p.to >= todayIst()) {
    try {
      const data = await upstox(`/v3/historical-candle/intraday/${k}/${unit}/${interval}`, { optionalAuth: true });
      rows.push(...(data?.candles ?? []));
    } catch (e) {
      if (!(e instanceof HttpError && e.extra.needsLogin)) console.warn("intraday candles:", e);
    }
  }

  const seen = new Set<number>();
  return rows
    .map((r) => ({ time: Math.floor(Date.parse(r[0]) / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] || 0 }))
    .filter((b) => Number.isFinite(b.time) && !seen.has(b.time) && seen.add(b.time))
    .sort((a, b) => a.time - b.time);
}

async function quote(p: any) {
  const keys = (Array.isArray(p.keys) ? p.keys : []).map(String).filter((k: string) => KEY_RE.test(k));
  if (!keys.length || keys.length > 400) throw new HttpError(400, "Send between 1 and 400 instrument keys");
  const data = await upstox(`/v2/market-quote/quotes?instrument_key=${keys.map(encodeURIComponent).join(",")}`);
  return Object.values(data ?? {}).map((v: any) => {
    const ltp = +v.last_price;
    const chg = +v.net_change || 0;
    const prev = ltp - chg;
    return { key: v.instrument_token, ltp, changePct: prev ? (chg / prev) * 100 : 0 };
  });
}

// ---------------------------------------------------------------------------
// Options

/** Expiry dates and lot size for an underlying's option contracts. */
async function optionExpiries(p: any) {
  const key = String(p.key ?? "");
  if (!UNDERLYING_RE.test(key)) throw new HttpError(400, "Bad underlying key");
  const data = await upstox(`/v2/option/contract?instrument_key=${encodeURIComponent(key)}`);
  const list = Array.isArray(data) ? data : [];
  const expiries = [...new Set(list.map((c: any) => String(c.expiry)))].filter((d) => DATE_RE.test(d)).sort();
  return { expiries, lotSize: Number(list[0]?.lot_size) || 1, exchange: list[0]?.exchange ?? null };
}

const side = (o: any) => o && ({
  key: o.instrument_key,
  ltp: +o.market_data?.ltp || 0,
  close: +o.market_data?.close_price || 0,
  volume: +o.market_data?.volume || 0,
  oi: +o.market_data?.oi || 0,
  prevOi: +o.market_data?.prev_oi || 0,
  bid: +o.market_data?.bid_price || 0,
  ask: +o.market_data?.ask_price || 0,
  iv: +o.option_greeks?.iv || 0,
  delta: +o.option_greeks?.delta || 0,
  theta: +o.option_greeks?.theta || 0,
  gamma: +o.option_greeks?.gamma || 0,
  vega: +o.option_greeks?.vega || 0,
});

/** Full chain for one expiry: strikes with call (ce) and put (pe) sides. */
async function optionChain(p: any) {
  const key = String(p.key ?? "");
  if (!UNDERLYING_RE.test(key)) throw new HttpError(400, "Bad underlying key");
  if (!DATE_RE.test(String(p.expiry ?? ""))) throw new HttpError(400, "Expiry must be yyyy-MM-dd");
  const data = await upstox(`/v2/option/chain?instrument_key=${encodeURIComponent(key)}&expiry_date=${p.expiry}`);
  const rows = (Array.isArray(data) ? data : []).map((r: any) => ({
    strike: +r.strike_price,
    pcr: +r.pcr || 0,
    ce: side(r.call_options),
    pe: side(r.put_options),
  })).sort((a: any, b: any) => a.strike - b.strike);
  return { spot: +(data?.[0]?.underlying_spot_price) || 0, rows };
}

// ---------------------------------------------------------------------------
// Who may call: a signed-in account listed in app_users, or the ACCESS_KEY.

const approved = new Map<string, number>(); // user JWT -> cache expiry (ms)

async function isApprovedUser(jwt: string) {
  const hit = approved.get(jwt);
  if (hit && hit > Date.now()) return true;
  const base = env("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const userRes = await fetch(`${base}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${jwt}` } });
  if (!userRes.ok) return false;
  const user = await userRes.json().catch(() => null);
  if (!user?.id) return false;
  const service = env("SUPABASE_SERVICE_ROLE_KEY");
  const rows = await fetch(`${base}/rest/v1/app_users?select=role&user_id=eq.${encodeURIComponent(user.id)}`, {
    headers: { apikey: service, Authorization: `Bearer ${service}` },
  }).then((r) => r.json()).catch(() => []);
  if (!Array.isArray(rows) || !rows.length) return false;
  if (approved.size > 500) approved.clear();
  approved.set(jwt, Date.now() + 5 * 60_000);
  return true;
}

async function authorize(req: Request) {
  const key = req.headers.get("x-access-key") ?? "";
  const accessKey = Deno.env.get("ACCESS_KEY") ?? "";
  if (key && accessKey && timingSafeEqual(key, accessKey)) return;
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (bearer.startsWith("eyJ") && await isApprovedUser(bearer)) return;
  throw new HttpError(401, "Sign in with an approved account to load NSE/BSE data.");
}

function timingSafeEqual(a: string, b: string) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    if (req.method !== "POST") throw new HttpError(405, "Use POST");
    await authorize(req);

    const body = await req.json().catch(() => ({}));
    switch (body.action) {
      case "status": {
        if (analyticsToken()) {
          // Analytics tokens are read-only, so check with a market-data call instead of the profile.
          await upstox(`/v2/market-quote/ltp?instrument_key=${encodeURIComponent("NSE_INDEX|Nifty 50")}`);
          return reply(200, { data: { connected: true, userName: "Upstox Analytics token", analytics: true } });
        }
        const s = await loadSession(true);
        if (!s) return reply(200, { data: { connected: false } });
        try {
          const profile = await upstox("/v2/user/profile");
          return reply(200, { data: { connected: true, userId: profile.user_id, userName: profile.user_name, since: s.createdAt } });
        } catch (e) {
          if (e instanceof HttpError && e.extra.needsLogin) return reply(200, { data: { connected: false, expired: true } });
          throw e;
        }
      }
      case "candles": return reply(200, { data: await candles(body) });
      case "quote": return reply(200, { data: await quote(body) });
      case "option_expiries": return reply(200, { data: await optionExpiries(body) });
      case "option_chain": return reply(200, { data: await optionChain(body) });
      default: throw new HttpError(400, "Unknown action");
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500) console.error(e);
    return reply(status, { error: e instanceof Error ? e.message : String(e), ...(e instanceof HttpError ? e.extra : {}) });
  }
});
