/**
 * modules/dynamicRag/understandQuery.js
 *
 * STEP 5 of the manager's doc — "Intent and constraint extraction".
 * (Step 4, remembering earlier questions, is skipped for now.)
 *
 * Job: turn the question into a clear, organised form that the later
 * steps can plan and search with:
 *
 *   goals        what the user wants (main goal + extra goals)
 *   companies    which companies, matched to the client's competitor list
 *   places       which countries / regions
 *   industries, products, topics, metrics
 *   time         real dates ("last 3 months" -> 2026-08-13 .. 2026-11-12)
 *   constraints  limits the user said ("only UAE")
 *   implied      things not said but needed, clearly marked as implied
 *
 * Who does what (manager's rule: the AI suggests, Node.js checks):
 *   AI   reads the question and fills the organised form (1 AI call).
 *   code checks the form:
 *        - the goal must be one from our fixed list
 *        - every company and place must really be in the question
 *          (typos allowed). Anything the AI added on its own is removed.
 *        - company names are matched to the client's competitor list
 *          (name + aliases) and to the client's own company name
 *        - dates are worked out here in code, never by the AI
 *        - if there is no topic at all ("analysis", "revenue"), the user
 *          is asked back
 *
 * What Step 5 does NOT do: choose which modules to search, search
 * anything, or answer. That is Step 6 onwards.
 *
 * Nothing in this file is about one client: all names come from the
 * database, all rules work the same for every client.
 */

const { createClient } = require('@supabase/supabase-js');
const { callLLM } = require('../llmClient');
const { ChatError } = require('./chatError');
const { preprocessText } = require('./preprocessQuery');   // only to spot date words
const { standardPlace, PLACES } = require('../placeNames');  // the same place names the news pipeline saves
const {
  UNDERSTAND_PROMPT_ID,
  PROMPT_REFRESH_MS,
  CHAT_TIMEZONE,
  NO_TOPIC_MESSAGE,
  TIME_UNCLEAR_MESSAGE,
} = require('./chatConfig');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── The fixed list of goal types (manager's doc, plus list and framework) ──
const GOAL_TYPES = [
  'fact_lookup',          // one number or one fact
  'list',                 // list items: "list the latest policy changes"
  'company_profile',
  'trends',
  'comparison',
  'opportunities',
  'competitor_analysis',
  'market_entry',
  'feasibility',
  'forecast',
  'risks',
  'campaign_ideas',
  'strategy',
  'framework',            // SWOT, PESTLE, Five Forces
];

const MAX_ATTEMPTS = 2;        // ask the AI at most twice
const MAX_ITEMS = 20;          // per list (companies, places...). Anything past this is recorded, never dropped silently
const MAX_ITEM_CHARS = 100;

// ═════════════════════════════════════════════════════════════════════════
// 1. The instruction, from the prompts table
// ═════════════════════════════════════════════════════════════════════════
let promptCache = { text: null, loadedAt: 0 };

async function loadPrompt() {
  if (promptCache.text && Date.now() - promptCache.loadedAt < PROMPT_REFRESH_MS) {
    return promptCache.text;
  }
  const { data, error } = await supabase
    .from('prompts')
    .select('prompt_template')
    .eq('id', UNDERSTAND_PROMPT_ID)
    .eq('is_active', true)
    .maybeSingle();

  if (error) throw new Error(`could not load prompt ${UNDERSTAND_PROMPT_ID}: ${error.message}`);
  if (!data || !data.prompt_template) {
    throw new Error(`prompt ${UNDERSTAND_PROMPT_ID} is missing or switched off in the prompts table`);
  }
  promptCache = { text: data.prompt_template, loadedAt: Date.now() };
  return promptCache.text;
}

// ═════════════════════════════════════════════════════════════════════════
// 2. The client's names: its own company and its competitors
// ═════════════════════════════════════════════════════════════════════════
async function loadClientNames(clientId) {
  const [clientRes, compRes] = await Promise.all([
    supabase.schema('admin').from('clients')
      .select('id, company_name, industry').eq('id', clientId).maybeSingle(),
    supabase.schema('admin').from('competitors')
      .select('id, name, name_key, search_name, aliases, is_active').eq('client_id', clientId),
  ]);
  if (clientRes.error) throw new Error(`could not load client: ${clientRes.error.message}`);
  if (compRes.error) throw new Error(`could not load competitors: ${compRes.error.message}`);

  const client = clientRes.data || {};
  const competitors = (compRes.data || []).filter((c) => c.is_active !== false);
  return {
    client: { company_name: client.company_name || null, industry: client.industry || null },
    competitors,
  };
}

// ═════════════════════════════════════════════════════════════════════════
// 3. Reading the AI's reply (no AI, no database — easy to test)
// ═════════════════════════════════════════════════════════════════════════
const cleanItem = (v) => String(v).replace(/\s+/g, ' ').trim().slice(0, MAX_ITEM_CHARS);

// cut: optional list. Items past MAX_ITEMS are written there as { field, value }.
function cleanList(value, field = null, cut = null) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    if (typeof v !== 'string') continue;
    // "corrected spelling: Nike" is a note the AI wrote, not a name
    if (v.includes(':')) continue;
    const item = cleanItem(v);
    if (!item || out.some((o) => o.toLowerCase() === item.toLowerCase())) continue;
    if (out.length >= MAX_ITEMS) {
      if (cut) cut.push({ field, value: item });
      continue;
    }
    out.push(item);
  }
  return out;
}

/**
 * @returns { form, problem }
 *   form    the organised form, or null if the reply cannot be used
 *   problem why it cannot be used, in words the AI can act on when it is
 *           asked again (and that we can read in the log)
 */
function checkAiReply(replyText) {
  const text = String(replyText || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return { form: null, problem: 'there is no JSON object in it' };

  let p;
  try {
    p = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return { form: null, problem: 'the JSON is broken' };
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { form: null, problem: 'it is not one JSON object' };

  const primary = String(p.primary_goal || '').trim().toLowerCase();
  if (!GOAL_TYPES.includes(primary)) {
    return { form: null, problem: `primary_goal "${primary}" is not one of the goals in the GOAL LIST` };
  }
  return { form: buildForm(p, primary), problem: null };
}

// The organised form, or null if the reply cannot be used.
const readAiReply = (replyText) => checkAiReply(replyText).form;

function buildForm(p, primary) {
  const secondary = cleanList(p.secondary_goals)
    .map((g) => g.toLowerCase())
    .filter((g) => GOAL_TYPES.includes(g) && g !== primary);

  const cut = [];
  return {
    primary_goal: primary,
    secondary_goals: secondary,
    companies: cleanList(p.companies, 'companies', cut),
    places: cleanList(p.places, 'places', cut),
    industries: cleanList(p.industries, 'industries', cut),
    products: cleanList(p.products, 'products', cut),
    topics: cleanList(p.topics, 'topics', cut),
    metrics: cleanList(p.metrics, 'metrics', cut),
    cut_by_limit: cut,
    about_own_business: p.about_own_business === true,
    dashboard_request: p.dashboard_request === true,
    constraints: cleanList(p.constraints),
    implied: cleanList(p.implied),
    answer_format: typeof p.answer_format === 'string' ? cleanItem(p.answer_format).slice(0, 40) : '',
  };
}

// ═════════════════════════════════════════════════════════════════════════
// 4. "Is this really in the question?" (no AI — easy to test)
// ═════════════════════════════════════════════════════════════════════════
// Words that do not identify anything on their own.
const FILLER_WORDS = new Set([
  'the', 'and', 'of', 'for', 'in', 'on', 'a', 'an', 'to', 'de', 'la', 'le',
  'inc', 'ltd', 'llc', 'plc', 'co', 'corp', 'corporation', 'company', 'companies', 'group', 'holdings',
]);

// lower case, no accents, no punctuation: "L'Oréal" -> "loreal"
function normalise(text) {
  return String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
const words = (text) => normalise(text).split(' ').filter(Boolean);
const meaningfulWords = (text) => words(text).filter((w) => !FILLER_WORDS.has(w));

// Number of single-letter changes between two words (typo distance).
// Two letters swapped ("lroeal" for "loreal") counts as ONE change, because
// that is one typing slip.
function editDistance(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 99;
  let before = null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cur[j] = Math.min(cur[j], before[j - 2] + 1);
      }
    }
    before = prev;
    prev = cur;
  }
  return prev[b.length];
}

// Two words count as the same word if they are equal, or close enough to
// be a typo ("microsft" ~ "microsoft"), or one is the start of the other
// ("saudi" ~ "saudis").
function sameWord(a, b) {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4) {
    const allowed = Math.max(a.length, b.length) >= 7 ? 2 : 1;
    if (editDistance(a, b) <= allowed) return true;
    if (a.startsWith(b) || b.startsWith(a)) return true;
  }
  // a short word with one letter missing ("nke" ~ "nike"): same first letter,
  // the other word only one letter longer
  const [shortW, longW] = a.length <= b.length ? [a, b] : [b, a];
  if (shortW.length === 3 && longW.length === 4 && shortW[0] === longW[0] && editDistance(shortW, longW) === 1) return true;
  return false;
}

/**
 * Is this item (a company or a place the AI found) really in the question?
 *   - written the same way, or with typos ("aple" -> "Apple")
 *   - written together or apart ("loreal" -> "L'Oréal")
 *   - short form ("UAE" -> "United Arab Emirates", "P&G" -> "Procter & Gamble")
 */
function isInQuestion(item, question) {
  const qWords = words(question);
  const qJoined = qWords.join('');
  const itemWords = meaningfulWords(item);
  if (itemWords.length === 0) return false;

  // written together: "loreal" in "compare loreal and nivea"
  const joined = itemWords.join('');
  if (joined.length >= 3 && qJoined.includes(joined)) return true;

  // short form: first letters of the item's words ("UAE", "P&G" -> "pg")
  if (itemWords.length >= 2) {
    const initials = itemWords.map((w) => w[0]).join('');
    const qShort = words(String(question).replace(/(\p{L})\s*&\s*(\p{L})/gu, '$1$2'));
    if (qWords.includes(initials) || qShort.includes(initials)) return true;
  }

  // a short name written exactly ("EU", "UK", "HM")
  if (itemWords.some((iw) => qWords.includes(iw))) return true;

  // any meaningful word of the item is in the question (typos allowed)
  return itemWords.some((iw) => iw.length >= 3 && qWords.some((qw) => sameWord(iw, qw)));
}

// Mostly non-Latin letters (Arabic, Hindi, Chinese...)? Then the AI's
// names are translations and cannot be compared word by word.
function isMostlyNonLatin(text) {
  const letters = String(text).match(/\p{L}/gu) || [];
  if (letters.length === 0) return false;
  const latin = letters.filter((ch) => /[A-Za-zÀ-ɏ]/.test(ch)).length;
  return latin / letters.length < 0.5;
}

// ═════════════════════════════════════════════════════════════════════════
// 5. Matching companies to the client's list (no AI — easy to test)
// ═════════════════════════════════════════════════════════════════════════
function buildCompanyList(names) {
  const list = [];
  for (const c of names.competitors || []) {
    const keys = [c.name, c.name_key, c.search_name, ...(Array.isArray(c.aliases) ? c.aliases : [])]
      .filter(Boolean);
    list.push({ type: 'competitor', id: c.id, name: c.name, keys });
  }
  if (names.client && names.client.company_name) {
    list.push({ type: 'own_company', id: null, name: names.client.company_name, keys: [names.client.company_name] });
  }
  return list;
}

// Does this company name mean this list entry?
function sameCompany(asked, key) {
  const a = meaningfulWords(asked);
  const k = meaningfulWords(key);
  if (a.length === 0 || k.length === 0) return false;
  const aj = a.join('');
  const kj = k.join('');
  if (aj === kj) return true;
  if (aj.length >= 5 && kj.length >= 5 && editDistance(aj, kj) <= 1) return true;
  // every word of the shorter name is in the longer one, and both start
  // with the same word ("Estee Lauder" ~ "The Estée Lauder Companies",
  // but "Beauty" is NOT "Northwind Beauty Group")
  const [short, long] = a.length <= k.length ? [a, k] : [k, a];
  const shortLen = short.join('').length;
  if (shortLen < 3) return false;
  // a 3-letter name only counts when it is exactly the first word of the
  // longer name: "YSL" ~ "YSL Beauty" (typos are not allowed this short)
  if (shortLen === 3) return short.length === 1 && short[0] === long[0];
  if (!sameWord(short[0], long[0])) return false;
  return short.every((sw) => long.some((lw) => sameWord(sw, lw)));
}

function matchCompany(asked, companyList) {
  for (const entry of companyList) {
    if (entry.keys.some((key) => sameCompany(asked, key))) {
      return { type: entry.type, id: entry.id, name: entry.name };
    }
  }
  return null;
}

// Names from the client's list that are written in the question, even if
// the AI missed them. Whole words only.
function findListedCompaniesInQuestion(question, companyList) {
  const q = ` ${words(question).join(' ')} `;
  const found = [];
  for (const entry of companyList) {
    const hit = entry.keys.some((key) => {
      const k = meaningfulWords(key).join(' ');
      return k.length >= 3 && q.includes(` ${k} `);
    });
    if (hit) found.push(entry);
  }
  return found;
}

// ═════════════════════════════════════════════════════════════════════════
// 6. Turning date phrases into real dates (no AI — easy to test)
// ═════════════════════════════════════════════════════════════════════════
// All dates are plain calendar dates 'YYYY-MM-DD'.
// Rules (written once here, the same for every question):
//   last 5 years / past 3 months   -> from that many back, up to today
//   last month / last year         -> the whole previous calendar month / year
//   past month / past year         -> the last 1 month / year up to today
//   next 3 years / coming quarter  -> from today forward
//   this month / this year / YTD   -> from its first day up to today
//   2024 / March 2025 / Q1 2025    -> that whole year / month / quarter
//   3 March 2025 / 2025-03-03      -> that one day
//   March / Q1 (no year)           -> the most recent one that has started
//   March to June 2025, Jan-Mar 2025, between Q1 and Q3 2025, Nov 2024 - Feb 2025
//                                  -> from the start of the first to the end of
//                                     the second. A missing year is taken from
//                                     the other side ("Nov to Feb 2025" = Nov 2024).
//                                     No year at all: the most recent such range
//                                     that has started.
//   since March                    -> from the start of that month up to today
//   since 2020                     -> from 1 Jan 2020 up to today
//   FY2024                         -> treated as calendar year 2024 for now
//                                     (each company's own financial year
//                                     comes with the SEC layer)
const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const utc = (y, m, d) => new Date(Date.UTC(y, m, d));
const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n);
function addMonths(d, n) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const lastDay = utc(y, m + 1, 0).getUTCDate();
  return utc(y, m, Math.min(d.getUTCDate(), lastDay));
}
const monthStart = (y, m) => utc(y, m, 1);
const monthEnd = (y, m) => utc(y, m + 1, 0);

// Today's date where the chat runs (default India time).
function todayIn(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
  const [y, m, d] = parts.split('-').map(Number);
  return utc(y, m - 1, d);
}

const toYear = (txt) => {
  const n = Number(txt);
  return txt.length === 2 ? 2000 + n : n;
};
const range = (from, to) => ({ from: ymd(from), to: ymd(to) });

function unitOf(word) {
  const w = word.toLowerCase();
  if (w.startsWith('day')) return 'day';
  if (w.startsWith('w')) return 'week';
  if (w.startsWith('mo') || w.startsWith('mth')) return 'month';
  if (w.startsWith('q')) return 'quarter';
  return 'year';
}

function step(today, unit, n) {
  if (unit === 'day') return addDays(today, n);
  if (unit === 'week') return addDays(today, n * 7);
  if (unit === 'month') return addMonths(today, n);
  if (unit === 'quarter') return addMonths(today, n * 3);
  return addMonths(today, n * 12);
}

function calendarUnit(today, unit, offset) {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  if (unit === 'day') { const d = addDays(today, offset); return range(d, d); }
  if (unit === 'week') {
    const monday = addDays(today, -((today.getUTCDay() + 6) % 7));
    const start = addDays(monday, offset * 7);
    return range(start, addDays(start, 6));
  }
  if (unit === 'month') return range(monthStart(y, m + offset), monthEnd(y, m + offset));
  if (unit === 'quarter') {
    const q = Math.floor(m / 3) + offset;
    return range(monthStart(y, q * 3), monthEnd(y, q * 3 + 2));
  }
  return range(utc(y + offset, 0, 1), utc(y + offset, 11, 31));
}

// ── One point in time, in any form ("March", "3 March 2025", "Q1", "FY24") ──
// Returns { from, to, hasYear } as Dates, or null if it cannot be read.
// yearHint: the year to use when the text has none (null = the most recent
// one that has already started).
function readPoint(text, today, yearHint = null) {
  const t = text.toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) { const d = utc(+iso[1], +iso[2] - 1, +iso[3]); return { from: d, to: d, hasYear: true }; }
  const isoMonth = t.match(/^(\d{4})-(\d{2})$/);
  if (isoMonth) { const y = +isoMonth[1]; const m = +isoMonth[2] - 1; return { from: monthStart(y, m), to: monthEnd(y, m), hasYear: true }; }

  const yearMatch = t.match(/(?:^|\s|fy\s?'?)(\d{4}|'\d{2})$|^fy\s?'?(\d{2,4})$/);
  const fy = t.match(/^fy\s?'?(\d{2,4})$/);
  let year = null;
  if (fy) year = toYear(fy[1]);
  else if (yearMatch && yearMatch[1]) year = toYear(yearMatch[1].replace("'", ''));
  const body = (fy ? '' : t.replace(/\s*(?:fy\s?)?'?(\d{4}|'\d{2})$/, '')).trim();

  // what the point is, without its year: [startMonth, endMonth, day]
  let shape = null;
  const mon = (w) => MONTHS[w.slice(0, 3)];
  let m;
  if (fy || body === '') shape = [0, 11, null];                                    // a year
  else if ((m = body.match(/^q([1-4])$/))) shape = [(m[1] - 1) * 3, (m[1] - 1) * 3 + 2, null];
  else if ((m = body.match(/^q([1-4]) fy$/))) shape = [(m[1] - 1) * 3, (m[1] - 1) * 3 + 2, null];
  else if ((m = body.match(/^h([12])$/))) shape = m[1] === '1' ? [0, 5, null] : [6, 11, null];
  else if ((m = body.match(/^([a-z]+)$/)) && mon(m[1]) !== undefined) shape = [mon(m[1]), mon(m[1]), null];
  else if ((m = body.match(/^([a-z]+) ?(\d{1,2})(?:st|nd|rd|th)?$/)) && mon(m[1]) !== undefined) shape = [mon(m[1]), mon(m[1]), +m[2]];
  else if ((m = body.match(/^(\d{1,2})(?:st|nd|rd|th)? (?:of )?([a-z]+)$/)) && mon(m[2]) !== undefined) shape = [mon(m[2]), mon(m[2]), +m[1]];
  if (!shape) return null;
  const [m1, m2, day] = shape;

  const hasYear = year !== null;
  if (!hasYear) {
    if (body === '') return null;
    year = yearHint !== null ? yearHint : today.getUTCFullYear();
    // no year and no hint: the most recent one that has already started
    if (yearHint === null && utc(year, m1, day || 1) > today) year -= 1;
  }
  if (day !== null) {
    const d = utc(year, m1, day);
    if (d.getUTCMonth() !== m1) return null;                                     // "31 June"
    return { from: d, to: d, hasYear };
  }
  return { from: monthStart(year, m1), to: monthEnd(year, m2), hasYear };
}

// "between March and June 2025", "Jan-Mar 2025", "from Q1 to Q3 2025"
function readRange(text, today) {
  const t = text.replace(/^\s*(?:between|from)\s+/i, '');
  const parts =
    t.split(/\s+(?:and|to|through|till|until)\s+/i).length === 2 ? t.split(/\s+(?:and|to|through|till|until)\s+/i)
      : t.split(/\s*[–—]\s*|\s+-\s+/).length === 2 ? t.split(/\s*[–—]\s*|\s+-\s+/)
        : t.split(/-(?=[A-Za-z])|(?<=[A-Za-z.])-/).length === 2 ? t.split(/-(?=[A-Za-z])|(?<=[A-Za-z.])-/)
          : null;
  if (!parts) return null;

  let end = readPoint(parts[1], today);
  if (!end) return null;
  let start = readPoint(parts[0], today, end.hasYear ? end.to.getUTCFullYear() : null);
  if (!start) return null;
  if (!end.hasYear && !start.hasYear) {
    // "October to December", no year at all: the most recent such range that
    // has started (asked in Nov 2026 = Oct 2026 to Dec 2026)
    start = readPoint(parts[0], today);
    end = readPoint(parts[1], today, start.from.getUTCFullYear());
    if (end.to < start.from) end = readPoint(parts[1], today, start.from.getUTCFullYear() + 1);
  } else if (!end.hasYear && start.hasYear) {
    // "March 2024 to June": the end takes the start's year
    end = readPoint(parts[1], today, start.from.getUTCFullYear());
    if (end.to < start.from) end = readPoint(parts[1], today, start.from.getUTCFullYear() + 1);
  } else if (!start.hasYear && start.from > end.to) {
    // "Nov to Feb 2025": November is in the year before
    start = readPoint(parts[0], today, start.from.getUTCFullYear() - 1);
  }
  if (!start || !end || start.from > end.to) return null;
  return range(start.from, end.to);
}

function resolveOne(expr, today) {
  const t = expr.text.toLowerCase();
  const years = (t.match(/\d{4}|'?\d{2}\b/g) || []).map((x) => x.replace("'", ''));

  switch (expr.kind) {
    case 'year': {
      const y = Number(years[0]);
      return range(utc(y, 0, 1), utc(y, 11, 31));
    }
    case 'year_range': {
      const [a, b] = years.map(Number).sort((x, y) => x - y);
      return range(utc(a, 0, 1), utc(b, 11, 31));
    }
    case 'since': {
      const y = Number(years[0]);
      const mon = t.match(/since\s+([a-z]{3})/);
      const m = mon && MONTHS[mon[1]] !== undefined ? MONTHS[mon[1]] : 0;
      return range(utc(y, m, 1), today);
    }
    case 'fiscal_year': {
      const y = toYear(years[years.length - 1]);
      return { ...range(utc(y, 0, 1), utc(y, 11, 31)), note: 'financial year treated as calendar year' };
    }
    case 'quarter': {
      const word = { first: 1, second: 2, third: 3, fourth: 4, '1st': 1, '2nd': 2, '3rd': 3, '4th': 4 };
      const qm = t.match(/q([1-4])/) || t.match(/(first|second|third|fourth|1st|2nd|3rd|4th)/);
      const q = qm ? Number(word[qm[1]] || qm[1]) : 1;
      if (years.length === 0) {
        const p = readPoint(`q${q}`, today);
        return { ...range(p.from, p.to), note: 'no year given: the most recent one' };
      }
      const y = toYear(years[years.length - 1]);
      return range(monthStart(y, (q - 1) * 3), monthEnd(y, (q - 1) * 3 + 2));
    }
    case 'half_year': {
      const h = t.includes('h2') ? 2 : 1;
      if (years.length === 0) {
        const p = readPoint(`h${h}`, today);
        return { ...range(p.from, p.to), note: 'no year given: the most recent one' };
      }
      const y = toYear(years[years.length - 1]);
      return range(monthStart(y, h === 1 ? 0 : 6), monthEnd(y, h === 1 ? 5 : 11));
    }
    case 'month_year': {
      const m = MONTHS[t.slice(0, 3)];
      const y = Number(years[0]);
      return range(monthStart(y, m), monthEnd(y, m));
    }
    case 'range':
      return readRange(expr.text, today);
    case 'day': {
      const p = readPoint(expr.text, today);
      return p ? range(p.from, p.to) : null;
    }
    case 'month': {
      // "in October", "since March", "end of September", "March", "2026-10"
      if (/^\d{4}-\d{2}$/.test(t)) {
        const p = readPoint(t, today);
        return p ? range(p.from, p.to) : null;
      }
      const since = /^since\s/.test(t);
      const word = t.match(/[a-z]+\.?$/);
      const p = word ? readPoint(word[0], today) : null;
      if (!p) return null;
      if (since) return range(p.from, today);
      return { ...range(p.from, p.to), note: 'no year given: the most recent one' };
    }
    case 'current_period': {
      if (t === 'today') return range(today, today);
      if (t === 'yesterday') { const d = addDays(today, -1); return range(d, d); }
      if (t.includes('to date') || t.includes('to-date') || t === 'ytd') return range(utc(today.getUTCFullYear(), 0, 1), today);
      const unit = unitOf(t.split(/\s+/).pop());
      return { from: calendarUnit(today, unit, 0).from, to: ymd(today) };
    }
    case 'relative_period': {
      const numberWord = Object.keys(NUMBER_WORDS).join('|');
      const m = t.match(new RegExp(`^(last|past|previous|next|coming|upcoming)\\s+(?:(\\d{1,3}|${numberWord})\\s*)?([a-z]+)$`));
      if (!m) return null;
      const [, direction, count, unitWord] = m;
      const unit = unitOf(unitWord);
      const forward = ['next', 'coming', 'upcoming'].includes(direction);
      const n = count === undefined ? null : Number(count) || NUMBER_WORDS[count] || null;

      if (n === null && (direction === 'last' || direction === 'previous')) return calendarUnit(today, unit, -1);
      if (n === null && forward) return calendarUnit(today, unit, 1);
      const amount = n === null ? 1 : n;   // "past month" = 1 month
      if (forward) return range(addDays(today, 1), step(today, unit, amount));
      return range(addDays(step(today, unit, -amount), 1), today);
    }
    default:
      return null;
  }
}

/**
 * @param timeExpressions  the date phrases Step 2 found [{ text, kind }]
 * @param today            a Date (UTC midnight). Given by the tests; normally todayIn(CHAT_TIMEZONE)
 * @returns { ranges: [{ text, kind, from, to, note? }], from, to } or null if no dates
 */
function resolveTime(timeExpressions, today) {
  const ranges = [];
  const unread = [];
  for (const expr of timeExpressions || []) {
    let r = null;
    try { r = resolveOne(expr, today); } catch (err) { r = null; }
    if (r && r.from && r.to) ranges.push({ text: expr.text, kind: expr.kind, ...r });
    else unread.push(expr.text);
  }
  if (ranges.length === 0 && unread.length === 0) return null;
  return {
    ranges,
    from: ranges.length ? ranges.map((r) => r.from).sort()[0] : null,
    to: ranges.length ? ranges.map((r) => r.to).sort().slice(-1)[0] : null,
    unread,          // found as a date, but could not be turned into dates
  };
}

// ═════════════════════════════════════════════════════════════════════════
// 7. Is there anything to work on? (no AI — easy to test)
// ═════════════════════════════════════════════════════════════════════════
// Words that name a KIND of question, not WHAT it is about.
// "analysis", "revenue", "trends" alone tell us nothing to search for.
const GENERAL_WORDS = new Set([
  'analysis', 'analyse', 'analyze', 'report', 'reports', 'insight', 'insights', 'data', 'update', 'updates',
  'information', 'info', 'detail', 'details', 'overview', 'summary', 'summarise', 'trend', 'trends',
  'growth', 'revenue', 'revenues', 'sales', 'profit', 'profits', 'margin', 'margins', 'performance',
  'strategy', 'news', 'latest', 'market', 'markets', 'business', 'opportunity', 'opportunities',
  'risk', 'risks', 'competitor', 'competitors', 'comparison', 'compare', 'forecast', 'outlook', 'numbers',
  'swot', 'pestle', 'pestel', 'industry', 'sector', 'change', 'changes',
]);
const hasRealWord = (item) => meaningfulWords(item).some((w) => !GENERAL_WORDS.has(w));

// A question made ONLY of general words ("market", "show me market trends")
// is too vague, whatever the AI marked: the AI may guess "own business",
// but the user named nothing. Words that ask something ("what happened"),
// own words (we, my), rival words and dates make it a real question.
const ASK_FILLER = new Set(['show', 'give', 'tell', 'me', 'please', 'pls', 'plz', 'about', 'any', 'some', 'all', 'get']);
function onlyGeneralWords(question, cleaned) {
  if (isMostlyNonLatin(question)) return false;
  if (cleaned && cleaned.time_expressions && cleaned.time_expressions.length) return false;
  const ws = meaningfulWords(question);
  if (ws.length === 0) return true;
  return ws.every((w) => GENERAL_WORDS.has(w) || ASK_FILLER.has(w)) &&
    !ws.some((w) => (OWN_WORDS.has(w) && !ASK_FILLER.has(w)) || RIVAL_WORDS.has(w));
}

function hasSomethingToWorkOn(form) {
  if (form.companies.length || form.places.length) return true;
  if (form.about_own_business || form.dashboard_request) return true;
  return [...form.industries, ...form.products, ...form.topics].some(hasRealWord);
}

// ═════════════════════════════════════════════════════════════════════════
// 8. Code checks the AI's form (no AI, no database — easy to test)
// ═════════════════════════════════════════════════════════════════════════
/**
 * @param form       what readAiReply() returned
 * @param question   the cleaned question (Step 2)
 * @param names      { client: {company_name, industry}, competitors: [...] }
 * @returns the checked form + list of what was removed and why
 */
// ── Names only: words that point at someone instead of naming them ──────
// "we", "our brand", "my company"  -> the client's own company
const OWN_WORDS = new Set(['we', 'us', 'our', 'ours', 'my', 'mine', 'i', 'me', 'myself', 'ourselves']);
// "competitors", "rivals", "the competition" -> the client's competitor list
const RIVAL_WORDS = new Set(['competitor', 'competitors', 'competition', 'rival', 'rivals']);
// words that describe a KIND of company, not one company: "premium skincare brand"
const KIND_WORDS = new Set([
  'brand', 'brands', 'company', 'companies', 'firm', 'firms', 'player', 'players', 'business', 'businesses',
  'retailer', 'retailers', 'startup', 'startups', 'manufacturer', 'manufacturers', 'label', 'labels',
  'supplier', 'suppliers', 'competitor', 'competitors', 'rival', 'rivals', 'others', 'leaders',
]);
// words that make a "place" a market or topic, not a place: "beauty market", "my market"
const NOT_PLACE_WORDS = new Set([
  'market', 'markets', 'industry', 'industries', 'sector', 'sectors', 'segment', 'segments',
  'category', 'categories', 'business', 'space', 'channel', 'channels',
]);
const plainWords = (text) => normalise(text).split(' ').filter(Boolean);
const STANDARD_PLACES = new Set(Object.keys(PLACES));

// Did the user type any word of this item with a capital letter (not the
// first word of the question)? Real names usually have one ("Huda Beauty"),
// descriptions do not ("premium skincare brand").
function typedWithCapital(item, question) {
  const q = String(question);
  const firstWordEnd = (q.match(/^\s*\S+/) || [''])[0].length;
  return String(item).split(/\s+/).some((word) => {
    const w = word.replace(/[^\p{L}\p{N}&'-]/gu, '');
    if (w.length < 2) return false;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeForRegex(w)}(?![\\p{L}\\p{N}])`, 'giu');
    let m;
    while ((m = re.exec(q)) !== null) {
      if (m.index >= firstWordEnd && /\p{Lu}/u.test(m[0][0])) return true;
    }
    return false;
  });
}
const escapeForRegex = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// What kind of thing did the AI put in "companies"?
//   'own'   we / our brand / my company      -> the client's own company
//   'rivals' competitors / rivals             -> the client's competitor list
//   'kind'  premium skincare brand            -> a description, goes to topics
//   'name'  a real company name
//   'rivals+' cheaper competitors          -> the competitor list, and "cheaper competitors" to topics
function companyKind(item, question, checkCapitals) {
  const words = plainWords(item);
  const capital = checkCapitals ? typedWithCapital(item, question) : /\p{Lu}/u.test(String(item));
  if (capital) return 'name';          // "Lumiere Brands", "XYZ Company" are names
  if (words.some((w) => RIVAL_WORDS.has(w))) {
    const plain = words.every((w) => RIVAL_WORDS.has(w) || OWN_WORDS.has(w) || FILLER_WORDS.has(w) ||
      ['main', 'top', 'all', 'other', 'key', 'big', 'biggest', 'direct', 'closest'].includes(w));
    return plain ? 'rivals' : 'rivals+';
  }
  if (words.some((w) => OWN_WORDS.has(w))) return 'own';
  if (words.some((w) => KIND_WORDS.has(w))) return 'kind';
  return 'name';
}

// What kind of thing did the AI put in "places"?
//   'own'   my market / our region -> the client's own business, not a place
//   'topic' beauty market          -> a topic, not a place
//   'place' { standard, known }    -> known = in the standard place list
function placeKind(item) {
  const words = plainWords(item);
  if (words.some((w) => OWN_WORDS.has(w))) return { kind: 'own' };
  if (words.some((w) => NOT_PLACE_WORDS.has(w))) return { kind: 'topic' };
  for (const tryName of [item, normalise(item)]) {
    const standard = standardPlace(tryName);
    if (STANDARD_PLACES.has(standard)) return { kind: 'place', standard, known: true };
  }
  return { kind: 'place', standard: item, known: false };
}

// Is a known place hiding in a company entry? "China" -> a place, "UAE retail"
// -> the place UAE + the topic "UAE retail". "Emirates NBD" and "Saudi Aramco"
// stay names: the other word was typed with a capital letter.
function placeInCompany(item, question, checkCapitals) {
  const words = String(item).split(/\s+/).filter(Boolean);
  for (let size = Math.min(3, words.length); size >= 1; size -= 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      const piece = words.slice(start, start + size).join(' ');
      const p = placeKind(piece);
      if (p.kind !== 'place' || !p.known) continue;
      const rest = [...words.slice(0, start), ...words.slice(start + size)].join(' ');
      if (!rest) return { place: piece, topic: null };
      const restIsName = checkCapitals ? typedWithCapital(rest, question) : /\p{Lu}/u.test(rest);
      if (!restIsName) return { place: piece, topic: item };
      return null;
    }
  }
  return null;
}

function checkForm(form, question, names) {
  const removed = [];
  const skipChecks = isMostlyNonLatin(question);

  // Nothing is cut silently: items past the per-list limit are recorded.
  for (const c of form.cut_by_limit || []) {
    removed.push({ field: c.field, value: c.value, why: `over the limit of ${MAX_ITEMS} per list (kept the first ${MAX_ITEMS})` });
  }

  // Companies and places decide WHAT we search, so they must really be in
  // the question. (Topics and industries may be reworded by the AI —
  // "EV" -> "electric vehicles" — so they are not checked word by word.)
  const keepIfAsked = (field) => form[field].filter((item) => {
    if (skipChecks || isInQuestion(item, question)) return true;
    removed.push({ field, value: item, why: 'not in the question' });
    return false;
  });
  const askedCompanies = keepIfAsked('companies');
  const askedPlaces = keepIfAsked('places');
  const movedToTopics = [];
  let ownByName = false;
  let rivalsByName = false;

  // Companies hold NAMES only. A name on the client's list always stays.
  const companyList = buildCompanyList(names);
  const ownEntry = companyList.find((e) => e.type === 'own_company');
  const companies = [];
  const placesFromCompanies = [];
  for (const asked of askedCompanies) {
    if (matchCompany(asked, companyList)) { companies.push(asked); continue; }
    const hidden = placeInCompany(asked, question, !skipChecks);
    if (hidden) {
      placesFromCompanies.push(hidden.place);
      if (hidden.topic) movedToTopics.push(hidden.topic);
      removed.push({ field: 'companies', value: asked, why: hidden.topic
        ? `a place and a topic, not a company: "${hidden.place}" moved to places, "${hidden.topic}" to topics`
        : 'a place, not a company: moved to places' });
      continue;
    }
    const kind = companyKind(asked, question, !skipChecks);
    if (kind === 'name') { companies.push(asked); continue; }
    if (kind === 'own') {
      ownByName = true;
      if (ownEntry) companies.push(ownEntry.name);
      removed.push({ field: 'companies', value: asked, why: ownEntry ? `means the client own company, written as "${ownEntry.name}"` : 'means the client own company' });
    } else if (kind === 'rivals' || kind === 'rivals+') {
      rivalsByName = true;
      if (kind === 'rivals+') movedToTopics.push(asked);
      removed.push({ field: 'companies', value: asked, why: kind === 'rivals'
        ? 'means the client competitors (all_competitors)'
        : 'means the client competitors (all_competitors), the description is moved to topics' });
    } else {
      movedToTopics.push(asked);
      removed.push({ field: 'companies', value: asked, why: 'a description, not a company name: moved to topics' });
    }
  }

  // Places: every place gets the standard name the news pipeline saves.
  // Markets and "my market" are not places. A place not in the standard
  // list is kept and marked, never dropped.
  const places = [];
  const placesNotInList = [];
  for (const asked of [...askedPlaces, ...placesFromCompanies]) {
    const p = placeKind(asked);
    if (p.kind === 'own') {
      ownByName = true;
      removed.push({ field: 'places', value: asked, why: 'means the client own market, not a place' });
      continue;
    }
    if (p.kind === 'topic') {
      movedToTopics.push(asked);
      removed.push({ field: 'places', value: asked, why: 'a market or topic, not a place: moved to topics' });
      continue;
    }
    if (places.includes(p.standard)) {
      removed.push({ field: 'places', value: asked, why: `the same place as ${p.standard}` });
      continue;
    }
    if (p.standard !== asked) removed.push({ field: 'places', value: asked, why: `written with the standard name "${p.standard}"` });
    places.push(p.standard);
    if (!p.known) placesNotInList.push(p.standard);
  }

  // Match companies to the client's list; add listed names the AI missed.
  const matched = companies.map((asked) => ({ name: asked, matched: matchCompany(asked, companyList) }));
  for (const entry of findListedCompaniesInQuestion(question, companyList)) {
    const already = matched.some((c) => c.matched && c.matched.name === entry.name && c.matched.type === entry.type);
    if (!already) matched.push({ name: entry.name, matched: { type: entry.type, id: entry.id, name: entry.name } });
  }
  // The same listed company named twice ("Loreal", "L'Oreal") -> once.
  const companiesOut = [];
  for (const c of matched) {
    const dup = c.matched && companiesOut.some((o) => o.matched && o.matched.name === c.matched.name && o.matched.type === c.matched.type);
    if (!dup) companiesOut.push(c);
  }

  // "we / our / my / I" in an English question = about the client's own
  // business, even if the AI missed it.
  const ownWords = /\b(we|us|our|ours|my|mine|i)\b/i.test(String(question).replace(/\bI\.?\s?e\b/gi, ''));
  // "competitors" / "rivals" with no company named = the client's own
  // competitors ("Competitor activity since March"). With a company named
  // ("Nike's competitors") it is about that company instead.
  const ownCompetitors = rivalsByName ||
    (/\b(competitors?|rivals?)\b/i.test(String(question)) && companiesOut.length === 0);
  // Dates are worked out by code (resolveTime), so date words the AI put in
  // topics or metrics are taken out: metrics ["last 3 months"] -> [],
  // topics ["sales since 2020"] -> ["sales"]. (Product names are left alone:
  // some have years in them.)
  const withoutDates = (field) => form[field].flatMap((item) => {
    const p = preprocessText(item);
    if (p.time_expressions.length === 0) return [item];
    let rest = p.preprocessed_query;
    for (const t of p.time_expressions) rest = rest.split(t.text).join(' ');
    rest = rest.replace(/\s+/g, ' ').trim();
    // drop little words left hanging at either end: "revenue in" -> "revenue"
    const EDGE = /^(?:in|of|for|from|to|over|during|since|by|at|on|the|and|,|-)\s+|\s+(?:in|of|for|from|to|over|during|since|by|at|on|the|and|,|-)$/i;
    while (EDGE.test(rest)) rest = rest.replace(EDGE, '').trim();
    rest = rest.replace(/^[\s,.;-]+|[\s,.;-]+$/g, '').trim();
    const keep = meaningfulWords(rest).some((w) => w.length >= 3);
    removed.push({
      field,
      value: item,
      why: keep ? `date words taken out (dates are worked out separately), kept "${rest}"` : 'a date (dates are worked out separately)',
    });
    return keep ? [rest] : [];
  });

  const topics = withoutDates('topics');
  for (const t of movedToTopics) if (!topics.some((x) => x.toLowerCase() === t.toLowerCase())) topics.push(t);

  const { cut_by_limit: cutByLimit, ...rest } = form;   // already recorded in removed
  const checked = {
    ...rest,
    companies: companiesOut,
    places,
    places_not_in_list: placesNotInList,
    topics,
    metrics: withoutDates('metrics'),
    // the question is about the client's competitors in general (search all of them)
    all_competitors: ownCompetitors,
    about_own_business: form.about_own_business || ownWords || ownCompetitors || ownByName ||
      companiesOut.some((c) => c.matched && c.matched.type === 'own_company'),
  };
  return { checked, removed, checks_skipped: skipChecks ? 'question is mostly not in Latin letters' : null };
}

// Companies and places written in a non-Latin script (Hindi "भारत", Arabic "السعودية").
// (Latin letters with accents, like "L'Oréal" or "Türkiye", are fine.)
const isForeignWord = (text) => [...String(text)].some((ch) => /\p{L}/u.test(ch) && !/\p{Script=Latin}/u.test(ch));
const nonEnglishNames = (form) => [...form.companies, ...form.places].filter(isForeignWord);

// ═════════════════════════════════════════════════════════════════════════
// Step 5 main
// ═════════════════════════════════════════════════════════════════════════
/**
 * @param request  what Step 1 returned (needs client_id)
 * @param cleaned  what Step 2 returned (needs preprocessed_query, time_expressions)
 * @param options  { today } — only for tests; normally today's date in CHAT_TIMEZONE
 * @returns {
 *   status: 'understood' | 'clarification',
 *   message,            (only for clarification)
 *   primary_goal, secondary_goals,
 *   companies: [{ name, matched: { type: 'competitor'|'own_company', id, name } | null }],
 *              names only: "we/our brand" -> own company, "rivals" -> all_competitors,
 *              descriptions ("premium skincare brand") -> topics
 *   places     standard names (placeNames.js), markets ("beauty market") -> topics
 *   places_not_in_list   places kept but not in the standard list ("Atlantis")
 *   all_competitors      true = about the client competitors in general
 *   industries, products, topics, metrics,
 *   about_own_business, dashboard_request,
 *   time: { ranges, from, to } | null,
 *   constraints, implied, answer_format,
 *   client: { company_name, industry, competitors: [names on the client's list] },
 *   removed_by_check, checks_skipped, attempts
 * }
 * If the AI answered twice but its form could still not be used (for
 * example the question is just "A"), the user is asked back (status
 * 'clarification'), never shown an error. ChatError 503 only when the AI
 * could not be reached at all.
 *
 * @throws ChatError 503 if the AI could not be reached
 */
// The answer when we must ask the user back before understanding the question.
// Same shape as a normal answer, with everything empty.
function askBack(message, names, extra) {
  return {
    status: 'clarification',
    message,
    primary_goal: null, secondary_goals: [], companies: [], places: [], industries: [], products: [],
    places_not_in_list: [], all_competitors: false,
    topics: [], metrics: [], about_own_business: false, dashboard_request: false, constraints: [], implied: [],
    answer_format: '', time: null,
    client: { ...names.client, competitors: (names.competitors || []).map((c) => c.name) },
    removed_by_check: [], checks_skipped: null,
    ...extra,
  };
}

// Date words that could not be read: from Step 2 (never matched as a date)
// and from the date reader here (matched, but not a real date, e.g. "31 June").
function unreadDates(cleaned, time) {
  return [...new Set([...(cleaned.time_unclear || []), ...((time && time.unread) || [])])];
}

async function understandQuery(request, cleaned, options = {}) {
  const question = cleaned.preprocessed_query;
  const today = options.today || todayIn(CHAT_TIMEZONE);

  const [prompt, names] = await Promise.all([loadPrompt(), loadClientNames(request.client_id)]);

  // A date we could not read is never guessed: a wrong date gives a wrong
  // answer that looks right. Ask the user first (this costs no AI call).
  const time = resolveTime(cleaned.time_expressions, today);
  const unclear = unreadDates(cleaned, time);
  if (unclear.length) {
    console.log(`[DynamicRAG] understandQuery: could not read the date (${unclear.join(', ')}), asking the user back`);
    return askBack(TIME_UNCLEAR_MESSAGE.replace('{words}', unclear.join(', ')), names, {
      attempts: 0, time_unclear: unclear,
    });
  }

  const messages = [
    { role: 'system', content: prompt },
    { role: 'user', content: `Question:\n"""\n${question}\n"""` },
  ];

  // Ask the AI. If its reply cannot be used, ask once more and tell it
  // exactly what was wrong (the same idea the manager's doc uses for plans:
  // the code checks, and sends the AI back with the reason).
  let form = null;
  let attempts = 0;
  let lastProblem = '';
  let aiReplied = false;        // did the AI answer at all (even with an unusable form)?
  let conversation = messages;
  while (!form && attempts < MAX_ATTEMPTS) {
    attempts += 1;
    let reply = null;
    try {
      reply = await callLLM(conversation, { temperature: 0, max_tokens: 600, timeout: 30000, maxRetries: 2 });
    } catch (err) {
      lastProblem = `AI call failed: ${err.message}`;
    }
    if (reply !== null) {
      aiReplied = true;
      const checkedReply = checkAiReply(reply);
      let problem = checkedReply.problem;
      form = checkedReply.form;
      // Names must be in English ("India", not "भारत"), or the search later
      // cannot match them with our data. Ask once more; on the last try the
      // form is kept as it is.
      const foreign = form ? nonEnglishNames(form) : [];
      if (form && foreign.length && attempts < MAX_ATTEMPTS) {
        problem = `these companies or places are not written in English: ${foreign.join(', ')}. ` +
          'Write every company and place in English (for example India, Saudi Arabia, United Arab Emirates)';
        form = null;
      }
      if (!form) {
        lastProblem = `AI reply could not be used because ${problem}. Reply was: ${String(reply).slice(0, 300)}`;
        conversation = [
          ...messages,
          { role: 'assistant', content: String(reply) },
          {
            role: 'user',
            content: `That reply cannot be used because ${problem}. ` +
              'Reply again with ONLY the JSON object, and use only goals from the GOAL LIST.',
          },
        ];
      }
    }
    if (!form) console.log(`[DynamicRAG] understandQuery attempt ${attempts}: ${lastProblem}`);
  }
  if (!form && !aiReplied) {
    console.error(`[DynamicRAG] understandQuery gave up after ${attempts} attempts. ${lastProblem}`);
    throw new ChatError(503, 'AI_UNAVAILABLE', 'I could not process your question right now. Please try again in a moment.');
  }
  if (!form) {
    // The AI answered, but twice with nothing usable: the question gives too
    // little to work on ("A"). Ask the user back instead of showing an error.
    console.log(`[DynamicRAG] understandQuery: no usable form after ${attempts} attempts, asking the user back. ${lastProblem}`);
    return askBack(NO_TOPIC_MESSAGE, names, { attempts, ai_problem: lastProblem });
  }

  const { checked, removed, checks_skipped } = checkForm(form, question, names);
  const result = {
    status: 'understood',
    message: null,
    ...checked,
    time,
    client: { ...names.client, competitors: (names.competitors || []).map((c) => c.name) },
    removed_by_check: removed,
    checks_skipped,
    attempts,
  };

  if (!hasSomethingToWorkOn(checked) || onlyGeneralWords(question, cleaned)) {
    result.status = 'clarification';
    result.message = NO_TOPIC_MESSAGE;
  }
  return result;
}

module.exports = {
  understandQuery,
  // parts, exported for the test file
  GOAL_TYPES,
  readAiReply,
  checkAiReply,
  isInQuestion,
  matchCompany,
  buildCompanyList,
  checkForm,
  resolveTime,
  unreadDates,
  hasSomethingToWorkOn,
  onlyGeneralWords,
  nonEnglishNames,
};
