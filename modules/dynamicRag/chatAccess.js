/**
 * modules/dynamicRag/chatAccess.js
 *
 * Who is asking? Used by every Decision Intelligence chat address
 * (the chat, the list of chats, one chat, delete, suggested questions).
 *
 * A real user (the dashboard's DI tab) sends the Supabase login token:
 *   Authorization: Bearer <token>
 * The token says who the person is (their email). Their row in
 * admin.client_users says which client they belong to and if they are
 * still active. The chat NEVER trusts a clientId / userId the screen sends:
 * otherwise anyone who knows the address could read any client's news.
 *
 * Test tools (the playground page and scripts/testDynamicRag.js) may send
 * clientId / userId themselves, but only when the playground is on
 * (.env DR_PLAYGROUND=on) and, when .env has DR_PLAYGROUND_KEY, with that
 * key in the header "x-playground-key". Only test tools get the "debug"
 * part of the reply and "stopAfterStep". The live server has the
 * playground off, so there only a login token works.
 */

const { createClient } = require('@supabase/supabase-js');
const { ChatError } = require('./chatError');
const { PLAYGROUND_ON, PLAYGROUND_KEY } = require('./chatConfig');

// ── Where the login is checked (tests give a fake one) ───────────────────
let supabase = null;
function realStore() {
  if (!supabase) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return {
    // the person behind a login token, or null
    async userOfToken(token) {
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data || !data.user) return null;
      return { email: data.user.email || '', banned_until: data.user.banned_until || null };
    },
    // their rows in the admin console (one per client they belong to)
    async usersByEmail(email) {
      const { data, error } = await supabase.schema('admin').from('client_users')
        .select('id, client_id, is_active').ilike('email', email);
      if (error) throw new Error(`user lookup failed: ${error.message}`);
      return data || [];
    },
  };
}
let store = null;
/** Tests: a fake login store ({ userOfToken, usersByEmail }); null = the real one. */
function useAccessStore(s) { store = s; }
const theStore = () => store || realStore();

const bearer = (req) => String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '')
  .replace(/^Bearer\s+/i, '').trim();

// the playground settings from .env (tests set their own)
let settings = null;
/** Tests: { on, key } in place of DR_PLAYGROUND / DR_PLAYGROUND_KEY; null = .env. */
function useAccessSettings(s) { settings = s; }

/** Is this request from a test tool (playground on, and the key when one is set)? */
function isTestTool(req) {
  const on = settings ? settings.on : PLAYGROUND_ON;
  const wantKey = settings ? settings.key : PLAYGROUND_KEY;
  if (!on) return false;
  if (!wantKey) return true;
  const key = (req.headers && req.headers['x-playground-key']) || '';
  return key === wantKey;
}

/**
 * @returns { clientId, userId, test } — test = a test tool (debug allowed)
 * @throws ChatError 401 (no / bad login) or 403 (not active, no workspace)
 */
async function whoIsAsking(req) {
  const test = isTestTool(req);
  const token = bearer(req);
  if (token) {
    const person = await theStore().userOfToken(token);
    if (!person || !person.email) throw new ChatError(401, 'LOGIN_NEEDED', 'Your login has expired. Please log in again.');
    if (person.banned_until && new Date(person.banned_until) > new Date()) {
      throw new ChatError(403, 'USER_INACTIVE', 'Your account is not active. Please contact your admin.');
    }
    const rows = await theStore().usersByEmail(String(person.email).toLowerCase());
    const active = rows.filter((r) => r.is_active !== false);
    if (!rows.length) throw new ChatError(403, 'USER_NOT_FOUND', 'Your account could not be found. Please log in again.');
    if (!active.length) throw new ChatError(403, 'USER_INACTIVE', 'Your account is not active. Please contact your admin.');
    // one person in two workspaces: we cannot tell which one is meant, so
    // we never guess (the dashboard logs in to one workspace per email)
    if (new Set(active.map((r) => String(r.client_id))).size > 1) {
      throw new ChatError(403, 'MORE_THAN_ONE_WORKSPACE', 'Your account is linked to more than one workspace. Please contact your admin.');
    }
    return { clientId: String(active[0].client_id), userId: String(active[0].id), test };
  }
  // no login token: only a test tool may say who it is
  if (test) {
    const src = { ...(req.query || {}), ...(req.body || {}) };
    return { clientId: src.clientId ? String(src.clientId) : '', userId: src.userId ? String(src.userId) : '', test: true };
  }
  throw new ChatError(401, 'LOGIN_NEEDED', 'Please log in again.');
}

module.exports = { whoIsAsking, isTestTool, useAccessStore, useAccessSettings };
