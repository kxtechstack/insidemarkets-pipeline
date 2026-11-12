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
const {
  UNDERSTAND_PROMPT_ID,
  PROMPT_REFRESH_MS,
  CHAT_TIMEZONE,
  NO_TOPIC_MESSAGE,
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
const MAX_ITEMS = 10;          // per list (companies, places...)
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

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    if (typeof v !== 'string') continue;
    // "corrected spelling: Nike" is a note the AI wrote, not a name
    if (v.includes(':')) continue;
    const item = cleanItem(v);
    if (item && !out.some((o) => o.toLowerCase() === item.toLowerCase())) out.push(item);
    if (out.length >= MAX_ITEMS) break;
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

  return {
    primary_goal: primary,
    secondary_goals: secondary,
    companies: cleanList(p.companies),
    places: cleanList(p.places),
    industries: cleanList(p.industries),
    products: cleanList(p.products),
    topics: cleanList(p.topics),
    metrics: cleanList(p.metrics),
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
function editDistance(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
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
  if (short.join('').length < 4) return false;
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
      const y = toYear(years[years.length - 1]);
      return range(monthStart(y, (q - 1) * 3), monthEnd(y, (q - 1) * 3 + 2));
    }
    case 'half_year': {
      const h = t.includes('h2') ? 2 : 1;
      const y = toYear(years[years.length - 1]);
      return range(monthStart(y, h === 1 ? 0 : 6), monthEnd(y, h === 1 ? 5 : 11));
    }
    case 'month_year': {
      const m = MONTHS[t.slice(0, 3)];
      const y = Number(years[0]);
      return range(monthStart(y, m), monthEnd(y, m));
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
  for (const expr of timeExpressions || []) {
    let r = null;
    try { r = resolveOne(expr, today); } catch (err) { r = null; }
    if (r && r.from && r.to) ranges.push({ text: expr.text, kind: expr.kind, ...r });
  }
  if (ranges.length === 0) return null;
  return {
    ranges,
    from: ranges.map((r) => r.from).sort()[0],
    to: ranges.map((r) => r.to).sort().slice(-1)[0],
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
function checkForm(form, question, names) {
  const removed = [];
  const skipChecks = isMostlyNonLatin(question);

  // Companies and places decide WHAT we search, so they must really be in
  // the question. (Topics and industries may be reworded by the AI —
  // "EV" -> "electric vehicles" — so they are not checked word by word.)
  const keepIfAsked = (field) => form[field].filter((item) => {
    if (skipChecks || isInQuestion(item, question)) return true;
    removed.push({ field, value: item, why: 'not in the question' });
    return false;
  });
  const companies = keepIfAsked('companies');
  const places = keepIfAsked('places');

  // Match companies to the client's list; add listed names the AI missed.
  const companyList = buildCompanyList(names);
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
  const checked = {
    ...form,
    companies: companiesOut,
    places,
    about_own_business: form.about_own_business || ownWords ||
      companiesOut.some((c) => c.matched && c.matched.type === 'own_company'),
  };
  return { checked, removed, checks_skipped: skipChecks ? 'question is mostly not in Latin letters' : null };
}

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
 *   places, industries, products, topics, metrics,
 *   about_own_business, dashboard_request,
 *   time: { ranges, from, to } | null,
 *   constraints, implied, answer_format,
 *   client: { company_name, industry },
 *   removed_by_check, checks_skipped, attempts
 * }
 * @throws ChatError 503 if the AI could not give a usable reply
 */
async function understandQuery(request, cleaned, options = {}) {
  const question = cleaned.preprocessed_query;
  const today = options.today || todayIn(CHAT_TIMEZONE);

  const [prompt, names] = await Promise.all([loadPrompt(), loadClientNames(request.client_id)]);

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
      const checkedReply = checkAiReply(reply);
      form = checkedReply.form;
      if (!form) {
        lastProblem = `AI reply could not be used because ${checkedReply.problem}. Reply was: ${String(reply).slice(0, 300)}`;
        conversation = [
          ...messages,
          { role: 'assistant', content: String(reply) },
          {
            role: 'user',
            content: `That reply cannot be used because ${checkedReply.problem}. ` +
              'Reply again with ONLY the JSON object, and use only goals from the GOAL LIST.',
          },
        ];
      }
    }
    if (!form) console.log(`[DynamicRAG] understandQuery attempt ${attempts}: ${lastProblem}`);
  }
  if (!form) {
    console.error(`[DynamicRAG] understandQuery gave up after ${attempts} attempts. ${lastProblem}`);
    throw new ChatError(503, 'AI_UNAVAILABLE', 'I could not process your question right now. Please try again in a moment.');
  }

  const { checked, removed, checks_skipped } = checkForm(form, question, names);
  const result = {
    status: 'understood',
    message: null,
    ...checked,
    time: resolveTime(cleaned.time_expressions, today),
    client: names.client,
    removed_by_check: removed,
    checks_skipped,
    attempts,
  };

  if (!hasSomethingToWorkOn(checked)) {
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
  hasSomethingToWorkOn,
};
