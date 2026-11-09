// TraderStack market data from Zerodha Kite Connect.
//
// Reads the day's access token (saved by kite-callback) from the private
// kite_session table and serves candles, quotes and symbol search. It never
// places orders and never returns the access token. Every request must carry
// the private ACCESS_KEY in the x-access-key header.
//
// Secrets: KITE_API_KEY, ACCESS_KEY, ALLOWED_ORIGINS (optional).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

const KITE = "https://api.kite.trade";

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
// Session token (cached briefly; re-read when Zerodha rejects it)

let cached: { token: string; userId: string; createdAt: string; at: number } | null = null;

async function loadSession(force = false) {
  if (!force && cached && Date.now() - cached.at < 60_000) return cached;
  const res = await fetch(`${env("SUPABASE_URL")}/rest/v1/kite_session?id=eq.1&select=user_id,access_token,created_at`, {
    headers: { apikey: env("SUPABASE_SERVICE_ROLE_KEY"), Authorization: `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}` },
  });
  const rows = await res.json().catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : null;
  cached = row ? { token: row.access_token, userId: row.user_id, createdAt: row.created_at, at: Date.now() } : null;
  return cached;
}

const needsLogin = (msg: string) => new HttpError(401, msg, { needsLogin: true });

async function kite(path: string, retried = false): Promise<any> {
  const s = await loadSession(retried);
  if (!s) throw needsLogin("Log in with Zerodha to load NSE/BSE data.");
  const res = await fetch(`${KITE}${path}`, {
    headers: { "X-Kite-Version": "3", Authorization: `token ${env("KITE_API_KEY")}:${s.token}` },
  });
  const json = await res.json().catch(() => ({}));
  if (json.error_type === "TokenException" || res.status === 403) {
    if (!retried) return kite(path, true); // maybe a fresh login just happened
    throw needsLogin("Your Zerodha session has expired. Log in again (sessions end every morning).");
  }
  if (json.status !== "success") throw new HttpError(502, `Zerodha: ${json.message || res.status}`);
  return json.data;
}

// ---------------------------------------------------------------------------
// Instruments (cached per exchange for 12 hours)

type Instrument = { token: string; symbol: string; name: string; exchange: string; type: string; segment: string };
const instruments = new Map<string, { at: number; list: Instrument[]; bySymbol: Map<string, Instrument> }>();

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function getInstruments(exchange: string) {
  const hit = instruments.get(exchange);
  if (hit && Date.now() - hit.at < 12 * 3600_000) return hit;
  const s = await loadSession();
  if (!s) throw needsLogin("Log in with Zerodha to load NSE/BSE data.");
  const res = await fetch(`${KITE}/instruments/${exchange}`, {
    headers: { "X-Kite-Version": "3", Authorization: `token ${env("KITE_API_KEY")}:${s.token}` },
  });
  if (res.status === 403) throw needsLogin("Your Zerodha session has expired. Log in again.");
  if (!res.ok) throw new HttpError(502, `Zerodha instruments ${res.status}`);
  const lines = (await res.text()).split("\n");
  const head = parseCsvLine(lines[0]);
  const col = (n: string) => head.indexOf(n);
  const [iTok, iSym, iName, iType, iSeg, iEx] = ["instrument_token", "tradingsymbol", "name", "instrument_type", "segment", "exchange"].map(col);
  const list: Instrument[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const r = parseCsvLine(lines[i]);
    const seg = r[iSeg];
    if (seg !== exchange && seg !== "INDICES") continue; // equities and indices only
    if (seg === exchange && r[iType] !== "EQ") continue;
    list.push({ token: r[iTok], symbol: r[iSym], name: r[iName], exchange: r[iEx], type: seg === "INDICES" ? "INDEX" : "EQ", segment: seg });
  }
  const entry = { at: Date.now(), list, bySymbol: new Map(list.map((x) => [x.symbol, x])) };
  instruments.set(exchange, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Actions

const EXCHANGES = new Set(["NSE", "BSE"]);
const INTERVALS: Record<string, number> = {
  minute: 60, "3minute": 100, "5minute": 100, "10minute": 100,
  "15minute": 200, "30minute": 200, "60minute": 400, day: 2000,
};
const DATE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const istToMs = (s: string) => Date.parse(s.replace(" ", "T") + "+05:30");
const msToIst = (ms: number) => new Date(ms + 19800_000).toISOString().slice(0, 19).replace("T", " ");
const SYMBOL_RE = /^[A-Za-z0-9&\-_. ]{1,40}$/;

async function resolveToken(exchange: string, symbol: string) {
  const { bySymbol } = await getInstruments(exchange);
  const inst = bySymbol.get(symbol);
  if (!inst) throw new HttpError(404, `${exchange}:${symbol} not found`);
  return inst.token;
}

async function candles(p: any) {
  if (!EXCHANGES.has(p.exchange)) throw new HttpError(400, "Bad exchange");
  if (!(p.interval in INTERVALS)) throw new HttpError(400, "Bad interval");
  if (!SYMBOL_RE.test(String(p.symbol ?? ""))) throw new HttpError(400, "Bad symbol");
  if (!DATE_RE.test(p.from) || !DATE_RE.test(p.to)) throw new HttpError(400, "Dates must be yyyy-MM-dd HH:mm:ss");
  const token = await resolveToken(p.exchange, p.symbol);

  const chunk = INTERVALS[p.interval] * 86400_000;
  const end = istToMs(p.to);
  let start = istToMs(p.from);
  const rows: any[] = [];
  while (start < end) {
    const stop = Math.min(end, start + chunk);
    const q = new URLSearchParams({ from: msToIst(start), to: msToIst(stop) });
    const data = await kite(`/instruments/historical/${token}/${p.interval}?${q}`);
    rows.push(...(data?.candles ?? []));
    start = stop + 1000;
  }
  const seen = new Set<number>();
  return rows
    .map((r) => ({
      time: Math.floor(Date.parse(String(r[0]).replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) / 1000),
      open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] || 0,
    }))
    .filter((b) => Number.isFinite(b.time) && !seen.has(b.time) && seen.add(b.time))
    .sort((a, b) => a.time - b.time);
}

async function quote(p: any) {
  const keys = (Array.isArray(p.instruments) ? p.instruments : [])
    .map(String)
    .filter((k: string) => /^(NSE|BSE):/.test(k) && SYMBOL_RE.test(k.slice(4)));
  if (!keys.length || keys.length > 200) throw new HttpError(400, "Send between 1 and 200 instruments");
  const q = keys.map((k: string) => `i=${encodeURIComponent(k)}`).join("&");
  const data = await kite(`/quote/ohlc?${q}`);
  return Object.entries(data ?? {}).map(([key, v]: [string, any]) => ({
    key,
    ltp: +v.last_price,
    close: +v.ohlc?.close,
    changePct: v.ohlc?.close ? ((+v.last_price - +v.ohlc.close) / +v.ohlc.close) * 100 : 0,
  }));
}

async function search(p: any) {
  if (!EXCHANGES.has(p.exchange)) throw new HttpError(400, "Bad exchange");
  const q = String(p.query ?? "").trim().toUpperCase().slice(0, 40);
  if (q.length < 2) return [];
  const { list } = await getInstruments(p.exchange);
  const score = (x: Instrument) =>
    (x.symbol === q ? 0 : x.symbol.startsWith(q) ? 1 : x.name.toUpperCase().startsWith(q) ? 2 : 3) + (x.type === "INDEX" ? -0.5 : 0);
  return list
    .filter((x) => x.symbol.toUpperCase().includes(q) || x.name.toUpperCase().includes(q))
    .sort((a, b) => score(a) - score(b) || a.symbol.length - b.symbol.length)
    .slice(0, 30)
    .map((x) => ({ exchange: x.exchange, symbol: x.symbol, name: x.name || x.symbol, type: x.type }));
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
    const key = req.headers.get("x-access-key") ?? "";
    if (!key || !timingSafeEqual(key, env("ACCESS_KEY"))) throw new HttpError(401, "Wrong or missing access key");

    const body = await req.json().catch(() => ({}));
    switch (body.action) {
      case "status": {
        const s = await loadSession(true);
        if (!s) return reply(200, { data: { connected: false } });
        try {
          const profile = await kite("/user/profile");
          return reply(200, { data: { connected: true, userId: profile.user_id, userName: profile.user_name, since: s.createdAt } });
        } catch (e) {
          if (e instanceof HttpError && e.extra.needsLogin) return reply(200, { data: { connected: false, expired: true } });
          throw e;
        }
      }
      case "candles": return reply(200, { data: await candles(body) });
      case "quote": return reply(200, { data: await quote(body) });
      case "search": return reply(200, { data: await search(body) });
      default: throw new HttpError(400, "Unknown action");
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500) console.error(e);
    return reply(status, { error: e instanceof Error ? e.message : String(e), ...(e instanceof HttpError ? e.extra : {}) });
  }
});
