/**
 * modules/decisionIntelligence/schemaDesigner.js
 *
 * Call 1 of the two-call dynamic-format pipeline.
 *
 * Takes a user question, returns a JSON schema of 4-6 headings with
 * sub-points. The headings are then fed into Call 2 (the writer) so the
 * answer's shape is tailored to the specific question rather than forced
 * into a fixed template.
 *
 * Never answers the question itself. Never returns facts or numbers.
 * Falls back to null on any failure so the caller can use the legacy
 * fixed-shape format.
 */

const { createClient } = require('@supabase/supabase-js');
const { callLLM } = require('../llmClient');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const PROMPT_ID = 'di_schema_designer_v1';
const MAX_SECTIONS = 6;
const MIN_SECTIONS = 3;

let _cachedPrompt = null;

async function loadPrompt() {
  if (_cachedPrompt) return _cachedPrompt;
  const { data, error } = await supabase
    .from('prompts')
    .select('prompt_template')
    .eq('id', PROMPT_ID)
    .eq('is_active', true)
    .single();
  if (error || !data) {
    throw new Error(`Could not load schema designer prompt: ${error?.message}`);
  }
  _cachedPrompt = data.prompt_template;
  return _cachedPrompt;
}

function stripFences(raw) {
  return (raw || '').trim()
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

async function designSchema(question) {
  if (!question || question.trim().length < 4) return null;

  let template;
  try {
    template = await loadPrompt();
  } catch (err) {
    console.log(`[schemaDesigner] prompt load failed: ${err.message}`);
    return null;
  }

  const userPrompt = template.replace(/\{question\}/g, question);

  let raw;
  try {
    raw = await callLLM(
      [{ role: 'user', content: userPrompt }],
      { temperature: 0.4, max_tokens: 600, timeout: 45000 }
    );
  } catch (err) {
    console.log(`[schemaDesigner] LLM call failed: ${err.message}`);
    return null;
  }

  const cleaned = stripFences(raw);
  const json = findBalancedJson(cleaned);
  if (!json) {
    console.log(`[schemaDesigner] no JSON found in output: ${cleaned.slice(0, 200)}`);
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    console.log(`[schemaDesigner] JSON parse failed: ${err.message}`);
    return null;
  }

  const sections = Array.isArray(parsed.sections) ? parsed.sections : [];
  const valid = sections
    .filter(s => s && typeof s.heading === 'string' && s.heading.trim())
    .map(s => ({
      heading: String(s.heading).trim().slice(0, 60),
      points: Array.isArray(s.points)
        ? s.points
            .filter(p => typeof p === 'string' && p.trim())
            .map(p => String(p).trim().slice(0, 120))
            .slice(0, 4)
        : [],
    }))
    .slice(0, MAX_SECTIONS);

  if (valid.length < MIN_SECTIONS) {
    console.log(`[schemaDesigner] too few valid sections (${valid.length}) — falling back`);
    return null;
  }

  console.log(`[schemaDesigner] designed ${valid.length} sections: ${valid.map(s => s.heading).join(' | ')}`);
  return { sections: valid };
}

module.exports = { designSchema };