/**
 * modules/emailAlerts/emailContent.js
 *
 * Builds the daily email for ONE client - short "notification" style (like the Groww Digest),
 * from the SAME data the landing page shows under "Today's Highlights":
 *
 *   public.daily_highlights
 *     kind = 'intro'   -> "Today in brief" (each sentence on its own short line)
 *     kind = 'module'  -> signal_date + signals_used (the list of signals behind each module)
 *   the signal tables  -> the one-line summary of each of those signals
 *     Market Dynamics  -> market_dynamics_signals
 *     Policy & Risk    -> policy_signals
 *     Forward Outlook  -> trend_signals
 *
 * No AI here. Nothing is re-written - only shortened (first sentence of each summary).
 */

const { createClient } = require('@supabase/supabase-js');

const { resolve: resolveTemplate } = require('./templateSettings');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Same order + names as the landing page (highlightGenerator.js)
const MODULES = [
  { id: '55c5ee19-bfca-468b-81b3-b89ca4f303c8', label: 'Market Dynamics', table: 'market_dynamics_signals', org: 'organization' },
  { id: '777a2b2e-8bb2-44ef-a4f2-1c0c1e03b960', label: 'Policy & Risk Monitor', table: 'policy_signals', org: 'country' },
  { id: '2eb989fd-0ea0-4320-b73a-f7eb8b970473', label: 'Forward Outlook', table: 'trend_signals', org: 'organization' },
];
const MAX_LINE_CHARS = 600;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const oneSpace = (s) => String(s || '').replace(/\s+/g, ' ').trim();
// split into sentences, but NOT after short forms like "U.S.", "Inc.", "Dr." or a single initial ("J. Smith")
const ABBR = /\b(?:U\.S|U\.K|U\.N|E\.U|U\.A\.E|Inc|Ltd|Corp|Co|Dr|Mr|Mrs|Ms|Prof|vs|etc|e\.g|i\.e|St|No|Jr|Sr|approx|Bn|Mn)\.|\b[A-Z]\./g;
const sentences = (text) => oneSpace(text)
  .replace(ABBR, (m) => m.slice(0, -1) + '\u0000')
  .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
  .map((x) => x.replace(/\u0000/g, '.').trim())
  .filter(Boolean);
const niceDate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
const dayDate = (d) => new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

// The first FULL sentence of a summary. It always ends at a full stop - never cut half-way.
// (Only a very long sentence, over MAX_LINE_CHARS, is shortened at a word, as a safety.)
function firstLine(text) {
  const s = sentences(text)[0] || '';
  if (s.length <= MAX_LINE_CHARS) return s;
  return `${s.slice(0, MAX_LINE_CHARS).replace(/\s+\S*$/, '')}...`;
}

// 'gain traction in the cosmetics industry' vs '... cosmetics market' = the same news
const titleWords = (t) => new Set(oneSpace(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean));
function sameTitle(a, b) {
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  const all = new Set([...a, ...b]).size;
  return all > 0 && both / all >= 0.8;
}

// sentences that only describe the page itself, not news ("The daily briefing covers ...", "Use Ask Decision Intelligence below ...")
const PAGE_ONLY = /^(the|this|today'?s)\s+(daily\s+)?(briefing|summary|update)s?\s+(covers|includes|looks at)|ask decision intelligence|explore any of these/i;

/**
 * @returns {null | {client, brief: string[], modules: [{label, signalDate, total, signals: [{title, tag, who, line}]}], newestAt}}
 *          null = nothing to send (no highlights yet)
 */
async function loadHighlights(clientId, tpl = resolveTemplate({})) {
  const { data: client, error: cErr } = await supabase.schema('admin').from('clients')
    .select('id, company_name, status, enabled_modules, email_alerts_enabled').eq('id', clientId).maybeSingle();
  if (cErr || !client) throw new Error(`client ${clientId} not found`);

  const { data: rows, error } = await supabase.from('daily_highlights')
    .select('kind, module_id, highlight_text, signal_date, signals_used, created_at')
    .eq('client_id', clientId).order('created_at', { ascending: false });
  if (error) throw new Error(`could not read highlights: ${error.message}`);

  const enabled = new Set(client.enabled_modules || []);
  const latest = (kind, moduleId) => (rows || []).find((r) => r.kind === kind && (moduleId === undefined || r.module_id === moduleId));

  const modules = [];
  for (const m of MODULES.filter((x) => enabled.has(x.id))) {
    const r = latest('module', m.id);
    if (!r) continue;
    // exactly the signals (and count) the landing page uses: signals_used, nothing removed
    const used = (Array.isArray(r.signals_used) ? r.signals_used : []).filter((s) => s && s.title);
    if (!used.length) continue;
    const top = used.slice(0, tpl.max_signals);

    // one-line summary + organisation / country for each signal, from the module's own table
    const ids = top.map((s) => s.id).filter(Boolean);
    const extra = new Map();
    if (ids.length) {
      const { data: sig, error: sErr } = await supabase.from(m.table).select('id, summary').in('id', ids);
      if (sErr) console.log(`[EmailAlerts] could not read ${m.table}: ${sErr.message}`);
      for (const s of sig || []) extra.set(s.id, s);
    }
    modules.push({
      label: m.label,
      signalDate: r.signal_date,
      total: used.length,
      createdAt: r.created_at,
      signals: top.map((s) => {
        const x = extra.get(s.id) || {};
        // the bold title already says who it is about, so no name in front of the line
        return { title: oneSpace(s.title), tag: s.tag || null, who: null, line: firstLine(x.summary) };
      }),
    });
  }
  if (!modules.length) return null;

  const intro = latest('intro');
  const brief = sentences(intro ? intro.highlight_text : '').filter((s) => !PAGE_ONLY.test(s)).slice(0, tpl.max_takeaways);
  const newestAt = [...modules.map((m) => m.createdAt), intro && intro.created_at].filter(Boolean).sort().pop();
  return { client, brief, modules, newestAt };
}

/**
 * The email (HTML + plain text). Tables + inline styles = looks right in Gmail / Outlook / phone.
 * @param data  result of loadHighlights()
 * @param user  {first_name}
 */
// Logo in the email header. Order of choice:
//   1. EMAIL_LOGO_URL in .env (a hosted https image)        - optional
//   2. the logo saved in the database (console -> Settings -> Email Template)
//   3. the file assets/insidemarkets-logo-white.png          - safety net
//   4. the plain text name
// 2 and 3 are attached INSIDE the email, so nothing needs hosting and Gmail shows them.
const fs = require('fs');
const path = require('path');
const LOGO_FILE = path.join(__dirname, 'assets', 'insidemarkets-logo-white.png');
const LOGO_CID = 'insidemarkets-logo@knometrix';
const LOGO_HOSTED = (process.env.EMAIL_LOGO_URL || '').trim();
let fileLogo;
function bundledLogo() {
  if (fileLogo === undefined) {
    try { fileLogo = { buffer: fs.readFileSync(LOGO_FILE), type: 'png', mime: 'image/png' }; } catch (e) { fileLogo = null; }
  }
  return fileLogo;
}
// PNG header: width at byte 16, height at byte 20. The email states its exact size up front so nothing jumps.
function logoWidth(logo, height) {
  try {
    if (!logo || logo.type !== 'png') return 0;
    return Math.round(height * logo.buffer.readUInt32BE(16) / logo.buffer.readUInt32BE(20));
  } catch (e) { return 0; }
}
const fill = (t, vars) => String(t).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));

function buildEmail(data, user, appUrl, tpl = resolveTemplate({})) {
  const { BRAND, INK, TEXT, MUTED, LINE, TINT, PAGE } = tpl;
  const today = niceDate(new Date());
  const company = data.client.company_name;
  const total = data.modules.reduce((n, m) => n + m.total, 0);
  const countText = `${total} new update${total === 1 ? '' : 's'}`;
  // no date in the subject; the top story makes each day's subject different,
  // so Gmail does not join every day's email into one long conversation
  const top = data.modules[0].signals[0];
  const topTitle = top ? top.title.replace(/[.\s]+$/, '') : '';
  const subject = topTitle
    ? `${tpl.subject_prefix}: ${topTitle.length > 90 ? `${topTitle.slice(0, 90).replace(/\s+\S*$/, '')}...` : topTitle}`
    : tpl.subject_prefix;
  const name = user && user.first_name ? oneSpace(user.first_name) : '';
  const niceName = name ? name.charAt(0).toUpperCase() + name.slice(1) : ''; // 'sneha' -> 'Sneha'
  const greeting = niceName ? `${tpl.greeting}, ${niceName}` : tpl.greeting;
  const link = appUrl || '';
  const first = data.modules[0].signals[0];
  // the grey line Gmail / Outlook show next to the subject in the inbox
  const preheader = `${countText} for ${company}.${first ? ` Top story: ${first.title}` : ''}`;

  // logo
  const logo = LOGO_HOSTED ? null : (tpl.logo || bundledLogo());
  const LOGO_URL = LOGO_HOSTED || (logo ? `cid:${LOGO_CID}` : '');
  const LOGO_HEIGHT = tpl.logo_height;
  const LOGO_WIDTH = logoWidth(logo, LOGO_HEIGHT);
  const HEADER_BG = BRAND;
  const introHtml = esc(fill(tpl.intro, { count: '\u0001', company: '\u0002' })).replace('\u0001', `<b>${countText}</b>`).replace('\u0002', esc(company));
  const introText = fill(tpl.intro, { count: countText, company });
  const noteText = fill(tpl.footer_note, { company });

  const F = 'font-family:Helvetica,Arial,sans-serif;';
  const NAVY = INK;
  const ACCENT = BRAND;
  const line = `border-bottom:1px solid ${LINE};`;

  const glance = data.modules.map((m, i) => `
              <td width="${Math.floor(100 / data.modules.length)}%" align="center" valign="top" style="${F}padding:16px 8px;${i ? `border-left:1px solid ${LINE};` : ''}">
                <div style="font-size:26px;font-weight:bold;color:${NAVY};line-height:1;">${m.total}</div>
                <div style="font-size:12px;color:${MUTED};margin-top:6px;line-height:1.3;">${esc(m.label)}</div>
              </td>`).join('');

  const sections = data.modules.map((m) => `
        <tr><td style="padding:32px 40px 0 40px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="${F}font-size:12px;font-weight:bold;letter-spacing:1.2px;text-transform:uppercase;color:${ACCENT};padding-bottom:10px;border-bottom:2px solid ${NAVY};">${esc(m.label)}</td>
              <td align="right" style="${F}font-size:12px;color:${MUTED};padding-bottom:10px;border-bottom:2px solid ${NAVY};">${esc(dayDate(m.signalDate || m.createdAt))}</td>
            </tr>
            ${m.signals.map((s) => `
            <tr><td colspan="2" style="${F}padding:16px 0;${line}">
              <div style="font-size:15px;line-height:1.4;color:${NAVY};font-weight:bold;">${esc(s.title)}</div>
              ${s.line ? `<div style="font-size:14px;line-height:1.6;color:${TEXT};margin-top:6px;">${esc(s.line)}</div>` : ''}
              ${s.tag ? `<div style="font-size:11px;color:${MUTED};margin-top:8px;text-transform:uppercase;letter-spacing:.6px;">${esc(s.tag)}</div>` : ''}
            </td></tr>`).join('')}
            ${link ? `
            <tr><td colspan="2" style="${F}padding:14px 0 0 0;font-size:13px;">
              <a href="${esc(link)}" style="color:${ACCENT};text-decoration:none;font-weight:bold;">View all ${m.total} ${esc(m.label)} update${m.total === 1 ? '' : 's'} &rarr;</a>
            </td></tr>` : ''}
          </table>
        </td></tr>`).join('');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${PAGE};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${PAGE};">${esc(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE};">
    <tr><td align="center" style="padding:28px 12px;">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;background:#ffffff;border-radius:6px;overflow:hidden;">

        <!-- header -->
${LOGO_URL ? `        <tr><td style="background:${HEADER_BG};padding:28px 40px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td><img src="${esc(LOGO_URL)}" alt="${esc(tpl.sender_name)}" ${LOGO_WIDTH ? `width="${LOGO_WIDTH}" ` : ''}height="${LOGO_HEIGHT}" style="display:block;${LOGO_WIDTH ? `width:${LOGO_WIDTH}px;` : 'width:auto;'}height:${LOGO_HEIGHT}px;border:0;outline:none;text-decoration:none;color:#ffffff;font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:bold;"></td>
            <td align="right" style="${F}font-size:12px;color:${tpl.HEAD_DATE};">${esc(today)}</td>
          </tr></table>
          <div style="${F}font-size:13px;color:${tpl.HEAD_SUB};margin-top:12px;">${esc(tpl.header_title)} &middot; ${esc(company)}</div>
        </td></tr>` : `        <tr><td style="background:${BRAND};padding:26px 40px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="${F}font-size:20px;font-weight:bold;color:#ffffff;letter-spacing:.3px;">${esc(tpl.sender_name)}</td>
            <td align="right" style="${F}font-size:12px;color:${tpl.HEAD_SUB};">${esc(today)}</td>
          </tr></table>
          <div style="${F}font-size:13px;color:${tpl.HEAD_SUB};margin-top:6px;">${esc(tpl.header_title)} &middot; ${esc(company)}</div>
        </td></tr>`}

        <!-- greeting -->
        <tr><td style="${F}padding:32px 40px 0 40px;">
          <div style="font-size:20px;color:${NAVY};font-weight:bold;">${esc(greeting)},</div>
          <div style="font-size:14px;line-height:1.6;color:${TEXT};margin-top:8px;">${introHtml}</div>
        </td></tr>

        <!-- numbers -->
        <tr><td style="padding:22px 40px 0 40px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${TINT};border-radius:6px;"><tr>${glance}
          </tr></table>
        </td></tr>

        ${data.brief.length ? `
        <!-- key takeaways -->
        <tr><td style="padding:30px 40px 0 40px;">
          <div style="${F}font-size:12px;font-weight:bold;letter-spacing:1.2px;text-transform:uppercase;color:${ACCENT};padding-bottom:10px;border-bottom:2px solid ${NAVY};">Key takeaways</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;">
            ${data.brief.map((s) => `
            <tr>
              <td width="18" valign="top" style="${F}padding:10px 0 0 0;font-size:14px;color:${ACCENT};">&#9632;</td>
              <td style="${F}padding:8px 0 0 0;font-size:14px;line-height:1.6;color:${TEXT};">${esc(s)}</td>
            </tr>`).join('')}
          </table>
        </td></tr>` : ''}

        ${sections}

        ${link ? `
        <!-- button -->
        <tr><td align="center" style="padding:36px 40px 8px 40px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="background:${ACCENT};border-radius:4px;">
              <a href="${esc(link)}" style="${F}display:inline-block;padding:13px 32px;font-size:14px;font-weight:bold;color:#ffffff;text-decoration:none;">${esc(tpl.button_text)}</a>
            </td>
          </tr></table>
        </td></tr>` : ''}

        <!-- footer -->
        <tr><td style="padding:32px 40px 0 40px;"><div style="border-top:1px solid ${LINE};"></div></td></tr>
        <tr><td style="${F}padding:18px 40px 32px 40px;font-size:11px;line-height:1.7;color:${MUTED};">
          <b style="color:${MUTED};">${esc(tpl.footer_brand)}</b><br>
          ${esc(noteText)}<br>
          ${esc(tpl.footer_unsubscribe)}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    `${tpl.sender_name} - ${tpl.header_title} - ${company} - ${today}`,
    '',
    `${greeting},`,
    introText,
    '',
    ...data.modules.map((m) => `${m.label}: ${m.total}`),
    '',
    ...(data.brief.length ? ['KEY TAKEAWAYS', ...data.brief.map((s) => `- ${s}`), ''] : []),
    ...data.modules.flatMap((m) => [
      `${m.label.toUpperCase()} (${dayDate(m.signalDate || m.createdAt)})`,
      ...m.signals.map((s) => `- ${s.title}${s.line ? `\n  ${s.line}` : ''}`),
      ...(link ? [`View all ${m.total} updates: ${link}`] : []),
      '',
    ]),
    link ? `${tpl.button_text}: ${link}` : '',
    '',
    tpl.footer_brand,
    noteText,
    tpl.footer_unsubscribe,
  ].join('\n');

  const attachments = logo
    ? [{ filename: `logo.${logo.type}`, content: logo.buffer, contentType: logo.mime, cid: LOGO_CID }] : [];
  return { subject, html, text, attachments, fromName: tpl.sender_name };
}

module.exports = { loadHighlights, buildEmail, MODULES };