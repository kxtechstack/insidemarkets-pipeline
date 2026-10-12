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

const TOPICAL_COVERAGE_PROMPT = `You are a coarse topical sanity checker for a market intelligence system.

You will be given:
  (1) a user's question
  (2) the titles and excerpts of documents the system retrieved from the client's data

Your job: decide whether the retrieved documents belong to the same BROAD
SECTOR/DOMAIN as the question.

=========================
THE CORE DISTINCTION
=========================

There are two kinds of difference to keep separate:

(A) TERMINOLOGY difference — same underlying thing, different word.
    Examples:
      "vapour duty" vs "vaping duty"
      "regulation" vs "rules" vs "compliance"
      "companies" vs "firms" vs "brands"
      "retailers" vs "retail stores"
    → These are COVERED. Answer YES.

(B) SECTOR difference — genuinely different business domain.
    Examples:
      "retail industry" vs "cosmetics industry"  ← different sectors
      "banking" vs "pharmaceuticals"
      "automotive" vs "beauty"
      "logistics" vs "food"
    → These are NOT COVERED. Answer NO.

The presence of a few sector-adjacent words does NOT convert a sector
mismatch into a match. If the question is about "retail" and the documents
are about cosmetics (even if some cosmetics articles mention "retail
distribution" in passing), answer NO. The client's dataset is about a
different sector than the question asks about.

=========================
WHAT COUNTS AS COVERED (YES)
=========================

Answer YES (covered) if:
  - The documents and the question are about the same industry, sector,
    company, product category, or regulatory area.
  - The documents use DIFFERENT TERMINOLOGY for the same subject (see A
    above). Same underlying thing, different words — still covered.
  - The documents are ABOUT the entity or topic the question names, even
    if they don't directly answer the question. A request for a
    framework-style analysis (like a SWOT) of a specific company is COVERED
    as long as the documents are about that company — the writer will
    construct the framework from the facts.
  - The documents are on a BROADER subject than the question, or a NARROWER
    subject within the question's domain.
  - The documents cover the same regulatory/tax/policy area at a different
    level of specificity (e.g. question about one specific duty, docs
    about the broader tax regime that includes it — still the same domain).

=========================
WHAT COUNTS AS NOT COVERED (NO)
=========================

Answer NO (not covered) if:
  - The question is about one SECTOR and the documents are about a
    DIFFERENT SECTOR — even if some documents mention the question's
    sector-adjacent words in passing. See (B) above.
  - The question is about a specific company and the documents are about
    an entirely unrelated company.
  - The question is bounded to one country/region and every document is
    about a different country/region.
  - The documents are about a completely unrelated subject.

=========================
THE HARD TEST
=========================

Before answering YES, ask yourself: "Would a careful analyst honestly be
able to write an answer to this specific question using ONLY these
documents, without having to import the sector the question asks about
from outside the documents?"

If the answer is "no, they'd be writing about a sector the documents don't
actually cover" → answer NO.

If the answer is "yes, but they'd need to phrase it differently or apply
a framework" → answer YES.

=========================
EXAMPLES
=========================

Question: "What is happening in Saudi Arabia retail industry?"
Documents: All cosmetics industry articles — regulations, product news,
           K-beauty trends. Some of them mention "retail distribution"
           in passing.
→ NO. The documents are about the cosmetics sector; the question is
     about the retail sector. A couple of "retail" mentions do not
     make this covered.

Question: "Do a SWOT for Estée Lauder?"
Documents: Estée Lauder market performance, brand acquisitions,
           research awards.
→ YES. The documents are about the company. The writer will construct
     the SWOT.

Question: "Updates on vapour duty?"
Documents: UK Vaping Products Duty, duty stamps, excise tax on vaping.
→ YES. Vapour/vaping is the same subject with different spelling.

Question: "Recent cosmetics regulations?"
Documents: EU cosmetics regulation, K-beauty regulatory news, FDA MoCRA.
→ YES. Same sector.

Question: "Recent cosmetics regulations?"
Documents: Automotive safety standards, driver licensing rules.
→ NO. Different sector.

=========================
OUTPUT
=========================

Return ONLY this JSON object and NOTHING ELSE:

{
  "covered": true | false,
  "confidence": 0.0 - 1.0,
  "reason": "<one short sentence>"
}

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