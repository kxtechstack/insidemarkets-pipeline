/**
 * modules/customSources/adminAccess.js
 *
 * Is the person calling a custom source address an admin?
 *
 * The admin console sends the Supabase login token of the person signed in:
 *   Authorization: Bearer <token>
 * The token says who they are (their email). They are an admin when that
 * email is in admin.admin_users. A login of the client dashboard is NOT
 * enough (the dashboard and the admin console share the same logins).
 *
 * Delete addresses: always need an admin login.
 * Run now: needs it only when .env says CS_REQUIRE_ADMIN_LOGIN=on, so the
 * admin console keeps working until it sends the token (then turn it on).
 */

const { createClient } = require('@supabase/supabase-js');

let supabase = null;
function realStore() {
  if (!supabase) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return {
    // the email behind a login token, or null
    async emailOfToken(token) {
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data || !data.user) return null;
      return data.user.email || null;
    },
    // is this email in admin.admin_users?
    async isAdminEmail(email) {
      const { data, error } = await supabase.schema('admin').from('admin_users')
        .select('email').ilike('email', email).limit(1);
      if (error) throw new Error(`admin lookup failed: ${error.message}`);
      return (data || []).length > 0;
    },
  };
}

let store = null;
/** Tests: a fake store ({ emailOfToken, isAdminEmail }); null = the real one. */
function useAdminStore(s) { store = s; }

let required = null;
/** Tests: true / false in place of .env CS_REQUIRE_ADMIN_LOGIN; null = .env. */
function useRunLoginSetting(on) { required = on; }
const runNeedsLogin = () => (required === null
  ? String(process.env.CS_REQUIRE_ADMIN_LOGIN || '').toLowerCase() === 'on'
  : required);

const bearer = (req) => String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '')
  .replace(/^Bearer\s+/i, '').trim();

/**
 * @returns { ok: true, email } or { ok: false, status, error }
 *   401 = no login or the login is not valid, 403 = signed in but not an admin
 */
async function checkAdmin(req) {
  const token = bearer(req);
  if (!token) return { ok: false, status: 401, error: 'Please sign in to the admin console again (no login was sent).' };
  const s = store || realStore();
  let email;
  try {
    email = await s.emailOfToken(token);
  } catch (e) {
    return { ok: false, status: 401, error: 'The login could not be checked. Please sign in again.' };
  }
  if (!email) return { ok: false, status: 401, error: 'The login is not valid or has run out. Please sign in again.' };
  try {
    if (!(await s.isAdminEmail(email))) return { ok: false, status: 403, error: 'Only admins can do this.' };
  } catch (e) {
    return { ok: false, status: 500, error: e.message };
  }
  return { ok: true, email };
}

/** Express helper: answers the request itself when the check fails. */
async function adminOrStop(req, res, { always = true } = {}) {
  if (!always && !runNeedsLogin()) return { ok: true, email: null };
  const who = await checkAdmin(req);
  if (!who.ok) res.status(who.status).json({ error: who.error });
  return who;
}

module.exports = { checkAdmin, adminOrStop, useAdminStore, useRunLoginSetting, runNeedsLogin };
