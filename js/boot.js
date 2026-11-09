// Entry point: show the sign-in screen until an approved account is signed in,
// then load the app.
import { h, fill } from './util.js';
import { signIn, signOut, getAccessToken, fetchRole, cachedRole, currentUser } from './auth.js';

const screen = document.getElementById('loginScreen');

async function startApp() {
  screen.hidden = true;
  document.body.classList.remove('locked');
  await import('./main.js');
}

function showLogin(message, kind = 'error') {
  document.body.classList.add('locked');
  screen.hidden = false;
  const email = h('input', { type: 'email', autocomplete: 'username', required: true, placeholder: 'you@example.com', value: currentUser()?.email || '' });
  const password = h('input', { type: 'password', autocomplete: 'current-password', required: true, placeholder: 'Password' });
  const msg = h('div', { class: `login-msg ${kind}`, role: 'alert', hidden: !message }, message || '');
  const button = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');

  const form = h('form', {
    class: 'login-card',
    onsubmit: async (e) => {
      e.preventDefault();
      button.disabled = true;
      button.textContent = 'Signing in…';
      msg.hidden = true;
      try {
        await signIn(email.value, password.value);
        const role = await fetchRole();
        if (!role) {
          await signOut();
          throw new Error('This account has not been given access yet. Ask the admin to add it.');
        }
        await startApp();
      } catch (err) {
        msg.textContent = err.message;
        msg.className = 'login-msg error';
        msg.hidden = false;
        button.disabled = false;
        button.textContent = 'Sign in';
        password.value = '';
        password.focus();
      }
    },
  },
  h('div', { class: 'login-brand' },
    h('span', { class: 'login-logo', 'aria-hidden': 'true' }),
    h('h1', {}, 'TraderStack')),
  h('p', { class: 'muted' }, 'Charts, backtesting and paper trading for NSE, BSE, crypto and forex.'),
  h('label', { class: 'field' }, 'Email', email),
  h('label', { class: 'field' }, 'Password', password),
  msg,
  button,
  h('p', { class: 'hint' }, 'Accounts are created by the admin.'));

  // Inline logo (set as markup so the browser creates real SVG elements).
  form.querySelector('.login-logo').innerHTML = '<svg viewBox="0 0 32 32" width="40" height="40"><rect width="32" height="32" rx="7" fill="var(--accent)"/><path d="M7 21l6-6 4 4 8-9" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  fill(screen, form);
  (email.value ? password : email).focus();
}

(async () => {
  try {
    if (await getAccessToken()) {
      // Use the cached role for an instant start; re-check in the background.
      if (cachedRole()) {
        startApp();
        fetchRole().then((role) => { if (!role) { signOut().then(() => location.reload()); } }).catch(() => {});
        return;
      }
      if (await fetchRole()) return startApp();
      await signOut();
      return showLogin('This account has not been given access yet. Ask the admin to add it.');
    }
  } catch (e) {
    console.error(e);
  }
  showLogin();
})();
