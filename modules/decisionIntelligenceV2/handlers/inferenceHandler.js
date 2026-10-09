/**
 * modules/decisionIntelligenceV2/handlers/inferenceHandler.js
 *
 * STAGE 3b — inference handler.
 *
 * Input:  retrieval hits (client signals) + custom source chunks
 *         (NO SEC — inference is client + custom only)
 * Output: { report, sources }
 *
 * TWO LLM calls now (matching the decision handler's pattern):
 *   1. Schema designer — designs 3-5 tailored headings for this question
 *   2. Writer          — fills those headings with bullets from context
 *
 * If the schema designer fails or the writer returns an unparseable shape,
 * the handler falls back to the legacy flat { title, bodyText } shape.
 * The external function signature and return type are unchanged.
 */

const { callLLM } = require('../../llmClient');

// ─────────────────────────────────────────────────────────────────────────
// Call 1 — schema designer (same pattern as decisionHandler)
// ─────────────────────────────────────────────────────────────────────────
const SCHEMA_DESIGNER_PROMPT = `You design the section structure for a concise market intelligence answer.

Given a client's question, return 3-5 headings that would best organise
a focused answer. Each heading must be a short noun phrase (2-6 words).

Examples of good headings:
- "Current Situation"
- "Key Developments"
- "Market Impact"
- "What to Watch"
- "Strategic Implications"
- "Supporting Evidence"
- "Drivers"
- "Outlook"

Rules:
- 3-5 headings only.
- Each heading must be 2-6 words.
- Headings must be SPECIFIC to the question — not generic templates.
- Do NOT number them.
- Do NOT include "Introduction", "Conclusion", "Overview", or "Executive Summary".
- Do NOT include "Recommendations" or "Next Steps" as headings.

Return ONLY this JSON:

{
  "sections": [
    { "heading": "..." },
    { "heading": "..." },
    { "heading": "..." }
  ]
}

Return ONLY the JSON. No markdown fences, no explanation.`;

// ─────────────────────────────────────────────────────────────────────────
// Call 2 — writer (fills the headings, matching decisionHandler's shape)
// ─────────────────────────────────────────────────────────────────────────
const WRITER_PROMPT = `You are a market intelligence analyst producing a concise, direct answer to a client's question.

You have been given retrieved signals and uploaded documents from the client's own data, plus a required section structure. Fill each section with 2-4 substantive bullets drawn from the context.

Content rules:
- Each section gets 2-4 bullets.
- Bullets must be complete thoughts, not single words.
- Every bullet must be grounded in the provided context. Do not invent facts, numbers, dates, or names.
- If a section cannot be supported by the context, use a single bullet: "No relevant data in the current dataset."
- Preserve exactly: organization names, regulation names, dates, numbers, monetary figures.
- Do not mention "the provided articles", "the context", or "the retrieved data".
- Do not include citation markers like [1], [2].
- Plain prose bullets. No tables. No markdown headers inside bullets.
- The bottom_line must be 1-2 sentences synthesising the key takeaway.

Output format — return EXACTLY this JSON object and NOTHING ELSE:

{
  "title": "<short descriptive title>",
  "sections": [
    { "heading": "<exact heading from the required structure>", "points": ["...", "..."] },
    ...
  ],
  "bottom_line": "<1-2 sentence conclusion>"
}

Critical formatting requirements:
- Every "points" array is an array of strings.
- Inside string values, any line break MUST be written as \\n. NEVER press Enter inside a string.
- Every heading must EXACTLY match one from the required structure, in the same order.
- Do not add or remove sections.
- Do not add any text before the opening { or after the closing }.
- Do not wrap the JSON in markdown code fences.
- Return ONLY the JSON object.`;

// ─────────────────────────────────────────────────────────────────────────
// Legacy flat-text prompt — used ONLY as fallback if schema path fails.
// ─────────────────────────────────────────────────────────────────────────
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
    if (ch === '\\') { out += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (inString && (ch === '\n' || ch === '\r')) { out += '\\n'; continue; }

    out += ch;
  }
  return out;
}

function tryParseJson(block, label = '') {
  if (!block) return null;

  try {
    return JSON.parse(block);
  } catch (err) {
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

function parseJsonWithTruncation(raw, label) {
  const stripped = stripFences(raw);
  let jsonBlock = findBalancedJson(stripped);
  if (!jsonBlock && stripped.startsWith('{')) {
    console.log(`[inferenceHandler] JSON appears truncated — attempting close-brace repair (${label})`);
    jsonBlock = stripped + '}';
  }
  return tryParseJson(jsonBlock, label);
}

// ─────────────────────────────────────────────────────────────────────────
// Call 1 — design the section structure
// ─────────────────────────────────────────────────────────────────────────
async function designInferenceSchema(question) {
  try {
    const schemaRaw = await callLLM(
      [
        { role: 'system', content: SCHEMA_DESIGNER_PROMPT },
        { role: 'user', content: question },
      ],
      { temperature: 0.3, max_tokens: 500, timeout: 45000 }
    );

    const parsed = parseJsonWithTruncation(schemaRaw, 'inference-schema');
    if (parsed && Array.isArray(parsed.sections)) {
      const valid = parsed.sections
        .filter((s) => s && typeof s.heading === 'string' && s.heading.trim())
        .map((s) => String(s.heading).trim())
        .slice(0, 5);

      if (valid.length >= 3) {
        console.log(`[inferenceHandler] schema: ${valid.join(' | ')}`);
        return valid;
      }
      console.log(`[inferenceHandler] schema produced only ${valid.length} valid headings — using legacy flat shape`);
    }
  } catch (err) {
    console.log(`[inferenceHandler] schema designer failed: ${err.message}`);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Sanitize the schema-path writer output
// ─────────────────────────────────────────────────────────────────────────
function sanitizeSectionsReport(report, headings, question) {
  const byHeading = new Map();
  if (report && Array.isArray(report.sections)) {
    for (const s of report.sections) {
      if (!s || typeof s.heading !== 'string') continue;
      const key = s.heading.trim().toLowerCase();
      const points = Array.isArray(s.points)
        ? s.points.filter((p) => typeof p === 'string' && p.trim())
        : [];
      byHeading.set(key, points);
    }
  }

  // Force the sections to be exactly the required headings, in order.
  // Empty points arrays get the fallback bullet so we never ship a header
  // with no content.
  const finalSections = headings.map((h) => {
    const points = byHeading.get(h.toLowerCase()) || [];
    return {
      heading: h,
      points: points.length > 0 ? points : ['No relevant data in the current dataset.'],
    };
  });

  if (!report) {
    return {
      title: question,
      sections: finalSections,
      bottom_line: 'Could not generate a structured report from the retrieved sources.',
    };
  }

  return {
    title: (report.title || question).toString().slice(0, 200),
    sections: finalSections,
    bottom_line: typeof report.bottom_line === 'string'
      ? report.bottom_line.trim()
      : '',
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Detect an all-empty report (every section only contains the fallback
// "No relevant data..." bullet). Used to short-circuit to _empty instead
// of returning an empty report shell to the frontend.
// ─────────────────────────────────────────────────────────────────────────
function isAllEmptyReport(rep) {
  if (!rep || !Array.isArray(rep.sections) || rep.sections.length === 0) return false;
  return rep.sections.every((s) =>
    Array.isArray(s.points) &&
    s.points.length === 1 &&
    /no relevant data/i.test(s.points[0])
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Legacy flat-text path — used only when schema path fails
// ─────────────────────────────────────────────────────────────────────────
async function runLegacyFlatAnswer(question, clientHits, customSourceHits, userPrompt) {
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
    console.log(`[inferenceHandler] legacy LLM call failed: ${err.message}`);
    return null;
  }

  if (process.env.DI_V2_DEBUG_LLM === '1') {
    console.log('[inferenceHandler] RAW LEGACY LLM OUTPUT:');
    console.log(raw);
    console.log('[inferenceHandler] END RAW');
  }

  const parsed = parseJsonWithTruncation(raw, 'legacy');

  if (!parsed || typeof parsed.bodyText !== 'string') {
    console.log(`[inferenceHandler] legacy retry with stricter JSON instruction`);
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
      const retryParsed = parseJsonWithTruncation(retryRaw, 'legacy-retry');
      if (retryParsed && typeof retryParsed.bodyText === 'string') {
        return {
          title: (retryParsed.title || question).toString().slice(0, 200),
          bodyText: String(retryParsed.bodyText).trim(),
        };
      }
    } catch (err) {
      console.log(`[inferenceHandler] legacy retry LLM call failed: ${err.message}`);
    }

    // Plain-prose fallback
    console.log(`[inferenceHandler] legacy JSON failed twice — falling back to plain-prose answer`);
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
        return { title: question, bodyText: plainBody };
      }
    } catch (err) {
      console.log(`[inferenceHandler] plain-prose fallback failed: ${err.message}`);
    }

    return {
      title: question,
      bodyText: 'I could not generate a structured answer from the retrieved sources.',
    };
  }

  return {
    title: (parsed.title || question).toString().slice(0, 200),
    bodyText: String(parsed.bodyText).trim(),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────
/**
 * @param {string} question
 * @param {Array}  clientHits           retrieval hits from client signals
 * @param {Array}  customSourceHits     retrieval hits from custom sources
 * @returns {Promise<{
 *   report: { title, sections, bottom_line } | { title, bodyText } | null,
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

  // ── Call 1: design headings ──────────────────────────────────────────
  const headings = await designInferenceSchema(question);

  if (headings) {
    // ── Call 2 (schema path): writer fills the headings ───────────────
    const headingsBlock = headings
      .map((h, i) => `${i + 1}. ${h}`)
      .join('\n');

    const writerPrompt =
      `Context:\n${context}\n\nQuestion: ${question}\n\n` +
      `Required section headings (exact, in this order):\n${headingsBlock}\n\n` +
      `Fill each section with 2-4 bullets drawn from the context. Return JSON only.`;

    let writerRaw;
    try {
      writerRaw = await callLLM(
        [
          { role: 'system', content: WRITER_PROMPT },
          { role: 'user', content: writerPrompt },
        ],
        { temperature: 0.2, max_tokens: 2200, timeout: 120000 }
      );
    } catch (err) {
      console.log(`[inferenceHandler] schema writer LLM call failed: ${err.message}`);
    }

    let report = null;
    if (writerRaw) {
      report = parseJsonWithTruncation(writerRaw, 'inference-writer');
    }

    // Retry once with stricter instruction
    if (!report || !Array.isArray(report.sections)) {
      console.log(`[inferenceHandler] schema writer retry with stricter instruction`);
      try {
        const retryRaw = await callLLM(
          [
            { role: 'system', content: WRITER_PROMPT },
            { role: 'user', content: writerPrompt + '\n\nIMPORTANT: Return ONLY valid JSON. No prose, no fences.' },
          ],
          { temperature: 0, max_tokens: 2200, timeout: 120000 }
        );
        report = parseJsonWithTruncation(retryRaw, 'inference-writer-retry');
      } catch (err) {
        console.log(`[inferenceHandler] schema writer retry failed: ${err.message}`);
      }
    }

    if (report && Array.isArray(report.sections)) {
      const sanitized = sanitizeSectionsReport(report, headings, question);

      // ── All-empty report check ──────────────────────────────────────
      // If every section ended up as just the fallback bullet, treat the
      // response as no_data instead of showing an empty report shell to
      // the user. The responseBuilder turns _empty:true into a clean
      // "no data" message with suggestions.
      if (isAllEmptyReport(sanitized)) {
        console.log(`[inferenceHandler] all sections empty — returning no_data`);
        return {
          report: null,
          sources: [],
          _empty: true,
          _reason: "Our current intelligence doesn't cover this yet. Here are some questions you might find useful:",
        };
      }

      return {
        report: sanitized,
        sources: collectSources(clientHits, customSourceHits),
      };
    }

    console.log(`[inferenceHandler] schema writer failed twice — falling back to legacy flat shape`);
  }

  // ── Fallback: legacy flat path ───────────────────────────────────────
  const legacyReport = await runLegacyFlatAnswer(question, clientHits, customSourceHits, userPrompt);

  if (!legacyReport) {
    return {
      report: null,
      sources: [],
      _empty: true,
      _reason: 'LLM call failed',
    };
  }

  return {
    report: legacyReport,
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
  sanitizeSectionsReport,
  isAllEmptyReport,
  tryParseJson,
  escapeRawNewlinesInStrings,
  INFERENCE_PROMPT,
  SCHEMA_DESIGNER_PROMPT,
  WRITER_PROMPT,
};