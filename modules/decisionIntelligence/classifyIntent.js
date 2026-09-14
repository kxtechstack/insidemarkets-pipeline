const { callLLM } = require('../llmClient');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const PROMPT_ID = 'decision_intelligence_intent_v1';

async function loadPrompt() {
  const { data, error } = await supabase
    .from('prompts')
    .select('prompt_template')
    .eq('id', PROMPT_ID)
    .eq('is_active', true)
    .single();
  if (error || !data) throw new Error(`Could not load intent prompt: ${error?.message}`);
  return data.prompt_template;
}

/**
 * Classifies the raw question into greeting / off_topic / clarification /
 * market_intelligence. Returns { intent, message, reasoning }.
 * On any failure, falls back to market_intelligence so we never block a
 * real question.
 */
async function classifyIntent(question) {
  try {
    const systemPrompt = await loadPrompt();
    const raw = await callLLM(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question },
      ],
      { temperature: 0, max_tokens: 300, timeout: 30000 }
    );

    // Strip markdown fences if the LLM added them
    let s = (raw || '').trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/, '')
      .replace(/```\s*$/, '')
      .trim();

    const parsed = JSON.parse(s);
    const valid = ['greeting', 'off_topic', 'clarification', 'market_intelligence'];
    if (!valid.includes(parsed.intent)) {
      return { intent: 'market_intelligence', message: null, reasoning: 'invalid intent, defaulted' };
    }
    return {
      intent: parsed.intent,
      message: parsed.message || null,
      reasoning: parsed.reasoning || '',
    };
  } catch (err) {
    console.log(`[classifyIntent] fell back to market_intelligence: ${err.message}`);
    return { intent: 'market_intelligence', message: null, reasoning: 'classifier error' };
  }
}

module.exports = { classifyIntent };