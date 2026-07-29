// checkHorizonDistribution.js
//
// Pulls the distribution of horizon_estimate values across policy_signals
// for a given module/client, to check whether the LLM relevance/extraction
// step is genuinely varying near_term/mid_term/long_term, or just
// defaulting most signals to one value (which would explain why every
// trend's calculateTrendRing() lands on the exact same weighted average).
//
// Usage: node checkHorizonDistribution.js <moduleId> <clientId>

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const main = async () => {
  const [moduleId, clientId] = process.argv.slice(2);
  if (!moduleId || !clientId) {
    console.error('Usage: node checkHorizonDistribution.js <moduleId> <clientId>');
    process.exit(1);
  }

  // Get all signal_ids that belong to trends in this module/client (via
  // trend_membership -> trend_clusters), then pull their horizon_estimate.
  const { data: clusters, error: clusterError } = await supabase
    .from('trend_clusters')
    .select('id')
    .eq('module_id', moduleId)
    .eq('client_id', clientId);

  if (clusterError || !clusters || clusters.length === 0) {
    console.error('Could not fetch trend clusters:', clusterError?.message || 'none found');
    process.exit(1);
  }

  const clusterIds = clusters.map(c => c.id);

  const { data: memberships, error: memberError } = await supabase
    .from('trend_membership')
    .select('signal_id')
    .in('trend_id', clusterIds);

  if (memberError || !memberships) {
    console.error('Could not fetch trend_membership:', memberError?.message);
    process.exit(1);
  }

  const signalIds = [...new Set(memberships.map(m => m.signal_id))];

  const { data: signals, error: signalsError } = await supabase
    .from('policy_signals')
    .select('id, horizon_estimate, signal_title')
    .in('id', signalIds);

  if (signalsError || !signals) {
    console.error('Could not fetch policy_signals:', signalsError?.message);
    process.exit(1);
  }

  const counts = { near_term: 0, mid_term: 0, long_term: 0, missing_or_invalid: 0 };
  const examples = { near_term: [], mid_term: [], long_term: [], missing_or_invalid: [] };

  for (const s of signals) {
    const key = ['near_term', 'mid_term', 'long_term'].includes(s.horizon_estimate)
      ? s.horizon_estimate
      : 'missing_or_invalid';
    counts[key]++;
    if (examples[key].length < 3) examples[key].push(s.signal_title);
  }

  const total = signals.length;

  console.log(`\n=== Horizon distribution across ${total} clustered signal(s) ===\n`);
  for (const key of ['near_term', 'mid_term', 'long_term', 'missing_or_invalid']) {
    const pct = total > 0 ? ((counts[key] / total) * 100).toFixed(1) : '0.0';
    console.log(`${key.padEnd(20)} ${String(counts[key]).padStart(4)}  (${pct}%)`);
    examples[key].forEach(t => console.log(`   - ${t}`));
  }

  console.log('');

  if (total > 0 && counts.mid_term / total > 0.85) {
    console.log('⚠️  Over 85% of signals are mid_term — the LLM relevance/extraction step is');
    console.log('    likely defaulting to mid_term rather than genuinely distinguishing horizons.');
    console.log('    This is why every trend\'s ring calculation lands on the same weighted average.\n');
  }

  process.exit(0);
};

main();