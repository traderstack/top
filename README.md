# TraderStack

Live charts for NSE, BSE, crypto and forex, with a strategy backtester and a
paper-trading terminal. Served from GitHub Pages at https://traderstack.top.

## What's here

| Part | Where | Notes |
|---|---|---|
| App shell | `index.html`, `css/app.css`, `js/main.js` | Plain ES modules, no build step. Every push to `main` deploys. |
| Charts | `js/chart.js` | TradingView Lightweight Charts v4.2.3 (Apache-2.0), vendored in `js/vendor/`. |
| Crypto data | `js/data/binance.js` | Binance public market-data API and WebSocket. No key. |
| Forex data | `js/data/forex.js` | ECB daily reference rates via frankfurter.app. Daily and weekly only. |
| NSE / BSE data | `js/data/upstox.js` + `supabase/functions/upstox*` | Upstox API through private Supabase Edge Functions. Live prices poll every 3 s. |
| NSE / BSE symbols | `data/instruments/` | Built weekly from Upstox's public instrument files by `.github/workflows/instruments.yml`. |
| Indicators | `js/ta.js` | SMA, EMA, RSI, MACD, Bollinger, ATR, Supertrend, VWAP, Donchian helpers. |
| Backtester | `js/backtest/` | Bar-by-bar engine; signals fill at the next bar's open. |
| Paper trading | `js/paper/broker.js` | ₹10,00,000 INR and $100,000 USD virtual accounts, market/limit/stop orders, strategy bots. Saved in the browser. |

## Writing a strategy

Strategies are JavaScript. The code receives `bars`, `open`, `high`, `low`, `close`,
`volume`, `params` and `ta`, and returns a function of the bar index:

```js
// @param fast 9 2 200 1 Fast EMA
// @param slow 21 3 400 1 Slow EMA
const fast = ta.ema(close, params.fast);
const slow = ta.ema(close, params.slow);
return (i) => {
  if (ta.crossover(fast, slow, i)) return 'long';
  if (ta.crossunder(fast, slow, i)) return 'flat';
  return null; // keep the current position
};
```

`// @param name default min max step Label` lines become inputs in the tester.

## Connecting Upstox (NSE / BSE)

Two Edge Functions run in the Supabase project `traderstack`
(`jdhqomlblzzrctuntvik`, Mumbai):

- `upstox-callback` handles the daily Upstox login and stores the access token in
  the private `upstox_session` table (RLS on, no policies).
- `upstox` serves candles and quotes to browsers that send your `ACCESS_KEY`. It
  never places orders and never returns the access token.

Setup with an **Analytics token** (recommended: read-only, valid about a year,
no daily login):

1. At account.upstox.com/developer/apps → **Analytics** → **Generate Token**.
2. In Supabase → project `traderstack` → Edge Functions → Secrets, add
   `UPSTOX_ANALYTICS_TOKEN` (the token) and `ACCESS_KEY` (a long random password
   you make up).
3. On the site, open **Settings**, paste the same `ACCESS_KEY` and press
   **Check connection**. Generate a new token when Upstox expires it.

Alternative setup with a daily login (only if you don't use an Analytics token):

1. Create an app at account.upstox.com/developer/apps with this **Redirect URL**:
   `https://jdhqomlblzzrctuntvik.supabase.co/functions/v1/upstox-callback`.
   Copy its **API key** and **API secret**.
2. In Supabase → project `traderstack` → Edge Functions → Secrets, add:
   - `UPSTOX_API_KEY` — the app's API key
   - `UPSTOX_API_SECRET` — the app's API secret
   - `UPSTOX_USER_ID` — your Upstox client ID (only this account can log in)
   - `ACCESS_KEY` — a long random password you make up
3. On the site, open **Settings**, paste the same `ACCESS_KEY`, press
   **Check connection**, then **Log in with Upstox**.

Upstox sessions end every night (around 3:30 AM IST), so log in once each trading
day. Historical charts may still load without a session; live prices need one.

Only browsers holding the access key can load NSE/BSE data, so exchange data from
your account isn't shown to the public. Crypto and forex are open to everyone.

In GitHub → Actions, run **Update NSE/BSE symbol list** once to build the search
list; after that it refreshes every Monday.

## Making changes

- After editing anything in `js/` or `css/`, run `node scripts/stamp.mjs`. It updates
  the version stamps in `index.html` so browsers load the new files immediately
  instead of serving a cached copy for up to 10 minutes.
- `.github/workflows/test.yml` runs on every pull request and push to `main`: unit
  tests (`tests/core.test.mjs`), the stamp check, and a browser smoke test
  (`tests/smoke.cjs`) with mocked market data.

## Running locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.
