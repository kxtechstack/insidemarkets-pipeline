/**
 * modules/decisionIntelligenceV2/handlers/topicalCoverage.js
 *
 * Pre-writer topical relevance check.
 *
 * Before the writer runs, this asks an LLM one question: are the retrieved
 * chunks actually about the same topic as the question? If not, the handler
 * short-circuits to a no-data response, avoiding a fabricated report built
 * from off-topic chunks (e.g. "Korea cosmetics" chunks reframed into a
 * "Korea retail" answer).
 *
 * Prompt lives in code for now; moves to public.prompts as
 * 'di_topical_coverage_v1' when DI V2 prompts move to the DB.
 *
 * Fails open: any LLM error, timeout, or unparseable response returns
 * { covered: true } so a transient issue never blocks a real answer.
 */

const { callLLM } = require('../../llmClient');

const TOPICAL_COVERAGE_PROMPT = `You are a strict topical relevance checker for a market intelligence system.

You will be given:
  (1) a user's question
  (2) the titles and excerpts of documents the system retrieved from the client's data

Your job: decide whether the retrieved documents ACTUALLY discuss the same topic as the question. If they do, a downstream analyst will write an answer. If they don't, the system will say "no relevant data" instead of writing a fabricated answer.

=========================
WHAT COUNTS AS "COVERED"
=========================

YES — the documents cover the question when:
  - They discuss the same sector, industry, or domain the question asks about.
  - A cosmetics document counts for a cosmetics question.
  - A broader document covers a narrower question (a "Korea beauty market" document covers a "Korea skincare market" question).
  - A narrower document covers a broader question IF the narrower topic is a clear sub-topic of the broader question (a "Korea cosmetics e-commerce" document covers a "Korea beauty market" question).
  - A differently-angled document on the same subject (a "Korea cosmetics regulation" document covers a "Korea cosmetics market" question).

NO — the documents do NOT cover the question when:
  - They discuss a DIFFERENT SECTOR. A "Korea cosmetics" document does NOT cover a "Korea retail" question. Cosmetics is not retail, retail is not cosmetics, even though they overlap commercially.
  - They discuss a DIFFERENT INDUSTRY. A "banking" document does NOT cover a "fintech" question.
  - They discuss a DIFFERENT COUNTRY or region than the question is bounded to.
  - They discuss a DIFFERENT SUBJECT ENTIRELY.

The bar is: could a careful analyst honestly write an answer to THIS question using ONLY these documents, without having to reframe one subject as another? If they'd have to say "well, the data is about cosmetics, but I'll write about retail anyway" — the answer is NO.

=========================
IMPORTANT — do not be fooled by shared vocabulary
=========================

Two documents can share the words "Korea," "market," "growth," "consumer," and still be about completely different topics. Do not pass a document just because it shares words with the question. Judge the actual subject.

If the question is "What is happening in Korean retail?" and every document is about Korean cosmetics — that is NOT coverage, even if the documents mention "retail distribution" or "consumer demand" in passing.

=========================
FRAMEWORK QUESTIONS — CRITICAL
=========================

If the question asks you to PRODUCE an analysis using a framework
(SWOT, PESTLE, PESTEL, Five Forces, Porter's Five Forces, Risk Analysis,
or an equivalent structured framework), do NOT fail coverage just because
the documents don't already contain that framework's output.

The framework output will be CONSTRUCTED downstream by an analyst FROM
these documents. Your job is only to check that the documents are about
the same SUBJECT as the question — the company, sector, or market the
framework is being applied to. Completely ignore the framework verb
("do a SWOT", "run a PESTLE", "analyze risks") when judging coverage.

Examples:
  Q: "Do a SWOT analysis for Estée Lauder."
  Documents: Estée Lauder operations, financials, acquisitions.
  → covered: TRUE. Documents are about Estée Lauder.

  Q: "SWOT for the cosmetics industry."
  Documents: cosmetics brands, market trends, regulations.
  → covered: TRUE. Documents are about cosmetics.

  Q: "SWOT for Enveda."
  Documents: Estée Lauder, M·A·C, DECIEM.
  → covered: FALSE. Different subject — Enveda not present.

The framework verb never affects coverage. Only the subject noun does.

=========================
OUTPUT
=========================

Return ONLY this JSON object and NOTHING ELSE:

{
  "covered": true | false,
  "confidence": 0.0 - 1.0,
  "reason": "<one short sentence>"
}

Bias: if the documents clearly share the same main topic as the question, return true. Return false only when there is a real domain mismatch.

No markdown fences, no explanation, no extra text. Return ONLY the JSON.`;

// ─────────────────────────────────────────────────────────────────────────
// Framework-only prompt — judges SUBJECT match only.
//
// Framework questions (SWOT / PESTLE / Five Forces / Risk Analysis) ask the
// writer to BUILD the framework from raw signals, so the documents will never
// "contain a SWOT" already. The normal coverage prompt gets confused by this
// and wrongly fails good questions. This prompt tells the AI to ignore the
// framework word entirely and only check whether the documents are about the
// same subject (company / sector / region) as the question.
// ─────────────────────────────────────────────────────────────────────────
const FRAMEWORK_SUBJECT_PROMPT = `You are checking whether retrieved documents are about the same SUBJECT as a user's question.

The user's question may ask for a SWOT, a PESTLE, Five Forces, or a Risk Analysis. IGNORE that request word completely. The framework will be built later, from these documents. You are NOT checking whether the documents contain a SWOT (they won't — that is expected). You are ONLY checking whether the documents are about the same subject as the question.

=========================
WHAT IS "THE SUBJECT"?
=========================

The subject is the company, industry, sector, market, or region the question is about.

Examples:

  Q: "Do a SWOT analysis for Estée Lauder."
     Subject = Estée Lauder (a company)
     Documents about Estée Lauder's operations, financials, products → subject matches.
     Documents about cosmetics in general → subject matches too (Estée Lauder is a cosmetics company, and the docs cover that sector).
     Documents about airlines or auto makers → subject does NOT match.

  Q: "SWOT for Enveda."
     Subject = Enveda (a company)
     Documents about Enveda → subject matches.
     Documents about Estée Lauder or Ulta → subject does NOT match.

  Q: "PESTLE for the cosmetics industry."
     Subject = cosmetics industry
     Documents about cosmetics brands, cosmetics regulation, cosmetics market trends → subject matches.
     Documents about banking or airlines → subject does NOT match.

  Q: "Risk analysis for entering the K-beauty market."
     Subject = K-beauty market
     Documents about K-beauty, Korean skincare, Korean beauty trends → subject matches.
     Documents about German healthcare or Indian auto → subject does NOT match.

  Q: "SWOT for the Saudi Arabia retail industry."
     Subject = Saudi Arabia retail
     Documents about Saudi Arabia retail → subject matches.
     Documents about cosmetics in Korea or beauty in France → subject does NOT match.
     Documents that mention "Saudi Arabia" but only about oil, or mention "retail" but only about US retail → subject does NOT match.

=========================
RULES — READ CAREFULLY
=========================

1. The question will contain a framework word: "SWOT", "PESTLE", "PESTEL", "Five Forces", "Porter's Five Forces", "Risk Analysis", or "Risk Categorization".
   DELETE that word from the question in your mind. It is not part of the subject. It is only the SHAPE of the answer that will be built LATER.
   The question "SWOT for Enveda" becomes "Enveda" in your head.
   The question "Do a PESTLE analysis for the cosmetics industry" becomes "the cosmetics industry".
   The question "Five forces for the US airline industry" becomes "the US airline industry".
   Never mention SWOT, PESTLE, Five Forces, or Risk Analysis in your reason. Ever.

2. After removing that framework word, ask yourself ONE question:
   "Is AT LEAST ONE of the retrieved documents about the same subject as what's left?"

3. "Same subject" means: the same company, the same industry, the same sector, the same market, or the same region.

   IMPORTANT — a company document counts as being about the industry it belongs to:
     - Estée Lauder is a cosmetics company → Estée Lauder's filings count for "the cosmetics industry".
     - Delta Air Lines is an airline → Delta's filings count for "the US airline industry".
     - Nestlé is a food company → Nestlé's filings count for "the food industry".
     - Entergy is a utility company → Entergy's filings do NOT count for "the K-beauty market" (different industry entirely).

   Also note: a specific industry subsector counts for the broader industry.
     - "K-beauty" is a subsector of "cosmetics" → a K-beauty document counts for "the cosmetics industry".
     - "skincare" is a subsector of "beauty" → a skincare document counts for "the beauty industry".

4. The batch will very often contain a MIX of on-topic and off-topic documents.
   You must ONLY care whether AT LEAST ONE document is on-topic.
   Do NOT fail the batch just because some documents are off-topic — the writer will use the on-topic ones and ignore the rest.

5. Return subject_matches: true if even ONE document is on-subject.
   Return subject_matches: false ONLY if EVERY SINGLE document in the batch is off-subject.

   Example of the correct way to reason:
     Q: "SWOT for the cosmetics industry"
     Batch: 10 client signals about cosmetics, 22 Estée Lauder 10-K chunks, 10 uploaded docs.
     → subject_matches: TRUE (Estée Lauder is a cosmetics company, and the client signals are about cosmetics)

     Q: "Risk analysis for K-beauty market"
     Batch: 15 K-beauty client signals, 12 Entergy 10-K chunks.
     → subject_matches: TRUE (the K-beauty signals are on-topic; Entergy is off-topic but that doesn't matter — one is enough)

     Q: "SWOT for Saudi Arabia retail industry"
     Batch: 10 cosmetic industry signals, 10 uploaded beauty docs.
     → subject_matches: FALSE (nothing in the batch is about Saudi Arabia retail)

6. Do NOT judge whether the documents are detailed, complete, contain the framework output, contain any kind of analysis, or mention strengths / weaknesses / opportunities / threats / political / economic / social / technological / legal / environmental factors. NONE of that matters. You are ONLY judging subject match.

=========================
OUTPUT
=========================

Return ONLY this JSON and NOTHING ELSE:

{
  "subject_matches": true | false,
  "reason": "<one short sentence>"
}

No markdown fences, no explanation, no extra text. Return ONLY the JSON.`;

const ITEM_MAX_CHARS = 350;
const MAX_CLIENT_HITS = 6;
const MAX_CUSTOM_HITS = 4;

function buildCoverageContext(clientHits, customSourceHits) {
  const parts = [];

  // Order matters here. SEC chunks are marked _matched: true by the SEC
  // sidecar (secHandler.js), which means a naive "matched first" ordering
  // makes SEC chunks crowd out the actual client signals retrieved by
  // semantic similarity to the question. That was the root cause of the
  // FW6 failure: for "Risk analysis for entering the K-beauty market",
  // the SEC sidecar injected 12 Entergy 10-K chunks (wrong ticker), and
  // those crowded out the K-beauty client signals — so the coverage LLM
  // only saw Entergy documents and correctly said "none are about K-beauty".
  //
  // Priority order for the coverage check:
  //   1. non-SEC matched client hits   — retrieved by similarity, boosted
  //   2. non-SEC unmatched client hits — retrieved by similarity, not boosted
  //   3. SEC hits last                 — injected by sidecar, may be off-topic
  const nonSecMatched   = (clientHits || []).filter((h) => h._matched && !h._sec);
  const nonSecUnmatched = (clientHits || []).filter((h) => !h._matched && !h._sec);
  const secHits         = (clientHits || []).filter((h) => h._sec);
  const clientPool = [...nonSecMatched, ...nonSecUnmatched, ...secHits].slice(0, MAX_CLIENT_HITS);

  for (const h of clientPool) {
    const title = h.title || 'Untitled';
    let text = h.chunk_text || '';
    if (text.length > ITEM_MAX_CHARS) text = text.slice(0, ITEM_MAX_CHARS) + '…';
    const label = h._sec ? '[SEC FILING]' : '[CLIENT SIGNAL]';
    parts.push(`${label} ${title}\n${text}`);
  }

  const customPool = (customSourceHits || []).slice(0, MAX_CUSTOM_HITS);
  for (const c of customPool) {
    const name = c.payload?.source_name || c.payload?.title || 'Uploaded document';
    let text = c.payload?.chunk_text || '';
    if (text.length > ITEM_MAX_CHARS) text = text.slice(0, ITEM_MAX_CHARS) + '…';
    parts.push(`[UPLOADED] ${name}\n${text}`);
  }

  return parts.join('\n\n---\n\n');
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

/**
 * Decides whether the retrieved chunks are actually about the same topic as
 * the question. Returns { covered: boolean, confidence: number, reason: string }.
 *
 * Fails open on any error (returns covered: true) so a transient LLM issue
 * never blocks a real answer.
 */
async function checkTopicalCoverage(question, clientHits, customSourceHits) {
  const context = buildCoverageContext(clientHits, customSourceHits);

  // If there's no context at all, there's nothing to check — the caller's
  // existing empty-check already handles this case, so pass through.
  if (!context || context.trim().length < 20) {
    return { covered: true, confidence: 1.0, reason: 'no context to check', _skipped: true };
  }

  let raw;
  try {
    raw = await callLLM(
      [
        { role: 'system', content: TOPICAL_COVERAGE_PROMPT },
        {
          role: 'user',
          content: `QUESTION:\n${question}\n\nRETRIEVED DOCUMENTS:\n${context}`,
        },
      ],
      { temperature: 0, max_tokens: 200, timeout: 30000 }
    );
  } catch (err) {
    console.log(`[TopicalCoverage] LLM call failed — failing open: ${err.message}`);
    return { covered: true, confidence: 0.0, reason: `check failed: ${err.message}`, _fallback: true };
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
    return { covered: true, confidence: 0.0, reason: 'unparseable response', _fallback: true };
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonBlock);
  } catch (err) {
    console.log(`[TopicalCoverage] JSON parse failed — failing open: ${err.message}`);
    return { covered: true, confidence: 0.0, reason: 'parse failed', _fallback: true };
  }

  const covered = parsed.covered === true;
  const confidence = Number.isFinite(parsed.confidence)
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 0.5;
  const reason = typeof parsed.reason === 'string' ? parsed.reason : '';

  console.log(
    `[TopicalCoverage] covered=${covered} confidence=${confidence.toFixed(2)} reason="${reason}"`
  );

  return { covered, confidence, reason };
}

// ─────────────────────────────────────────────────────────────────────────
// Framework-only checker — judges SUBJECT match only.
//
// Same return shape as checkTopicalCoverage: { covered, confidence, reason }.
// Handlers call this instead of checkTopicalCoverage when the question
// matches the framework regex. All non-framework questions keep using
// checkTopicalCoverage unchanged.
//
// Fails open on error, same as checkTopicalCoverage — if the AI call fails
// or the JSON is unparseable, we return covered: true so a transient issue
// never blocks a real answer.
// ─────────────────────────────────────────────────────────────────────────
async function checkFrameworkSubjectCoverage(question, clientHits, customSourceHits) {
  const context = buildCoverageContext(clientHits, customSourceHits);

  if (!context || context.trim().length < 20) {
    return { covered: true, confidence: 1.0, reason: 'no context to check', _skipped: true };
  }

  let raw;
  try {
    raw = await callLLM(
      [
        { role: 'system', content: FRAMEWORK_SUBJECT_PROMPT },
        {
          role: 'user',
          content: `QUESTION:\n${question}\n\nRETRIEVED DOCUMENTS:\n${context}`,
        },
      ],
      { temperature: 0, max_tokens: 200, timeout: 30000 }
    );
  } catch (err) {
    console.log(`[FrameworkCoverage] LLM call failed — failing open: ${err.message}`);
    return { covered: true, confidence: 0.0, reason: `check failed: ${err.message}`, _fallback: true };
  }

  if (process.env.DI_V2_DEBUG_LLM === '1') {
    console.log('[FrameworkCoverage] RAW LLM OUTPUT:');
    console.log(raw);
    console.log('[FrameworkCoverage] END RAW');
  }

  const stripped = stripFences(raw);
  const jsonBlock = findBalancedJson(stripped);
  if (!jsonBlock) {
    console.log(`[FrameworkCoverage] no JSON in output — failing open: ${stripped.slice(0, 200)}`);
    return { covered: true, confidence: 0.0, reason: 'unparseable response', _fallback: true };
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonBlock);
  } catch (err) {
    console.log(`[FrameworkCoverage] JSON parse failed — failing open: ${err.message}`);
    return { covered: true, confidence: 0.0, reason: 'parse failed', _fallback: true };
  }

  const covered = parsed.subject_matches === true;
  const reason = typeof parsed.reason === 'string' ? parsed.reason : '';

  console.log(
    `[FrameworkCoverage] subject_matches=${covered} reason="${reason}"`
  );

  return { covered, confidence: covered ? 1 : 0, reason };
}

// ─────────────────────────────────────────────────────────────────────────
// List-only per-item relevance filter.
//
// Given a question and a set of already-filtered candidate signals, ask the
// LLM which specific candidates genuinely answer the question. Return only
// those. Runs ONLY on the list path — inference/decision/framework paths
// keep using checkTopicalCoverage / checkFrameworkSubjectCoverage unchanged.
//
// Failure behaviour:
//   - LLM error, timeout, or unparseable response → return the full input
//     (fail open, same as today's behaviour) so a transient issue doesn't
//     hide valid results.
//   - LLM succeeded and selected an empty list → return [] (honor the LLM).
// ─────────────────────────────────────────────────────────────────────────
const LIST_SELECTION_PROMPT = `You are filtering a list of retrieved signals for a client's question.

You will be given:
  (1) A user's question. They want a LIST of signals that answer it.
  (2) A numbered list of candidate signals, each with a title and a short excerpt.

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

2. Judge the TITLE FIRST — the title is the article's actual subject.
   If the title clearly matches the question, include the candidate
   regardless of what the excerpt says. The excerpt is a random
   ~300-character slice of the article body and may not mention the
   main topic directly, may be from the middle of a paragraph, or may
   focus on a side detail. Do not reject a candidate just because its
   excerpt looks off-topic when the title is clearly on-topic.

   Only fall back to judging the excerpt when the title is ambiguous
   (e.g. generic like "Market Update" or "Industry News").

   Worked examples:

     Q: "List recent funding rounds in the Cosmetics industry."
     Candidate title: "Amoéba Embarks on Final Funding Round to Fuel Commercial Launch"
     Candidate excerpt: "...for professionals in the field of biocontrol and industrial greentech..."
     → INCLUDE. The title explicitly says "Funding Round". The excerpt's drift into "biocontrol" is irrelevant — the article IS a funding round article.

     Q: "List recent funding rounds in the Cosmetics industry."
     Candidate title: "Korea Enacts Dedicated Law to Boost Cosmetics Sector"
     Candidate excerpt: "...to ensure a resilient, long-term supply chain..."
     → DO NOT INCLUDE. The title is about a law, not a funding round. No amount of cosmetics-industry relevance makes it a funding round.

     Q: "What are the current import tariff rates for our core products across key markets?"
     Candidate title: "Canadian Cosmetics Face Tariff Hurdle in US Market"
     Candidate excerpt: "...Canadian cosmetics manufacturers are facing a significant challenge..."
     → INCLUDE. The title explicitly says "Tariff Hurdle". A tariff article about a specific market is still a tariff article.

3. Do NOT include candidates that merely share vocabulary with the question when the TITLE is also off-topic.
   A title about "retail" is NOT relevant to "retail in Saudi Arabia" unless the title mentions Saudi Arabia.
   A title about "cosmetics regulations in Vietnam" is NOT relevant to "cosmetics regulations in the UK".

4. Do NOT include candidates whose TITLE is about a different industry, different country, or different subject than the question.

5. If NONE of the candidates answer the question, return "relevant_indices": [].

6. Return ONLY the JSON. No markdown fences, no explanation, no extra text.`;

const LIST_ITEM_MAX_CHARS = 300;

function buildListSelectionContext(clientHits) {
  const lines = [];
  clientHits.forEach((h, i) => {
    const title = h.title || 'Untitled';
    let snippet = h.chunk_text || '';
    if (snippet.length > LIST_ITEM_MAX_CHARS) snippet = snippet.slice(0, LIST_ITEM_MAX_CHARS) + '…';
    lines.push(`[${i + 1}] ${title}\n${snippet}`);
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
    console.log(`[ListSelection] LLM call failed — failing open, returning all ${clientHits.length} hits: ${err.message}`);
    return clientHits;
  }

  if (process.env.DI_V2_DEBUG_LLM === '1') {
    console.log('[ListSelection] RAW LLM OUTPUT:');
    console.log(raw);
    console.log('[ListSelection] END RAW');
  }

  const stripped = stripFences(raw);
  const jsonBlock = findBalancedJson(stripped);
  if (!jsonBlock) {
    console.log(`[ListSelection] no JSON in output — failing open: ${stripped.slice(0, 200)}`);
    return clientHits;
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonBlock);
  } catch (err) {
    console.log(`[ListSelection] JSON parse failed — failing open: ${err.message}`);
    return clientHits;
  }

  if (!Array.isArray(parsed.relevant_indices)) {
    console.log(`[ListSelection] no relevant_indices array — failing open`);
    return clientHits;
  }

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
    `[ListSelection] selected ${selected.length}/${clientHits.length} relevant ` +
    `(reason="${parsed.reason || ''}")`
  );

  return selected;
}

module.exports = {
  checkTopicalCoverage,
  checkFrameworkSubjectCoverage,
  selectRelevantHitsForList,
  TOPICAL_COVERAGE_PROMPT,
  FRAMEWORK_SUBJECT_PROMPT,
  LIST_SELECTION_PROMPT,
};