require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { calculateTrendConfidenceScore } = require('./trendClustering');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

(async () => {
  const trendId = '1ab71a6b-cdc9-4221-8666-f1113fbaa8d5';
  const score = await calculateTrendConfidenceScore(trendId);
  console.log('New confidence score:', score);

  await supabase.from('trend_clusters').update({ confidence_score: score }).eq('id', trendId);

  // also update the snapshot row so trend_snapshots_latest reflects it too
  await supabase.from('trend_snapshots')
    .update({ confidence_score: score })
    .eq('trend_id', trendId)
    .order('created_at', { ascending: false })
    .limit(1);

  console.log('Updated DB. Confidence:', score, score > 7 ? 'High' : score > 4 ? 'Medium' : 'Low');
  process.exit(0);
})();