/**
 * modules/decisionIntelligenceV2/handlers/decisionHandler.js
 *
 * STAGE 3c — decision handler.
 *
 * Input:  retrieval hits (client signals) + custom source chunks
 * Output: { report: { title, sections: [{heading, points}], bottom_line }, sources }
 *
 * TWO LLM calls:
 *   1. Schema designer — designs 4-5 tailored headings for this question
 *   2. Writer          — fills those headings with bullets from context
 */

const { callLLM } = require('../../llmClient');
const { checkTopicalCoverage, checkFrameworkSubjectCoverage } = require('./topicalCoverage');

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

const WRITER_PROMPT = `You are a senior market intelligence analyst producing a rich report for a client.

You have been given retrieved signals and uploaded documents from the client's own data, plus a required section structure. Fill each section with substantive bullets drawn from the context.

Content rules:
- Each section gets 3-5 bullets.
- Bullets must be complete thoughts, not single words.
- HARD RULE: If a fact about a specific company is not explicitly present in the context, do NOT write it. Even if the fact is true in the real world (e.g., "Amazon is an e-commerce leader"), if it is not literally stated in the context chunks, it is forbidden. Fabricating general knowledge about companies is a critical error.
- CORRECTION RULE: If the user's question contains a factually incorrect premise (e.g. "Estée Lauder acquired Rhode" when the context shows e.l.f. Beauty acquired Rhode), do NOT just say "No relevant data". Instead, explicitly correct the premise in your answer. Write: "The context does not support the premise that [X] acquired [Y]. The available signals indicate that [what actually happened]." Then provide the details about what DID happen.
- MULTI-ENTITY RULE: If the user's question names TWO OR MORE specific entities (companies, brands, products) to compare, you MUST address EVERY named entity in the report. Every section must include at least one bullet about EACH named entity. If a section has no context for one entity, use the bullet "No relevant data in the current dataset for [entity name]." Do NOT write a report about only one of them.
- CRITICAL: If ANY chunk in the context contains the phrase "VERIFIED FINANCIAL FACTS", you MUST include those exact numbers verbatim in a "Financial Performance" or "Market Share" section. Do NOT paraphrase. Do NOT substitute "the company reported strong revenue" — copy the actual "$X.XXB" figures. This is the most important part of the report for numeric comparisons.
- If a section cannot be supported by the context, use a single bullet: "No relevant data in the current dataset."
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

  // Take up to 2 SEC chunks per ticker so no single company dominates.
  const allSecHits = clientHits.filter((h) => h._sec);
  const byTicker = new Map();
  for (const h of allSecHits) {
    const ticker = h._sec_payload?.ticker || h._sec_payload?.tickers?.[0] || '__unk__';
    if (!byTicker.has(ticker)) byTicker.set(ticker, []);
    if (byTicker.get(ticker).length < 2) byTicker.get(ticker).push(h);
  }
  const secHits = [...byTicker.values()].flat().slice(0, MAX_CLIENT_CHUNKS);

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

const FALLBACK_HEADINGS = [
  'Market Context',
  'Key Developments',
  'Strategic Implications',
  'Risks and Considerations',
];

async function buildDecisionAnswer(question, clientHits = [], customSourceHits = [], routerResult = null) {
  if (!clientHits.length && !customSourceHits.length) {
    return {
      report: null,
      sources: [],
      _empty: true,
      _reason: 'no client signals or uploaded documents matched the question',
    };
  }

  const FRAMEWORK_RE = /\b(swot|pestle|pestel|five\s*forces|5\s*forces|porter|risk\s*analysis|risk\s*categor)/i;
  const isFrameworkQuestion = FRAMEWORK_RE.test(question);

  const coverage = isFrameworkQuestion
    ? await checkFrameworkSubjectCoverage(question, clientHits, customSourceHits, routerResult)
    : await checkTopicalCoverage(question, clientHits, customSourceHits);

  if (isFrameworkQuestion) {
    console.log(`[decisionHandler] framework question — subject-only coverage: covered=${coverage.covered}`);
  }

  if (!coverage.covered) {
    console.log(`[decisionHandler] Topical coverage FAILED: ${coverage.reason}`);
    return {
      report: null,
      sources: [],
      _empty: true,
      _reason: `The available data does not cover this topic. ${coverage.reason}`,
    };
  }

  // Filter hits to only the on-topic ones.
  const filteredClientHits = Array.isArray(coverage.filteredClientHits)
    ? coverage.filteredClientHits
    : clientHits;
  const filteredCustomHits = Array.isArray(coverage.filteredCustomHits)
    ? coverage.filteredCustomHits
    : customSourceHits;

  console.log(`[decisionHandler] after coverage filter: ${filteredClientHits.length} client + ${filteredCustomHits.length} custom`);

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

  const context = buildContext(filteredClientHits, filteredCustomHits);

  const headingsBlock = headings
    .map((h, i) => `${i + 1}. ${h}`)
    .join('\n');

  let userPrompt = '';
  if (coverage._partial) {
    userPrompt = 
      `⚠️ PARTIAL DATA AVAILABLE ⚠️\n` +
      `The user asked: ${question}\n` +
      `We could not find data for all entities. Specifically: ${coverage._missingEntity}\n\n` +
      `CRITICAL INSTRUCTIONS — FOLLOW EXACTLY:\n` +
      `1. In EVERY section, end the bullets with ONE additional bullet that says: "No data available for ${coverage._missingEntity || 'the other entity'}."\n` +
      `2. The bottom_line MUST BEGIN with the exact sentence: "Unfortunately, we could not find data for ${coverage._missingEntity || 'the compared entity'} to complete this comparison."\n` +
      `3. After that sentence, you may summarize the entity we DO have data for.\n` +
      `4. Do NOT omit the warning. Do NOT bury it at the end. The user must see it clearly.\n\n` +
      `Context:\n${context}\n\n` +
      `Required section headings (exact, in this order):\n${headingsBlock}\n\n` +
      `Fill each section with 3-5 bullets plus the required warning bullet. Return JSON only.`;
  } else {
    userPrompt =
      `Context:\n${context}\n\nQuestion: ${question}\n\n` +
      `Required section headings (exact, in this order):\n${headingsBlock}\n\n` +
      `Fill each section with 3-5 bullets drawn from the context. Return JSON only.`;
  }

  let report = null;
  try {
    const writerRaw = await callLLM(
      [
        { role: 'system', content: WRITER_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0.2, max_tokens: 2500, timeout: 120000 }
    );
    report = parseJsonWithTruncation(writerRaw, 'writer');
  } catch (err) {
    console.log(`[decisionHandler] writer LLM call failed: ${err.message}`);
  }

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

  // Extract the verified facts chunk if it exists (injected by Guard A/B
  // in secHandler for comparisons). We'll use this to guarantee the
  // numbers appear in the final report even if the LLM ignores them.
  const factsChunk = filteredClientHits.find(h =>
    h._sec && h.chunk_text && /VERIFIED FINANCIAL FACTS/i.test(h.chunk_text)
  );

  if (factsChunk) {
    // Keep only the bullet lines from the facts body. Skip headers.
    const lines = factsChunk.chunk_text.split('\n');
    const factLines = lines.filter(l => {
      const t = l.trim();
      return t.startsWith('-') || t.startsWith('###');
    });
    if (factLines.length > 0) {
      coverage._sec_facts = factLines.map(l => l.replace(/^-\s*/, '').trim());
      console.log(`[decisionHandler] Extracted ${coverage._sec_facts.length} verified facts for fallback injection`);
    }
  }

  const sanitizedReport = sanitizeReport(report, headings, question, coverage);

  return {
    report: sanitizedReport,
    sources: collectSources(filteredClientHits, filteredCustomHits, isFrameworkQuestion),
    _partial: coverage._partial || false,
    _missingEntity: coverage._missingEntity || null,
  };
}

function sanitizeReport(report, headings, question, partialInfo = null) {
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

  const finalSections = headings.map((h) => ({
    heading: h,
    points: byHeading.get(h.toLowerCase()) || ['No relevant data in the current dataset.'],
  }));

  // ── DETERMINISTIC FACTS INJECTION ──
  // If the LLM ignored the verified financial facts, force them into
  // the most relevant section (Financial / Market Share / Revenue).
  if (partialInfo && Array.isArray(partialInfo._sec_facts) && partialInfo._sec_facts.length > 0) {
    const targetHeading = headings.find(h => /financial|revenue|market\s+share/i.test(h))
      || headings[0];

    const targetSection = finalSections.find(s => s.heading === targetHeading);
    if (targetSection) {
      // Check if any number is already mentioned in this section
      const alreadyPresent = targetSection.points.some(p =>
        /\$[\d.,]+\s*[BMK]/i.test(p)
      );

      if (!alreadyPresent) {
        targetSection.points = [...partialInfo._sec_facts, ...targetSection.points];
        console.log(`[decisionHandler] Deterministically injected ${partialInfo._sec_facts.length} facts into "${targetHeading}"`);
      }
    }
  }
  // ──────────────────────────────────

  if (!report) {
    return {
      title: question,
      sections: finalSections,
      bottom_line: 'Could not generate a structured report from the retrieved sources.',
    };
  }

  let finalBottomLine = typeof report.bottom_line === 'string'
    ? report.bottom_line.trim()
    : '';

  // Deterministic fallback: if partial data and LLM forgot the warning,
  // prepend it ourselves so the user is guaranteed to see it.
  if (partialInfo && partialInfo._partial && partialInfo._missingEntity) {
    const missingName = String(partialInfo._missingEntity).trim();
    const warningAlreadyPresent = /could not find|not available|not in the|no data for|unable to find|comparison is partial/i.test(finalBottomLine);

    if (!warningAlreadyPresent) {
      // If missingName is short (looks like a name), say so directly.
      // Otherwise, use a generic phrasing.
      const looksLikeName = missingName.length <= 40 && !/\bnot\b|\bis\b|\bwas\b|\bdata\b/i.test(missingName);

      const warningText = looksLikeName
        ? `Unfortunately, we could not find data for ${missingName} to complete this comparison.`
        : `Unfortunately, data for one of the compared entities was not available, so this comparison is partial.`;

      finalBottomLine = `${warningText} ${finalBottomLine}`;
    }
  }

  return {
    title: (report.title || question).toString().slice(0, 200),
    sections: finalSections,
    bottom_line: finalBottomLine,
  };
}

function collectSources(clientHits, customSourceHits, isFrameworkQuestion = false) {
  const out = [];

  const matched   = clientHits.filter((h) => h._matched);
  const unmatched = clientHits.filter((h) => !h._matched);

  // Framework questions: include every client hit the coverage filter kept
  // (the writer saw them all, so the sources panel should reflect that).
  // Normal questions: keep the existing matched-first / top-3-unmatched logic.
  const ordered = isFrameworkQuestion
    ? [...matched, ...unmatched]
    : (matched.length > 0 ? matched : unmatched.slice(0, 3));

  const seenArticles = new Set();
    for (const h of ordered) {
    if (h._sec) {
      const sec = h._sec_payload || {};

      // Synthetic financial facts chunk can cover MULTIPLE tickers.
      // Emit one source per ticker so the user sees all companies
      // whose data appears in the answer.
      const tickers = Array.isArray(sec.tickers) && sec.tickers.length > 0
        ? sec.tickers
        : (sec.ticker ? [sec.ticker] : [null]);

      for (const t of tickers) {
        const key = `sec:${t}:${sec.fiscal_year}:${sec.item_code}`;
        if (seenArticles.has(key)) continue;
        seenArticles.add(key);

        // Build a per-ticker title for the facts chunk
        let title = h.title;
        if (sec.item_code === 'financial_facts' && t) {
          title = `Verified Financial Facts for ${t}`;
        }

        out.push({
          type: 'sec',
          ticker: t,
          fiscal_year: sec.fiscal_year || null,
          item_code: sec.item_code || null,
          title,
          url: null,
          matched: true,
        });
      }
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
  SCHEMA_DESIGNER_PROMPT,
  WRITER_PROMPT,
  FALLBACK_HEADINGS,
};