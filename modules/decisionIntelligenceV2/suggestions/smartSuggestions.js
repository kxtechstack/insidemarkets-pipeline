/**
 * smartSuggestions.js
 * =====================
 * Builds suggested questions for a client using their most recent
 * signals (title + summary) from the last 15 days.
 * Widens to 30 / 90 days if too few signals.
 *
 * One safeguard against hallucination:
 *   1. Prompt forces the LLM to cite the source signal ID for each question.
 *   2. Verification checks numbers and capitalized words in the question
 *      appear in that signal's title/summary. Questions that fail are dropped.
 *
 * Falls back to generic suggestions if 0 survive.
 */

const { createClient } = require('@supabase/supabase-js');
const { callLLM } = require('../../llmClient');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const MIN_ITEMS = 5;
const MAX_ITEMS = 20;
const SUMMARY_MAX_CHARS = 400;

// How many raw questions the LLM should generate. We generate more than
// we need so that after dropping bad ones we still end up with up to 4.
const LLM_QUESTION_COUNT = 6;
const FINAL_QUESTION_COUNT = 4;

const FALLBACK_SUGGESTIONS = [
  'What are the major policy changes in the last week?',
  'What recent market activity is happening in my sector?',
  'What consolidation activity is happening in my market?',
  'List the most recent regulatory filings recorded this quarter.',
];

// ────────────────────────────────────────────────────────────────────────
// Fetch recent signals
// ────────────────────────────────────────────────────────────────────────
async function fetchItemsForWindow(clientId, days) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const [p, m, f] = await Promise.all([
    supabase
      .from('policy_signals')
      .select('signal_title, summary, created_at')
      .eq('client_id', clientId)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(MAX_ITEMS),
    supabase
      .from('market_dynamics_signals')
      .select('signal_title, summary, published_date')
      .eq('client_id', clientId)
      .gte('published_date', cutoff)
      .order('published_date', { ascending: false })
      .limit(MAX_ITEMS),
    supabase
      .from('trend_signals')
      .select('signal_title, summary, created_at')
      .eq('client_id', clientId)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(MAX_ITEMS),
  ]);

  const rows = [
    ...(p.data || []),
    ...(m.data || []),
    ...(f.data || []),
  ];

  return rows
    .map((r) => ({
      title: (r.signal_title || '').trim(),
      summary: (r.summary || '').trim(),
    }))
    .filter((it) => it.title.length > 0);
}

async function getRecentItems(clientId) {
  let items = await fetchItemsForWindow(clientId, 15);
  if (items.length >= MIN_ITEMS) return items;

  items = await fetchItemsForWindow(clientId, 30);
  if (items.length >= MIN_ITEMS) return items;

  items = await fetchItemsForWindow(clientId, 90);
  return items;
}

// ────────────────────────────────────────────────────────────────────────
// LLM prompt
// ────────────────────────────────────────────────────────────────────────
const SUGGESTIONS_PROMPT = `You write suggested questions for a market intelligence chat. The user is an executive at a company. You will be given a numbered list of the client's recent signals. Each item has an ID, a TITLE, and a SUMMARY.

Write up to ${LLM_QUESTION_COUNT} questions the user would want to ask about THIS data. For each question, you MUST return the ID of the single signal that supports it.

HARD RULES — do not break these:
- Every question must be supported by EXACTLY ONE signal. Never combine two signals into one question.
- Return the signal's ID with each question (use the ID field given to you).
- Use ONLY information that appears literally in that ONE signal's title or summary.
- Do NOT invent a company, product, date, event, regulation, number, or topic that is not explicitly in that signal.
- If a name or number is not in the summary, do not use it.
- Do NOT ask generic category questions like "What's happening in my market?".

STYLE:
- Direct, plain English. Like a busy executive typing into a chat.
- Under 15 words each.
- Cover different signals — do not use the same signal twice.

Return ONLY this JSON, nothing else:
{
  "suggestions": [
    { "id": <signal_id_number>, "question": "<question text>" },
    { "id": <signal_id_number>, "question": "<question text>" }
  ]
}`;

// ────────────────────────────────────────────────────────────────────────
// Verification — token check
// ────────────────────────────────────────────────────────────────────────
const STOPWORDS = new Set([
  'the','a','an','and','or','but','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','could','should','may',
  'might','must','can','of','in','on','at','to','for','with','by','from','as',
  'what','how','why','when','where','who','which','this','that','these','those',
  'about','into','over','under','than','then','so','if','it','its','their',
  'his','her','our','your','my','we','you','they','he','she','i','me','us',
  'them','him','any','all','some','no','not','more','most','many','much',
  'very','just','also','only','even','still','yet','well','up','down','out',
  'new','latest','recent','recently','now','today','week','month','year',
  'whats','hows','whys','whens','wheres',
]);

const GENERIC_CAPITALIZED = new Set([
  'the','this','that','these','those','what','when','where','how','why','who','which',
  'is','are','was','were','be','been','being','a','an','and','or','but','for','of','to',
  'in','on','at','by','with','from','as','it','its','if','so','then','than',
  'will','would','could','should','can','may','might','must','do','does','did','have','has','had',
]);

function extractTokens(originalQuestion) {
  const tokens = new Set();

  const numberMatches = String(originalQuestion).match(/\d[\d,.]*/g) || [];
  for (const n of numberMatches) {
    tokens.add(n.replace(/,/g, ''));
  }

  const words = String(originalQuestion).match(/\b[A-Z][A-Za-z'&.\-]{2,}\b/g) || [];
  for (const w of words) {
    const lower = w.toLowerCase().replace(/[.\-']/g, '');
    if (lower.length < 3) continue;
    if (STOPWORDS.has(lower)) continue;
    if (GENERIC_CAPITALIZED.has(lower)) continue;
    tokens.add(lower);

    const parts = w.toLowerCase().split(/[.\-']+/).filter(Boolean);
    if (parts.length > 1) {
      const joined = parts.join('');
      if (joined.length >= 3 && !STOPWORDS.has(joined)) tokens.add(joined);
    }
  }

  return [...tokens];
}

function verifyQuestion(question, signal) {
  const rawHaystack = `${signal.title || ''} ${signal.summary || ''}`.toLowerCase();
  const haystack = rawHaystack + ' ' + rawHaystack.replace(/[.\-']/g, '');
  const tokens = extractTokens(question);

  for (const t of tokens) {
    if (!haystack.includes(t)) {
      return { ok: false, missingToken: t };
    }
  }
  return { ok: true };
}

// ────────────────────────────────────────────────────────────────────────
// LLM call
// ────────────────────────────────────────────────────────────────────────
async function generateSuggestionsWithLLM(items) {
  const block = items
    .slice(0, MAX_ITEMS)
    .map((it, i) => {
      const summary = it.summary.length > SUMMARY_MAX_CHARS
        ? it.summary.slice(0, SUMMARY_MAX_CHARS) + '…'
        : it.summary;
      return `ID: ${i + 1}\nTITLE: ${it.title}\nSUMMARY: ${summary || '(no summary)'}`;
    })
    .join('\n\n---\n\n');

  const raw = await callLLM(
    [
      { role: 'system', content: SUGGESTIONS_PROMPT },
      { role: 'user', content: `Client signals:\n\n${block}` },
    ],
    { temperature: 0.3, max_tokens: 700, timeout: 30000 }
  );

  let cleaned = String(raw || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/```\s*$/, '')
    .trim();

  const first = cleaned.indexOf('{');
  if (first === -1) throw new Error('no JSON in LLM output');
  let depth = 0;
  let end = -1;
  for (let i = first; i < cleaned.length; i++) {
    if (cleaned[i] === '{') depth++;
    else if (cleaned[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) throw new Error('unbalanced JSON in LLM output');

  const parsed = JSON.parse(cleaned.slice(first, end + 1));
  if (!Array.isArray(parsed.suggestions)) throw new Error('no suggestions array');

  return parsed.suggestions
    .filter((s) => s && typeof s === 'object' && typeof s.question === 'string' && Number.isInteger(s.id))
    .slice(0, LLM_QUESTION_COUNT);
}

// ────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────
async function getSmartSuggestions(clientId) {
  if (!clientId) return FALLBACK_SUGGESTIONS;

  let items = [];
  try {
    items = await getRecentItems(clientId);
  } catch (err) {
    console.log(`[smartSuggestions] fetch failed: ${err.message}`);
    return FALLBACK_SUGGESTIONS;
  }

  if (items.length < MIN_ITEMS) {
    console.log(`[smartSuggestions] only ${items.length} items in 90d — fallback`);
    return FALLBACK_SUGGESTIONS;
  }

  let raw;
  try {
    raw = await generateSuggestionsWithLLM(items);
  } catch (err) {
    console.log(`[smartSuggestions] LLM failed: ${err.message} — fallback`);
    return FALLBACK_SUGGESTIONS;
  }

  const verified = [];

  for (const item of raw) {
    if (verified.length >= FINAL_QUESTION_COUNT) break;

    const signal = items[item.id - 1];
    if (!signal) {
      console.log(`[smartSuggestions] DROP "${item.question}" — invalid id ${item.id}`);
      continue;
    }

    const tokenCheck = verifyQuestion(item.question, signal);
    if (!tokenCheck.ok) {
      console.log(`[smartSuggestions] DROP "${item.question}" — missing token "${tokenCheck.missingToken}" in signal ${item.id}`);
      continue;
    }

    verified.push(item.question);
  }

  if (verified.length === 0) {
    console.log(`[smartSuggestions] all ${raw.length} questions failed verification — fallback`);
    return FALLBACK_SUGGESTIONS;
  }

  console.log(`[smartSuggestions] kept ${verified.length} of ${raw.length} questions`);
  return verified;
}

module.exports = { getSmartSuggestions };