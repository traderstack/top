// Sign-in with Supabase Auth (email + password), without the supabase-js library.
//
// The session lives in localStorage and refreshes itself before it expires. Being
// signed in is not enough to use the app: the account also needs a row in the
// `app_users` table (role 'admin' or 'user'), which only an admin can add.
import { store } from './util.js';

export const SUPABASE_URL = 'https://jdhqomlblzzrctuntvik.supabase.co';
export const PUBLISHABLE_KEY = 'sb_publishable_gFFbgzD8Ps_0ALgUpCl9Cw_LmMie46y';

let session = store.get('session', null); // {access_token, refresh_token, expires_at, user}
let refreshing = null;

async function authFetch(path, body, token) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: PUBLISHABLE_KEY,
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json.msg || json.error_description || json.message || `Sign-in service error ${res.status}`;
    throw new Error(msg === 'Invalid login credentials' ? 'Wrong email or password.' : msg);
  }
  return json;
}

function save(json) {
  session = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: json.expires_at ?? Math.floor(Date.now() / 1000) + (json.expires_in || 3600),
    user: { id: json.user?.id, email: json.user?.email },
  };
  store.set('session', session);
}

export async function signIn(email, password) {
  save(await authFetch('token?grant_type=password', { email: email.trim(), password }));
  return session;
}

export async function signOut() {
  const token = session?.access_token;
  session = null;
  store.del('session');
  store.del('role');
  if (token) await authFetch('logout', {}, token).catch(() => {});
}

export async function changePassword(newPassword) {
  const token = await getAccessToken();
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    method: 'PUT',
    headers: { apikey: PUBLISHABLE_KEY, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ password: newPassword }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.msg || json.message || `Could not change password (${res.status})`);
}

/** A valid access token, refreshed when it is within a minute of expiring. Null if signed out. */
export async function getAccessToken() {
  if (!session) return null;
  if (session.expires_at - 60 > Date.now() / 1000) return session.access_token;
  refreshing ??= authFetch('token?grant_type=refresh_token', { refresh_token: session.refresh_token })
    .then(save)
    .catch(() => { session = null; store.del('session'); })
    .finally(() => { refreshing = null; });
  await refreshing;
  return session?.access_token ?? null;
}

export const currentUser = () => session?.user ?? null;

/** The account's role from app_users ('admin' | 'user'), or null if it has no access. */
export async function fetchRole() {
  const token = await getAccessToken();
  if (!token) return null;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/app_users?select=role&user_id=eq.${session.user.id}`, {
    headers: { apikey: PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) { await signOut(); return null; }
  const rows = await res.json().catch(() => []);
  const role = Array.isArray(rows) && rows[0]?.role ? rows[0].role : null;
  store.set('role', role);
  return role;
}

export const cachedRole = () => store.get('role', null);
