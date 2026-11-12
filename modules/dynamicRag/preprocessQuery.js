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
 *   3. Date phrases     — spot "last 5 years", "FY2024", "since 2020"...
 *                         Only SPOT them. Turning them into real dates is a
 *                         later step's job.
 *   4. Keep both        — original question, cleaned question, and a list of
 *                         every word that was changed.
 *
 * What Step 2 does NOT do: guess the meaning, fix spelling by itself,
 * search any data, or decide if the question is in scope.
 *
 * No client, brand or industry words live in this file. All word swaps
 * come from the dr_terms table, so they can be changed without code.
 */

const { createClient } = require('@supabase/supabase-js');
const { ChatError } = require('./chatError');
const { WORD_LIST_REFRESH_MS } = require('./chatConfig');

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

  // (?<![letter or digit]) ... (?![letter or digit])  = whole word only
  const matcher = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, 'giu');

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

// Order matters: bigger phrases first, so "since 2020" is found before "2020",
// and "Q3 FY2025" is found as one quarter before "FY2025" alone.
const DATE_PATTERNS = [
  { kind: 'year_range',      re: `\\b(?:from\\s+)?${YEAR}\\s*(?:-|–|—|to|through|till|until)\\s*${YEAR}\\b` },
  { kind: 'year_range',      re: `\\bbetween\\s+${YEAR}\\s+and\\s+${YEAR}\\b` },
  { kind: 'since',           re: `\\bsince\\s+(?:${MONTH}\\.?\\s+)?${YEAR}\\b` },
  { kind: 'quarter',         re: `\\bQ[1-4]\\s?(?:FY\\s?)?'?(?:\\d{4}|\\d{2})\\b` },
  { kind: 'quarter',         re: `\\b(?:first|second|third|fourth|1st|2nd|3rd|4th)\\s+quarter\\s+(?:of\\s+)?${YEAR}\\b` },
  { kind: 'fiscal_year',     re: `\\b(?:FY\\s?'?(?:\\d{4}|\\d{2})|(?:fiscal|financial)\\s+year\\s+(?:\\d{4}|\\d{2}))\\b` },
  { kind: 'half_year',       re: `\\bH[12]\\s?(?:\\d{4}|\\d{2})\\b` },
  { kind: 'relative_period', re: `\\b(?:last|past|previous|next|coming|upcoming)\\s+(?:${COUNT}\\s*)?${UNIT}\\b` },
  { kind: 'current_period',  re: `\\b(?:this|current)\\s+(?:week|month|quarter|year)\\b` },
  { kind: 'current_period',  re: `\\b(?:today|yesterday|year[\\s-]to[\\s-]date|YTD)\\b` },
  { kind: 'month_year',      re: `\\b${MONTH}\\.?\\s+${YEAR}\\b` },
  { kind: 'year',            re: `(?<![\\d.,$€£])\\b${YEAR}\\b(?![.,]?\\d)` },
];

function detectTimeExpressions(text) {
  const found = [];
  const overlaps = (start, end) => found.some((f) => start < f.end && end > f.start);

  for (const { kind, re } of DATE_PATTERNS) {
    const pattern = new RegExp(re, 'gi');
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (!overlaps(start, end)) found.push({ text: m[0], kind, start, end });
    }
  }

  return found
    .sort((a, b) => a.start - b.start)
    .map(({ text: phrase, kind }) => ({ text: phrase, kind }));
}

// ── The cleaning itself (no database — easy to test) ─────────────────────
function preprocessText(originalQuery, terms = []) {
  const tidied = cleanText(originalQuery);
  const swapped = applyTerms(tidied, terms);

  return {
    original_query: originalQuery,              // untouched
    preprocessed_query: swapped.text,
    detected_terms: swapped.detected,
    time_expressions: detectTimeExpressions(swapped.text),
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
 *   corrections_applied: ["KSA -> Saudi Arabia", ...],
 *   word_list_loaded: true | false
 * }
 */
async function preprocessQuery(request) {
  const wordList = await loadTerms();
  const result = preprocessText(request.original_query, wordList.terms);

  // A question made only of invisible characters is empty once cleaned.
  if (!result.preprocessed_query) {
    throw new ChatError(400, 'EMPTY_QUESTION', 'Please type a question.');
  }

  return { ...result, word_list_loaded: wordList.ok };
}

module.exports = { preprocessQuery, preprocessText };
