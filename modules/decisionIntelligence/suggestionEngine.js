/**
 * modules/decisionIntelligence/suggestionEngine.js
 *
 * Builds "next question" suggestions that are verified against the
 * client's OWN current data before being shown -- instead of a static
 * hardcoded list, each candidate question is actually retrieval-tested,
 * so a suggestion only appears if clicking it will return a real answer.
 */
const { createClient } = require('@supabase/supabase-js');
const { retrieveClientData } = require('./retrieveClientData');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * Pulls a handful of categories the client actually has recent signals
 * for, across Policy & Risk and Market Dynamics, turns each into a
 * natural question, and verifies it returns real results before
 * offering it. Returns up to `limit` verified question strings.
 */
async function getVerifiedSuggestions(clientId, industry, limit = 4) {
  const candidates = [];

  try {
    const { data: policyRows } = await supabase
      .from('policy_signals')
      .select('category')
      .eq('client_id', clientId)
      .order('source_published_date', { ascending: false })
      .limit(20);

    const policyCategories = [...new Set((policyRows || []).map(r => r.category).filter(Boolean))].slice(0, 4);
    for (const cat of policyCategories) {
      candidates.push(`What are the recent ${cat.toLowerCase()} updates in my market?`);
    }
  } catch (err) {
    console.log(`[suggestionEngine] policy_signals lookup failed: ${err.message}`);
  }

  try {
    const { data: mdRows } = await supabase
      .from('market_dynamics_signals')
      .select('category')
      .eq('client_id', clientId)
      .order('published_date', { ascending: false })
      .limit(20);

    const mdCategories = [...new Set((mdRows || []).map(r => r.category).filter(Boolean))].slice(0, 4);
    for (const cat of mdCategories) {
      candidates.push(`What recent ${cat.toLowerCase()} activity is happening in my market?`);
    }
  } catch (err) {
    console.log(`[suggestionEngine] market_dynamics_signals lookup failed: ${err.message}`);
  }

  const verified = [];
  for (const question of candidates) {
    if (verified.length >= limit) break;
    try {
      const results = await retrieveClientData(
        question, clientId, industry, 5, null,
        Number(process.env.LIST_SCORE_FLOOR) || 0.35,
        true
      );
      if (results.length > 0) {
        verified.push(question);
      }
    } catch (err) {
      console.log(`[suggestionEngine] verification failed for "${question}": ${err.message}`);
    }
  }

  return verified;
}

module.exports = { getVerifiedSuggestions };