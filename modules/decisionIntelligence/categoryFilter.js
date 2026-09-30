/**
 * modules/decisionIntelligence/categoryFilter.js
 *
 * Instead of a hardcoded keyword->category table (which breaks the
 * moment a client's data has a category or phrasing we didn't
 * anticipate), this embeds the ACTUAL category values present in this
 * client's data and matches the question against them semantically --
 * same embedding model used everywhere else in the pipeline. This
 * scales automatically to any category, in any module, without a
 * code change.
 */

const { createClient } = require('@supabase/supabase-js');
const { embedText } = require('./retrieveClientData');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Cache category embeddings per-client for the life of the process --
// categories change rarely, so recomputing on every question is wasted work.
const categoryCache = new Map(); // clientId -> { categories: [...], embeddings: [...], fetchedAt }
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function cosineSim(a, b) {
  // Embeddings from embedText() are already L2-normalized, so dot
  // product alone equals cosine similarity.
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

async function getClientCategories(clientId) {
  const cached = categoryCache.get(clientId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }

  const categories = new Set();

  try {
    const { data } = await supabase
      .from('policy_signals')
      .select('category')
      .eq('client_id', clientId)
      .not('category', 'is', null);
    (data || []).forEach(r => r.category && categories.add(r.category));
  } catch (err) {
    console.log(`[categoryFilter] policy_signals category fetch failed: ${err.message}`);
  }

  try {
    const { data } = await supabase
      .from('market_dynamics_signals')
      .select('category')
      .eq('client_id', clientId)
      .not('category', 'is', null);
    (data || []).forEach(r => r.category && categories.add(r.category));
  } catch (err) {
    console.log(`[categoryFilter] market_dynamics_signals category fetch failed: ${err.message}`);
  }

  const categoryList = [...categories];
  const embeddings = [];
  for (const cat of categoryList) {
    try {
      embeddings.push(await embedText(cat));
    } catch (err) {
      console.log(`[categoryFilter] embedding failed for category "${cat}": ${err.message}`);
      embeddings.push(null);
    }
  }

  const result = { categories: categoryList, embeddings, fetchedAt: Date.now() };
  categoryCache.set(clientId, result);
  return result;
}

const MATCH_THRESHOLD = Number(process.env.CATEGORY_MATCH_THRESHOLD) || 0.55;

/**
 * Returns the category value(s) that genuinely match the question's
 * intent, e.g. "licensing changes" -> ["Licensing Change"]. Returns []
 * if nothing clears the threshold -- meaning "no specific category
 * detected," so the caller shows results unfiltered.
 */
async function detectTargetCategories(question, clientId) {
  const { categories, embeddings } = await getClientCategories(clientId);
  if (categories.length === 0) return [];

  let questionVector;
  try {
    questionVector = await embedText(question);
  } catch (err) {
    console.log(`[categoryFilter] question embedding failed: ${err.message}`);
    return [];
  }

  const scored = categories
    .map((cat, i) => ({ cat, score: embeddings[i] ? cosineSim(questionVector, embeddings[i]) : -1 }))
    .filter(s => s.score >= MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  console.log(
    `[categoryFilter] question="${question.slice(0, 60)}" | top matches: ` +
    scored.slice(0, 3).map(s => `${s.cat}(${s.score.toFixed(3)})`).join(', ') || 'none'
  );

  return scored.map(s => s.cat);
}

function applyCategoryFilter(items, targetCategories) {
  if (!targetCategories || targetCategories.length === 0) return items;
  const targetSet = new Set(targetCategories.map(c => c.toLowerCase()));
  return items.filter(item => item.category && targetSet.has(item.category.toLowerCase()));
}

module.exports = { detectTargetCategories, applyCategoryFilter };