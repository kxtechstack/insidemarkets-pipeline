/**
 * modules/emailAlerts/templateSettings.js
 *
 * Reads the email's look + wording from the database (admin.app_settings, keys 'email_tpl_...'),
 * so the admin can change them in the console (Settings -> Email Template). No code change, no deploy.
 *
 *  - Anything missing or invalid (empty text, wrong colour code, broken logo) falls back to DEFAULTS below,
 *    so a typo in the console can never break the daily email.
 *  - ONE brand colour is set by the admin; every other colour is worked out from it, so they always match.
 *  - The email PASSWORD (SMTP_PASS) is NOT here. It stays in .env.
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const PREFIX = 'email_tpl_';
const CACHE_MS = 30 * 1000;

// Used when the database has no value (or a bad one). Same values as the SQL file email_alerts_003_template.sql.
const DEFAULTS = {
  brand_color: '#232B9C',
  logo_height: '16',
  sender_name: 'InsideMarkets',
  subject_prefix: 'Your Daily Intelligence Briefing',
  header_title: 'Daily Intelligence Briefing',
  greeting: 'Good morning',
  intro: 'Here is your briefing for today. We tracked {count} relevant to {company}.',
  button_text: 'Open your dashboard',
  footer_brand: 'InsideMarkets by Knometrix',
  footer_note: 'This briefing is prepared for {company} and its authorised users. Please do not forward it outside your organisation.',
  footer_unsubscribe: 'You receive this email because daily briefings are enabled for your account. To change this, please contact your InsideMarkets administrator.',
  max_signals: '6',
  max_takeaways: '5',
  logo_data: '', // empty = use the logo file in modules/emailAlerts/assets
};

// ---------- small helpers ----------
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgbToHex = (r) => `#${r.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
const mix = (a, b, t) => { const x = hexToRgb(a); const y = hexToRgb(b); return rgbToHex(x.map((v, i) => v * (1 - t) + y[i] * t)); }; // t=0 -> a, t=1 -> b
const luminance = (h) => {
  const [r, g, b] = hexToRgb(h).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const text = (v, fallback, max) => { const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return s ? s.slice(0, max) : fallback; };
const whole = (v, fallback, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= min && n <= max ? n : fallback; };

// logo: base64 of a PNG or JPEG (Gmail does not show SVG). Anything else is ignored.
function readLogo(value) {
  const raw = String(value || '').replace(/^data:image\/[a-z+]+;base64,/i, '').replace(/\s+/g, '');
  if (!raw) return null;
  try {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length < 100 || buf.length > 400 * 1024) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { buffer: buf, type: 'png', mime: 'image/png' };
    if (buf[0] === 0xff && buf[1] === 0xd8) return { buffer: buf, type: 'jpg', mime: 'image/jpeg' };
  } catch (e) { /* fall through */ }
  return null;
}

/** Turns the raw rows into one ready-to-use settings object (all values checked). */
function resolve(raw = {}) {
  const get = (k) => (raw[k] !== undefined ? raw[k] : DEFAULTS[k]);
  let brand = String(get('brand_color') || '').trim();
  // the header text is white, so the brand colour must be dark enough to read it
  if (!/^#[0-9a-f]{6}$/i.test(brand) || luminance(brand) > 0.2) brand = DEFAULTS.brand_color;
  const WHITE = '#ffffff';
  const ink = mix(brand, '#000000', 0.62);
  return {
    // colours - all worked out from the ONE brand colour
    BRAND: brand,
    INK: ink,                          // headings
    TEXT: mix(ink, WHITE, 0.22),       // body text
    MUTED: mix(ink, WHITE, 0.45),      // small text
    LINE: mix(brand, WHITE, 0.9),      // thin lines
    TINT: mix(brand, WHITE, 0.94),     // light boxes
    PAGE: mix(brand, WHITE, 0.93),     // page background
    HEAD_DATE: mix(WHITE, brand, 0.25), // date in the header
    HEAD_SUB: mix(WHITE, brand, 0.12),  // second line in the header
    // wording
    sender_name: text(get('sender_name'), DEFAULTS.sender_name, 60),
    subject_prefix: text(get('subject_prefix'), DEFAULTS.subject_prefix, 100),
    header_title: text(get('header_title'), DEFAULTS.header_title, 80),
    greeting: text(get('greeting'), DEFAULTS.greeting, 60),
    intro: text(get('intro'), DEFAULTS.intro, 400),
    button_text: text(get('button_text'), DEFAULTS.button_text, 40),
    footer_brand: text(get('footer_brand'), DEFAULTS.footer_brand, 100),
    footer_note: text(get('footer_note'), DEFAULTS.footer_note, 400),
    footer_unsubscribe: text(get('footer_unsubscribe'), DEFAULTS.footer_unsubscribe, 400),
    // numbers
    logo_height: whole(get('logo_height'), 16, 10, 60),
    max_signals: whole(get('max_signals'), 6, 1, 10),
    max_takeaways: whole(get('max_takeaways'), 5, 0, 8),
    // logo (null = use the file in assets/, or the plain text name)
    logo: readLogo(get('logo_data')),
  };
}

let cache = null;
let cachedAt = 0;

/**
 * @param {{fresh?: boolean}} opt  fresh = skip the 30-second memory (used by preview and test email,
 *                                 so the admin sees a change at once)
 */
async function loadTemplate(opt = {}) {
  if (!opt.fresh && cache && Date.now() - cachedAt < CACHE_MS) return cache;
  const raw = {};
  try {
    const { data, error } = await supabase.schema('admin').from('app_settings').select('key, value').like('key', `${PREFIX}%`);
    if (error) throw new Error(error.message);
    for (const r of data || []) raw[r.key.slice(PREFIX.length)] = r.value;
  } catch (e) {
    console.log(`[EmailAlerts] could not read the email template settings, using the defaults: ${e.message}`);
    if (cache) return cache; // keep the last good one
  }
  cache = resolve(raw);
  cachedAt = Date.now();
  return cache;
}

module.exports = { loadTemplate, resolve, DEFAULTS, PREFIX };