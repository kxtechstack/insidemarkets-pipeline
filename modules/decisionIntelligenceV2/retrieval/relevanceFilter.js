/**
 * modules/decisionIntelligenceV2/retrieval/relevanceFilter.js
 *
 * LLM-driven relevance filter for INFERENCE and DECISION questions.
 * (LIST questions do NOT use this — they use filterListHits.js instead.)
 *
 * One batched LLM call judges each retrieved chunk. Returns only chunks
 * that pass the minScore threshold.
 */

const { callLLM } = require('../../llmClient');

const DEFAULT_MIN_SCORE = 80;
const CHUNK_PREVIEW_CHARS = 1500;
const MAX_CHUNKS_PER_CALL = 20;

const AUDIT_PROMPT = `You are a strict relevance auditor for a market intelligence chat.

You will be given a QUESTION and a numbered list of CHUNKS. Each chunk has a TITLE and a BODY PREVIEW.

Decide for each chunk: does this chunk DIRECTLY ANSWER the specific question asked?

Return ONLY this JSON:
{
  "chunks": [
    { "index": 1, "relevant": true | false, "score": <0-100>, "reason": "<short>" }
  ]
}

THE CARDINAL RULE:
A chunk is relevant ONLY if it directly helps answer the SPECIFIC question.
Sharing keywords with the question is NOT relevance.

HOW TO READ A CHUNK:
1. Read the TITLE first. The title usually states what the chunk is ABOUT.
2. Read the BODY for supporting details.
3. Decide: if a user asked the QUESTION, would this chunk help them?

SCORING:
90-100 = direct answer to the question
80-89  = strongly on-topic, clearly contributes
40-79  = shares topic but doesn't answer — DROP
0-39   = off-topic — DROP

When in doubt, DROP (relevant: false, score below 80).
Return one entry per chunk, in the same order as provided.
Return ONLY the JSON. No markdown. No explanation.`;

function buildNumberedList(clientHits, customHits) {
  const items = [];
  for (const h of clientHits) {
    items.push({
      kind: 'client',
      ref: h,
      title: h.title || 'Untitled',
      module: h.module_name || '',
      text: (h.chunk_text || '').slice(0, CHUNK_PREVIEW_CHARS),
      label: `[CLIENT] ${h.title || 'Untitled'}${h.module_name ? ' | ' + h.module_name : ''}`,
    });
  }
  for (const c of customHits) {
    const p = c.payload || {};
    items.push({
      kind: 'custom',
      ref: c,
      title: p.source_name || p.title || 'Document',
      module: '',
      text: (p.chunk_text || '').slice(0, CHUNK_PREVIEW_CHARS),
      label: `[UPLOADED] ${p.source_name || p.title || 'Document'} | chunk ${p.chunk_index ?? '?'}`,
    });
  }
  return items.slice(0, MAX_CHUNKS_PER_CALL);
}

function parseVerdict(raw) {
  const stripped = String(raw || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/```\s*$/, '')
    .trim();
  const first = stripped.indexOf('{');
  if (first === -1) return null;
  let depth = 0, end = -1;
  for (let i = first; i < stripped.length; i++) {
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  try { return JSON.parse(stripped.slice(first, end + 1)); } catch { return null; }
}

async function filterRelevantChunks(question, clientHits = [], customHits = [], opts = {}) {
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;

  const passthrough = {
    keptClientHits: clientHits,
    keptCustomHits: customHits,
    verdicts: [],
    filterRan: false,
  };

  const items = buildNumberedList(clientHits, customHits);
  if (items.length === 0) return passthrough;

  const chunkBlocks = items.map((it, i) => {
    return `--- CHUNK ${i + 1} ---\nTITLE: ${it.title}${it.module ? ` (${it.module})` : ''}\nBODY PREVIEW:\n${it.text}`;
  }).join('\n\n');

  const userPrompt = `QUESTION:\n${question}\n\n${chunkBlocks}`;

  let raw;
  try {
    raw = await callLLM(
      [
        { role: 'system', content: AUDIT_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0, max_tokens: 2500, timeout: 90000 }
    );
  } catch (err) {
    console.log(`[relevanceFilter] LLM failed (${err.message}) — passing all hits`);
    return passthrough;
  }

  const parsed = parseVerdict(raw);
  if (!parsed || !Array.isArray(parsed.chunks)) {
    console.log(`[relevanceFilter] verdict unparseable — passing all hits`);
    return passthrough;
  }

  const byIndex = new Map();
  for (const v of parsed.chunks) {
    const idx = Number(v.index);
    if (Number.isInteger(idx) && idx >= 1 && idx <= items.length) {
      byIndex.set(idx, {
        relevant: v.relevant === true,
        score: typeof v.score === 'number' ? v.score : null,
        reason: typeof v.reason === 'string' ? v.reason : '',
      });
    }
  }

  const verdicts = [];
  const keptClientHits = [];
  const keptCustomHits = [];

  items.forEach((it, i) => {
    const n = i + 1;
    const v = byIndex.get(n);

    if (!v) {
      verdicts.push({ kind: it.kind, label: it.label, index: n, relevant: true, score: null, reason: 'no verdict returned' });
      if (it.kind === 'client') keptClientHits.push(it.ref);
      else keptCustomHits.push(it.ref);
      return;
    }

    verdicts.push({ kind: it.kind, label: it.label, index: n, ...v });

    const passesScore = v.score !== null && v.score >= minScore;
    if (v.relevant && passesScore) {
      if (it.kind === 'client') keptClientHits.push(it.ref);
      else keptCustomHits.push(it.ref);
    }
  });

  const keptCount = keptClientHits.length + keptCustomHits.length;
  console.log(`[relevanceFilter] kept ${keptCount}/${items.length} chunks (minScore=${minScore})`);

  return { keptClientHits, keptCustomHits, verdicts, filterRan: true };
}

module.exports = { filterRelevantChunks, DEFAULT_MIN_SCORE };