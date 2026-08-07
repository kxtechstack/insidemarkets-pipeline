const { createClient } = require('@supabase/supabase-js');
const { callLLM } = require('./llmClient');

const { pipeline } = require('@xenova/transformers');

let embedderPromise = null;
const getEmbedder = () => {
  if (!embedderPromise) embedderPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  return embedderPromise;
};
const embedText = async (text) => {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
};

const cosineSimilarity = (a, b) => {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

const CARD_SIMILARITY_THRESHOLD = 0.45;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const getDimensionName = async (submoduleId) => {
  const { data } = await supabase
    .schema('admin')
    .from('submodules')
    .select('submodule_name')
    .eq('id', submoduleId)
    .single();
  return data?.submodule_name || null;
};

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

// Step 1 — find the most similar EXISTING card for this signal, if any
// crosses the similarity threshold. Uses content similarity, not just
// "does any card exist for this signal" — so unrelated companies/topics
// under the same signal get their own separate cards.
const findExistingInsight = async (clientId, signalId, articleText) => {
  const { data: candidates } = await supabase
    .from('market_insights')
    .select('*')
    .eq('client_id', clientId)
    .eq('signal_id', signalId);

  if (!candidates || candidates.length === 0) return null;

  const newEmbedding = await embedText((articleText || '').slice(0, 1000));

  let bestMatch = null;
  let bestScore = 0;

  for (const card of candidates) {
    const cardText = `${card.title} ${card.summary}`.slice(0, 1000);
    const cardEmbedding = await embedText(cardText);
    const score = cosineSimilarity(newEmbedding, cardEmbedding);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = card;
    }
  }

  console.log(`  [CardMatch] Best match score: ${bestScore.toFixed(3)} (threshold: ${CARD_SIMILARITY_THRESHOLD})`);

  return bestScore >= CARD_SIMILARITY_THRESHOLD ? bestMatch : null;
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
  .replace(/{industry}/g, industry)
  .replace(/{existing_card}/g, existingText)
  .replace(/{new_article}/g, newArticleText);

  const raw = await callLLM([
    { role: 'system', content: 'You only respond with valid JSON, nothing else.' },
    { role: 'user', content: finalPrompt },
  ], { temperature: 0.4, max_tokens: 600, timeout: 90000 });

  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  const parsed = repairAndParseJson(raw);

  return {
    title: parsed.title,
    summary: parsed.summary,
    short_summary: parsed.short_summary,
    business_impact: Array.isArray(parsed.business_impact) ? parsed.business_impact : [],
    country: parsed.country || existingCard?.country || 'Global',
  };
};

// Step 3 — the main entry point. Called once per relevant Market Dynamics article.
const enrichOrCreateInsight = async (clientId, moduleId, submoduleId, signalId, articleId, articleText, industry) => {
  const existing = await findExistingInsight(clientId, signalId, articleText);

  const writeup = await generateInsightWriteup(existing, articleText, industry);
  const category = await getDimensionName(submoduleId);

  if (existing) {
    await supabase
      .from('market_insights')
      .update({
        title: writeup.title,
        summary: writeup.summary,
        short_summary: writeup.short_summary,
        business_impact: writeup.business_impact,
        country: writeup.country,
        category,
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
      short_summary: writeup.short_summary,
      business_impact: writeup.business_impact,
      country: writeup.country,
      category,
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