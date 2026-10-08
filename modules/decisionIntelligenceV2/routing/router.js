/**
 * modules/decisionIntelligenceV2/routing/router.js
 */

const { callLLM } = require('../../llmClient');

const ROUTER_PROMPT = `You are a classifier for a market intelligence chat assistant.

The user has asked a question. Analyze it and return structured metadata
describing what they want.

Return ONLY this JSON object:

{
  "intent": "greeting" | "off_topic" | "clarification" | "market_intelligence",
  "type": "list" | "inference" | "decision",
  "time_constraint": {
    "present": true | false,
    "value": <number|null>,
    "unit": "days" | "weeks" | "months" | "quarters" | "years" | null,
    "phrase": "<exact phrase from the question, or null>"
  },
  "entity_mentions": ["<proper nouns from the question>"],
  "concept_keywords": ["<literal 1-2 word search terms>"],
  "sector_term": "<the industry or sector word the question is about, or null>",
  "metrics_found": ["Revenue" | "NetIncome" | "TotalAssets" | "TotalLiabilities" | "CashFlow" | "CapEx"],
  "framework": "swot" | "pestle" | "five_forces" | "risk_analysis" | null,
  "is_company_set_query": true | false,
  "primary_intent": "<one sentence summarizing what the user wants, or a short reply if intent is not market_intelligence>"
}

=========================
FIELD RULES
=========================

--- intent ---
- "greeting"      = hello, hi, thanks, bye, ok, or any short social message
- "off_topic"     = not about business/market/finance (weather, jokes, general chat)
- "clarification" = too vague to answer ("hmm", "i don't know", "help")
- "market_intelligence" = a real business/market/finance question

If intent is NOT "market_intelligence", put a short friendly reply in
"primary_intent" that the assistant can say back to the user.

--- type --- (only matters when intent = market_intelligence)
- "list"      = user wants a LIST of items.
- "inference" = user wants an EXPLANATION or ANALYSIS.
- "decision"  = user wants a DEEP analysis requiring STRUCTURED FRAMEWORKS
                or COMPARISONS.

When unsure between list and inference, prefer "list".
When unsure between inference and decision, prefer "inference".

--- time_constraint ---
Fill ONLY if the question has an explicit time window.

  "last week"      → { "value": 7,  "unit": "days",  "phrase": "last week" }
  "last 2 weeks"   → { "value": 14, "unit": "days",  "phrase": "last 2 weeks" }
  "recent"         → { "value": 30, "unit": "days",  "phrase": "recent" }
  "latest"         → { "value": 14, "unit": "days",  "phrase": "latest" }
  "past quarter"   → { "value": 90, "unit": "days",  "phrase": "past quarter" }
  "today"          → { "value": 1,  "unit": "days",  "phrase": "today" }
  "yesterday"      → { "value": 2,  "unit": "days",  "phrase": "yesterday" }
  "last year"      → { "value": 1,  "unit": "years", "phrase": "last year" }
  "this year"      → { "value": 1,  "unit": "years", "phrase": "this year" }
  "last 3 years"   → { "value": 3,  "unit": "years", "phrase": "last 3 years" }
  "last 5 yer"     → { "value": 5,  "unit": "years", "phrase": "last 5 yer" }
  "last 3 yr"      → { "value": 3,  "unit": "years", "phrase": "last 3 yr" }
  "2024 and 2023"  → { "value": null, "unit": null, "phrase": "2024 and 2023" }

Never use a value greater than what fits in one year for that unit:
  ✗ { "value": 7, "unit": "weeks" }
  ✓ { "value": 7, "unit": "days" }

Recognize misspelled time units ("yer", "yr", "yers", "yrs", "mth", "wk")
as their proper units. If the phrase is explicit years like "2024 and
2023", set present: false and put the phrase in "phrase".

--- entity_mentions ---
Proper nouns ONLY: company names, brand names, regulator names,
jurisdiction names, city names.

NEVER include:
  ✗ Industry names (Cosmetics, Beauty, Healthcare, Logistics, Automobile,
    Airlines, Food, Retail, Technology, Finance, Pharmaceutical, etc.)
  ✗ Generic categories (sector, industry, market, business, brand, company)
  ✗ Acronyms (VC, PE, M&A, ESG, IPO, B2B, B2C, AI, ML, SaaS, etc.)
  ✗ Common plural nouns (products, brands, customers, users, items, things)
  ✗ Sector descriptors combining a region + industry ("US banks",
    "European airlines", "Asian tech companies", "Indian pharma").
    Those go in sector_term, not entity_mentions.

If the list would be empty, output [].

Real examples: "Glossier", "Estée Lauder", "L'Oréal", "FDA",
"European Union", "South Korea", "United Kingdom", "HMRC".

Fix obvious misspellings: "glossieer" → "Glossier", "estee lauder" →
"Estée Lauder", "microsoft" → "Microsoft". Always output the properly
spelled proper noun.

--- concept_keywords ---
3-6 keywords. Each keyword must be 1-2 WORDS.

DO NOT include GENERIC SYNONYMS that could apply to many different topics:
  ✗ compliance, requirements, obligations, rules, laws
  ✗ updates, update, news, recent
  ✗ activity, activities, information, data
  ✗ trend, trends, growth, development, changes
  ✗ industry, sector, business, company, companies, market

DO NOT include industry names or time words.

Include the specific topic vocabulary and its closest LITERAL variants:

  Q: "List recent funding rounds in our Cosmetics industry"
  GOOD: ["funding", "round", "raise"]

  Q: "What are the major policy changes in the last week?"
  GOOD: ["regulation", "policy", "compliance", "reform"]

  Q: "What is the New Excise Duty on Vaping Products?"
  GOOD: ["excise duty", "vaping product", "duty", "tax"]

--- sector_term ---
The industry or sector the question is about, as a single lowercase word
or short phrase. Set to null if the question is about a specific named
company, or if there is no clear sector.

Examples:
  "SWOT for cosmetics industry"         → "cosmetics"
  "PESTLE for the beauty sector"        → "beauty"
  "automobile industry SWOT"            → "automobile"
  "five forces of the pharma market"    → "pharma"
  "household products industry SWOT"    → "household products"
  "SWOT for Estée Lauder"               → null
  "top 5 cosmetic companies by revenue" → "cosmetics"
  "risk analysis for K-beauty"          → "k-beauty"
  "what's happening with L'Oréal?"      → null

Rules:
- Include product-category words and industry names.
- Do NOT include generic words like "market", "industry", "sector",
  "business", "company".
- Do NOT include country/region names.
- If the question is about a specific named company, output null.

--- metrics_found ---
An ARRAY of the financial metrics the user is asking about. Output zero,
one, or multiple values from the six canonical names below. Never output
raw text from the question — always canonicalize to one of the six.

CANONICAL METRICS AND COMMON WORDINGS:
  "Revenue"          ← revenue, sales, top line, turnover, reveneu,
                        revne, revenu, rev, revnue, sales figure
  "NetIncome"        ← net income, profit, net profit, bottom line,
                        earnings, proft, netincome
  "TotalAssets"      ← total assets, assets, asset base
  "TotalLiabilities" ← total liabilities, liabilities
  "CashFlow"         ← cash flow, cashflow, operating cash, free cash flow
  "CapEx"            ← capital expenditure, capex, capital expenditures,
                        r&d spending, capital spending

Examples:
  "microsoft revenue last year"                → ["Revenue"]
  "ulta revne last 3 yer"                      → ["Revenue"]
  "compare apple profit vs revenue of 2025"    → ["Revenue", "NetIncome"]
  "apple net income"                           → ["NetIncome"]
  "microsoft revenue for 2024 and 2023"        → ["Revenue"]
  "rank US banks by total assets"              → ["TotalAssets"]
  "compare apple net income and revenue 2024"  → ["Revenue", "NetIncome"]
  "pestle for delta air lines"                 → []
  "swot analysis for estee lauder"             → []
  "five forces of the pharma market"           → []
  "what partnership trends in cosmetics"       → []

Output [] when no financial metric is being asked about.

--- framework ---
If the question names a business framework, set this field. Otherwise null.

  "swot"          ← swot
  "pestle"        ← pestle, pestel, pest analysis
  "five_forces"   ← five forces, porter's five forces, 5 forces
  "risk_analysis" ← risk analysis, risk categor, categorize the risk,
                    types of risk, risk breakdown, risk matrix
  null            ← everything else

Examples:
  "SWOT for Estée Lauder"          → "swot"
  "pestle for delta air lines"     → "pestle"
  "five forces of the cosmetics market" → "five_forces"
  "risk analysis for entering K-beauty" → "risk_analysis"
  "microsoft revenue last year"    → null

--- is_company_set_query ---
TRUE only if the user asks to COMPARE FINANCIAL METRICS across a SET of
public companies. FALSE for everything else.

A question about "our Cosmetics industry" is NOT a company-set query,
even though it mentions cosmetics.

"rank X by Y", "top N X by Y", "which X have the highest Y",
"compare X by Y" — ALL of these ARE company-set queries when X refers
to a sector/subsector of public companies and Y is a financial metric.

  "rank US banks by total assets"           → true, sector_term: "banks"
  "top 10 pharma companies by revenue"      → true, sector_term: "pharma"
  "top 5 airlines by revenue"               → true, sector_term: "airlines"

=========================
EXAMPLES
=========================

Input: "hi"
Output: { "intent": "greeting", "type": "list",
  "time_constraint": { "present": false, "value": null, "unit": null, "phrase": null },
  "entity_mentions": [], "concept_keywords": [], "sector_term": null,
  "metrics_found": [], "framework": null, "is_company_set_query": false,
  "primary_intent": "Hi! What would you like to know about your market data?" }

Input: "microsoft revenue for the last 3 years"
Output: { "intent": "market_intelligence", "type": "inference",
  "time_constraint": { "present": true, "value": 3, "unit": "years", "phrase": "last 3 years" },
  "entity_mentions": ["Microsoft"], "concept_keywords": ["revenue"],
  "sector_term": null, "metrics_found": ["Revenue"], "framework": null,
  "is_company_set_query": false,
  "primary_intent": "Get Microsoft's revenue for the last 3 fiscal years." }

Input: "ulta revne last 3 yer"
Output: { "intent": "market_intelligence", "type": "inference",
  "time_constraint": { "present": true, "value": 3, "unit": "years", "phrase": "last 3 yer" },
  "entity_mentions": ["Ulta Beauty"], "concept_keywords": ["revenue"],
  "sector_term": null, "metrics_found": ["Revenue"], "framework": null,
  "is_company_set_query": false,
  "primary_intent": "Get Ulta Beauty's revenue for the last 3 fiscal years." }

Input: "compare apple profit vs revenue of 2025"
Output: { "intent": "market_intelligence", "type": "decision",
  "time_constraint": { "present": false, "value": null, "unit": null, "phrase": null },
  "entity_mentions": ["Apple"], "concept_keywords": ["revenue", "net income"],
  "sector_term": null, "metrics_found": ["Revenue", "NetIncome"], "framework": null,
  "is_company_set_query": false,
  "primary_intent": "Compare Apple's net income and revenue for 2025." }

Input: "compare apple net income and revenue 2024"
Output: { "intent": "market_intelligence", "type": "decision",
  "time_constraint": { "present": false, "value": null, "unit": null, "phrase": null },
  "entity_mentions": ["Apple"], "concept_keywords": ["revenue", "net income"],
  "sector_term": null, "metrics_found": ["Revenue", "NetIncome"], "framework": null,
  "is_company_set_query": false,
  "primary_intent": "Compare Apple's net income and revenue for 2024." }

Input: "compare estee lauder and ulta revenue in the last 3 years"
Output: { "intent": "market_intelligence", "type": "decision",
  "time_constraint": { "present": true, "value": 3, "unit": "years", "phrase": "last 3 years" },
  "entity_mentions": ["Estée Lauder", "Ulta Beauty"],
  "concept_keywords": ["revenue"],
  "sector_term": null, "metrics_found": ["Revenue"], "framework": null,
  "is_company_set_query": false,
  "primary_intent": "Compare Estée Lauder and Ulta Beauty revenue for the last 3 years." }

Input: "rank US banks by total assets"
Output: { "intent": "market_intelligence", "type": "decision",
  "time_constraint": { "present": false, "value": null, "unit": null, "phrase": null },
  "entity_mentions": [], "concept_keywords": ["total assets"],
  "sector_term": "banks", "metrics_found": ["TotalAssets"], "framework": null,
  "is_company_set_query": true,
  "primary_intent": "Rank US banks by their total assets." }

Input: "SWOT analysis for cosmetics industry"
Output: { "intent": "market_intelligence", "type": "decision",
  "time_constraint": { "present": false, "value": null, "unit": null, "phrase": null },
  "entity_mentions": [], "concept_keywords": ["swot"],
  "sector_term": "cosmetics", "metrics_found": [], "framework": "swot",
  "is_company_set_query": false,
  "primary_intent": "SWOT analysis of the cosmetics industry." }

Input: "five forces of the pharma market"
Output: { "intent": "market_intelligence", "type": "decision",
  "time_constraint": { "present": false, "value": null, "unit": null, "phrase": null },
  "entity_mentions": [], "concept_keywords": ["five forces"],
  "sector_term": "pharma", "metrics_found": [], "framework": "five_forces",
  "is_company_set_query": false,
  "primary_intent": "Five forces analysis of the pharma market." }

Input: "swot for the automobile industry"
Output: { "intent": "market_intelligence", "type": "decision",
  "time_constraint": { "present": false, "value": null, "unit": null, "phrase": null },
  "entity_mentions": [], "concept_keywords": ["swot"],
  "sector_term": "automobile", "metrics_found": [], "framework": "swot",
  "is_company_set_query": false,
  "primary_intent": "SWOT analysis of the automobile industry." }

=========================

Respond with ONLY the JSON object. No markdown fences, no explanation.`;

const UNIT_DAYS = { days: 1, weeks: 7, months: 30, quarters: 90, years: 365 };

const VALID_INTENTS = new Set(['greeting', 'off_topic', 'clarification', 'market_intelligence']);
const VALID_TYPES   = new Set(['list', 'inference', 'decision']);
const VALID_UNITS   = new Set(['days', 'weeks', 'months', 'quarters', 'years']);
const VALID_METRICS = new Set(['Revenue', 'NetIncome', 'TotalAssets', 'TotalLiabilities', 'CashFlow', 'CapEx']);
const VALID_FRAMEWORKS = new Set(['swot', 'pestle', 'five_forces', 'risk_analysis']);

function stripFences(raw) {
  return String(raw || '').trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
}

function findBalancedJson(s) {
  const first = s.indexOf('{');
  if (first === -1) return null;
  let depth = 0;
  for (let i = first; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) return s.slice(first, i + 1); }
  }
  return null;
}

function fallbackResult(question) {
  return {
    intent: 'market_intelligence',
    type: 'inference',
    time_constraint: { present: false, value: null, unit: null, phrase: null },
    entity_mentions: [],
    concept_keywords: [],
    sector_term: null,
    metrics_found: [],
    framework: null,
    is_company_set_query: false,
    primary_intent: String(question || '').slice(0, 200),
    _fallback: true,
  };
}

function stripIndustryName(result, industry) {
  if (!industry) return result;
  const industryLower = String(industry).toLowerCase().trim();
  if (!industryLower) return result;

  const isIndustry = (term) => String(term).toLowerCase().trim() === industryLower;
  result.entity_mentions = (result.entity_mentions || []).filter((e) => !isIndustry(e));
  result.concept_keywords = (result.concept_keywords || []).filter((k) => !isIndustry(k));
  return result;
}

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
  if (phraseDays === null) {
    if (phraseLower.includes('week') && !phraseLower.match(/\d+\s*week/)) namedDays = 7;
    else if (phraseLower.includes('month') && !phraseLower.match(/\d+\s*month/)) namedDays = 30;
    else if (phraseLower.includes('quarter') && !phraseLower.match(/\d+\s*quarter/)) namedDays = 90;
    else if (phraseLower.includes('year') && !phraseLower.match(/\d+\s*year/)) namedDays = 365;
    else if (phraseLower.includes('today')) namedDays = 1;
    else if (phraseLower.includes('yesterday')) namedDays = 2;
    else if (phraseLower.includes('recent') || phraseLower.includes('latest')) namedDays = 30;
  }

  const phraseTarget = phraseDays !== null ? phraseDays : namedDays;
  if (phraseTarget !== null && Math.abs(llmDays - phraseTarget) < 0.1) {
    return { present: true, value, unit, phrase };
  }

  if (phraseDays !== null) {
    const pv = Number(digitUnitMatch[1]);
    const pu = digitUnitMatch[2];
    const puMap = { day: 'days', week: 'weeks', month: 'months', quarter: 'quarters', year: 'years' };
    console.log(`[router] TIME NORMALIZED: phrase="${phrase}"  ${value} ${unit} → ${pv} ${puMap[pu]}`);
    return { present: true, value: pv, unit: puMap[pu], phrase };
  }

  if (namedDays !== null) {
    console.log(`[router] TIME NORMALIZED: phrase="${phrase}"  ${value} ${unit} → ${namedDays} days`);
    return { present: true, value: namedDays, unit: 'days', phrase };
  }

  return { present: true, value, unit, phrase };
}

function sanitize(parsed, question) {
  const out = fallbackResult(question);
  if (!parsed || typeof parsed !== 'object') return out;

  if (VALID_INTENTS.has(parsed.intent)) out.intent = parsed.intent;
  if (VALID_TYPES.has(parsed.type))     out.type   = parsed.type;

  const tc = parsed.time_constraint;
  if (tc && typeof tc === 'object' && tc.present === true) {
    const value = Number(tc.value);
    if (Number.isFinite(value) && value > 0 && VALID_UNITS.has(tc.unit)) {
      out.time_constraint = {
        present: true, value, unit: tc.unit,
        phrase: typeof tc.phrase === 'string' ? tc.phrase : null,
      };
    }
  }

  if (Array.isArray(parsed.entity_mentions)) {
    out.entity_mentions = parsed.entity_mentions
      .filter((e) => typeof e === 'string').map((e) => e.trim())
      .filter((e) => e.length > 0).slice(0, 10);
  }

  if (Array.isArray(parsed.concept_keywords)) {
    out.concept_keywords = parsed.concept_keywords
      .filter((k) => typeof k === 'string').map((k) => k.trim().toLowerCase())
      .filter((k) => k.length > 0).slice(0, 8);
  }

  if (typeof parsed.sector_term === 'string' && parsed.sector_term.trim()) {
    out.sector_term = parsed.sector_term.trim().toLowerCase().slice(0, 60);
  }

  if (Array.isArray(parsed.metrics_found)) {
    out.metrics_found = parsed.metrics_found
      .filter((m) => typeof m === 'string' && VALID_METRICS.has(m))
      .slice(0, 6);
  }

  if (typeof parsed.framework === 'string' && VALID_FRAMEWORKS.has(parsed.framework)) {
    out.framework = parsed.framework;
  }

  if (typeof parsed.is_company_set_query === 'boolean') {
    out.is_company_set_query = parsed.is_company_set_query;
  }

  if (typeof parsed.primary_intent === 'string' && parsed.primary_intent.trim()) {
    out.primary_intent = parsed.primary_intent.trim().slice(0, 400);
  }

  out._fallback = false;
  return out;
}

async function route(question, industry = null) {
  if (!question || typeof question !== 'string' || !question.trim()) {
    return fallbackResult(question);
  }

  let raw;
  try {
    raw = await callLLM(
      [{ role: 'system', content: ROUTER_PROMPT }, { role: 'user', content: question }],
      { temperature: 0, max_tokens: 900, timeout: 30000 }
    );
  } catch (err) {
    console.log(`[router] LLM call failed: ${err.message}`);
    return fallbackResult(question);
  }

  if (process.env.DI_V2_DEBUG_LLM === '1') {
    console.log('[router] RAW LLM OUTPUT:'); console.log(raw); console.log('[router] END RAW');
  }

  const stripped = stripFences(raw);
  const jsonBlock = findBalancedJson(stripped);
  if (!jsonBlock) {
    console.log(`[router] no JSON found in: ${stripped.slice(0, 200)}`);
    return fallbackResult(question);
  }

  let parsed;
  try { parsed = JSON.parse(jsonBlock); }
  catch (err) {
    console.log(`[router] JSON parse failed: ${err.message}`);
    return fallbackResult(question);
  }

  let result = sanitize(parsed, question);

  if (result.intent === 'market_intelligence') {
    result = stripIndustryName(result, industry);
    result.time_constraint = normalizeTimeConstraint(result.time_constraint);
  }

  return result;
}

module.exports = {
  route, ROUTER_PROMPT, fallbackResult, sanitize,
  stripIndustryName, normalizeTimeConstraint, UNIT_DAYS,
  VALID_METRICS, VALID_FRAMEWORKS,
};