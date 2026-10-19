/**
 * modules/decisionIntelligenceV2/handlers/topicalCoverage.js
 *
 * Pre-writer topical relevance check.
 *
 * Two checkers:
 *   - checkTopicalCoverage          — normal (non-framework) questions
 *   - checkFrameworkSubjectCoverage — SWOT / PESTLE / Five Forces / Risk Analysis
 *
 * Both return { covered, onTopicIndices, filteredClientHits, filteredCustomHits }.
 *
 * The framework checker accepts an optional routerResult and, when
 * supplied, runs a strict deterministic term-match guard on top of the
 * LLM's on_topic_indices. This prevents the LLM from passing documents
 * that match only one of the question's subject parts (e.g. "UAE banking"
 * passing a "UAE skincare" document because it matches "UAE").
 *
 * Fails open: any LLM error, timeout, or unparseable response returns
 * { covered: true } so a transient issue never blocks a real answer.
 */

const { callLLM } = require('../../llmClient');

const TOPICAL_COVERAGE_PROMPT = `You are a strict topical relevance checker for a market intelligence system.

You will be given:
  (1) a user's question
  (2) a numbered list of documents the system retrieved from the client's data

Your job has TWO parts:
  A. Decide whether AT LEAST ONE document discusses the same topic as the question.
  B. Identify WHICH specific documents are on-topic (by their numbers).

=========================
PART A — COVERED OR NOT
=========================

YES — the batch is covered when AT LEAST ONE document discusses the same
sector, industry, or domain as the question. The bar for coverage is low:
one good document is enough.

NO — the batch is not covered when EVERY document is about a different
sector, industry, country, or subject than the question.

=========================
PART B — WHICH DOCUMENTS ARE ON-TOPIC
=========================

You must return the list of document numbers that ARE about the same
topic as the question.

A document is "on-topic" if an analyst could pull a real fact from it
that answers or directly supports the question.

A document is "off-topic" if it only shares general vocabulary
("beauty", "market", "growth") but its actual subject is different.

Be strict about Part B. A document about "Middle East beauty market trends"
is OFF-TOPIC for a question specifically about "Beautyworld Middle East 2026
exhibition" — same region, same industry, but different subject.

=========================
WORKED EXAMPLES
=========================

Q: "What's the status of AI-powered acne prescribing in Utah?"
Documents: 5 about Utah acne pilots, 1 PDF about global beauty.
→ covered: true
→ on_topic_indices: [1,2,3,4,5]   (the PDF is off-topic)
→ reason: "Five documents describe the Utah acne pilot program."

Q: "What's happening at Beautyworld Middle East 2026?"
Documents: 1 about Pakistan pavilion at Beautyworld ME 2026, 12 about
general Middle East beauty market trends, funding, and unrelated events.
→ covered: true
→ on_topic_indices: [1]   (only the Pakistan article is about the event)
→ reason: "Only one document discusses the specific event."

Q: "What's the EU rule on cosmetic packaging?"
Documents: 8 about EU packaging regulations, 2 about UK/Italy packaging,
1 PDF about global beauty.
→ covered: true
→ on_topic_indices: [1,2,3,4,5,6,7,8,9,10]  (the PDF is off-topic)

Q: "Which company acquired ATTAIN Cosmetics?"
Documents: 3 about Macquarie/Hwasung/NowCos, 0 mentioning ATTAIN.
→ covered: false
→ on_topic_indices: []
→ reason: "No document mentions ATTAIN Cosmetics."

=========================
CRITICAL — NEVER ADMIT MISSING DATA AND STILL SAY COVERED
=========================

Before returning covered=true, re-read your own "reason" string.

If your reason says something like:
  - "X is not mentioned in any document"
  - "none of the documents mention X"
  - "the documents do not discuss X"
  - "the documents discuss Y instead of X"
  - "IBM's 2025 revenue is not mentioned but one of the documents is about..."
  - "the specific company/metric/year asked about is not present"

...then you MUST return covered=false. Do NOT return covered=true
just because the documents share general vocabulary (revenue, growth,
company) with the question. If the SPECIFIC subject the user asked
about is absent, the answer is false.

The test: strip away all general vocabulary. Does any document actually
contain a fact that answers the exact question the user asked? If not,
covered=false.

Examples of the CORRECT behavior:

  Q: "IBM 2025 revenue"
  Documents: 2 signals about Cosmos Health's revenue growth.
  → reason says: "IBM is not mentioned; the documents discuss Cosmos Health."
  → covered: FALSE
  → on_topic_indices: []

  Q: "IBM 2025 revenue"
  Documents: 3 IBM 10-K chunks containing revenue figures.
  → reason says: "IBM revenue for FY2025 is present in three chunks."
  → covered: TRUE
  → on_topic_indices: [1,2,3]

  Q: "Which company acquired ATTAIN Cosmetics?"
  Documents: 3 articles about Macquarie/Hwasung/NowCos.
  → reason says: "No document mentions ATTAIN Cosmetics."
  → covered: FALSE

=========================
OUTPUT
=========================

Return ONLY this JSON object and NOTHING ELSE:

{
  "covered": true | false,
  "on_topic_indices": [<1-based document numbers that are on-topic>],
  "reason": "<one short sentence>"
}

Rules:
- If covered is false, on_topic_indices must be [].
- If covered is true, on_topic_indices must contain at least one number.
- If your reason says the specific entity/metric/year asked about is
  missing or not mentioned, covered MUST be false.
- Numbers must be integers, 1-based, matching the document numbers given.
- No markdown fences, no explanation, no extra text. Return ONLY the JSON.`;

// ─────────────────────────────────────────────────────────────────────────
// Framework-only prompt
// ─────────────────────────────────────────────────────────────────────────
const FRAMEWORK_SUBJECT_PROMPT = `You are checking whether retrieved documents are about the same SUBJECT as a user's question.

The user's question asks for a SWOT, PESTLE, Five Forces, or Risk Analysis. IGNORE that request word. It is not part of the subject — it's the SHAPE of the answer that will be built later. Only check whether the documents are about the same subject as the question.

=========================
WHAT IS "THE SUBJECT"?
=========================

The subject is the company, industry, sector, market, or region the question is about.

=========================
RULES
=========================

1. Delete the framework word (SWOT / PESTLE / Five Forces / Risk Analysis)
   from the question in your mind.
2. Ask: "Is AT LEAST ONE retrieved document about the same subject as
   what's left?"
3. A company document counts as about the industry it belongs to. A subsector
   counts as about the broader industry.
4. The batch will often mix on-topic and off-topic documents. Only care
   whether AT LEAST ONE is on-topic. Return true if even one is.
5. Return the on-topic documents by their numbers.

=========================
CRITICAL — MULTI-PART SUBJECTS
=========================

When the question names BOTH a region AND an industry (e.g. "UAE banking
sector", "Saudi Arabia retail industry", "K-beauty market", "Korean
cosmetics industry"), a document must match BOTH parts.

  Q: "PESTLE for the UAE banking sector"
  Subject has TWO parts: UAE + banking
  - Document about UAE banking → MATCH
  - Document about UAE skincare → NO MATCH (region only)
  - Document about US banking → NO MATCH (industry only)
  - Document about Pakistani trade with UAE → NO MATCH
  - Document about Regional Banking Consolidation in the Middle East → MATCH (banking + regional fit)

  Q: "SWOT for the Saudi Arabia retail industry"
  Subject has TWO parts: Saudi Arabia + retail
  - Document about Saudi retail → MATCH
  - Document about US retail → NO MATCH
  - Document about Saudi oil → NO MATCH
  - Document about Saudi ice cream shops / food safety → NO MATCH (food isn't retail)

RULES:
- If the question names a region, a document from a DIFFERENT region does
  NOT match, even if it's the same industry.
- If the question names an industry, a document from a DIFFERENT industry
  does NOT match, even if it's the same region.
- Only documents matching ALL named parts count as on-topic.
- If NOTHING matches all parts, return subject_matches: false.

=========================
OUTPUT
=========================

Return ONLY this JSON and NOTHING ELSE:

{
  "subject_matches": true | false,
  "on_topic_indices": [<1-based document numbers that match the subject>],
  "reason": "<one short sentence>"
}

No markdown fences, no explanation, no extra text. Return ONLY the JSON.`;

// ─────────────────────────────────────────────────────────────────────────
// Context builder
// ─────────────────────────────────────────────────────────────────────────
const ITEM_MAX_CHARS = 350;

function buildCoverageContext(clientHits, customSourceHits) {
  const parts = [];
  const indexMap = [];

  const nonSecMatched   = (clientHits || []).filter((h) => h._matched && !h._sec);
  const nonSecUnmatched = (clientHits || []).filter((h) => !h._matched && !h._sec);
  const secHits         = (clientHits || []).filter((h) => h._sec);
  const orderedClient   = [...nonSecMatched, ...nonSecUnmatched, ...secHits];

  orderedClient.forEach((h) => {
    const title = h.title || 'Untitled';
    let text = h.chunk_text || '';
    if (text.length > ITEM_MAX_CHARS) text = text.slice(0, ITEM_MAX_CHARS) + '…';
    const label = h._sec ? '[SEC FILING]' : '[CLIENT SIGNAL]';
    parts.push(`${parts.length + 1}. ${label} ${title}\n${text}`);
    indexMap.push({ kind: 'client', ref: h });
  });

  (customSourceHits || []).forEach((c) => {
    const name = c.payload?.source_name || c.payload?.title || 'Uploaded document';
    let text = c.payload?.chunk_text || '';
    if (text.length > ITEM_MAX_CHARS) text = text.slice(0, ITEM_MAX_CHARS) + '…';
    parts.push(`${parts.length + 1}. [UPLOADED] ${name}\n${text}`);
    indexMap.push({ kind: 'custom', ref: c });
  });

  return { text: parts.join('\n\n---\n\n'), indexMap };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────
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

function applyIndexFilter(indexMap, indices, clientHits, customSourceHits) {
  const wanted = new Set(indices);
  const filteredClient = [];
  const filteredCustom = [];

  indexMap.forEach((entry, i) => {
    if (!wanted.has(i + 1)) return;
    if (entry.kind === 'client') filteredClient.push(entry.ref);
    else filteredCustom.push(entry.ref);
  });

  return {
    filteredClientHits: filteredClient,
    filteredCustomHits: filteredCustom,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Strict framework term check
//
// Given the router's parsing of the question (sector_term +
// entity_mentions) and a set of LLM-approved document indices, this
// drops any document that doesn't contain every single term in its
// title + text.
// ─────────────────────────────────────────────────────────────────────────
const STOP_TERMS = new Set([
  'sector', 'industry', 'market', 'business', 'the', 'and', 'for', 'of', 'in',
]);

function normalizeTerm(t) {
  return String(t || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // strip diacritics: é → e, ñ → n, etc.
    .toLowerCase()
    .replace(/[^\w\s&'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildRequiredTerms(routerResult) {
  const terms = new Set();

  if (routerResult && typeof routerResult.sector_term === 'string' && routerResult.sector_term.trim()) {
    const s = normalizeTerm(routerResult.sector_term);
    if (s && !STOP_TERMS.has(s)) terms.add(s);
  }

  if (routerResult && Array.isArray(routerResult.entity_mentions)) {
    for (const e of routerResult.entity_mentions) {
      const n = normalizeTerm(e);
      if (!n) continue;
      if (STOP_TERMS.has(n)) continue;
      terms.add(n);
    }
  }

  return [...terms];
}

function documentContainsTerm(ref, term) {
  const parts = [];
  if (ref.title) parts.push(ref.title);
  if (ref.chunk_text) parts.push(ref.chunk_text);
  if (ref.payload?.title) parts.push(ref.payload.title);
  if (ref.payload?.chunk_text) parts.push(ref.payload.chunk_text);
  const haystack = normalizeTerm(parts.join(' '));
  if (!haystack) return false;
  return haystack.includes(term);
}

function strictFilterByTerms(indexMap, indices, routerResult) {
  const terms = buildRequiredTerms(routerResult);
  if (terms.length === 0) return { keptIndices: indices, terms: [] };

  const kept = [];
  for (const idx of indices) {
    const entry = indexMap[idx - 1];
    if (!entry) continue;
    const ref = entry.ref;

    const hasAll = terms.every((t) => documentContainsTerm(ref, t));
    if (hasAll) {
      kept.push(idx);
    } else {
      const missing = terms.filter((t) => !documentContainsTerm(ref, t));
      const title = ref.title || ref.payload?.title || '(untitled)';
      console.log(
        `[FrameworkStrictFilter] DROP "${String(title).slice(0, 80)}" — missing terms [${missing.join(', ')}]`
      );
    }
  }

  return { keptIndices: kept, terms };
}

// ─────────────────────────────────────────────────────────────────────────
// Public: general coverage (non-framework)
// ─────────────────────────────────────────────────────────────────────────
async function checkTopicalCoverage(question, clientHits, customSourceHits) {
  const { text: context, indexMap } = buildCoverageContext(clientHits, customSourceHits);

  if (!context || context.trim().length < 20) {
    return { covered: true, confidence: 1.0, reason: 'no context to check', onTopicIndices: null, _skipped: true };
  }

  let raw;
  try {
    raw = await callLLM(
      [
        { role: 'system', content: TOPICAL_COVERAGE_PROMPT },
        { role: 'user', content: `QUESTION:\n${question}\n\nRETRIEVED DOCUMENTS:\n${context}` },
      ],
      { temperature: 0, max_tokens: 400, timeout: 45000 }
    );
  } catch (err) {
    console.log(`[TopicalCoverage] LLM call failed — failing open: ${err.message}`);
    return { covered: true, confidence: 0.0, reason: `check failed: ${err.message}`, onTopicIndices: null, _fallback: true };
  }

  if (process.env.DI_V2_DEBUG_LLM === '1') {
    console.log('[TopicalCoverage] RAW LLM OUTPUT:');
    console.log(raw);
    console.log('[TopicalCoverage] END RAW');
  }

  const stripped = stripFences(raw);
  const jsonBlock = findBalancedJson(stripped);
  if (!jsonBlock) {
    console.log(`[TopicalCoverage] no JSON in output — failing open: ${stripped.slice(0, 200)}`);
    return { covered: true, confidence: 0.0, reason: 'unparseable response', onTopicIndices: null, _fallback: true };
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonBlock);
  } catch (err) {
    console.log(`[TopicalCoverage] JSON parse failed — failing open: ${err.message}`);
    return { covered: true, confidence: 0.0, reason: 'parse failed', onTopicIndices: null, _fallback: true };
  }

  const reason = typeof parsed.reason === 'string' ? parsed.reason : '';

  // Safety net: if the LLM's own reason admits the subject is missing,
  // force covered=false even if it said true. This catches the case where
  // the LLM says "covered=true, reason: IBM is not mentioned" — a direct
  // contradiction that would otherwise leak a wrong answer downstream.
  const admitsMissing = /\b(not mentioned|no document|none of the documents|do(?:es)? not (?:discuss|mention|contain)|not present|absent|not in the (?:current )?dataset)\b/i.test(reason);
  const covered = parsed.covered === true && !admitsMissing;

  if (parsed.covered === true && admitsMissing) {
    console.log(`[TopicalCoverage] OVERRIDE: LLM said covered=true but reason admits missing data. Reason: "${reason}"`);
  }

  let indices = Array.isArray(parsed.on_topic_indices)
    ? parsed.on_topic_indices.filter((n) => Number.isInteger(n) && n >= 1 && n <= indexMap.length)
    : [];

  // If we overrode to false, clear the indices too.
  if (!covered) indices = [];

  if (covered && indices.length === 0) {
    indices = Array.from({ length: indexMap.length }, (_, i) => i + 1);
    console.log(`[TopicalCoverage] covered=true but no indices — keeping all ${indices.length}`);
  }

  const filtered = applyIndexFilter(indexMap, indices, clientHits, customSourceHits);

  console.log(
    `[TopicalCoverage] covered=${covered} kept=${filtered.filteredClientHits.length} client + ${filtered.filteredCustomHits.length} custom of ${indexMap.length} — "${reason}"`
  );

  return {
    covered,
    confidence: covered ? 1 : 0,
    reason,
    onTopicIndices: indices,
    filteredClientHits: filtered.filteredClientHits,
    filteredCustomHits: filtered.filteredCustomHits,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Public: framework coverage + strict term check
// ─────────────────────────────────────────────────────────────────────────
async function checkFrameworkSubjectCoverage(question, clientHits, customSourceHits, routerResult = null) {
  const { text: context, indexMap } = buildCoverageContext(clientHits, customSourceHits);

  if (!context || context.trim().length < 20) {
    return { covered: true, confidence: 1.0, reason: 'no context to check', onTopicIndices: null, _skipped: true };
  }

  let raw;
  try {
    raw = await callLLM(
      [
        { role: 'system', content: FRAMEWORK_SUBJECT_PROMPT },
        { role: 'user', content: `QUESTION:\n${question}\n\nRETRIEVED DOCUMENTS:\n${context}` },
      ],
      { temperature: 0, max_tokens: 400, timeout: 45000 }
    );
  } catch (err) {
    console.log(`[FrameworkCoverage] LLM call failed — failing open: ${err.message}`);
    return { covered: true, confidence: 0.0, reason: `check failed: ${err.message}`, onTopicIndices: null, _fallback: true };
  }

  const stripped = stripFences(raw);
  const jsonBlock = findBalancedJson(stripped);
  if (!jsonBlock) {
    return { covered: true, confidence: 0.0, reason: 'unparseable response', onTopicIndices: null, _fallback: true };
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonBlock);
  } catch (err) {
    return { covered: true, confidence: 0.0, reason: 'parse failed', onTopicIndices: null, _fallback: true };
  }

  const llmCovered = parsed.subject_matches === true;
  const reason = typeof parsed.reason === 'string' ? parsed.reason : '';

  let llmIndices = Array.isArray(parsed.on_topic_indices)
    ? parsed.on_topic_indices.filter((n) => Number.isInteger(n) && n >= 1 && n <= indexMap.length)
    : [];

  if (llmCovered && llmIndices.length === 0) {
    llmIndices = Array.from({ length: indexMap.length }, (_, i) => i + 1);
  }

  // ── Strict deterministic filter using router's sector + entities ──
  let finalIndices = llmIndices;
  if (routerResult) {
    const { keptIndices, terms } = strictFilterByTerms(indexMap, llmIndices, routerResult);
    if (terms.length > 0) {
      console.log(
        `[FrameworkStrictFilter] terms=[${terms.join(', ')}] LLM-kept=${llmIndices.length} strict-kept=${keptIndices.length}`
      );
      finalIndices = keptIndices;
    }
  }

  const covered = llmCovered && finalIndices.length > 0;
  const filtered = applyIndexFilter(indexMap, finalIndices, clientHits, customSourceHits);

  // Build a clear reason. If the LLM said "covered" but the strict term
  // filter emptied the list, the LLM's own reason no longer reflects
  // reality — replace it with something honest.
  let finalReason = reason;
  if (llmCovered && finalIndices.length === 0) {
    const terms = buildRequiredTerms(routerResult);
    finalReason = terms.length > 0
      ? `No documents match all parts of the subject (${terms.join(' + ')}).`
      : 'No documents match the full subject of the question.';
  }

  console.log(
    `[FrameworkCoverage] subject_matches=${covered} kept=${filtered.filteredClientHits.length} client + ${filtered.filteredCustomHits.length} custom of ${indexMap.length} — "${finalReason}"`
  );

  return {
    covered,
    confidence: covered ? 1 : 0,
    reason: finalReason,
    onTopicIndices: finalIndices,
    filteredClientHits: filtered.filteredClientHits,
    filteredCustomHits: filtered.filteredCustomHits,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// List-only per-item relevance filter — unchanged
// ─────────────────────────────────────────────────────────────────────────
const LIST_SELECTION_PROMPT = `You are filtering a list of retrieved signals for a client's question.

You will be given:
  (1) A user's question.
  (2) A numbered list of candidate signals, each with a title, category, and short excerpt.

Your job: decide which of these candidates genuinely answer the question.

Return ONLY this JSON:

{
  "relevant_indices": [<1-based indices of the candidates that answer the question>],
  "reason": "<one short sentence>"
}

=========================
RULES
=========================

1. Judge each candidate independently. A candidate is either in or out.

2. If the user asks for "funding", you MUST reject articles that are not about capital being raised or invested. Reject "strategic moves", "incubators", or "trends".
3. If the user asks for "acquisitions", you MUST reject anything that is not a direct purchase, merger, or buyout.
4. If the user asks for "new entrants", "new players", or "startups", you MUST reject articles about regulations, policies, or product launches. Only accept articles about a brand new company or brand entering the market.

5. If NONE of the candidates answer the question, return "relevant_indices": [].

6. Return ONLY the JSON. No markdown fences, no explanation, no extra text.`;

const LIST_ITEM_MAX_CHARS = 300;

function buildListSelectionContext(clientHits) {
  const lines = [];
  clientHits.forEach((h, i) => {
    const title = h.title || 'Untitled';
    const cat = h.category || h.insight_category || 'General';
    let snippet = h.chunk_text || '';
    if (snippet.length > LIST_ITEM_MAX_CHARS) snippet = snippet.slice(0, LIST_ITEM_MAX_CHARS) + '…';
    lines.push(`[${i + 1}] ${title} (Category: ${cat})\n${snippet}`);
  });
  return lines.join('\n\n---\n\n');
}

async function selectRelevantHitsForList(question, clientHits) {
  if (!Array.isArray(clientHits) || clientHits.length === 0) return clientHits;

  const context = buildListSelectionContext(clientHits);
  if (!context || context.trim().length < 20) return clientHits;

  let raw;
  try {
    raw = await callLLM(
      [
        { role: 'system', content: LIST_SELECTION_PROMPT },
        { role: 'user', content: `QUESTION:\n${question}\n\nCANDIDATE SIGNALS:\n${context}` },
      ],
      { temperature: 0, max_tokens: 250, timeout: 30000 }
    );
  } catch (err) {
    console.log(`[ListSelection] LLM call failed — failing open: ${err.message}`);
    return clientHits;
  }

  const stripped = stripFences(raw);
  const jsonBlock = findBalancedJson(stripped);
  if (!jsonBlock) return clientHits;

  let parsed;
  try {
    parsed = JSON.parse(jsonBlock);
  } catch (err) {
    return clientHits;
  }

  if (!Array.isArray(parsed.relevant_indices)) return clientHits;

  const seen = new Set();
  const selected = [];
  for (const idx of parsed.relevant_indices) {
    const n = Number(idx);
    if (!Number.isInteger(n)) continue;
    if (n < 1 || n > clientHits.length) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    selected.push(clientHits[n - 1]);
  }

  console.log(
    `[ListSelection] selected ${selected.length}/${clientHits.length} relevant (reason="${parsed.reason || ''}")`
  );

  return selected;
}

module.exports = {
  checkTopicalCoverage,
  checkFrameworkSubjectCoverage,
  selectRelevantHitsForList,
  buildCoverageContext,
  TOPICAL_COVERAGE_PROMPT,
  FRAMEWORK_SUBJECT_PROMPT,
  LIST_SELECTION_PROMPT,
};