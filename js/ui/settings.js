// Settings dialog: Upstox connection and paper-trading options.
import { $, h, toast, fill } from '../util.js';
import { getConfig, setConfig, call, LOGIN_URL } from '../data/upstox.js';
import { broker } from '../paper/broker.js';

export function initSettings(app) {
  const dlg = $('#settingsDialog');

  function render() {
    const cfg = getConfig();
    const access = h('input', { value: cfg.accessKey, type: 'password', placeholder: 'The ACCESS_KEY you set in Supabase', autocomplete: 'off' });
    const url = h('input', { value: cfg.url, spellcheck: 'false' });
    const anon = h('input', { value: cfg.anonKey, spellcheck: 'false' });
    const status = h('div', { class: 'hint' });
    const loginBtn = h('a', { class: 'btn primary', href: LOGIN_URL, hidden: true }, 'Log in with Upstox');
    const commission = h('input', { type: 'number', min: 0, step: 0.01, value: broker.state.commissionPct });

    const save = () => {
      setConfig({ url: url.value.trim(), anonKey: anon.value.trim(), accessKey: access.value.trim() });
      broker.setCommission(commission.value);
      app.emit('broker-config');
    };

    const check = async () => {
      if (!access.value.trim()) { status.textContent = 'Enter your access key first.'; status.className = 'hint'; return; }
      save();
      status.textContent = 'Checking…';
      status.className = 'hint';
      try {
        const s = await call('status');
        if (s.connected) {
          status.textContent = `Connected to Upstox as ${s.userName || s.userId}. Live prices are on.`;
          status.className = 'hint up';
          loginBtn.hidden = true;
        } else {
          status.textContent = s.expired
            ? 'Backend OK, but today\'s Upstox session has ended. Log in again (Upstox sessions end every night around 3:30 AM).'
            : 'Backend OK. Log in with Upstox to turn on live prices.';
          status.className = 'hint';
          loginBtn.hidden = false;
        }
      } catch (e) {
        status.textContent = `Connection failed: ${e.message}`;
        status.className = 'hint down';
      }
    };

    fill(dlg,
      h('div', { class: 'd-head' }, h('h2', {}, 'Settings'), h('button', { class: 'btn ghost icon', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
      h('div', { class: 'd-body' },
        h('div', { class: 'section-title' }, 'NSE / BSE data — Upstox'),
        h('p', { class: 'muted' }, 'Your Upstox login and API secret stay in your Supabase backend, never in this page. Only someone with the access key below can load NSE/BSE data through it, which keeps exchange data private to you.'),
        h('label', { class: 'field' }, 'Access key', access),
        h('div', { class: 'st-row' }, h('button', { class: 'btn', onclick: check }, 'Check connection'), loginBtn),
        status,
        h('details', {},
          h('summary', { class: 'hint' }, 'Backend details'),
          h('div', { class: 'd-body', style: 'padding:8px 0 0' },
            h('label', { class: 'field' }, 'Backend function URL', url),
            h('label', { class: 'field' }, 'Supabase publishable key', anon))),
        h('p', { class: 'hint' }, 'Saved in this browser only.'),

        h('div', { class: 'section-title' }, 'Paper trading'),
        h('label', { class: 'field' }, 'Commission per fill (%)', commission),
        h('div', { class: 'st-row' },
          h('button', {
            class: 'btn',
            onclick: () => {
              if (!confirm('Reset paper accounts to ₹10,00,000 and $100,000, and delete all positions, orders, history and bots?')) return;
              broker.reset();
              toast('Paper accounts reset', 'ok');
            },
          }, 'Reset paper accounts')),
      ),
      h('div', { class: 'd-foot' },
        h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => { save(); dlg.close(); toast('Settings saved', 'ok'); app.load(); } }, 'Save')),
    );
    if (cfg.accessKey) check();
  }

  const open = () => { render(); dlg.showModal(); };
  $('#settingsBtn').addEventListener('click', open);
  app.on('open-settings', open);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}
