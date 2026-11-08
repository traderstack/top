// TraderStack backend for Angel One SmartAPI market data.
//
// Holds your Angel One credentials as Supabase secrets, logs in with a TOTP generated
// here, and returns market data to the TraderStack site. It never places orders and
// never returns your JWT. Every request must carry the private ACCESS_KEY.
//
// Secrets (set with `supabase secrets set` or in the dashboard):
//   ANGEL_API_KEY      SmartAPI app key
//   ANGEL_CLIENT_CODE  Angel One client ID
//   ANGEL_MPIN         4-digit MPIN used to log in
//   ANGEL_TOTP_SECRET  base32 secret shown when you enabled TOTP for SmartAPI
//   ACCESS_KEY         long random string; the site sends it as x-access-key
//   ALLOWED_ORIGINS    optional, comma-separated (default: https://traderstack.top)

const BASE = "https://apiconnect.angelone.in";

const env = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) throw new HttpError(500, `Server is missing the ${k} secret.`);
  return v;
};

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ---------------------------------------------------------------------------
// CORS

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
// TOTP (RFC 6238, SHA-1, 30 s, 6 digits)

function base32Decode(input: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const c of clean) {
    value = (value << 5) | alphabet.indexOf(c);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return new Uint8Array(out);
}

async function totp(secret: string, now = Date.now()): Promise<string> {
  const counter = Math.floor(now / 1000 / 30);
  const msg = new ArrayBuffer(8);
  const view = new DataView(msg);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const off = mac[mac.length - 1] & 0x0f;
  const code = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(code % 1_000_000).padStart(6, "0");
}

// ---------------------------------------------------------------------------
// Angel session (cached per function instance)

type Session = { jwt: string; feedToken: string; at: number };
let session: Session | null = null;
let loggingIn: Promise<Session> | null = null;

function angelHeaders(jwt?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "X-UserType": "USER",
    "X-SourceID": "WEB",
    "X-ClientLocalIP": "127.0.0.1",
    "X-ClientPublicIP": "127.0.0.1",
    "X-MACAddress": "00:00:00:00:00:00",
    "X-PrivateKey": env("ANGEL_API_KEY"),
    ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
  };
}

async function login(): Promise<Session> {
  const res = await fetch(`${BASE}/rest/auth/angelbroking/user/v1/loginByPassword`, {
    method: "POST",
    headers: angelHeaders(),
    body: JSON.stringify({
      clientcode: env("ANGEL_CLIENT_CODE"),
      password: env("ANGEL_MPIN"),
      totp: await totp(env("ANGEL_TOTP_SECRET")),
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!json?.status || !json?.data?.jwtToken) {
    throw new HttpError(502, `Angel One login failed: ${json?.message || res.status} ${json?.errorcode ?? ""}`.trim());
  }
  return { jwt: json.data.jwtToken, feedToken: json.data.feedToken, at: Date.now() };
}

async function getSession(force = false): Promise<Session> {
  // Angel sessions expire daily; refresh every 6 hours to be safe.
  if (!force && session && Date.now() - session.at < 6 * 3600_000) return session;
  loggingIn ??= login().finally(() => { loggingIn = null; });
  session = await loggingIn;
  return session;
}

async function angel(path: string, body: unknown, retried = false): Promise<any> {
  const s = await getSession();
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: angelHeaders(s.jwt), body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  const expired = res.status === 401 || res.status === 403 || ["AG8001", "AG8002", "AG8003", "AB1010"].includes(json?.errorcode);
  if (expired && !retried) {
    await getSession(true);
    return angel(path, body, true);
  }
  if (!json?.status) throw new HttpError(502, `Angel One: ${json?.message || res.status} ${json?.errorcode ?? ""}`.trim());
  return json.data;
}

// ---------------------------------------------------------------------------
// Actions

const EXCHANGES = new Set(["NSE", "BSE", "NFO", "BFO", "CDS", "MCX"]);
const INTERVALS = new Set(["ONE_MINUTE", "THREE_MINUTE", "FIVE_MINUTE", "TEN_MINUTE", "FIFTEEN_MINUTE", "THIRTY_MINUTE", "ONE_HOUR", "ONE_DAY"]);
const MAX_DAYS: Record<string, number> = {
  ONE_MINUTE: 30, THREE_MINUTE: 60, FIVE_MINUTE: 100, TEN_MINUTE: 100,
  FIFTEEN_MINUTE: 200, THIRTY_MINUTE: 200, ONE_HOUR: 400, ONE_DAY: 2000,
};
const DATE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

const istToMs = (s: string) => Date.parse(s.replace(" ", "T") + ":00+05:30");
const msToIst = (ms: number) => new Date(ms + 19800_000).toISOString().slice(0, 16).replace("T", " ");

async function candles(p: any) {
  if (!EXCHANGES.has(p.exchange)) throw new HttpError(400, "Bad exchange");
  if (!INTERVALS.has(p.interval)) throw new HttpError(400, "Bad interval");
  if (!/^\d{1,12}$/.test(String(p.token))) throw new HttpError(400, "Bad token");
  if (!DATE_RE.test(p.from) || !DATE_RE.test(p.to)) throw new HttpError(400, "Dates must be yyyy-MM-dd HH:mm");

  // Split long ranges into chunks within Angel's per-request limit.
  const chunk = MAX_DAYS[p.interval] * 86400_000;
  const end = istToMs(p.to);
  let start = istToMs(p.from);
  const rows: any[] = [];
  while (start < end) {
    const stop = Math.min(end, start + chunk);
    const data = await angel("/rest/secure/angelbroking/historical/v1/getCandleData", {
      exchange: p.exchange, symboltoken: String(p.token), interval: p.interval,
      fromdate: msToIst(start), todate: msToIst(stop),
    });
    if (Array.isArray(data)) rows.push(...data);
    start = stop + 60_000;
  }
  const seen = new Set<number>();
  return rows
    .map((r) => ({ time: Math.floor(Date.parse(r[0]) / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] || 0 }))
    .filter((b) => Number.isFinite(b.time) && !seen.has(b.time) && seen.add(b.time))
    .sort((a, b) => a.time - b.time);
}

async function quote(p: any) {
  const exchangeTokens: Record<string, string[]> = {};
  let n = 0;
  for (const [ex, tokens] of Object.entries(p.exchangeTokens ?? {})) {
    if (!EXCHANGES.has(ex) || !Array.isArray(tokens)) continue;
    exchangeTokens[ex] = tokens.map(String).filter((t) => /^\d{1,12}$/.test(t));
    n += exchangeTokens[ex].length;
  }
  if (!n || n > 50) throw new HttpError(400, "Send between 1 and 50 tokens");
  const data = await angel("/rest/secure/angelbroking/market/v1/quote/", { mode: "OHLC", exchangeTokens });
  return (data?.fetched ?? []).map((q: any) => ({
    exchange: q.exchange,
    token: String(q.symbolToken),
    symbol: q.tradingSymbol,
    ltp: +q.ltp,
    open: +q.open, high: +q.high, low: +q.low, close: +q.close,
    changePct: q.close ? ((+q.ltp - +q.close) / +q.close) * 100 : 0,
  }));
}

async function search(p: any) {
  if (!EXCHANGES.has(p.exchange)) throw new HttpError(400, "Bad exchange");
  const q = String(p.query ?? "").trim().slice(0, 40);
  if (q.length < 2) return [];
  const data = await angel("/rest/secure/angelbroking/order/v1/searchScrip", { exchange: p.exchange, searchscrip: q });
  return (data ?? []).map((r: any) => ({ exchange: r.exchange, tradingsymbol: r.tradingsymbol, symboltoken: String(r.symboltoken) }));
}

// ---------------------------------------------------------------------------

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
    const key = req.headers.get("x-access-key") ?? "";
    if (!key || !timingSafeEqual(key, env("ACCESS_KEY"))) throw new HttpError(401, "Wrong or missing access key");

    const body = await req.json().catch(() => ({}));
    switch (body.action) {
      case "ping": {
        await getSession();
        return reply(200, { data: { ok: true, clientCode: env("ANGEL_CLIENT_CODE") } });
      }
      case "session": {
        // Market-data-only credentials for the browser's live WebSocket. No JWT.
        const s = await getSession();
        return reply(200, { data: { clientCode: env("ANGEL_CLIENT_CODE"), feedToken: s.feedToken, apiKey: env("ANGEL_API_KEY") } });
      }
      case "candles": return reply(200, { data: await candles(body) });
      case "quote": return reply(200, { data: await quote(body) });
      case "search": return reply(200, { data: await search(body) });
      default: throw new HttpError(400, "Unknown action");
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500) console.error(e);
    return reply(status, { error: e instanceof Error ? e.message : String(e) });
  }
});
