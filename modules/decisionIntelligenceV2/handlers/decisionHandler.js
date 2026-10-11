/**
 * modules/decisionIntelligenceV2/handlers/decisionHandler.js
 *
 * STAGE 3c — decision handler.
 *
 * Input:  retrieval hits (client signals) + custom source chunks
 * Output: { report: { title, sections: [{heading, points}], bottom_line }, sources }
 *         OR { report: null, sources: [], _empty: true, _reason: "..." }
 *
 * TWO LLM calls:
 *   1. Schema designer — designs 4-5 tailored headings for this question
 *   2. Writer          — fills those headings with bullets from context
 *
 * No SEC. No frameworks hardcoded. Dynamic structure.
 * Prompts stay in code until Stage 6.
 */

const { callLLM } = require('../../llmClient');

// ─────────────────────────────────────────────────────────────────────────
// Call 1 — schema designer
// ─────────────────────────────────────────────────────────────────────────
const SCHEMA_DESIGNER_PROMPT = `You design the section structure for a rich market intelligence report.

Given a client's question, return 4-5 headings that would best organise
a thorough answer. Each heading must be a short noun phrase (2-6 words).

Examples of good headings:
- "Market Size and Growth"
- "Competitive Landscape"
- "Regulatory Considerations"
- "Key Risks"
- "Entry Considerations"
- "Strategic Implications"
- "Funding Environment"
- "Product and Category Trends"
- "Regional Dynamics"

Rules:
- 4-5 headings only.
- Each heading must be 2-6 words.
- Headings must be SPECIFIC to the question — not generic templates.
- Do NOT number them.
- Do NOT include "Introduction", "Conclusion", "Overview", or "Executive Summary".
- Do NOT include "Recommendations" or "Next Steps" as headings (these go in the bottom_line).
- For framework questions (SWOT, PESTLE, Five Forces, Risk Analysis), use the
  framework's own standard headings:
    SWOT: Strengths, Weaknesses, Opportunities, Threats
    PESTLE: Political, Economic, Social, Technological, Legal, Environmental
    Five Forces: Threat of New Entrants, Supplier Power, Buyer Power,
                 Threat of Substitutes, Competitive Rivalry
    Risk Analysis: Operational Risks, Financial Risks, Regulatory & Legal Risks,
                   Market & Competitive Risks

Return ONLY this JSON:

{
  "sections": [
    { "heading": "..." },
    { "heading": "..." },
    { "heading": "..." },
    { "heading": "..." }
  ]
}

Return ONLY the JSON. No markdown fences, no explanation.`;

// ─────────────────────────────────────────────────────────────────────────
// Call 2 — writer
// ─────────────────────────────────────────────────────────────────────────
const WRITER_PROMPT = `You are a senior market intelligence analyst producing a rich report for a client.

You have been given retrieved signals and uploaded documents from the client's own data, plus a required section structure. Fill each section with substantive bullets drawn from the context.

Content rules:
- Each section gets 3-5 bullets.
- Bullets must be complete thoughts, not single words.
- Every bullet must be grounded in the provided context. Do not invent facts, numbers, dates, or names.
- If a section cannot be supported by the context, use a single bullet: "No relevant data in the current dataset."
- If a section has no supporting content, return EXACTLY the string "No relevant data in the current dataset." as its single bullet. Do not return an empty array. Do not return a header with no bullets.
- Preserve exactly: organization names, regulation names, dates, numbers, monetary figures.
- Do not mention "the provided articles", "the context", or "the retrieved data".
- Do not include citation markers like [1], [2].
- Plain prose bullets. No tables. No markdown headers inside bullets.
- The bottom_line must be 2-3 sentences synthesising the key takeaway.

Output format — return EXACTLY this JSON object and NOTHING ELSE:

{
  "title": "<short descriptive title>",
  "sections": [
    { "heading": "<exact heading from the required structure>", "points": ["...", "...", "..."] },
    ...
  ],
  "bottom_line": "<2-3 sentence conclusion>"
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
// Context builder
// ─────────────────────────────────────────────────────────────────────────
const MAX_CLIENT_CHUNKS = 8;
const MAX_CUSTOM_CHUNKS = 8;
const ITEM_MAX_CHARS = 1200;

function buildContext(clientHits, customHits) {
  const parts = [];

  const secHits    = clientHits.filter((h) => h._sec).slice(0, 4);
  const clientOnly = clientHits.filter((h) => !h._sec);
  const matched    = clientOnly.filter((h) => h._matched);
  const unmatched  = clientOnly.filter((h) => !h._matched);
  const clientPool = [...secHits, ...matched, ...unmatched].slice(0, MAX_CLIENT_CHUNKS);

  for (const h of clientPool) {
    const title = h.title || 'Untitled';
    let text = h.chunk_text || '';
    if (text.length > ITEM_MAX_CHARS) text = text.slice(0, ITEM_MAX_CHARS) + '…';
    const label = h._sec ? '[SEC FILING]' : '[CLIENT SIGNAL]';
    parts.push(`${label} ${title}\n${text}`);
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
    if (escaped) { out += ch; escaped = false; continue; }
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
      console.log(`[decisionHandler] JSON repaired${label ? ' (' + label + ')' : ''}`);
      return parsed;
    } catch (err2) {
      console.log(`[decisionHandler] JSON parse failed${label ? ' (' + label + ')' : ''}: ${err.message}`);
      return null;
    }
  }
}

function parseJsonWithTruncation(raw, label) {
  const stripped = stripFences(raw);
  let jsonBlock = findBalancedJson(stripped);
  if (!jsonBlock && stripped.startsWith('{')) {
    console.log(`[decisionHandler] JSON appears truncated — attempting close-brace repair (${label})`);
    jsonBlock = stripped + '}';
  }
  return tryParseJson(jsonBlock, label);
}

// ─────────────────────────────────────────────────────────────────────────
// Fallback headings when schema designer fails
// ─────────────────────────────────────────────────────────────────────────
const FALLBACK_HEADINGS = [
  'Market Context',
  'Key Developments',
  'Strategic Implications',
  'Risks and Considerations',
];

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
// Main handler
// ─────────────────────────────────────────────────────────────────────────
async function buildDecisionAnswer(question, clientHits = [], customSourceHits = []) {
  if (!clientHits.length && !customSourceHits.length) {
    return {
      report: null,
      sources: [],
      _empty: true,
      _reason: "Our current intelligence doesn't cover this yet. Here are some questions you might find useful:",
    };
  }

  // ── Call 1: design the section structure ────────────────────────────
  let headings = FALLBACK_HEADINGS;

  try {
    const schemaRaw = await callLLM(
      [
        { role: 'system', content: SCHEMA_DESIGNER_PROMPT },
        { role: 'user', content: question },
      ],
      { temperature: 0.3, max_tokens: 500, timeout: 45000 }
    );

    const parsed = parseJsonWithTruncation(schemaRaw, 'schema');
    if (parsed && Array.isArray(parsed.sections)) {
      const valid = parsed.sections
        .filter((s) => s && typeof s.heading === 'string' && s.heading.trim())
        .map((s) => String(s.heading).trim())
        .slice(0, 5);

      if (valid.length >= 4) {
        headings = valid;
        console.log(`[decisionHandler] schema: ${valid.join(' | ')}`);
      } else {
        console.log(`[decisionHandler] schema produced only ${valid.length} valid headings — using fallback`);
      }
    }
  } catch (err) {
    console.log(`[decisionHandler] schema designer failed: ${err.message}`);
  }

  // ── Call 2: write the sections ──────────────────────────────────────
  const context = buildContext(clientHits, customSourceHits);

  const headingsBlock = headings
    .map((h, i) => `${i + 1}. ${h}`)
    .join('\n');

  const userPrompt =
    `Context:\n${context}\n\nQuestion: ${question}\n\n` +
    `Required section headings (exact, in this order):\n${headingsBlock}\n\n` +
    `Fill each section with 3-5 bullets drawn from the context. Return JSON only.`;

  let report = null;
  try {
    const writerRaw = await callLLM(
      [
        { role: 'system', content: WRITER_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0.2, max_tokens: 2500, timeout: 120000 }
    );

    if (process.env.DI_V2_DEBUG_LLM === '1') {
      console.log('[decisionHandler] RAW WRITER OUTPUT:');
      console.log(writerRaw);
      console.log('[decisionHandler] END RAW');
    }

    report = parseJsonWithTruncation(writerRaw, 'writer');
  } catch (err) {
    console.log(`[decisionHandler] writer LLM call failed: ${err.message}`);
  }

  // Retry once if writer failed
  if (!report || !Array.isArray(report.sections)) {
    console.log(`[decisionHandler] writer retry with stricter instruction`);
    try {
      const retryRaw = await callLLM(
        [
          { role: 'system', content: WRITER_PROMPT },
          { role: 'user', content: userPrompt + '\n\nIMPORTANT: Return ONLY valid JSON. No prose, no fences.' },
        ],
        { temperature: 0, max_tokens: 2500, timeout: 120000 }
      );
      report = parseJsonWithTruncation(retryRaw, 'writer-retry');
    } catch (err) {
      console.log(`[decisionHandler] writer retry failed: ${err.message}`);
    }
  }

  // Sanitize sections
  const sanitizedReport = sanitizeReport(report, headings, question);

  // ── All-empty report check ──────────────────────────────────────────
  // If every section ended up as just the fallback bullet, treat the
  // response as no_data instead of showing an empty report shell to the
  // user. The responseBuilder turns _empty:true into a clean "no data"
  // message with suggestions.
  if (isAllEmptyReport(sanitizedReport)) {
    console.log(`[decisionHandler] all sections empty — returning no_data`);
    return {
      report: null,
      sources: [],
      _empty: true,
      _reason: "Our current intelligence doesn't cover this yet. Here are some questions you might find useful:",
    };
  }

  return {
    report: sanitizedReport,
    sources: collectSources(clientHits, customSourceHits),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Sanitize the writer output — enforce heading list, shape, and types
// ─────────────────────────────────────────────────────────────────────────
function sanitizeReport(report, headings, question) {
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
// Source collection — same rules as inferenceHandler
// ─────────────────────────────────────────────────────────────────────────
function collectSources(clientHits, customSourceHits) {
  const out = [];

  const matched   = clientHits.filter((h) => h._matched);
  const unmatched = clientHits.filter((h) => !h._matched);
  const ordered   = matched.length > 0 ? matched : unmatched.slice(0, 3);

  const seenArticles = new Set();
  for (const h of ordered) {
    if (h._sec) {
      const sec = h._sec_payload || {};
      const key = `sec:${sec.ticker}:${sec.fiscal_year}:${sec.item_code}`;
      if (seenArticles.has(key)) continue;
      seenArticles.add(key);
      out.push({
        type: 'sec',
        ticker: sec.ticker || null,
        fiscal_year: sec.fiscal_year || null,
        item_code: sec.item_code || null,
        title: h.title,
        url: null,
        matched: true,
      });
      continue;
    }
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
  buildDecisionAnswer,
  buildContext,
  collectSources,
  sanitizeReport,
  isAllEmptyReport,
  SCHEMA_DESIGNER_PROMPT,
  WRITER_PROMPT,
  FALLBACK_HEADINGS,
};