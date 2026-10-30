/**
 * modules/emailAlerts/dailyEmail.js
 *
 * Decides WHO gets the daily email and sends it.
 *   - only clients with "Send Email Alerts" ON (admin.clients.email_alerts_enabled = true)
 *   - only active clients
 *   - to every active user of that client (admin.client_users)
 *   - never twice on the same day (public.email_alert_log)
 *   - not again if the highlights have not changed since the last email
 *     (set EMAIL_ALERTS_SKIP_IF_NO_NEW=false to send every day anyway)
 */

const { createClient } = require('@supabase/supabase-js');
const { loadHighlights, buildEmail } = require('./emailContent');
const { sendEmail } = require('./mailer');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const admin = () => supabase.schema('admin');

const appUrl = () => process.env.CLIENT_APP_URL || '';
const istDate = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const short = (s, n = 300) => String(s || '').replace(/\s+/g, ' ').slice(0, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function log(row) {
  const { error } = await supabase.from('email_alert_log').insert(row);
  if (error && !/duplicate key/i.test(error.message)) console.log(`[EmailAlerts] log write failed: ${error.message}`);
}

async function activeUsers(clientId) {
  const { data, error } = await admin().from('client_users')
    .select('email, first_name, is_active').eq('client_id', clientId);
  if (error) throw new Error(`could not read users: ${error.message}`);
  const seen = new Set();
  return (data || []).filter((u) => {
    const e = String(u.email || '').trim().toLowerCase();
    if (u.is_active === false || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) || seen.has(e)) return false;
    seen.add(e);
    return true;
  });
}

/**
 * Daily email for one client.
 * @returns {{client, sent, failed, skipped, reason?}}
 */
async function sendDailyForClient(clientId) {
  const sendDate = istDate();
  const data = await loadHighlights(clientId);
  const { data: client } = await admin().from('clients')
    .select('id, company_name, status, email_alerts_enabled').eq('id', clientId).maybeSingle();
  const out = { client: client ? client.company_name : clientId, sent: 0, failed: 0, skipped: 0 };

  if (!client || !client.email_alerts_enabled) return { ...out, reason: 'email alerts are OFF for this client' };
  if (client.status && client.status.toLowerCase() !== 'active') return { ...out, reason: `client is ${client.status}` };
  if (!data) {
    await log({ client_id: clientId, email: '(all users)', send_date: sendDate, status: 'skipped', reason: 'no highlights yet' });
    return { ...out, reason: 'no highlights yet' };
  }

  // nothing new since the last daily email -> do not send the same text again
  if (String(process.env.EMAIL_ALERTS_SKIP_IF_NO_NEW || 'true').toLowerCase() !== 'false') {
    const { data: last } = await supabase.from('email_alert_log').select('highlights_at')
      .eq('client_id', clientId).eq('send_type', 'daily').eq('status', 'sent').not('highlights_at', 'is', null)
      .order('highlights_at', { ascending: false }).limit(1).maybeSingle();
    if (last && last.highlights_at && new Date(data.newestAt) <= new Date(last.highlights_at)) {
      await log({ client_id: clientId, email: '(all users)', send_date: sendDate, status: 'skipped', reason: 'no new highlights since the last email', highlights_at: data.newestAt });
      return { ...out, reason: 'no new highlights since the last email' };
    }
  }

  const users = await activeUsers(clientId);
  if (!users.length) return { ...out, reason: 'no active users with an email address' };

  // who already got today's email (e.g. the run was started twice)
  const { data: done } = await supabase.from('email_alert_log').select('email')
    .eq('client_id', clientId).eq('send_type', 'daily').eq('status', 'sent').eq('send_date', sendDate);
  const already = new Set((done || []).map((r) => r.email.toLowerCase()));

  for (const u of users) {
    const email = u.email.trim().toLowerCase();
    if (already.has(email)) { out.skipped++; continue; }
    const mail = buildEmail(data, u, appUrl());
    try {
      await sendEmail({ to: email, ...mail });
      out.sent++;
      await log({ client_id: clientId, email, send_date: sendDate, status: 'sent', highlights_at: data.newestAt });
    } catch (e) {
      out.failed++;
      console.error(`[EmailAlerts] ${out.client} -> ${email} failed: ${e.message}`);
      await log({ client_id: clientId, email, send_date: sendDate, status: 'failed', reason: short(e.message), highlights_at: data.newestAt });
    }
    await sleep(300);
  }
  return out;
}

/** Daily run: every client with the toggle ON */
async function runDailyEmails() {
  const { data: clients, error } = await admin().from('clients')
    .select('id, company_name').eq('email_alerts_enabled', true).order('company_name');
  if (error) throw new Error(`could not read clients: ${error.message}`);
  const results = [];
  for (const c of clients || []) {
    try {
      results.push(await sendDailyForClient(c.id));
    } catch (e) {
      console.error(`[EmailAlerts] ${c.company_name} failed: ${e.message}`);
      results.push({ client: c.company_name, error: e.message });
    }
  }
  return results;
}

/**
 * Test email: one person, ignores the toggle and the "nothing new" rule.
 * Only to a user of this client or an admin user (so the link cannot be used to email strangers).
 */
async function sendTestEmail(clientId, to) {
  const email = String(to || '').trim().toLowerCase();
  const [{ data: cu }, { data: au }] = await Promise.all([
    admin().from('client_users').select('email, first_name').eq('client_id', clientId),
    admin().from('admin_users').select('email, full_name'),
  ]);
  const user = (cu || []).find((u) => String(u.email).toLowerCase() === email);
  const adminUser = (au || []).find((u) => String(u.email).toLowerCase() === email);
  if (!user && !adminUser) throw new Error('test emails can only go to a user of this client or an admin user');

  const data = await loadHighlights(clientId);
  if (!data) throw new Error('this client has no highlights yet - nothing to send');
  const name = user ? user.first_name : (adminUser.full_name || '').split(' ')[0];
  const mail = buildEmail(data, { first_name: name, email }, appUrl());
  try {
    await sendEmail({ to: email, ...mail });
    await log({ client_id: clientId, email, send_date: istDate(), send_type: 'test', status: 'sent', highlights_at: data.newestAt });
  } catch (e) {
    await log({ client_id: clientId, email, send_date: istDate(), send_type: 'test', status: 'failed', reason: short(e.message) });
    throw e;
  }
  return { sent_to: email, modules: data.modules.map((m) => m.label) };
}

/** HTML of the email, for the browser (no email is sent) */
async function previewHtml(clientId) {
  const data = await loadHighlights(clientId);
  if (!data) return null;
  const users = await activeUsers(clientId);
  return buildEmail(data, users[0] || {}, appUrl()).html;
}

/**
 * Runs every minute. ONE send time for ALL clients: admin.app_settings 'email_alert_time'
 * (India time, 'HH:MM', default 07:00), changed by the admin on the console Settings page.
 * A client is sent when:
 *   - its "Email alerts" toggle is ON
 *   - now is between the send time and 60 minutes after it (so a short server restart does not lose the day)
 *   - nothing was done for it yet today (sent / skipped / failed are all written in email_alert_log)
 */
const SEND_WINDOW_MIN = 60;
const DEFAULT_TIME = '07:00';
const toMinutes = (hhmm) => {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

async function getSendTime() {
  const { data, error } = await admin().from('app_settings').select('value').eq('key', 'email_alert_time').maybeSingle();
  if (error) console.log(`[EmailAlerts] could not read the send time, using ${DEFAULT_TIME}: ${error.message}`);
  return (data && toMinutes(data.value) !== null) ? data.value : DEFAULT_TIME;
}

async function runDueEmails() {
  const nowIst = new Date(Date.now() + 5.5 * 3600e3);
  const nowMin = nowIst.getUTCHours() * 60 + nowIst.getUTCMinutes();
  const t = toMinutes(await getSendTime());
  if (nowMin < t || nowMin >= t + SEND_WINDOW_MIN) return [];
  const today = istDate();

  const { data: clients, error } = await admin().from('clients')
    .select('id, company_name').eq('email_alerts_enabled', true);
  if (error) throw new Error(`could not read clients: ${error.message}`);

  const results = [];
  for (const c of clients || []) {
    const { count } = await supabase.from('email_alert_log').select('id', { count: 'exact', head: true })
      .eq('client_id', c.id).eq('send_type', 'daily').eq('send_date', today);
    if (count) continue; // already done today

    try {
      results.push(await sendDailyForClient(c.id));
    } catch (e) {
      console.error(`[EmailAlerts] ${c.company_name} failed: ${e.message}`);
      await log({ client_id: c.id, email: '(all users)', send_date: today, status: 'failed', reason: short(e.message) });
      results.push({ client: c.company_name, error: e.message });
    }
  }
  return results;
}

module.exports = { runDailyEmails, runDueEmails, getSendTime, sendDailyForClient, sendTestEmail, previewHtml };