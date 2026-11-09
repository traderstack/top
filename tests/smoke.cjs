// Browser smoke test: loads the site with mocked market data and checks the main
// flows still work. Run with a static server on :8765, e.g.
//   python3 -m http.server 8765 & node tests/smoke.cjs
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:8765/';
let failed = false;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed = true; };

function bars(n, sec, base) {
  const t0 = Math.floor(Date.now() / 1000 / sec) * sec - (n - 1) * sec;
  let p = base;
  return Array.from({ length: n }, (_, i) => {
    const c = base * (1 + 0.1 * Math.sin(i / 25));
    const b = { time: t0 + i * sec, open: p, high: Math.max(p, c) * 1.002, low: Math.min(p, c) * 0.998, close: c, volume: 100 };
    p = c;
    return b;
  });
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.setDefaultTimeout(8000);

  // Some browsers report a locale Intl rejects (e.g. "en_US"); the charts must cope.
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'language', { get: () => 'en_US' }));

  // Supabase Auth: one test account; any other password is rejected.
  await page.route(/^https:\/\/[a-z]+\.supabase\.co\/auth\/v1\/token/, (r) => {
    const b = r.request().postDataJSON();
    if (b.password !== 'right-password') return r.fulfill({ status: 400, json: { error_description: 'Invalid login credentials' } });
    r.fulfill({ json: { access_token: 'eyJtest', refresh_token: 'r', expires_in: 3600, user: { id: 'u1', email: b.email } } });
  });
  await page.route(/^https:\/\/[a-z]+\.supabase\.co\/rest\/v1\/app_users/, (r) => r.fulfill({ json: [{ role: 'admin' }] }));
  await page.route(/^https:\/\/data-api\.binance\.vision\/api\/v3\/klines/, (r) => {
    const u = new URL(r.request().url());
    if (u.searchParams.get('endTime')) return r.fulfill({ json: [] });
    r.fulfill({ json: bars(+u.searchParams.get('limit'), 3600, 70000).map((b) => [b.time * 1000, b.open, b.high, b.low, b.close, b.volume].map(String)) });
  });
  await page.route(/^https:\/\/api\.frankfurter\.app/, (r) => r.fulfill({ json: { rates: {} } }));
  await page.route(/^https:\/\/[a-z]+\.supabase\.co\/functions\/v1\/upstox$/, (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204 });
    const b = r.request().postDataJSON();
    if (b.action === 'status') return r.fulfill({ json: { data: { connected: true, analytics: true } } });
    if (b.action === 'quote') return r.fulfill({ json: { data: b.keys.map((key) => ({ key, ltp: key.startsWith('NSE_FO') ? 120 : 2900, changePct: 1.2 })) } });
    if (b.action === 'option_expiries') return r.fulfill({ json: { data: { expiries: ['2026-11-11', '2026-11-18'], lotSize: 75 } } });
    if (b.action === 'option_chain') {
      const side = (k, ltp, oi) => ({ key: `NSE_FO|${k}`, ltp, close: ltp * 0.9, volume: 1000, oi, prevOi: oi * 0.8, iv: 14.2, delta: 0.5 });
      const rows = Array.from({ length: 41 }, (_, i) => { const strike = 23000 + i * 50; return { strike, ce: side(1000 + i, Math.max(5, 24010 - strike), 5000 + i * 100), pe: side(2000 + i, Math.max(5, strike - 24010), 9000 - i * 100) }; });
      return r.fulfill({ json: { data: { spot: 24010, rows } } });
    }
    return r.fulfill({ json: { data: bars(300, 86400, 2900) } });
  });
  await page.routeWebSocket(/.*/, () => {});

  await page.goto(BASE);

  // Sign-in screen comes first; the app stays hidden.
  await page.waitForSelector('.login-card');
  check(!(await page.isVisible('.topbar')), 'app is hidden until signed in');
  await page.fill('.login-card input[type=email]', 'admin@example.com');
  await page.fill('.login-card input[type=password]', 'wrong');
  await page.click('.login-card button[type=submit]');
  await page.waitForSelector('.login-msg:not([hidden])');
  check((await page.textContent('.login-msg')).includes('Wrong email or password'), 'wrong password shows an error');
  await page.fill('.login-card input[type=password]', 'right-password');
  await page.click('.login-card button[type=submit]');
  await page.waitForSelector('.wl-row');
  check(await page.isVisible('.topbar'), 'signing in opens the app');
  check((await page.locator('.wl-row').count()) > 3, 'watchlist renders');

  // Search: click a result with mouse movement between press and release.
  await page.click('#symbolBtn');
  await page.click('.chips button:has-text("NSE")');
  await page.keyboard.type('RELIANCE');
  await page.waitForSelector('.search-results .r');
  const row = page.locator('.search-results .r').first();
  const box = await row.boundingBox();
  await page.mouse.move(box.x + 30, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 50, box.y + 14, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  check(!(await page.evaluate(() => document.querySelector('#searchDialog').open)), 'search closes after clicking a result');
  check((await page.textContent('#symbolName')).includes('RELIANCE'), 'clicked result opens its chart');
  check((await page.textContent('#chartStatus')).trim() === '', 'NSE chart loads without an error card');

  // Backtest runs on the loaded chart.
  await page.click('text=Run backtest');
  check((await page.locator('.stat').count()) >= 8, 'backtest shows stats');

  // Option chain: renders around the ATM strike, B buys one lot, LTP opens the chart.
  await page.click('[data-tab=options]');
  await page.waitForSelector('table.oc tbody tr');
  check((await page.locator('table.oc tbody tr').count()) === 21, 'option chain shows ±10 strikes');
  check((await page.textContent('table.oc tr.atm td.strike')).includes('24,000'), 'ATM strike is highlighted');
  check((await page.textContent('.oc-summary')).includes('Max pain'), 'PCR and max pain shown');
  const atm = page.locator('table.oc tr.atm');
  await atm.hover();
  await atm.locator('td.ltp').first().locator('button.b').click();
  await page.waitForTimeout(400);
  const pos = JSON.parse(await page.evaluate(() => localStorage.getItem('ts.paper'))).positions;
  const opt = Object.values(pos).find((p) => p.sym.option);
  check(opt && opt.qty === 75, 'B buys one lot (75) of the call');
  await atm.locator('td.ltp a').first().click();
  await page.waitForTimeout(800);
  check((await page.textContent('#symbolName')).includes('24000 CE'), 'clicking an option price opens its chart');

  // Drawing tools: trend line (2 clicks), horizontal line, select + Delete, measure.
  const drawCount = () => page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('ts.draw.') && k !== 'ts.draw.flags').reduce((n, [, v]) => n + JSON.parse(v).length, 0));
  const before = await drawCount();
  const cb = await page.locator('#chartMain').boundingBox();
  await page.click('.draw-btn[data-tool=trend]');
  await page.mouse.click(cb.x + 200, cb.y + 150);
  await page.mouse.click(cb.x + 400, cb.y + 250);
  await page.waitForTimeout(150);
  check((await drawCount()) === before + 1, 'trend line saved after two clicks');
  check(await page.evaluate(() => document.querySelector('.draw-btn[data-tool=cursor]').classList.contains('on')), 'tool returns to cursor after drawing');
  await page.click('.draw-btn[data-tool=hline]');
  await page.mouse.click(cb.x + 300, cb.y + 100);
  await page.waitForTimeout(150);
  check((await drawCount()) === before + 2, 'horizontal line saved');
  check((await page.locator('.draw-layer .drawing').count()) >= 2, 'drawings render on the chart');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(150);
  check((await drawCount()) === before + 1, 'Delete removes the selected drawing');
  await page.click('.draw-btn[data-tool=channel]');
  await page.mouse.click(cb.x + 150, cb.y + 300);
  await page.mouse.click(cb.x + 450, cb.y + 200);
  await page.mouse.click(cb.x + 300, cb.y + 320);
  await page.waitForTimeout(150);
  check((await drawCount()) === before + 2, 'parallel channel saved after three clicks');
  check((await page.locator('.draw-layer polygon').count()) >= 1, 'channel band renders');
  await page.click('.draw-btn[data-tool=long]');
  await page.mouse.click(cb.x + 350, cb.y + 200);
  await page.waitForTimeout(150);
  check((await drawCount()) === before + 3, 'long position placed with one click');
  check(/R:R 2\.00/.test(await page.textContent('.draw-layer')), 'long position shows 2:1 reward/risk by default');
  await page.click('.draw-btn[data-tool=short]');
  await page.mouse.click(cb.x + 250, cb.y + 150);
  await page.waitForTimeout(150);
  check(/Short /.test(await page.textContent('.draw-layer')), 'short position renders');
  await page.click('.draw-btn[data-tool=measure]');
  await page.mouse.click(cb.x + 150, cb.y + 300);
  await page.mouse.click(cb.x + 350, cb.y + 120);
  await page.waitForTimeout(150);
  check(/bars/.test(await page.textContent('.draw-layer .measure') || ''), 'measure shows change and bar count');
  await page.keyboard.press('Escape');

  // The session survives a reload.
  await page.reload();
  await page.waitForSelector('.wl-row');
  check(!(await page.isVisible('.login-card')), 'still signed in after reload');

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
