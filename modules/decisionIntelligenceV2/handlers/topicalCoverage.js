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

const ITEM_MAX_CHARS = 350;
const MAX_CLIENT_HITS = 6;
const MAX_CUSTOM_HITS = 4;

function buildCoverageContext(clientHits, customSourceHits) {
  const parts = [];

  // Prefer matched hits, then unmatched — capped at MAX_CLIENT_HITS total
  const matched = (clientHits || []).filter((h) => h._matched);
  const unmatched = (clientHits || []).filter((h) => !h._matched);
  const clientPool = [...matched, ...unmatched].slice(0, MAX_CLIENT_HITS);

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

module.exports = { checkTopicalCoverage, TOPICAL_COVERAGE_PROMPT };