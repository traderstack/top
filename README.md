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
| NSE / BSE data | `js/data/angel.js` + `supabase/functions/angel` | Angel One SmartAPI through a private Supabase Edge Function. |
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

## Connecting Angel One (NSE / BSE)

The backend runs as the `angel` Edge Function in the Supabase project
`traderstack` (`jdhqomlblzzrctuntvik`, Mumbai). It logs in to Angel One, serves
candles, quotes and symbol search, and gives the browser a market-data-only feed
token for live ticks. It never places orders and never returns your session token.

1. In the Angel One SmartAPI portal (smartapi.angelbroking.com), create an app and
   copy its **API key**. Enable **TOTP** for your account and keep the base32 secret
   shown under the QR code.
2. In Supabase → project `traderstack` → Edge Functions → Secrets, add:
   - `ANGEL_API_KEY` — the SmartAPI app key
   - `ANGEL_CLIENT_CODE` — your Angel One client ID
   - `ANGEL_MPIN` — your 4-digit MPIN
   - `ANGEL_TOTP_SECRET` — the TOTP base32 secret
   - `ACCESS_KEY` — a long random password you make up
3. On the site, open **Settings**, paste the same `ACCESS_KEY` and press
   **Test connection**.

Only browsers holding the access key can load NSE/BSE data, so exchange data from
your account isn't shown to the public. Crypto and forex are open to everyone.

## Running locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.
