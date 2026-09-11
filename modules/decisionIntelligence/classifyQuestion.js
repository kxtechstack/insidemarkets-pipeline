/**
 * modules/decisionIntelligence/classifyQuestion.js
 *
 * THE single top-level classifier for the Decision Intelligence chat.
 * classifyListOrInference.js (the earlier rule-based classifier) has
 * been retired as a separate router -- its regex patterns are reused
 * here only as a FALLBACK when the LLM call itself fails, instead of
 * this file's old behavior of blindly defaulting every failure to
 * "decision". A rule-based guess is more useful than always guessing
 * the same thing.
 *
 * One LLM call decides which of the 3 top-level buckets the question
 * belongs to:
 *   - "list"       -> client's own data, answer is a list of items
 *   - "inference"  -> client's own data, direct numeric/data analysis
 *   - "decision"   -> Decision Intelligence (SEC filings + client data
 *                     together, includes SWOT/PESTLE/Five Forces/Risk
 *                     Analysis "business model" questions)
 *
 * Uses the project's existing modules/llmClient.js, and a Supabase-stored
 * prompt (id: question_classifier_v1) so the classification rules can be
 * tuned without a code deploy.
 */

const { createClient } = require('@supabase/supabase-js');
const { callLLM } = require('../llmClient');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const CLASSIFIER_PROMPT_ID = 'question_classifier_v1';

let _cachedPrompt = null;

async function getClassifierPrompt() {
  if (_cachedPrompt) return _cachedPrompt;
  const { data, error } = await supabase
    .from('prompts')
    .select('prompt_template')
    .eq('id', CLASSIFIER_PROMPT_ID)
    .eq('is_active', true)
    .single();

  if (error || !data) {
    throw new Error(`Could not load classifier prompt '${CLASSIFIER_PROMPT_ID}': ${error?.message}`);
  }
  _cachedPrompt = data.prompt_template;
  return _cachedPrompt;
}

// ---------------------------------------------------------------------------
// Fallback-only rule-based guess (reused from the retired
// classifyListOrInference.js) -- only used if the LLM call itself fails,
// so the system degrades to "reasonable regex guess" instead of always
// silently defaulting to "decision".
// ---------------------------------------------------------------------------
const LIST_PATTERNS = [
  /^what are the/i, /^which /i, /^list /i, /give me (a |the )?list/i,
  /show me (all|the) /i, /^what (new|recent) /i, /recorded (in|during|for)/i,
  /newly added/i, /required (documentation )?steps/i,
];
const INFERENCE_PATTERNS = [
  /how (has|have|did) /i, /compare/i, /\bvs\.?\b|\bversus\b/i, /trend/i,
  /change(d)? (over|in|during)/i, /impact of/i, /why (has|did|is)/i,
  /analy[sz]e/i, /\bimprove(d)?\b|\bworsen(ed)?\b|\bdeclin(e|ed)\b|\bincrease(d)?\b|\bdecrease(d)?\b/i,
];
// Decision-specific signals: SEC/framework/broad-strategy language that
// should win over a List/Inference-looking pattern if both appear (e.g.
// "compare Apple and Microsoft's SWOT" has both "compare" AND "SWOT" --
// SWOT should win, since that's never answerable from client data alone).
const DECISION_PATTERNS = [
  /swot/i, /pestle|pestel/i, /five forces|5 forces|porter/i,
  /risk analysis|categorize the risk|risk categor/i,
  /\b(revenue|net income|profit|earnings|eps|total assets|total liabilities|cash flow)\b.*\b(19|20)\d{2}\b/i,
  /10-?k|sec filing/i, /should (we|i) (expand|prioriti[sz]e|invest|enter)/i,
  /which (country|market) should/i,
];

function ruleBasedFallback(question) {
  if (DECISION_PATTERNS.some(p => p.test(question))) return 'decision';
  const listScore = LIST_PATTERNS.filter(p => p.test(question)).length;
  const inferenceScore = INFERENCE_PATTERNS.filter(p => p.test(question)).length;
  if (inferenceScore > listScore) return 'inference';
  if (listScore > 0) return 'list';
  return 'decision'; // genuinely ambiguous with no LLM available -- decision is the broadest/safest bucket
}

/**
 * @param {string} question - the raw text the user typed
 * @returns {Promise<{type: 'list'|'inference'|'decision', reasoning: string}>}
 */
async function classifyQuestion(question) {
  let systemPrompt;
  try {
    systemPrompt = await getClassifierPrompt();
  } catch (err) {
    const type = ruleBasedFallback(question);
    return { type, reasoning: `Could not load classifier prompt (${err.message}); used rule-based fallback -> ${type}.` };
  }

  let raw;
  try {
    raw = await callLLM(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question },
      ],
      { temperature: 0, max_tokens: 200, timeout: 30000 }
    );
  } catch (err) {
    const type = ruleBasedFallback(question);
    return { type, reasoning: `Classifier LLM call failed (${err.message}); used rule-based fallback -> ${type}.` };
  }

  const cleaned = raw.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const type = ruleBasedFallback(question);
    return { type, reasoning: `Could not parse classifier output (${raw}); used rule-based fallback -> ${type}.` };
  }

  const validTypes = new Set(['list', 'inference', 'decision']);
  if (!validTypes.has(parsed.type)) {
    const type = ruleBasedFallback(question);
    return { type, reasoning: `Unexpected type "${parsed.type}"; used rule-based fallback -> ${type}.` };
  }

  return { type: parsed.type, reasoning: parsed.reasoning || '' };
}

module.exports = { classifyQuestion, CLASSIFIER_PROMPT_ID };