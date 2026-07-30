const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const LM_STUDIO_URL = process.env.LM_STUDIO_URL || 'http://localhost:1234/v1/chat/completions';
const LM_STUDIO_MODEL = process.env.LM_STUDIO_MODEL || 'llama-3.2-3b-instruct';

// Repairs common LLM JSON formatting issues before parsing (small models
// occasionally return slightly malformed JSON — stray commas, unescaped
// quotes, truncated output). Local copy, not shared with trendClustering.js.
const repairAndParseJson = (rawContent) => {
  let cleaned = rawContent.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  const firstBrace = cleaned.indexOf('{');
  if (firstBrace !== -1) {
    let depth = 0;
    let endIndex = -1;
    for (let i = firstBrace; i < cleaned.length; i++) {
      if (cleaned[i] === '{') depth++;
      else if (cleaned[i] === '}') {
        depth--;
        if (depth === 0) { endIndex = i; break; }
      }
    }
    if (endIndex !== -1) cleaned = cleaned.slice(firstBrace, endIndex + 1);
  }

  cleaned = cleaned
    .replace(/\\u(?![0-9a-fA-F]{4})/g, '')
    .replace(/[\u0000-\u001F]+/g, ' ')
    .replace(/\]"\s*\}/g, ']}')
    .replace(/"\s*\}\s*\}/g, '"}');

  try {
    return JSON.parse(cleaned);
  } catch (parseErr) {
    try {
      return JSON.parse(cleaned.replace(/\\"/g, '"'));
    } catch (unescapeErr) {
      try {
        const repaired = cleaned.replace(
          /"(title|summary|country)"\s*:\s*"((?:[^"\\]|\\.)*)"/g,
          (match, key, value) => `"${key}": "${value}"`
        );
        return JSON.parse(repaired);
      } catch (repairErr) {
        let repaired2 = cleaned;
        const quoteCount = (repaired2.match(/(?<!\\)"/g) || []).length;
        if (quoteCount % 2 !== 0) repaired2 += '"';
        const openBrackets = (repaired2.match(/\[/g) || []).length;
        const closeBrackets = (repaired2.match(/\]/g) || []).length;
        for (let i = 0; i < openBrackets - closeBrackets; i++) repaired2 += ']';
        const openBraces = (repaired2.match(/\{/g) || []).length;
        const closeBraces = (repaired2.match(/\}/g) || []).length;
        for (let i = 0; i < openBraces - closeBraces; i++) repaired2 += '}';
        return JSON.parse(repaired2);
      }
    }
  }
};

// Deterministic — never asked from the LLM. Strategic Relevance is
// confidence based on how many corroborating signals back this card.
const calculateRelevanceLevel = (signalCount) => {
  if (signalCount >= 7) return 'Critical';
  if (signalCount >= 4) return 'High';
  if (signalCount >= 2) return 'Medium';
  return 'Low';
};

// Step 1 — does a card already exist at this exact address?
const findExistingInsight = async (clientId, signalId) => {
  const { data } = await supabase
    .from('market_insights')
    .select('*')
    .eq('client_id', clientId)
    .eq('signal_id', signalId)
    .maybeSingle();
  return data || null;
};

// Step 2 — ask the LLM to write (or rewrite) the card.
// existingCard is null on first creation.
const generateInsightWriteup = async (existingCard, newArticleText, industry) => {
  const { data: promptRow, error } = await supabase
    .from('prompts')
    .select('prompt_template')
    .eq('id', 'market_dynamics_writeup_v1')
    .eq('is_active', true)
    .single();

  if (error || !promptRow) {
    throw new Error(`Could not load market_dynamics_writeup_v1 prompt: ${error?.message}`);
  }

  const existingText = existingCard
    ? `EXISTING CARD:\nTitle: ${existingCard.title}\nSummary: ${existingCard.summary}`
    : 'EXISTING CARD: none — this is the first signal for this topic.';

  const finalPrompt = promptRow.prompt_template
    .replace('{industry}', industry)
    .replace('{existing_card}', existingText)
    .replace('{new_article}', newArticleText);

  const response = await axios.post(LM_STUDIO_URL, {
    model: LM_STUDIO_MODEL,
    messages: [
      { role: 'system', content: 'You only respond with valid JSON, nothing else.' },
      { role: 'user', content: finalPrompt },
    ],
    temperature: 0.4,
    max_tokens: 600,
  }, {
    timeout: 90000,
    headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
  });

  const raw = response.data.choices[0].message.content.trim();
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  const parsed = repairAndParseJson(raw);

  return {
    title: parsed.title,
    summary: parsed.summary,
    business_impact: Array.isArray(parsed.business_impact) ? parsed.business_impact : [],
    country: parsed.country || existingCard?.country || 'Unknown',
  };
};

// Step 3 — the main entry point. Called once per relevant Market Dynamics article.
const enrichOrCreateInsight = async (clientId, moduleId, submoduleId, signalId, articleId, articleText, industry, submoduleName = null) => {
  const existing = await findExistingInsight(clientId, signalId);

  const writeup = await generateInsightWriteup(existing, articleText, industry);

  if (existing) {
    await supabase
      .from('market_insights')
      .update({
        title: writeup.title,
        summary: writeup.summary,
        business_impact: writeup.business_impact,
        country: writeup.country,
        category: submoduleName || existing.category,
        signal_count: existing.signal_count + 1,
        relevance_level: calculateRelevanceLevel(existing.signal_count + 1),
        last_enriched_at: new Date().toISOString(),
      })
      .eq('id', existing.id);

    await supabase.from('market_insight_members').insert({ insight_id: existing.id, article_id: articleId });
    console.log(`  [MarketDynamics] Enriched existing card "${writeup.title}" (now ${existing.signal_count + 1} signals)`);
    return { status: 'enriched', insightId: existing.id };
  }

  const { data: newInsight, error } = await supabase
    .from('market_insights')
    .insert({
      client_id: clientId,
      module_id: moduleId,
      submodule_id: submoduleId,
      signal_id: signalId,
      title: writeup.title,
      summary: writeup.summary,
      business_impact: writeup.business_impact,
      country: writeup.country,
      category: submoduleName || null,
      signal_count: 1,
      relevance_level: calculateRelevanceLevel(1),
      last_enriched_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    console.error('  [MarketDynamics] Failed to create insight:', error.message);
    return { status: 'error', error: error.message };
  }

  await supabase.from('market_insight_members').insert({ insight_id: newInsight.id, article_id: articleId });
  console.log(`  [MarketDynamics] Created new card "${writeup.title}"`);
  return { status: 'created', insightId: newInsight.id };
};

module.exports = { findExistingInsight, generateInsightWriteup, enrichOrCreateInsight };