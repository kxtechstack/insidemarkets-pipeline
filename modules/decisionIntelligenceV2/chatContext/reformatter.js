/**
 * chatContext/reformatter.js
 *
 * Handles "reformat" follow-ups — requests like "give me this in bullet
 * points" or "summarize that" that apply a TRANSFORMATION to the previous
 * assistant answer, rather than fetching new information.
 *
 * Does NOT touch retrieval, routing, SEC, or the pipeline.
 */

const { createClient } = require('@supabase/supabase-js');
const { callLLM } = require('../../llmClient');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const REFORMAT_PROMPT = `You are a formatting assistant for a market intelligence chat.

The user has asked for their PREVIOUS answer to be reformatted. You will be
given the previous answer's full content and the user's reformat instruction.

Apply the instruction to the previous answer. Do NOT add information that
wasn't in the previous answer. Do NOT remove substance unless the
instruction explicitly says to.

Preserve exactly:
- Company names, dates, numbers, percentages, monetary figures
- The names of regulations, products, and organizations
- All factual claims

Output format — return EXACTLY this JSON object and NOTHING ELSE:

{
  "title": "<short title>",
  "sections": [
    { "heading": "<heading>", "points": ["<bullet>", "<bullet>"] }
  ],
  "bottom_line": "<1-2 sentence takeaway or empty string>"
}

Rules:
- If the user asked for bullet points, produce sections with the requested
  number of points.
- If the user asked to summarize / TL;DR / make shorter, produce ONE section
  with key points and a short bottom_line.
- If the user asked to expand, produce multiple sections with more detail.
- Do not include markdown fences, prose before/after, or commentary.
- The "points" arrays are arrays of strings. Line breaks inside strings must
  be written as \\n. Never press Enter inside a string.`;

async function loadPreviousAssistantMessage(conversationId) {
  if (!conversationId) return null;

  const { data, error } = await supabase
    .from('di_messages')
    .select('content, type, payload, created_at')
    .eq('conversation_id', conversationId)
    .eq('role', 'assistant')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.log(`[reformatter] loadPrevious error: ${error.message}`);
    return null;
  }
  return data || null;
}

function flattenPreviousAnswer(previous) {
  const payload = previous?.payload;
  if (!payload) return null;

  if (payload.type === 'list' && Array.isArray(payload.items)) {
    const lines = payload.items.map((it, i) =>
      `[${i + 1}] ${it.module || ''} — ${it.title || ''}${
        it.summary ? `\n    ${it.summary}` : ''
      }`
    );
    return {
      shape: 'list',
      text: `LIST ANSWER (${payload.items.length} items):\n${lines.join('\n')}`,
      type: 'list',
    };
  }

  if (payload.type === 'decision' || payload.type === 'inference') {
    const r = payload.report || {};
    let text = '';
    if (r.title) text += `TITLE: ${r.title}\n\n`;
    if (Array.isArray(r.sections)) {
      for (const s of r.sections) {
        text += `${s.heading}\n`;
        for (const p of (s.points || [])) text += `- ${p}\n`;
        text += '\n';
      }
    }
    if (r.bodyText) text += `${r.bodyText}\n\n`;
    if (r.bottom_line) text += `BOTTOM LINE: ${r.bottom_line}\n`;
    return { shape: 'sections', text: text.trim(), type: payload.type };
  }

  return {
    shape: 'unknown',
    text: JSON.stringify(payload).slice(0, 4000),
    type: payload.type || 'unknown',
  };
}

function parseReformatterJson(raw) {
  const cleaned = String(raw || '').trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/```\s*$/, '')
    .trim();

  const first = cleaned.indexOf('{');
  if (first === -1) return null;
  let depth = 0, end = -1;
  for (let i = first; i < cleaned.length; i++) {
    if (cleaned[i] === '{') depth++;
    else if (cleaned[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;

  try {
    const parsed = JSON.parse(cleaned.slice(first, end + 1));
    if (!Array.isArray(parsed.sections)) return null;
    return {
      title: typeof parsed.title === 'string' ? parsed.title.slice(0, 200) : '',
      sections: parsed.sections
        .filter(s => s && typeof s.heading === 'string')
        .map(s => ({
          heading: s.heading,
          points: Array.isArray(s.points)
            ? s.points.filter(p => typeof p === 'string' && p.trim())
            : [],
        }))
        .filter(s => s.points.length > 0),
      bottom_line: typeof parsed.bottom_line === 'string' ? parsed.bottom_line : '',
    };
  } catch (err) {
    return null;
  }
}

async function reformatPreviousAnswer({ conversationId, instruction }) {
  const previous = await loadPreviousAssistantMessage(conversationId);
  if (!previous) {
    console.log(`[reformatter] no previous assistant message for conversation ${conversationId}`);
    return { payload: null, previousFound: false, error: 'no previous assistant message' };
  }

  console.log(`[reformatter] found previous message: type=${previous.type} content="${String(previous.content).slice(0, 80)}"`);

  const flattened = flattenPreviousAnswer(previous);
  if (!flattened || !flattened.text) {
    console.log(`[reformatter] could not flatten previous message payload`);
    return { payload: null, previousFound: true, error: 'could not flatten previous answer' };
  }

  console.log(`[reformatter] flattened ${flattened.shape} answer (${flattened.text.length} chars)`);

  const userPrompt =
    `PREVIOUS ANSWER:\n${flattened.text}\n\n` +
    `USER'S REFORMAT INSTRUCTION:\n${instruction}`;

  let raw;
  try {
    raw = await callLLM(
      [
        { role: 'system', content: REFORMAT_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0.2, max_tokens: 1800, timeout: 90000 }
    );
  } catch (err) {
    console.log(`[reformatter] LLM call failed: ${err.message}`);
    return { payload: null, previousFound: true, error: err.message };
  }

  const report = parseReformatterJson(raw);
  if (!report || report.sections.length === 0) {
    console.log(`[reformatter] could not parse LLM output, raw: ${String(raw).slice(0, 300)}`);
    return { payload: null, previousFound: true, error: 'parse failed' };
  }

  const payload = {
    type: 'decision',
    report,
    sources: previous.payload?.sources || [],
    chart: null,
    chartMeta: null,
    _reformat: true,
  };

  return {
    payload,
    previousFound: true,
    previousShape: flattened.shape,
    previousType: flattened.type,
  };
}

module.exports = {
  reformatPreviousAnswer,
  loadPreviousAssistantMessage,
  flattenPreviousAnswer,
  REFORMAT_PROMPT,
};