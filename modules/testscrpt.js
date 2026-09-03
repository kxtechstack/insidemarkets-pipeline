require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { calculateTrendConfidenceScore } = require('./trendClustering');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

(async () => {
  const trendId = '766f8ec9-3070-4a1e-9da1-68731bfebfb8'; // AI Longevity
  const score = await calculateTrendConfidenceScore(trendId);
  console.log('New confidence score:', score, score > 7 ? 'High' : score > 4 ? 'Medium' : 'Low');

  await supabase.from('trend_clusters').update({ confidence_score: score }).eq('id', trendId);
  await supabase.from('trend_snapshots')
    .update({ confidence_score: score })
    .eq('trend_id', trendId)
    .order('created_at', { ascending: false })
    .limit(1);

  console.log('DB updated.');
  process.exit(0);
})();