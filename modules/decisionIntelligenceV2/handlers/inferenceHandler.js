/**
 * modules/decisionIntelligenceV2/handlers/inferenceHandler.js
 *
 * STAGE 3b — inference handler.
 *
 * Input:  retrieval hits (client signals) + custom source chunks
 * Output: { report: { title, bodyText }, sources: [...] }
 *
 * ONE LLM call (with one retry on JSON parse failure).
 * No schema designer. No sections. No framework.
 * Short, direct answer in prose.
 */

const { callLLM } = require('../../llmClient');

const INFERENCE_PROMPT = `You are a market intelligence analyst writing a short, direct answer to a client's question.

You have been given retrieved signals and uploaded documents from the client's own data. Answer the question using ONLY that context. Never use outside knowledge.

Content rules:
- Open with a one-paragraph direct answer.
- Then add 2-4 supporting bullets.
- Optional one-sentence "What this means" summary at the end.
- Total under 400 words.
- Do not invent facts, numbers, organizations, dates, or names.
- If the context does not answer the question, say so plainly.
- Do not mention "the provided articles", "the context", or "the retrieved data".
- Do not include citation markers like [1], [2] in the body.
- Preserve exactly: organization names, regulation names, dates, numbers, monetary figures.
- Plain prose only. No tables. No markdown headers.

Output format — return EXACTLY this JSON object and NOTHING ELSE.
Here is a complete worked example. Match this format precisely:

{
  "title": "Glossier Restructuring Update",
  "bodyText": "Glossier is undergoing significant restructuring under new CEO Colin Walsh. The company has reduced its workforce by roughly a third to lower operating costs and refocus the brand.\\n- The workforce was cut from ~170 to ~115 employees.\\n- Founded in 2014, Glossier peaked at a $1.8 billion valuation before pandemic-era growth stalled.\\n- Leadership has flagged a return to core values: innovation, cultural relevance, and customer trust.\\nWhat this means: Glossier's ability to rebuild brand relevance will determine its long-term trajectory in the beauty market."
}

Critical formatting requirements:
- The "bodyText" value MUST be wrapped in double quotes on both sides.
- Inside bodyText, every line break MUST be written as \\n (backslash, then the letter n). NEVER press Enter inside the string.
- Bullets start with "- " and are separated by \\n- .
- Do not add any text before the opening { or after the closing }.
- Do not wrap the JSON in markdown code fences.
- Do not include any explanation. Return ONLY the JSON object.`;

// ─────────────────────────────────────────────────────────────────────────
// Context builder
// ─────────────────────────────────────────────────────────────────────────

const MAX_CLIENT_CHUNKS = 8;
const MAX_CUSTOM_CHUNKS = 10;
const ITEM_MAX_CHARS = 1200;

function buildContext(clientHits, customHits) {
  const parts = [];

  const matched   = clientHits.filter((h) => h._matched);
  const unmatched = clientHits.filter((h) => !h._matched);

  const clientPool = [...matched, ...unmatched].slice(0, MAX_CLIENT_CHUNKS);

  for (const h of clientPool) {
    const title = h.title || 'Untitled';
    let text = h.chunk_text || '';
    if (text.length > ITEM_MAX_CHARS) text = text.slice(0, ITEM_MAX_CHARS) + '…';
    parts.push(`[CLIENT] ${title}\n${text}`);
  }

  const customPool = (customHits || []).slice(0, MAX_CUSTOM_CHUNKS);
  for (const c of customPool) {
    const name = c.payload?.source_name || c.payload?.title || 'Uploaded document';
    let text = c.payload?.chunk_text || '';
    if (text.length > ITEM_MAX_CHARS) text = text.slice(0, ITEM_MAX_CHARS) + '…';
    parts.push(`[UPLOADED] ${name}\n${text}`);
  }

  return parts.join('\n\n---\n\n');
}

// ─────────────────────────────────────────────────────────────────────────
// JSON parsing helpers
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

/**
 * Walk the string character-by-character and escape raw newlines that
 * appear INSIDE a quoted string. This is the most common LLM JSON
 * failure mode — putting literal line breaks inside "bodyText" instead
 * of the \n escape sequence.
 *
 * Character-walk is more reliable than a regex because it handles
 * escaped quotes and multi-line strings correctly.
 */
function escapeRawNewlinesInStrings(s) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }

    if (inString && (ch === '\n' || ch === '\r')) {
      out += '\\n';
      continue;
    }

    out += ch;
  }

  return out;
}

/**
 * Attempt to parse JSON, applying the raw-newline repair if the first
 * parse fails. Returns the parsed object or null.
 */
function tryParseJson(block, label = '') {
  if (!block) return null;

  try {
    return JSON.parse(block);
  } catch (err) {
    // Retry with repair
    try {
      const repaired = escapeRawNewlinesInStrings(block);
      const parsed = JSON.parse(repaired);
      console.log(`[inferenceHandler] JSON repaired${label ? ' (' + label + ')' : ''}`);
      return parsed;
    } catch (err2) {
      console.log(`[inferenceHandler] JSON parse failed${label ? ' (' + label + ')' : ''}: ${err.message}`);
      return null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────
/**
 * @param {string} question
 * @param {Array}  clientHits           retrieval hits from client signals
 * @param {Array}  customSourceHits     retrieval hits from custom sources
 * @returns {Promise<{
 *   report: { title: string, bodyText: string } | null,
 *   sources: Array,
 *   _empty?: boolean,
 *   _reason?: string,
 * }>}
 */
async function buildInferenceAnswer(question, clientHits = [], customSourceHits = []) {
  if (!clientHits.length && !customSourceHits.length) {
    return {
      report: null,
      sources: [],
      _empty: true,
      _reason: 'no client signals or uploaded documents matched the question',
    };
  }

  const context = buildContext(clientHits, customSourceHits);
  const userPrompt = `Context:\n${context}\n\nQuestion: ${question}`;

  let raw;
  try {
    raw = await callLLM(
      [
        { role: 'system', content: INFERENCE_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0.2, max_tokens: 2000, timeout: 90000 }
    );
  } catch (err) {
    console.log(`[inferenceHandler] LLM call failed: ${err.message}`);
    return {
      report: null,
      sources: [],
      _empty: true,
      _reason: `LLM call failed: ${err.message}`,
    };
  }

  if (process.env.DI_V2_DEBUG_LLM === '1') {
    console.log('[inferenceHandler] RAW LLM OUTPUT:');
    console.log(raw);
    console.log('[inferenceHandler] END RAW');
  }

  // First parse attempt
  const stripped = stripFences(raw);
  let jsonBlock = findBalancedJson(stripped);

  // If balanced-JSON extraction failed but the text starts with '{', the
  // model likely truncated the response (missing final '}'). Try appending
  // one — if the body was complete, this parses cleanly.
  if (!jsonBlock && stripped.startsWith('{')) {
    console.log(`[inferenceHandler] JSON appears truncated — attempting close-brace repair`);
    jsonBlock = stripped + '}';
  }

  let parsed = tryParseJson(jsonBlock, 'first pass');

    console.log(`[inferenceHandler] parsed object:`, parsed ? Object.keys(parsed) : 'null');
  console.log(`[inferenceHandler] bodyText type:`, parsed ? typeof parsed.bodyText : 'no-parsed');
  if (parsed && typeof parsed.bodyText === 'string') {
    console.log(`[inferenceHandler] bodyText length:`, parsed.bodyText.length);
  }
  console.log(`[inferenceHandler] jsonBlock length:`, jsonBlock ? jsonBlock.length : 'null');

  // Retry once if parse failed or shape is wrong
  if (!parsed || typeof parsed.bodyText !== 'string') {
    console.log(`[inferenceHandler] retrying with stricter JSON instruction`);
    try {
      const retryRaw = await callLLM(
        [
          { role: 'system', content: INFERENCE_PROMPT },
          {
            role: 'user',
            content:
              userPrompt +
              '\n\nIMPORTANT: Your previous response was not valid JSON. Return ONLY the JSON object. ' +
              'No markdown fences. No explanation. The "bodyText" field must be a single JSON string ' +
              'with escaped newlines (\\n), not raw line breaks.',
          },
        ],
        { temperature: 0, max_tokens: 2000, timeout: 90000 }
      );
      const retryStripped = stripFences(retryRaw);
      const retryBlock = findBalancedJson(retryStripped);
      parsed = tryParseJson(retryBlock, 'retry');
    } catch (err) {
      console.log(`[inferenceHandler] retry LLM call failed: ${err.message}`);
    }
  }

  // If still unparseable, fall back to a plain-prose answer (no JSON).
  if (!parsed || typeof parsed.bodyText !== 'string') {
    console.log(`[inferenceHandler] JSON failed twice — falling back to plain-prose answer`);
    try {
      const plainRaw = await callLLM(
        [
          {
            role: 'system',
            content:
              'You are a market intelligence analyst. Answer the question using ONLY the provided context. ' +
              'Open with a direct answer, then 2-4 bullets, then an optional "What this means" line. ' +
              'Under 400 words. Plain prose — no JSON, no markdown headers, no tables. ' +
              'Do not invent facts. Preserve organization names, dates, and numbers exactly.',
          },
          { role: 'user', content: userPrompt },
        ],
        { temperature: 0.2, max_tokens: 1200, timeout: 90000 }
      );

      const plainBody = String(plainRaw || '').trim();
      if (plainBody.length > 20) {
        return {
          report: {
            title: question,
            bodyText: plainBody,
          },
          sources: collectSources(clientHits, customSourceHits),
        };
      }
    } catch (err) {
      console.log(`[inferenceHandler] plain-prose fallback failed: ${err.message}`);
    }

    // Absolute last resort
    return {
      report: {
        title: question,
        bodyText: 'I could not generate a structured answer from the retrieved sources.',
      },
      sources: collectSources(clientHits, customSourceHits),
    };
  }

  return {
    report: {
      title: (parsed.title || question).toString().slice(0, 200),
      bodyText: String(parsed.bodyText).trim(),
    },
    sources: collectSources(clientHits, customSourceHits),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Source collection — matched only, fallback to top 3 un-matched
// ─────────────────────────────────────────────────────────────────────────
function collectSources(clientHits, customSourceHits) {
  const out = [];

  const matched   = clientHits.filter((h) => h._matched);
  const unmatched = clientHits.filter((h) => !h._matched);
  const ordered   = matched.length > 0 ? matched : unmatched.slice(0, 3);

  const seenArticles = new Set();
  for (const h of ordered) {
    if (!h.article_id) continue;
    if (seenArticles.has(h.article_id)) continue;
    seenArticles.add(h.article_id);

    out.push({
      type: 'client',
      article_id: h.article_id,
      module: h.module_name,
      module_id: h.module_id,
      title: h.title,
      url: h.url || null,
      matched: Boolean(h._matched),
    });
  }

  const seenCustom = new Set();
  for (const c of customSourceHits || []) {
    const p = c.payload || {};
    const sid = p.source_id;
    if (sid && seenCustom.has(sid)) continue;
    if (sid) seenCustom.add(sid);

    out.push({
      type: 'custom_source',
      source_id: sid || null,
      source_name: p.source_name || p.title || 'Uploaded document',
      source_type: p.source_type || null,
      content_id: p.content_id || null,
      chunk_index: p.chunk_index ?? null,
      url: p.source_url || null,
    });
  }

  return out;
}

module.exports = {
  buildInferenceAnswer,
  buildContext,
  collectSources,
  tryParseJson,
  escapeRawNewlinesInStrings,
  INFERENCE_PROMPT,
};