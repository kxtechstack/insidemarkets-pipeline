// checkTrendSignals.js
//
// Pulls every signal that got clustered into a given trend, along with
// join metadata (match_type, joined_at) -- so you can eyeball whether the
// signals grouped together actually belong together, and whether the
// generated name/summary accurately represents them.
//
// Usage: node checkTrendSignals.js <trendId>

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const main = async () => {
  const trendId = process.argv[2];
  if (!trendId) {
    console.error('Usage: node checkTrendSignals.js <trendId>');
    process.exit(1);
  }

  // Trend header info
  const { data: trend, error: trendError } = await supabase
    .from('trend_clusters')
    .select('id, name, sector, impact, status')
    .eq('id', trendId)
    .single();

  if (trendError || !trend) {
    console.error('Could not fetch trend:', trendError?.message);
    process.exit(1);
  }

  // Membership rows (which signals + how/when they joined)
  const { data: members, error: membersError } = await supabase
    .from('trend_membership')
    .select('signal_id, match_type, joined_at')
    .eq('trend_id', trendId)
    .order('joined_at', { ascending: true });

  if (membersError || !members || members.length === 0) {
    console.error('No membership rows found:', membersError?.message);
    process.exit(1);
  }

  const signalIds = members.map(m => m.signal_id);

  // Full signal details
  const { data: signals, error: signalsError } = await supabase
    .from('policy_signals')
    .select('id, signal_title, organization, signal_type, summary, horizon_estimate, source_article_url, article_id')
    .in('id', signalIds);

  if (signalsError) {
    console.error('Could not fetch signal details:', signalsError.message);
    process.exit(1);
  }

  const signalById = {};
  (signals || []).forEach(s => { signalById[s.id] = s; });

  console.log('\n=== Trend:', trend.name, `(${trend.id})`, '===');
  console.log('Sector:', trend.sector, '| Impact:', trend.impact, '| Status:', trend.status);
  console.log(`\n${members.length} signal(s) in this cluster:\n`);

  members.forEach((m, i) => {
    const s = signalById[m.signal_id];
    console.log(`--- Signal ${i + 1} (${m.match_type}, joined ${m.joined_at}) ---`);
    if (!s) {
      console.log(`  [missing] signal_id ${m.signal_id} not found in policy_signals`);
    } else {
      console.log(`  Title:        ${s.signal_title}`);
      console.log(`  Organization: ${s.organization}`);
      console.log(`  Type:         ${s.signal_type}`);
      console.log(`  Horizon:      ${s.horizon_estimate}`);
      console.log(`  Summary:      ${s.summary}`);
      console.log(`  Source URL:   ${s.source_article_url || '(none)'}`);
    }
    console.log('');
  });

  process.exit(0);
};

main();