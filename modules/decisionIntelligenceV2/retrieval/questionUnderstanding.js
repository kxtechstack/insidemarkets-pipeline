/**
 * modules/decisionIntelligenceV2/retrieval/questionUnderstanding.js
 *
 * STAGE 2 — generic question understanding (industry_context removed).
 *
 * Changes from Stage 1g:
 *   1. Removed `industry_context` field entirely. The industry is always
 *      provided by the caller (from the frontend request) and passed as a
 *      filter to Qdrant. The LLM has no business guessing an industry.
 *
 * NOTE ON PROMPTS-IN-CODE: prompt lives in code during Stage 1/2. Moves to
 * public.prompts after cutover.
 */

const { callLLM } = require('../../llmClient');

// ─────────────────────────────────────────────────────────────────────────
// TODO (post-V2): move to DB under id 'di_v2_question_understanding_v1'
// ─────────────────────────────────────────────────────────────────────────
const QUESTION_UNDERSTANDING_PROMPT = `You are a question-understanding extractor for a market intelligence chat.

The user has asked a question. Extract structured metadata about WHAT the
question is asking — NOT what the answer is.

Return a JSON object with exactly these fields:

{
  "question_type": "list" | "explain" | "compare" | "analyze",
  "time_constraint": {
    "present": true | false,
    "value": <number|null>,
    "unit": "days" | "weeks" | "months" | "quarters" | "years" | null,
    "phrase": "<the exact phrase from the question, or null>"
  },
  "entity_mentions": ["<proper nouns from the question>"],
  "concept_keywords": ["<literal 1-2 word search terms>"],
  "primary_intent": "<one sentence summarizing what the user is looking for>",
  "is_company_set_query": true | false
}

=========================
RULES
=========================

--- question_type ---
- "list"    = enumeration
- "explain" = explanation
- "compare" = comparison
- "analyze" = deep analysis ("SWOT", "PESTLE", "five forces", "should we...")

--- time_constraint ---
Fill ONLY if the question has an explicit time window.

CRITICAL — value and unit MUST AGREE:

  "last week"        → { value: 7, unit: "days" }
  "last 2 weeks"     → { value: 14, unit: "days" }
  "past month"       → { value: 30, unit: "days" }
  "last 3 months"    → { value: 90, unit: "days" }
  "this quarter"     → { value: 90, unit: "days" }
  "recent" / "recently" → { value: 30, unit: "days" }
  "latest"           → { value: 14, unit: "days" }
  "today"            → { value: 1, unit: "days" }
  "yesterday"        → { value: 2, unit: "days" }

Never use a value greater than what fits in one year for that unit:
  ✗ { value: 7, unit: "weeks" }    — that's 7 weeks, not "a week"
  ✓ { value: 7, unit: "days" }

Also fill "phrase" with the exact text ("last week", "recent", etc.).

--- entity_mentions ---
Proper nouns ONLY: company names, brand names, regulator names, jurisdiction
names, city names.

NEVER include: industry names (Cosmetics, Beauty, Healthcare, Logistics,
Automobile, Airlines, Food, Retail, Technology, Finance, Pharmaceutical,
etc.), generic categories (sector, industry, market, business, brand,
company), acronyms (VC, PE, M&A, ESG, IPO, AI, ML), or common plural nouns
(products, brands, customers, consumers, competitors, users).

If the list would be empty, output [].

Real entity examples: "Glossier", "Estée Lauder", "L'Oréal", "FDA",
"European Union", "South Korea", "United Kingdom", "HMRC".

--- concept_keywords ---
3-6 keywords. Each keyword must be 1-2 WORDS.

CRITICAL: USE ALL THE SYNONYMS THAT WILL APPEAR IN THE ACTUAL ARTICLES.
Include the most common variants that journalists would use:

  Merger/acquisition topics → merger, acquisition, consolidation, takeover
  Funding topics            → funding, investment, raise, financing, round
  Regulation topics         → regulation, policy, compliance, rule, reform
  Layoff topics             → layoff, workforce, reduction
  Launch topics             → launch, introduced, unveiled

DO NOT include abstract labels or filler:
  ✗ activity, sector, industry, business, market, news, updates, changes,
    developments, brands, companies, rounds, items, things, reports,
    trends, growth
  ✗ time words
  ✗ question words
  ✗ 3+ word phrases

POSITIVE examples:
  Q: "policy changes last week"       → ["regulation", "policy", "compliance", "rule", "reform"]
  Q: "funding rounds"                 → ["funding", "investment", "raise", "financing", "round"]
  Q: "consolidation or merger"        → ["merger", "acquisition", "consolidation", "takeover"]
  Q: "what updates on glossier"       → ["glossier"]
  Q: "excise duty on vaping products" → ["excise duty", "vaping product", "duty", "tax", "levy"]

--- is_company_set_query ---
TRUE only for questions that ask to COMPARE FINANCIAL METRICS across a
SET of public companies ("top 5 cosmetic companies by revenue", "which tech
companies have the highest margins", "compare automotive companies' net
income"). FALSE for everything else.

A question about "our Cosmetics industry" is NOT a company-set query, even
though it mentions cosmetics.

--- greeting / off-topic ---
Return question_type: "explain", is_company_set_query: false, empty arrays.

=========================

Respond with ONLY the JSON object. No markdown fences, no explanation.`;

// ─────────────────────────────────────────────────────────────────────────
const UNIT_DAYS = {
  days: 1, weeks: 7, months: 30, quarters: 90, years: 365,
};

function fallbackUnderstanding(question) {
  return {
    question_type: 'list',
    time_constraint: { present: false, value: null, unit: null, phrase: null },
    entity_mentions: [],
    concept_keywords: [],
    primary_intent: String(question || '').slice(0, 200),
    is_company_set_query: false,
    _fallback: true,
  };
}

function stripFences(raw) {
  return String(raw || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/```\s*$/, '')
    .trim();
}

function findBalancedJson(s) {
  const first = s.indexOf('{');
  if (first === -1) return null;
  let depth = 0;
  for (let i = first; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) return s.slice(first, i + 1);
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Time normalizer (unchanged from Stage 1g)
// ─────────────────────────────────────────────────────────────────────────
function normalizeTimeConstraint(tc) {
  if (!tc || !tc.present || !tc.unit) return tc;

  let { value, unit, phrase } = tc;
  const phraseLower = String(phrase || '').toLowerCase();
  const llmDays = Number(value) * (UNIT_DAYS[unit] || 1);

  const digitUnitMatch = phraseLower.match(/(\d+)\s*(day|week|month|quarter|year)s?/);
  let phraseDays = null;
  if (digitUnitMatch) {
    const pv = Number(digitUnitMatch[1]);
    const pu = digitUnitMatch[2];
    const puMap = { day: 'days', week: 'weeks', month: 'months', quarter: 'quarters', year: 'years' };
    phraseDays = pv * (UNIT_DAYS[puMap[pu]] || 1);
  }

  if (phraseDays !== null && Math.abs(llmDays - phraseDays) < 0.1) {
    return { present: true, value, unit, phrase };
  }

  let namedDays = null;
  if (phraseLower.includes('week') && !phraseLower.match(/\d+\s*week/)) namedDays = 7;
  else if (phraseLower.includes('month') && !phraseLower.match(/\d+\s*month/)) namedDays = 30;
  else if (phraseLower.includes('quarter') && !phraseLower.match(/\d+\s*quarter/)) namedDays = 90;
  else if (phraseLower.includes('year') && !phraseLower.match(/\d+\s*year/)) namedDays = 365;
  else if (phraseLower.includes('today')) namedDays = 1;
  else if (phraseLower.includes('yesterday')) namedDays = 2;
  else if (phraseLower.includes('recent') || phraseLower.includes('latest')) namedDays = 30;

  if (namedDays !== null && Math.abs(llmDays - namedDays) < 0.1) {
    return { present: true, value, unit, phrase };
  }

  let corrected = false;
  if (namedDays !== null && Math.abs(llmDays - namedDays) >= 0.1) {
    value = namedDays;
    unit = 'days';
    corrected = true;
  } else if (phraseDays !== null && Math.abs(llmDays - phraseDays) >= 0.1) {
    const pv = Number(digitUnitMatch[1]);
    const pu = digitUnitMatch[2];
    const puMap = { day: 'days', week: 'weeks', month: 'months', quarter: 'quarters', year: 'years' };
    value = pv;
    unit = puMap[pu];
    corrected = true;
  }

  if (corrected) {
    console.log(
      `[questionUnderstanding] TIME NORMALIZED: ` +
      `phrase="${phrase}"  ${tc.value} ${tc.unit} → ${value} ${unit}`
    );
  }

  return { present: true, value, unit, phrase };
}

// ─────────────────────────────────────────────────────────────────────────
// Strippers (unchanged from Stage 1g)
// ─────────────────────────────────────────────────────────────────────────
function stripIndustryName(understanding, industry) {
  if (!industry) return understanding;

  const industryLower = String(industry).toLowerCase().trim();
  const industryWords = industryLower.split(/\s+/).filter((w) => w.length >= 3);
  const industriesToStrip = new Set([industryLower, ...industryWords]);

  const KNOWN_INDUSTRY_SYNONYMS = {
    cosmetics: ['cosmetic', 'beauty', 'skincare', 'makeup'],
    beauty: ['cosmetic', 'cosmetics', 'skincare', 'makeup'],
    healthcare: ['health care', 'health', 'medical'],
    'health care': ['healthcare', 'health', 'medical'],
    pharmaceutical: ['pharma', 'pharmaceuticals', 'drug'],
    logistics: ['shipping', 'freight', 'supply chain'],
    automobile: ['automotive', 'auto', 'car'],
    automotive: ['automobile', 'auto', 'car'],
    airlines: ['airline', 'aviation', 'air travel'],
    airline: ['airlines', 'aviation', 'air travel'],
  };
  if (KNOWN_INDUSTRY_SYNONYMS[industryLower]) {
    for (const s of KNOWN_INDUSTRY_SYNONYMS[industryLower]) {
      industriesToStrip.add(s);
    }
  }

  const isIndustryTerm = (term) => {
    const t = String(term).toLowerCase().trim();
    if (!t) return false;
    if (industriesToStrip.has(t)) return true;
    const firstWord = t.split(/\s+/)[0];
    if (industriesToStrip.has(firstWord)) return true;
    return false;
  };

  understanding.entity_mentions = (understanding.entity_mentions || [])
    .filter((e) => !isIndustryTerm(e));
  understanding.concept_keywords = (understanding.concept_keywords || [])
    .filter((k) => !isIndustryTerm(k));

  return understanding;
}

const ACRONYM_BLACKLIST = new Set([
  'vc', 'pe', 'm&a', 'ma', 'esg', 'ipo', 'b2b', 'b2c', 'd2c',
  'seo', 'kpi', 'roi', 'ebitda', 'arr', 'mrr', 'yoy', 'qoq',
  'ai', 'ml', 'ar', 'vr', 'iot', 'saas', 'paas', 'iaas',
]);

function stripAcronymEntities(understanding) {
  understanding.entity_mentions = (understanding.entity_mentions || [])
    .filter((e) => !ACRONYM_BLACKLIST.has(String(e).toLowerCase().trim()));
  return understanding;
}

const FILLER_CONCEPTS_SINGLE_WORD = new Set([
  'activity', 'activities', 'sector', 'sectors', 'industry', 'industries',
  'business', 'businesses', 'market', 'markets', 'news',
  'update', 'updates', 'change', 'changes',
  'development', 'developments', 'brand', 'brands',
  'company', 'companies', 'round', 'rounds',
  'item', 'items', 'thing', 'things',
  'report', 'reports', 'trend', 'trends', 'growth',
  'event', 'events', 'issue', 'issues', 'topic', 'topics',
  'product', 'products', 'service', 'services',
]);

function stripFillerConcepts(understanding) {
  understanding.concept_keywords = (understanding.concept_keywords || [])
    .filter((k) => {
      const words = String(k).toLowerCase().trim().split(/\s+/);
      if (words.length === 1 && FILLER_CONCEPTS_SINGLE_WORD.has(words[0])) return false;
      return true;
    });
  return understanding;
}

function stripNonProperNounEntities(understanding, question) {
  const q = String(question || '');
  understanding.entity_mentions = (understanding.entity_mentions || [])
    .filter((e) => {
      const trimmed = String(e).trim();
      if (!trimmed) return false;
      const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const reCS = new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?:[^A-Za-z0-9]|$)`);
      if (reCS.test(q)) return true;
      if (trimmed === trimmed.toUpperCase() && trimmed.length >= 2) {
        const reCI = new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?:[^A-Za-z0-9]|$)`, 'i');
        return reCI.test(q);
      }
      return false;
    });
  return understanding;
}

// ─────────────────────────────────────────────────────────────────────────
// Sanitize (industry_context removed)
// ─────────────────────────────────────────────────────────────────────────
const VALID_TYPES = new Set(['list', 'explain', 'compare', 'analyze']);
const VALID_UNITS = new Set(['days', 'weeks', 'months', 'quarters', 'years']);

function sanitizeUnderstanding(parsed, question) {
  const out = fallbackUnderstanding(question);

  if (parsed && typeof parsed === 'object') {
    let anyFieldApplied = false;

    if (VALID_TYPES.has(parsed.question_type)) {
      out.question_type = parsed.question_type;
      anyFieldApplied = true;
    }

    const tc = parsed.time_constraint;
    if (tc && typeof tc === 'object' && tc.present === true) {
      const value = Number(tc.value);
      if (Number.isFinite(value) && value > 0 && VALID_UNITS.has(tc.unit)) {
        out.time_constraint = {
          present: true,
          value,
          unit: tc.unit,
          phrase: typeof tc.phrase === 'string' ? tc.phrase : null,
        };
        anyFieldApplied = true;
      }
    }

    if (Array.isArray(parsed.entity_mentions)) {
      out.entity_mentions = parsed.entity_mentions
        .filter((e) => typeof e === 'string' && e.trim().length > 1)
        .map((e) => e.trim())
        .slice(0, 10);
      anyFieldApplied = true;
    }

    if (Array.isArray(parsed.concept_keywords)) {
      out.concept_keywords = parsed.concept_keywords
        .filter((k) => typeof k === 'string' && k.trim().length > 2)
        .map((k) => k.trim().toLowerCase())
        .filter((k) => k.split(/\s+/).length <= 2)
        .slice(0, 8);
      anyFieldApplied = true;
    }

    if (typeof parsed.primary_intent === 'string' && parsed.primary_intent.trim()) {
      out.primary_intent = parsed.primary_intent.trim().slice(0, 400);
      anyFieldApplied = true;
    }

    if (anyFieldApplied || typeof parsed.is_company_set_query === 'boolean') {
      out.is_company_set_query = parsed.is_company_set_query === true;
    }

    if (anyFieldApplied) out._fallback = false;
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────
async function understandQuestion(question, industry = null) {
  if (!question || typeof question !== 'string' || !question.trim()) {
    return fallbackUnderstanding(question);
  }

  let raw;
  try {
    raw = await callLLM(
      [
        { role: 'system', content: QUESTION_UNDERSTANDING_PROMPT },
        { role: 'user', content: question },
      ],
      { temperature: 0, max_tokens: 600, timeout: 30000 }
    );
  } catch (err) {
    console.log(`[questionUnderstanding] LLM call failed: ${err.message}`);
    return fallbackUnderstanding(question);
  }

  if (process.env.DI_V2_DEBUG_LLM === '1') {
    console.log('[questionUnderstanding] RAW LLM OUTPUT:');
    console.log(raw);
    console.log('[questionUnderstanding] END RAW');
  }

  const stripped = stripFences(raw);
  const jsonBlock = findBalancedJson(stripped);
  if (!jsonBlock) {
    console.log(`[questionUnderstanding] no JSON found in: ${stripped.slice(0, 200)}`);
    return fallbackUnderstanding(question);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonBlock);
  } catch (err) {
    console.log(`[questionUnderstanding] JSON parse failed: ${err.message}`);
    return fallbackUnderstanding(question);
  }

  let understanding = sanitizeUnderstanding(parsed, question);
  understanding.time_constraint = normalizeTimeConstraint(understanding.time_constraint);
  understanding = stripAcronymEntities(understanding);
  understanding = stripIndustryName(understanding, industry);
  understanding = stripFillerConcepts(understanding);
  understanding = stripNonProperNounEntities(understanding, question);

  return understanding;
}

module.exports = {
  understandQuestion,
  QUESTION_UNDERSTANDING_PROMPT,
  fallbackUnderstanding,
  sanitizeUnderstanding,
  stripIndustryName,
  stripAcronymEntities,
  stripFillerConcepts,
  stripNonProperNounEntities,
  normalizeTimeConstraint,
  UNIT_DAYS,
};