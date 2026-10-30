/**
 * modules/emailAlerts/route.js
 *
 * In server.js (before app.listen):
 *   const { registerEmailAlertsRoute } = require('./modules/emailAlerts/route');
 *   registerEmailAlertsRoute(app);
 *
 *  GET  /email-alerts/preview/:clientId   open in the browser: shows the email (sends nothing)
 *  POST /email-alerts/test/:clientId      body {to}: send ONE test email (to a user of this client or an admin)
 *  POST /email-alerts/run                 send today's emails now (body {clientId?} = only that client)
 *  GET  /email-alerts/log/:clientId       what was sent / failed / skipped
 *
 *  Timer: every minute it checks the ONE send time for all clients (admin.app_settings 'email_alert_time',
 *         India time, default 07:00, changed on the console Settings page). EMAIL_ALERTS_TIME=off turns it off on a machine.
 */

const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { runDailyEmails, runDueEmails, getSendTime, sendDailyForClient, sendTestEmail, previewHtml } = require('./dailyEmail');
const { isConfigured } = require('./mailer');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (res, msg, code = 400) => res.status(code).json({ ok: false, error: msg });

let running = false;
async function runOnce(label, job) {
  if (running) return { busy: true };
  running = true;
  try {
    const r = await job();
    if (label !== 'due check') console.log(`[EmailAlerts] ${label}:`, JSON.stringify(r));
    return r;
  } finally {
    running = false;
  }
}

function registerEmailAlertsRoute(app) {
  app.get('/email-alerts/preview/:clientId', async (req, res) => {
    const { clientId } = req.params;
    if (!UUID.test(clientId)) return bad(res, 'bad clientId');
    try {
      const html = await previewHtml(clientId);
      if (!html) return res.status(404).send('This client has no highlights yet - nothing to show.');
      return res.type('html').send(html);
    } catch (e) {
      return bad(res, e.message, 500);
    }
  });

  app.post('/email-alerts/test/:clientId', async (req, res) => {
    const { clientId } = req.params;
    if (!UUID.test(clientId)) return bad(res, 'bad clientId');
    const to = req.body && req.body.to;
    if (!to) return bad(res, 'give the email address in "to"');
    try {
      return res.json({ ok: true, ...(await sendTestEmail(clientId, to)) });
    } catch (e) {
      return bad(res, e.message, /can only go|no highlights/.test(e.message) ? 400 : 500);
    }
  });

  app.post('/email-alerts/run', async (req, res) => {
    const clientId = req.body && req.body.clientId;
    if (clientId && !UUID.test(clientId)) return bad(res, 'bad clientId');
    if (!isConfigured()) return bad(res, 'Email is not set up yet (SMTP settings missing in .env)');
    try {
      const r = await runOnce('manual run', () => (clientId ? sendDailyForClient(clientId).then((x) => [x]) : runDailyEmails()));
      if (r.busy) return res.status(409).json({ ok: false, error: 'Emails are being sent right now. Please wait.' });
      return res.json({ ok: true, results: r });
    } catch (e) {
      return bad(res, e.message, 500);
    }
  });

  app.get('/email-alerts/log/:clientId', async (req, res) => {
    const { clientId } = req.params;
    if (!UUID.test(clientId)) return bad(res, 'bad clientId');
    const { data, error } = await supabase.from('email_alert_log')
      .select('sent_at, send_date, send_type, email, status, reason, highlights_at')
      .eq('client_id', clientId).order('sent_at', { ascending: false }).limit(Math.min(Number(req.query.limit) || 100, 500));
    if (error) return bad(res, error.message, 500);
    return res.json({ ok: true, log: data || [] });
  });

  // ---- timer: every minute, check if the send time has come ----
  // ONE time for all clients (admin.app_settings 'email_alert_time', India time), set on the console Settings page.
  // EMAIL_ALERTS_TIME=off in .env turns sending off on this machine (use it on your laptop).
  const off = String(process.env.EMAIL_ALERTS_TIME || '').trim().toLowerCase() === 'off';
  if (!off) {
    cron.schedule('* * * * *', async () => {
      if (!isConfigured()) return;
      try {
        const r = await runOnce('due check', runDueEmails);
        if (Array.isArray(r) && r.length) console.log('[EmailAlerts] daily run:', JSON.stringify(r));
      } catch (e) {
        console.error(`[EmailAlerts] daily run failed: ${e.message}`);
      }
    }, { timezone: 'Asia/Kolkata' });
    getSendTime().then((t) => console.log(`[EmailAlerts] daily emails ON - sent at ${t} India time (change it in the console Settings page)${isConfigured() ? '' : ' - BUT SMTP settings are missing in .env'}`)).catch(() => {});
  } else {
    console.log('[EmailAlerts] daily emails are OFF on this machine (EMAIL_ALERTS_TIME=off)');
  }
}

module.exports = { registerEmailAlertsRoute };