// modules/userAccess/route.js
//
// GET /auth/access-status
// The client dashboard calls this every ~30 sec with the logged-in
// person's token. Answer: { active: true/false }.
// If active is false, the dashboard logs the person out.

const { createClient } = require('@supabase/supabase-js');

// Same settings as server.js and emailAlerts use
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

function registerUserAccessRoute(app) {
  app.get('/auth/access-status', async (req, res) => {
    try {
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      if (!token) {
        return res.status(401).json({ active: false, reason: 'no_token' });
      }

      // 1) Who is this? (fails if the login was removed / token is bad)
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data || !data.user) {
        return res.status(401).json({ active: false, reason: 'invalid_session' });
      }

      const email = String(data.user.email || '').toLowerCase();

      // 2) Blocked in Supabase login?
      const bannedUntil = data.user.banned_until ? new Date(data.user.banned_until) : null;
      if (bannedUntil && bannedUntil > new Date()) {
        return res.json({ active: false, reason: 'user_inactive' });
      }

      // 3) Still active in the admin console?
      const { data: rows, error: dbErr } = await supabase
        .schema('admin')
        .from('client_users')
        .select('is_active')
        .ilike('email', email);

      if (dbErr) throw dbErr;

      const active = (rows || []).some((r) => r.is_active !== false);
      return res.json({ active, reason: active ? null : 'user_inactive' });
    } catch (err) {
      console.error('[UserAccess] status check failed:', err.message);
      // Our own server problem -> do NOT kick the user out for it
      return res.status(500).json({ active: true, reason: 'check_failed' });
    }
  });

  console.log('[UserAccess] GET /auth/access-status ready');
}

module.exports = { registerUserAccessRoute };