
/**
 * modules/decisionIntelligence/suggestionEngine.js
 *
 * Builds "try this instead" suggestions for the no-data fallback. Unlike
 * a hardcoded list, each suggestion is built directly from a database
 * query confirming real, recent rows exist for that category -- so a
 * suggestion is never shown unless clicking it is guaranteed to find
 * something. No semantic search involved here on purpose: semantic
 * retrieval is exactly the unreliable layer we don't want deciding what
 * gets suggested.
 */
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const RECENCY_DAYS = 90;

async function getVerifiedSuggestions(clientId, limit = 4) {
  const cutoff = new Date(Date.now() - RECENCY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const candidates = [];

  try {
    const { data } = await supabase
      .from('policy_signals')
      .select('category')
      .eq('client_id', clientId)
      .gte('source_published_date', cutoff)
      .not('category', 'is', null);

    const counts = {};
    (data || []).forEach(r => { counts[r.category] = (counts[r.category] || 0) + 1; });
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .forEach(([category, count]) => {
        candidates.push({ question: `What are the recent ${category.toLowerCase()} items in my market?`, count });
      });
  } catch (err) {
    console.log(`[suggestionEngine] policy_signals query failed: ${err.message}`);
  }

  try {
    const { data } = await supabase
      .from('market_dynamics_signals')
      .select('category')
      .eq('client_id', clientId)
      .gte('published_date', cutoff)
      .not('category', 'is', null);

    const counts = {};
    (data || []).forEach(r => { counts[r.category] = (counts[r.category] || 0) + 1; });
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .forEach(([category, count]) => {
        candidates.push({ question: `What recent ${category.toLowerCase()} activity is happening in my market?`, count });
      });
  } catch (err) {
    console.log(`[suggestionEngine] market_dynamics_signals query failed: ${err.message}`);
  }

  // Highest-count categories first, dedupe identical question text, cap at limit.
  const seen = new Set();
  const result = [];
  for (const c of candidates.sort((a, b) => b.count - a.count)) {
    if (seen.has(c.question)) continue;
    seen.add(c.question);
    result.push(c.question);
    if (result.length >= limit) break;
  }

  return result;
}

module.exports = { getVerifiedSuggestions };