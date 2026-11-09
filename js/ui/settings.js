// Settings dialog: account, NSE/BSE connection and paper-trading options.
import { $, h, toast, fill } from '../util.js';
import { getConfig, setConfig, call, LOGIN_URL } from '../data/upstox.js';
import { currentUser, cachedRole, changePassword, signOut } from '../auth.js';
import { broker } from '../paper/broker.js';

export function initSettings(app) {
  const dlg = $('#settingsDialog');

  function render() {
    const cfg = getConfig();
    const user = currentUser();
    const access = h('input', { value: cfg.accessKey, type: 'password', placeholder: 'Optional: only needed without signing in', autocomplete: 'off' });
    const url = h('input', { value: cfg.url, spellcheck: 'false' });
    const anon = h('input', { value: cfg.anonKey, spellcheck: 'false' });
    const status = h('div', { class: 'hint' });
    const loginBtn = h('a', { class: 'btn', href: LOGIN_URL, hidden: true }, 'Log in with Upstox');
    const commission = h('input', { type: 'number', min: 0, step: 0.01, value: broker.state.commissionPct });

    const newPass = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'New password (8+ characters)' });
    const passMsg = h('div', { class: 'hint' });

    const save = () => {
      setConfig({ url: url.value.trim(), anonKey: anon.value.trim(), accessKey: access.value.trim() });
      broker.setCommission(commission.value);
      app.emit('broker-config');
    };

    const check = async () => {
      save();
      status.textContent = 'Checking…';
      status.className = 'hint';
      try {
        const s = await call('status');
        if (s.connected) {
          status.textContent = `Connected to Upstox${s.analytics ? ' (Analytics token)' : ` as ${s.userName || s.userId}`}. Live prices are on.`;
          status.className = 'hint up';
          loginBtn.hidden = true;
        } else {
          status.textContent = s.expired
            ? 'Today\'s Upstox session has ended. Log in again (Upstox sessions end every night around 3:30 AM).'
            : 'Log in with Upstox to turn on live prices.';
          status.className = 'hint';
          loginBtn.hidden = false;
        }
      } catch (e) {
        status.textContent = `Connection failed: ${e.message}`;
        status.className = 'hint down';
      }
    };

    const updatePassword = async () => {
      if (newPass.value.length < 8) { passMsg.textContent = 'Use at least 8 characters.'; passMsg.className = 'hint down'; return; }
      passMsg.textContent = 'Saving…';
      passMsg.className = 'hint';
      try {
        await changePassword(newPass.value);
        newPass.value = '';
        passMsg.textContent = 'Password changed.';
        passMsg.className = 'hint up';
      } catch (e) {
        passMsg.textContent = e.message;
        passMsg.className = 'hint down';
      }
    };

    fill(dlg,
      h('div', { class: 'd-head' }, h('h2', {}, 'Settings'), h('button', { class: 'btn ghost icon', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
      h('div', { class: 'd-body' },
        h('div', { class: 'section-title' }, 'Account'),
        h('div', { class: 'kv' }, h('span', {}, 'Signed in as'), h('b', {}, `${user?.email ?? '—'}${cachedRole() === 'admin' ? ' · admin' : ''}`)),
        h('div', { class: 'st-row' }, newPass, h('button', { class: 'btn', onclick: updatePassword }, 'Change password')),
        passMsg,
        h('div', { class: 'st-row' }, h('button', {
          class: 'btn',
          onclick: async () => { await signOut(); location.reload(); },
        }, 'Sign out')),

        h('div', { class: 'section-title' }, 'NSE / BSE data — Upstox'),
        h('p', { class: 'muted' }, 'NSE/BSE prices come from Upstox through your private Supabase backend. Only approved, signed-in accounts can load them.'),
        h('div', { class: 'st-row' }, h('button', { class: 'btn', onclick: check }, 'Check connection'), loginBtn),
        status,
        h('details', {},
          h('summary', { class: 'hint' }, 'Advanced'),
          h('div', { class: 'd-body', style: 'padding:8px 0 0' },
            h('label', { class: 'field' }, 'Access key', access),
            h('label', { class: 'field' }, 'Backend function URL', url),
            h('label', { class: 'field' }, 'Supabase publishable key', anon))),

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
    check();
  }

  const open = () => { render(); dlg.showModal(); };
  $('#settingsBtn').addEventListener('click', open);
  app.on('open-settings', open);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}
