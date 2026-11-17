/**
 * modules/dynamicRag/preprocessQuery.js
 *
 * STEP 2 of the manager's doc — "Query preprocessing".
 * Plain code only, NO AI.
 *
 * Job: tidy the text so every later step gets the same clean input.
 * It must never change what the user means.
 *
 *   1. Tidy text        — extra spaces, invisible characters, "!!!" -> "!".
 *   2. Word list        — swap known short forms for the standard word
 *                         ("KSA" -> "Saudi Arabia"), using the dr_terms table.
 *   2b. Spelling        — fix obvious, high-confidence typos ("comapre" ->
 *                         "compare", "mnths" -> "months"), using a list of
 *                         English words with how common each word is. Names
 *                         are never changed: the client's company, its
 *                         competitors, places and word-list terms are
 *                         protected, and so is any word typed with a capital
 *                         letter or in CAPITALS. A word is only fixed when one
 *                         common word is clearly the best match; anything
 *                         unsure is left as typed (the AI in Step 5 reads it).
 *   3. Date phrases     — spot "last 5 years", "FY2024", "since 2020",
 *                         "March to June 2025", "in October"...
 *                         Only SPOT them. Turning them into real dates is a
 *                         later step's job. Date words that could not be read
 *                         are listed in time_unclear (never silently dropped).
 *   4. Keep both        — original question, cleaned question, and a list of
 *                         every word that was changed.
 *
 * What Step 2 does NOT do: guess the meaning, search any data, or decide if
 * the question is in scope.
 *
 * No client, brand or industry words live in this file. All word swaps
 * come from the dr_terms table, so they can be changed without code.
 */

const { createClient } = require('@supabase/supabase-js');
const { ChatError } = require('./chatError');
const fs = require('fs');
const path = require('path');
const { WORD_LIST_REFRESH_MS } = require('./chatConfig');
const { PLACES, standardPlace, placeFromAdjective } = require('../placeNames');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── 1. Tidy text ─────────────────────────────────────────────────────────
function cleanText(text) {
  let t = String(text == null ? '' : text);

  // Same letter can be stored in two ways (é as one character, or e + accent).
  // NFC makes it one way, so "Estée" always matches "Estée".
  t = t.normalize('NFC');

  // Invisible characters (come from copy-paste). They break word matching.
  t = t.replace(/[​-‍⁠﻿]/g, '');

  // Tabs, new lines and other control characters -> a normal space.
  t = t.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ');

  // Curly quotes -> plain quotes, so L’Oréal and L'Oréal are the same text.
  t = t.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"');

  // Many spaces -> one space. Remove spaces at both ends.
  t = t.replace(/\s+/g, ' ').trim();

  // "!!!" -> "!" and "???" -> "?". Other punctuation is left alone.
  t = t.replace(/([!?])\1+/g, '$1');

  return t;
}

// ── 2. Word list ─────────────────────────────────────────────────────────
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * terms: rows from dr_terms
 *   { term, replace_with, kind, entity_type, case_sensitive }
 *
 * Rules:
 *   - whole words only  ("yr" never changes "tyre")
 *   - longest term first ("Saudi Aramco" is checked before "Saudi")
 *   - one pass over the text, so a swapped-in word is never swapped again
 *   - a case_sensitive row only matches the exact capitals ("US", not "us")
 *   - kind = alias        -> written exactly as stored ("Saudi Arabia")
 *     kind = abbreviation / typo -> keeps the user's first capital letter
 */
function applyTerms(text, terms) {
  const rows = (terms || [])
    .map((r) => ({
      ...r,
      term: cleanText(r.term),
      replace_with: cleanText(r.replace_with),
    }))
    .filter((r) => r.term && r.replace_with);

  const corrections = [];
  const detected = {};          // entity_type -> [standard names]
  if (rows.length === 0) return { text, corrections, detected };

  const exact = new Map();      // case-sensitive rows, keyed by the exact term
  const loose = new Map();      // other rows, keyed by lower-case term
  for (const r of rows) {
    if (r.case_sensitive) exact.set(r.term, r);
    else loose.set(r.term.toLowerCase(), r);
  }

  const alternatives = [...new Set(rows.map((r) => r.term))]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join('|');

  // (?<![letter or digit]) ... (?![letter or digit])  = whole word only.
  // A word joined to another by & . ' = / is part of one code and is never
  // swapped: "r&d", "u.s.", "n=50", "AT&T" stay as typed.
  const matcher = new RegExp(`(?<![\\p{L}\\p{N}]|[\\p{L}\\p{N}][&.'=/])(?:${alternatives})(?![\\p{L}\\p{N}]|[&.'=/][\\p{L}\\p{N}])`, 'giu');

  const out = text.replace(matcher, (found) => {
    const row = exact.get(found) || loose.get(found.toLowerCase());
    if (!row) return found;     // e.g. "us" when only "US" is in the list

    // Names (aliases) are written exactly as stored. For ordinary words
    // (abbreviation / typo) keep the user's capital: "Comapre" -> "Compare".
    let replacement = row.replace_with;
    if (row.kind !== 'alias' && /^\p{Lu}/u.test(found) && /^\p{Ll}/u.test(replacement)) {
      replacement = replacement[0].toUpperCase() + replacement.slice(1);
    }

    if (found !== replacement) {
      const note = `${found} -> ${replacement}`;
      if (!corrections.includes(note)) corrections.push(note);
    }
    if (row.entity_type) {
      const list = detected[row.entity_type] || (detected[row.entity_type] = []);
      if (!list.includes(row.replace_with)) list.push(row.replace_with);
    }
    return replacement;
  });

  return { text: out, corrections, detected };
}

// ── 3. Date phrases ──────────────────────────────────────────────────────
// These are the date formats the chat understands. They are the same for
// every client, so they are safe to keep in code.
const YEAR = '(?:199\\d|20[0-4]\\d)';
const COUNT = '(?:\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
const UNIT = '(?:day|week|wk|month|mth|quarter|qtr|year|yr)s?';
const MONTH =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|' +
  'sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

// One POINT in time: a month (with or without year), a quarter, a half year,
// a financial year or a year. A RANGE is any point to any point, so every
// combination is understood the same way ("March to June 2025", "Jan-Mar 2025",
// "Q1 to Q3 2025", "between March and June 2025", "Nov 2024 - Feb 2025").
const MONTH_P = `${MONTH}\\.?`;
const DAY_NUM = '\\d{1,2}(?:st|nd|rd|th)?';
// a single day: "March 3rd", "3 March", "3rd of March 2025", "2025-03-03"
const DAY_POINT =
  `(?:\\d{4}-\\d{2}-\\d{2}|${MONTH_P}\\s*${DAY_NUM}(?:,?\\s+${YEAR})?|${DAY_NUM}\\s+(?:of\\s+)?${MONTH_P}(?:,?\\s+${YEAR})?)`;
const POINT_WITH_YEAR =
  `(?:${MONTH_P},?\\s+${YEAR}|Q[1-4]\\s?(?:FY\\s?)?'?(?:\\d{4}|\\d{2})|H[12]\\s?(?:\\d{4}|\\d{2})|FY\\s?'?(?:\\d{4}|\\d{2})|${YEAR})`;
const POINT_NO_YEAR = `(?:${MONTH_P}|Q[1-4]|H[12])`;
const POINT = `(?:${DAY_POINT}|${POINT_WITH_YEAR}|${POINT_NO_YEAR})`;
// A full month name with a capital letter is a date on its own ("compare March and
// June"). "May" is not here: "May I ..." is common; "in May" is found below.
// Only full names: short forms alone ("Mar Tech", "Jan" a person) are too often not dates.
const CAPITAL_MONTH = '(?:January|February|March|April|June|July|August|September|October|November|December)';
// Words that put a month with no year in a date ("in October", "since March").
const DATE_WORD = '(?:in|during|since|by|until|till|through|for|of|from|early|late|mid|end\\s+of|start\\s+of|beginning\\s+of)';

// Order matters: bigger phrases first, so "since 2020" is found before "2020",
// and "Q3 FY2025" is found as one quarter before "FY2025" alone.
const DATE_PATTERNS = [
  { kind: 'year_range',      re: `\\b(?:from\\s+)?${YEAR}\\s*(?:-|–|—|to|through|till|until)\\s*${YEAR}\\b` },
  { kind: 'year_range',      re: `\\bbetween\\s+${YEAR}\\s+and\\s+${YEAR}\\b` },
  { kind: 'range',           re: `\\bbetween\\s+${POINT}\\s+and\\s+${POINT}\\b` },
  { kind: 'range',           re: `\\b(?:from\\s+)?${POINT}\\s*(?:-|–|—|to|through|till|until)\\s*${POINT}\\b` },
  { kind: 'since',           re: `\\bsince\\s+(?:${MONTH}\\.?\\s+)?${YEAR}\\b` },
  { kind: 'quarter',         re: `\\bQ[1-4]\\s?(?:FY\\s?)?'?(?:\\d{4}|\\d{2})\\b` },
  { kind: 'quarter',         re: `\\b(?:first|second|third|fourth|1st|2nd|3rd|4th)\\s+quarter\\s+(?:of\\s+)?${YEAR}\\b` },
  { kind: 'fiscal_year',     re: `\\b(?:FY\\s?'?(?:\\d{4}|\\d{2})|(?:fiscal|financial)\\s+year\\s+(?:\\d{4}|\\d{2}))\\b` },
  { kind: 'half_year',       re: `\\bH[12]\\s?(?:\\d{4}|\\d{2})\\b` },
  { kind: 'relative_period', re: `\\b(?:last|past|previous|next|coming|upcoming)\\s+(?:${COUNT}\\s*)?${UNIT}\\b` },
  { kind: 'current_period',  re: `\\b(?:this|current)\\s+(?:week|month|quarter|year)\\b` },
  { kind: 'current_period',  re: `\\b(?:today|yesterday|year[\\s-]to[\\s-]date|YTD)\\b` },
  { kind: 'day',             re: `(?<![\\d/.,-])${DAY_POINT}(?![\\d/-])` },
  // a month written as 2026-10
  { kind: 'month',           re: `(?<![\\d/.,-])${YEAR}-(?:0[1-9]|1[0-2])(?![\\d/-])` },
  { kind: 'month_year',      re: `\\b${MONTH}\\.?,?\\s+${YEAR}\\b` },
  { kind: 'month',           re: `\\b${DATE_WORD}\\s+(?:the\\s+)?${MONTH_P}(?![\\w])(?!\\s*,?\\s*\\d)` },
  // "September and october", "March or april": the second month of a list
  // ("may" is left out: "and may affect" is not a date)
  { kind: 'month',           re: `(?<=${MONTH_P}\\s+(?:and|or|vs|versus|&)\\s+)(?!may\\b)${MONTH_P}(?![\\w])(?!\\s*,?\\s*\\d)` },
  { kind: 'month',           re: `\\b${CAPITAL_MONTH}\\.?(?![\\w])(?!\\s*,?\\s*\\d)`, flags: 'g' },
  // a quarter or half with no year ("Q1", "in H2"): the most recent one
  { kind: 'quarter',         re: `\\bQ[1-4]\\b(?!\\s*(?:FY\\s?)?'?\\d)`, flags: 'g' },
  { kind: 'half_year',       re: `\\bH[12]\\b(?!\\s*'?\\d)`, flags: 'g' },
  { kind: 'year',            re: `(?<![\\d.,$€£])\\b${YEAR}\\b(?![.,]?\\d)` },
];

function findDateSpans(text) {
  const found = [];
  const overlaps = (start, end) => found.some((f) => start < f.end && end > f.start);

  for (const { kind, re, flags } of DATE_PATTERNS) {
    const pattern = new RegExp(re, flags || 'gi');
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (!overlaps(start, end)) found.push({ text: m[0], kind, start, end });
    }
  }

  return found.sort((a, b) => a.start - b.start);
}

function detectTimeExpressions(text) {
  return findDateSpans(text).map(({ text: phrase, kind }) => ({ text: phrase, kind }));
}

// ── Date words that were NOT read ────────────────────────────────────────
// After the date phrases are found, any date word left over means a date was
// only partly understood. Step 5 then asks the user instead of guessing.
//   - a quarter / half year / FY word: Q1..Q4, H1, H2, FY..
//   - a month name written like a date: with a capital letter ("in May" is
//     found above; "March" alone with a capital), or next to a number
// (Years are always found by the "year" pattern, so they are never left over.)
const LEFT_DATE_WORDS = [
  // 03/04/2025 means March 4 or April 3 depending on the country: never guessed
  new RegExp('\\b\\d{1,2}[/.]\\d{1,2}[/.]\\d{2,4}\\b', 'g'),
  new RegExp(`\\b(?:Q[1-4]|H[12]|FY\\s?'?\\d{2,4})\\b`, 'g'),
  new RegExp(`\\b${CAPITAL_MONTH}\\b`, 'g'),
  new RegExp(`\\b${MONTH}\\.?\\s*\\d{1,2}(?:st|nd|rd|th)?\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b`, 'gi'),
];

function findUnreadDateWords(text, found) {
  const covered = (start, end) => found.some((f) => start >= f.start && end <= f.end);
  const left = [];
  for (const re of LEFT_DATE_WORDS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!covered(m.index, m.index + m[0].length) && !left.includes(m[0])) left.push(m[0]);
    }
  }
  return left;
}

// ── Spelling slips in date words ─────────────────────────────────────────
// "Janaury 2025", "last 3 mnths", "since Septmber", "past 2 yeras": a date
// word with one slip would be missed, and the question would silently get
// the wrong dates (or none). A word is fixed only when
//   - it is one slip away from a date word (two slips for long words), and
//   - it stands where a date word stands: next to a number or a year, or
//     after a date word like "last", "since", "in", "from"
// so "mouth care" never becomes "month care". Every fix is listed.
const DATE_WORD_LIST = [
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'month', 'months', 'week', 'weeks', 'year', 'years', 'quarter', 'quarters', 'today', 'yesterday',
];
const DATE_WORD_SET = new Set(DATE_WORD_LIST);
const DATE_LEAD_WORDS = new Set([
  'last', 'past', 'previous', 'next', 'coming', 'upcoming', 'this', 'since', 'in', 'from', 'to', 'until', 'till',
  'during', 'of', 'between', 'and', 'early', 'late', 'mid', 'end', 'start', 'by', 'for', 'before', 'after',
]);
const COUNT_WORDS = new Set(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'few', 'several']);

// Single-letter changes between two words; two letters swapped = one change.
function slips(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  if (a === b) return 0;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

function fixDateTypos(text) {
  const corrections = [];
  const tokens = String(text).split(/(\s+|[-–](?=\p{L}))/u);   // words, spaces and dashes ("Juen-Aug")
  const words = tokens.map((t, i) => ({ t, i })).filter((x) => x.t.trim());
  const isNumber = (w) => w && (/^\d{1,4}$/.test(w) || COUNT_WORDS.has(w));
  for (let k = 0; k < words.length; k++) {
    const raw = words[k].t;
    const core = raw.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    const w = core.toLowerCase();
    if (w.length < 4 || DATE_WORD_SET.has(w) || !/^\p{L}+$/u.test(w)) continue;
    const before = words[k - 1] ? words[k - 1].t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') : '';
    const after = words[k + 1] ? words[k + 1].t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') : '';
    // "Marhc to June": a range word, then a real date word ("Marco and Lisa" stays)
    const twoAfter = words[k + 2] ? words[k + 2].t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') : '';
    const afterRaw = words[k + 1] ? words[k + 1].t.trim() : '';
    const dateAfterRange = (['to', 'and', 'through', 'till', 'until'].includes(after) || ['-', '–'].includes(afterRaw)) &&
      (DATE_WORD_SET.has(twoAfter) || new RegExp(`^${MONTH}$`, 'i').test(twoAfter) || /^(199\d|20[0-4]\d)$/.test(twoAfter));
    const inDatePlace = isNumber(before) || /^(199\d|20[0-4]\d)$/.test(after) || DATE_LEAD_WORDS.has(before) || dateAfterRange;
    let best = null;
    for (const d of DATE_WORD_LIST) {
      const n = slips(w, d);
      const allowed = d.length >= 8 ? 2 : 1;
      // a tie goes to the word of the same length ("montsh" -> "months", not "month")
      const better = !best || n < best.n || (n === best.n && d.length === w.length && best.d.length !== w.length);
      if (n <= allowed && better) best = { d, n };
    }
    if (!best) continue;
    // "today" / "yesterday" stand alone ("tody alerts"); other words need a date place
    if (!inDatePlace && !['today', 'yesterday'].includes(best.d)) continue;
    // a unit word (months, weeks...) only right after a number or "last/past/next"
    const unit = /^(month|week|year|quarter)s?$/.test(best.d);
    if (unit && !(isNumber(before) || ['last', 'past', 'previous', 'next', 'coming', 'upcoming', 'this'].includes(before))) continue;
    const fixed = /^\p{Lu}/u.test(core) ? best.d[0].toUpperCase() + best.d.slice(1) : best.d;
    tokens[words[k].i] = raw.replace(core, fixed);
    corrections.push(`${core} -> ${fixed}`);
  }
  return { text: tokens.join(''), corrections };
}

// ── Spelling ─────────────────────────────────────────────────────────────
// data/englishWords.txt: ~82,000 English words, each with how often it is
// used (the free SymSpell frequency list, MIT licence). Read once, when the
// first question needs it.
let englishWords = null;          // word -> how common
let wordsByStart = null;          // first letter + length -> words
function loadEnglishWords() {
  if (englishWords) return;
  englishWords = new Map();
  wordsByStart = new Map();
  const file = path.join(__dirname, 'data', 'englishWords.txt');
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split('\n')) {
    const [w, n] = line.trim().split(' ');
    if (!w || !/^[a-z]+$/.test(w)) continue;
    englishWords.set(w, Number(n) || 0);
    const k = `${w[0]}${w.length}`;
    if (!wordsByStart.has(k)) wordsByStart.set(k, []);
    wordsByStart.get(k).push(w);
  }
}

// data/wordPairs.txt: ~242,000 pairs of English words with how often they
// appear together ("should we 121814400"). From the free SymSpell project
// (MIT licence). Used only to break a tie by looking at the next or the
// previous word: "latst trends" -> "latest trends" (common), not "last
// trends" (never seen). No word list kept by hand.
let wordPairs = null;             // "a b" -> how common
function loadWordPairs() {
  if (wordPairs) return;
  wordPairs = new Map();
  const file = path.join(__dirname, 'data', 'wordPairs.txt');
  if (!fs.existsSync(file)) {
    console.log('[DynamicRAG] preprocessQuery WARNING: data/wordPairs.txt is missing, spelling ties are left as typed');
    return;
  }
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split('\n')) {
    const [a, b, n] = line.trim().split(' ');
    if (a && b) wordPairs.set(`${a} ${b}`, Number(n) || 0);
  }
}
const pairCount = (a, b) => (a && b && wordPairs.get(`${a} ${b}`)) || 0;
const MIN_PAIR = 1000000;         // a pair must be seen at least this often to decide

const MIN_COMMON = 1000000;       // a fix must be a common word
const MAX_WORDS_TO_CHECK = 40;    // per question, so a very long question stays fast
const bestMatchCache = new Map(); // word -> best match (same answer every time)
const CLEAR_WINNER = 5;           // ... at least 5 times more common than the next one
const plainLower = (w) => String(w).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// Words that are never "fixed": names of the client, its competitors, places
// and word-list terms (and anything one slip away from them: "lancme").
function protectedWordSet(names) {
  const set = new Set();
  const add = (text) => {
    for (const w of plainLower(text).split(/[^a-z0-9]+/)) if (w.length >= 3) set.add(w);
  };
  for (const n of names || []) add(n);
  for (const [std, aliases] of Object.entries(PLACES)) { add(std); for (const a of aliases) add(a); }
  return set;
}
function nearProtected(w, protectedSet) {
  if (protectedSet.has(w)) return true;
  for (const p of protectedSet) {
    if (p.length < 4) continue;
    const allowed = Math.max(w.length, p.length) >= 7 ? 2 : 1;
    if (Math.abs(p.length - w.length) <= allowed && slips(w, p) <= allowed) return true;
  }
  return false;
}

/**
 * Fixes obvious typos. A word is fixed only when ALL of these are true:
 *   - it is 4+ letters, small letters (not a name typed with a capital or in
 *     CAPITALS; the first word of the question may start with a capital)
 *   - it is not an English word, and not a protected name (or close to one)
 *   - one common English word is one slip away (two for 7+ letters), starts
 *     with the same letter, and is clearly more common than any other match
 * @returns { text, corrections: ["comapre -> compare"] }
 */
function fixSpelling(text, protectedNames = []) {
  loadEnglishWords();
  const protectedSet = protectedWordSet(protectedNames);
  const corrections = [];
  const tokens = String(text).split(/(\s+|[-–/](?=\p{L}))/u);

  // first look at every word: is it English, a name, or a possible typo?
  const words = [];                 // { i, core, w, kind: 'english' | 'name' | 'typo' | 'other', fix }
  let firstWord = true;
  let checked = 0;
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    if (!raw || !raw.trim() || /^[-–/]$/.test(raw)) continue;
    const isFirst = firstWord;
    firstWord = false;
    const core = raw.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    const w = core.toLowerCase();
    const entry = { i, raw, core, w, kind: 'other', fix: null };
    words.push(entry);
    if (!/^[a-zA-Z]{4,}$/.test(core)) {                                   // short, accents, digits, apostrophes
      if (/^\p{L}{3,}$/u.test(core) && !englishWords.has(w)) entry.kind = 'name';
      continue;
    }
    if (englishWords.has(w)) { entry.kind = 'english'; continue; }
    if (/^[A-Z]{2,}/.test(core) || (/^[A-Z]/.test(core) && !isFirst) || nearProtected(w, protectedSet)) {
      entry.kind = 'name';                                                // KSA, Careem, lancme
      continue;
    }
    if (checked >= MAX_WORDS_TO_CHECK) { entry.kind = 'name'; continue; }
    checked += 1;
    entry.check = true;          // a possible typo (used again by the next-word check)
    if (!bestMatchCache.has(w)) {
      const allowed = w.length >= 7 ? 2 : 1;
      const found = [];
      for (let len = w.length - allowed; len <= w.length + allowed; len++) {
        for (const c of wordsByStart.get(`${w[0]}${len}`) || []) {
          const d = slips(w, c);
          if (d <= allowed) found.push({ c, d, n: englishWords.get(c) });
        }
      }
      found.sort((a, b) => a.d - b.d || b.n - a.n);
      const best = found[0];
      const rival = best && found.find((x) => x !== best && x.d === best.d);
      const sure = best && best.n >= MIN_COMMON && !(rival && rival.n * CLEAR_WINNER > best.n);
      if (bestMatchCache.size > 5000) bestMatchCache.clear();
      bestMatchCache.set(w, sure ? best.c : null);
    }
    const fix = bestMatchCache.get(w);
    if (fix) { entry.kind = 'typo'; entry.fix = fix; } else entry.kind = 'name';   // unsure: treat as a name, leave it
  }

  // The next-word check: a word left unsure (two words fit equally well, or
  // the best word is 2 slips away from a short word) is fixed when its
  // neighbour clearly decides: "latst trends" -> "latest" ("latest trends"
  // is common, "last trends" is never seen), "shud we" -> "should".
  // The neighbour is used as fixed above ("latst trnds" -> "latest trends").
  loadWordPairs();
  const asNow = (e) => (e ? (e.fix || e.w) : null);
  for (let k = 0; k < words.length; k++) {
    const e = words[k];
    if (!e.check || e.kind !== 'name' || !wordPairs.size) continue;
    const prev = asNow(words[k - 1]);
    const next = asNow(words[k + 1]);
    const found = [];
    for (let len = e.w.length - 2; len <= e.w.length + 2; len++) {
      for (const c of wordsByStart.get(`${e.w[0]}${len}`) || []) {
        if ((englishWords.get(c) || 0) < MIN_COMMON) continue;
        const d = slips(e.w, c);
        if (d <= 2) found.push({ c, d });
      }
    }
    // A fix must fit the words around it. With a word on both sides, a
    // candidate scores by the WEAKER of its two pairs, so it has to fit
    // both: "how shud we" -> "should" ("how should" and "should we" are both
    // common; "how she" is, but "she we" is not). A word that goes with
    // everything ("the last", "the latest") cannot decide alone.
    // Words one slip away are tried first, two slips only if none fits.
    const fit = (c) => {
      const p = pairCount(prev, c);
      const q = pairCount(c, next);
      if (prev && next) return Math.min(p, q);
      return Math.max(p, q);
    };
    let best = null;
    for (const tier of [1, 2]) {
      const ranked = found.filter((x) => x.d <= tier).map((x) => ({ ...x, s: fit(x.c) })).sort((p, q) => q.s - p.s || p.d - q.d);
      const [top, second] = ranked;
      if (top && top.s >= MIN_PAIR && !(second && second.s * CLEAR_WINNER > top.s)) { best = top; break; }
      if (ranked.some((x) => x.s >= MIN_PAIR)) break;     // 1-slip words fit, but none clearly: leave it
    }
    if (!best) continue;
    e.kind = 'typo';
    e.fix = best.c;
  }

  // a word in a list with a name is a name too: "careem and talabat", "nykaa, sephora"
  const LINKS = new Set(['and', 'or', 'vs', 'versus', '&', 'with']);
  // ...but not after "our", "the", "a": "our compny vs estee lauder" -> "company"
  const OWNER_WORDS = new Set(['our', 'my', 'your', 'their', 'his', 'her', 'its', 'the', 'a', 'an', 'this', 'that']);
  for (let k = 0; k < words.length; k++) {
    const e = words[k];
    if (e.kind !== 'typo') continue;
    const before = words[k - 1];
    if (before && OWNER_WORDS.has(before.w)) {
      const fixedHere = /^[A-Z]/.test(e.core) ? e.fix[0].toUpperCase() + e.fix.slice(1) : e.fix;
      tokens[e.i] = e.raw.replace(e.core, fixedHere);
      corrections.push(`${e.core} -> ${fixedHere}`);
      continue;
    }
    const linkedName = (dir) => {
      const link = words[k + dir];
      const other = words[k + 2 * dir];
      const comma = dir > 0 ? /,$/.test(e.raw) : (words[k - 1] && /,$/.test(words[k - 1].raw));
      if (comma && link && link.kind === 'name') return true;
      return Boolean(link && LINKS.has(link.w || link.raw.toLowerCase()) && other && other.kind === 'name');
    };
    if (linkedName(1) || linkedName(-1)) { e.kind = 'name'; continue; }
    const fixed = /^[A-Z]/.test(e.core) ? e.fix[0].toUpperCase() + e.fix.slice(1) : e.fix;
    tokens[e.i] = e.raw.replace(e.core, fixed);
    corrections.push(`${e.core} -> ${fixed}`);
  }
  return { text: tokens.join(''), corrections };
}

// ── The cleaning itself (no database — easy to test) ─────────────────────
// protectedNames: names never "fixed" (the client's company, its competitors);
// places and word-list terms are always protected.
// options.fixWords = false: only find the date words, never change other
// words. Spelling is fixed ONCE, here in Step 2, on the user's question.
// Later steps reuse this function only to find date words in the AI's text,
// and must not "fix" names in it ("Lancme" must not become "Lance").
function preprocessText(originalQuery, terms = [], protectedNames = [], options = {}) {
  const fixWords = options.fixWords !== false;
  const tidied = cleanText(originalQuery);
  const swapped = applyTerms(tidied, terms);
  // obvious typos, after the word list (a word-list term is never "fixed")
  if (fixWords) {
    // names from the word list are protected (KSA, Saudi Arabia); its
    // ordinary words are not ("opps" -> "opportunities" must not stop
    // "opportunites" from being fixed)
    const nameTerms = (terms || []).filter((t) => t.kind === 'alias' || t.entity_type);
    const spelling = fixSpelling(swapped.text, [...protectedNames, ...nameTerms.flatMap((t) => [t.term, t.replace_with])]);
    swapped.text = spelling.text;
    for (const c of spelling.corrections) if (!swapped.corrections.includes(c)) swapped.corrections.push(c);
  }
  // date words with a spelling slip are fixed before dates are spotted
  const dateFix = fixDateTypos(swapped.text);
  swapped.text = dateFix.text;
  for (const c of dateFix.corrections) if (!swapped.corrections.includes(c)) swapped.corrections.push(c);

  const spans = findDateSpans(swapped.text);

  return {
    original_query: originalQuery,              // untouched
    preprocessed_query: swapped.text,
    detected_terms: swapped.detected,
    time_expressions: spans.map(({ text: phrase, kind }) => ({ text: phrase, kind })),
    // date words that are in the question but were not read as a date
    // (Step 5 asks the user instead of guessing)
    time_unclear: findUnreadDateWords(swapped.text, spans),
    corrections_applied: swapped.corrections,
  };
}

// ── Word list from the database (kept in memory for a short time) ────────
let termsCache = { terms: [], ok: false, loadedAt: 0 };

async function loadTerms() {
  if (Date.now() - termsCache.loadedAt < WORD_LIST_REFRESH_MS) return termsCache;

  const { data, error } = await supabase
    .from('dr_terms')
    .select('term, replace_with, kind, entity_type, case_sensitive')
    .eq('is_active', true);

  if (error) {
    // The word list is a helper, not a must. Without it the question is
    // still tidied and dates are still spotted — only the word swaps are
    // skipped. So we carry on, and say so loudly in the log.
    console.log(`[DynamicRAG] preprocessQuery WARNING: word list (dr_terms) could not be loaded: ${error.message}`);
    termsCache = { terms: [], ok: false, loadedAt: Date.now() };
    return termsCache;
  }

  termsCache = { terms: data || [], ok: true, loadedAt: Date.now() };
  return termsCache;
}

// ── Step 2 main ──────────────────────────────────────────────────────────
/**
 * @param {object} request  what Step 1 returned (needs request.original_query)
 * @returns {
 *   original_query, preprocessed_query,
 *   detected_terms: { <type>: [names] },
 *   time_expressions: [{ text, kind }],
 *   time_unclear: ["March", ...]   date words that could not be read as a date
 *   corrections_applied: ["KSA -> Saudi Arabia", ...],
 *   word_list_loaded: true | false
 * }
 */
// The client: its own company, its competitors (names never "fixed" as
// typos) and its industry (used by Step 3 for its examples).
const namesCache = new Map();     // client id -> { client, loadedAt }

async function loadClient(clientId) {
  const empty = { names: [], companies: [], industry: null };
  if (!clientId) return empty;
  const hit = namesCache.get(clientId);
  if (hit && Date.now() - hit.loadedAt < WORD_LIST_REFRESH_MS) return hit.client;
  const [client, comps] = await Promise.all([
    supabase.schema('admin').from('clients').select('company_name, industry').eq('id', clientId).maybeSingle(),
    supabase.schema('admin').from('competitors').select('name, name_key, search_name, aliases').eq('client_id', clientId),
  ]);
  if (client.error || comps.error) {
    console.log(`[DynamicRAG] preprocessQuery WARNING: client names could not be loaded, spelling fixes skip them: ${(client.error || comps.error).message}`);
    return empty;
  }
  const own = client.data && client.data.company_name;
  // every company with all the ways it can be written
  const companies = [
    ...(own ? [{ name: own, kind: 'own company', keys: [own] }] : []),
    ...(comps.data || []).map((c) => ({
      name: c.name,
      kind: 'competitor',
      keys: [c.name, c.name_key, c.search_name, ...(Array.isArray(c.aliases) ? c.aliases : [])],
    })),
  ].map((c) => ({ ...c, keys: c.keys.filter((x) => typeof x === 'string' && x.trim()) }));
  const result = {
    names: companies.flatMap((c) => c.keys),
    companies,
    industry: (client.data && client.data.industry) || null,
  };
  namesCache.set(clientId, { client: result, loadedAt: Date.now() });
  return result;
}

async function loadClientNames(clientId) {
  return (await loadClient(clientId)).names;
}

// Which of the client's companies does the question name? Written in full
// ("Estee Lauder"), by its first word ("estee") or with one slip ("lancme").
// No AI. Used by Step 3, so a question that names a company is never asked
// back for "no topic".
function companiesNamed(text, companies) {
  const tokens = plainLower(text).split(/[^a-z0-9]+/).filter(Boolean);
  const joined = ` ${tokens.join(' ')} `;
  const out = [];
  for (const c of companies || []) {
    const hit = c.keys.some((k) => {
      const kw = plainLower(k).split(/[^a-z0-9]+/).filter(Boolean);
      if (!kw.length) return false;
      if (joined.includes(` ${kw.join(' ')} `)) return true;
      const first = kw[0] === 'the' ? kw[1] : kw[0];
      if (!first || first.length < 4) return false;
      return tokens.some((t) => t === first ||
        (t.length >= 5 && Math.abs(t.length - first.length) <= 1 && slips(t, first) <= 1));
    });
    if (hit && !out.some((o) => o.name === c.name)) out.push({ name: c.name, kind: c.kind });
  }
  return out;
}

// Which places does the question name? ("uae", "saudi", "the Indian market")
function placesNamed(text) {
  const typed = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  const tokens = typed.map((t) => t.toLowerCase());
  const out = [];
  // "Global" ("the world") is too general to count as a topic
  const add = (p) => { if (p && p !== 'Global' && !out.includes(p)) out.push(p); };
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const phrase = tokens.slice(i, i + n).join(' ');
      if (phrase.length < 2) continue;
      // a short code counts only in CAPITALS: "UK", "EU", "UAE" (not "in", "it", "us")
      if (n === 1 && phrase.length <= 3 && !/^[A-Z]+$/.test(typed[i])) continue;
      const p = standardPlace(phrase);
      if (p && p.toLowerCase() !== phrase) add(p);            // a known place, written another way
      else if (p && PLACES[p]) add(p);                          // a known place, written the standard way
    }
  }
  for (let i = 0; i < tokens.length - 1; i++) {
    if (/^(market|markets|mkt|mkts|consumers|shoppers|customers|economy|government|retail|brands?)$/.test(tokens[i + 1])) {
      add(placeFromAdjective(tokens[i]));
    }
  }
  return out;
}

async function preprocessQuery(request) {
  const [wordList, client] = await Promise.all([loadTerms(), loadClient(request.client_id)]);
  const result = preprocessText(request.original_query, wordList.terms, client.names);

  // A question made only of invisible characters is empty once cleaned.
  if (!result.preprocessed_query) {
    throw new ChatError(400, 'EMPTY_QUESTION', 'Please type a question.');
  }

  return {
    ...result,
    word_list_loaded: wordList.ok,
    // for Step 3: what the question clearly names (found by code, no AI)
    companies_named: companiesNamed(result.preprocessed_query, client.companies),
    places_named: placesNamed(result.preprocessed_query),
    client_industry: client.industry,
  };
}

module.exports = {
  preprocessQuery,
  preprocessText,
  companiesNamed,
  placesNamed,
  fixDateTypos,
  fixSpelling,
};
