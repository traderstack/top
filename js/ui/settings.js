// Settings dialog: Angel One backend connection and paper-trading options.
import { $, h, toast, fill } from '../util.js';
import { getConfig, setConfig } from '../data/angel.js';
import { broker } from '../paper/broker.js';

export function initSettings(app) {
  const dlg = $('#settingsDialog');

  function render() {
    const cfg = getConfig();
    const url = h('input', { value: cfg.url, placeholder: 'https://<project>.supabase.co/functions/v1/angel', spellcheck: 'false' });
    const anon = h('input', { value: cfg.anonKey, placeholder: 'Supabase publishable / anon key', spellcheck: 'false' });
    const access = h('input', { value: cfg.accessKey, type: 'password', placeholder: 'The ACCESS_KEY you set on the function', autocomplete: 'off' });
    const status = h('div', { class: 'hint' });
    const commission = h('input', { type: 'number', min: 0, step: 0.01, value: broker.state.commissionPct });

    const save = () => {
      setConfig({ url: url.value.trim(), anonKey: anon.value.trim(), accessKey: access.value.trim() });
      broker.setCommission(commission.value);
      app.emit('angel-config');
    };

    const test = async () => {
      save();
      status.textContent = 'Testing…';
      try {
        const res = await fetch(url.value.trim(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-access-key': access.value.trim(),
            ...(anon.value.trim() ? { apikey: anon.value.trim() } : {}),
          },
          body: JSON.stringify({ action: 'ping' }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
        status.textContent = `Connected to Angel One as ${json.data.clientCode}.`;
        status.className = 'hint up';
      } catch (e) {
        status.textContent = `Connection failed: ${e.message}`;
        status.className = 'hint down';
      }
    };

    fill(dlg, 
      h('div', { class: 'd-head' }, h('h2', {}, 'Settings'), h('button', { class: 'btn ghost icon', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
      h('div', { class: 'd-body' },
        h('div', { class: 'section-title' }, 'NSE / BSE data — Angel One SmartAPI'),
        h('p', { class: 'muted' }, 'Your Angel One login stays in your Supabase backend, never in this page. Only someone with the access key below can load NSE/BSE data through it, which keeps exchange data private to you.'),
        h('label', { class: 'field' }, 'Backend function URL', url),
        h('label', { class: 'field' }, 'Supabase anon key', anon),
        h('label', { class: 'field' }, 'Access key', access),
        h('div', { class: 'st-row' }, h('button', { class: 'btn', onclick: test }, 'Test connection'), status),
        h('p', { class: 'hint' }, 'These are saved in this browser only.'),

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
  }

  const open = () => { render(); dlg.showModal(); };
  $('#settingsBtn').addEventListener('click', open);
  app.on('open-settings', open);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}
