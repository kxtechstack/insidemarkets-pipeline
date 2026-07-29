// checkTrend.js
//
// Pulls the current name/summary/business_impact/impact/sector for a trend
// so you can eyeball what survived after the competitor grounding check
// stripped out fabricated mentions.
//
// Usage: node checkTrend.js <trendId>

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const main = async () => {
  const trendId = process.argv[2];
  if (!trendId) {
    console.error('Usage: node checkTrend.js <trendId>');
    process.exit(1);
  }

  const { data, error } = await supabase
    .from('trend_clusters')
    .select('id, name, sector, impact, summary, business_impact, status, promoted_at')
    .eq('id', trendId)
    .single();

  if (error || !data) {
    console.error('Could not fetch trend:', error?.message);
    process.exit(1);
  }

  console.log('\n=== Trend', data.id, '===');
  console.log('Status:', data.status, '| Promoted at:', data.promoted_at);
  console.log('Name:', data.name);
  console.log('Sector:', data.sector);
  console.log('Impact:', data.impact);
  console.log('\nSummary:\n', data.summary);
  console.log('\nBusiness Impact bullets (' + (data.business_impact?.length || 0) + '):');
  (data.business_impact || []).forEach((b, i) => console.log(`  ${i + 1}. ${b}`));
  console.log('');

  process.exit(0);
};

main();