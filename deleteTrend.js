// deleteTrend.js
//
// Cleanly deletes a trend cluster that shouldn't have been formed/promoted
// (e.g. an incoherent grab-bag like "Innovation Hub"). Removes:
//   - the trend_clusters row
//   - all trend_membership rows for it
//   - its centroid vector in Qdrant (if promoted)
//   - the individual signal vectors in Qdrant tagged to this trend_id
//     via trend_membership (their underlying policy_signals rows are
//     NOT touched -- the articles themselves stay valid for RAG chat,
//     similar-articles, etc. They just go back to being un-clustered)
//
// After running this, the freed-up signals are simply not part of any
// trend. They CAN get picked up into a new/different candidate trend
// on a future pipeline run if a new signal matches them well -- but
// nothing forces that to happen automatically.
//
// Usage: node deleteTrend.js <trendId>

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { QdrantClient } = require('@qdrant/js-client-rest');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});

const TREND_COLLECTION = process.env.TREND_QDRANT_COLLECTION || 'trend_matching';

const main = async () => {
  const trendId = process.argv[2];
  if (!trendId) {
    console.error('Usage: node deleteTrend.js <trendId>');
    process.exit(1);
  }

  const { data: trend, error: trendError } = await supabase
    .from('trend_clusters')
    .select('id, name, centroid_point_id, status')
    .eq('id', trendId)
    .single();

  if (trendError || !trend) {
    console.error('Trend not found:', trendError?.message);
    process.exit(1);
  }

  console.log(`\nAbout to delete trend: "${trend.name || '(unnamed)'}" (${trend.id}), status: ${trend.status}`);

  // 1. Get member signal ids (needed to clean up their Qdrant vectors)
  const { data: members } = await supabase
    .from('trend_membership')
    .select('signal_id')
    .eq('trend_id', trendId);

  const signalIds = (members || []).map(m => m.signal_id);
  console.log(`Found ${signalIds.length} member signal(s) — their underlying articles will NOT be deleted.`);

  // 2. Delete signal-type vectors in Qdrant belonging to this trend's signals
  //    (matched by article_id payload field, scoped to type='signal')
  if (signalIds.length > 0) {
    try {
      await qdrant.delete(TREND_COLLECTION, {
        filter: {
          must: [
            { key: 'type', match: { value: 'signal' } },
            { key: 'article_id', match: { any: signalIds } },
          ],
        },
      });
      console.log('Deleted signal vectors from Qdrant.');
    } catch (err) {
      console.error('Warning: failed to delete signal vectors from Qdrant:', err.message);
    }
  }

  // 3. Delete the centroid vector, if this trend was ever promoted
  if (trend.centroid_point_id) {
    try {
      await qdrant.delete(TREND_COLLECTION, {
        points: [trend.centroid_point_id],
      });
      console.log('Deleted centroid vector from Qdrant.');
    } catch (err) {
      console.error('Warning: failed to delete centroid vector from Qdrant:', err.message);
    }
  }

  // 4. Delete trend_membership rows
  const { error: membershipDeleteError } = await supabase
    .from('trend_membership')
    .delete()
    .eq('trend_id', trendId);

  if (membershipDeleteError) {
    console.error('Failed to delete trend_membership rows:', membershipDeleteError.message);
    process.exit(1);
  }
  console.log('Deleted trend_membership rows.');

  // 5. Delete any trend_snapshots for this trend (if weekly scoring ran on it)
  const { error: snapshotDeleteError } = await supabase
    .from('trend_snapshots')
    .delete()
    .eq('trend_id', trendId);

  if (snapshotDeleteError) {
    console.error('Warning: failed to delete trend_snapshots rows:', snapshotDeleteError.message);
  } else {
    console.log('Deleted trend_snapshots rows (if any existed).');
  }

  // 6. Finally, delete the trend_clusters row itself
  const { error: clusterDeleteError } = await supabase
    .from('trend_clusters')
    .delete()
    .eq('id', trendId);

  if (clusterDeleteError) {
    console.error('Failed to delete trend_clusters row:', clusterDeleteError.message);
    process.exit(1);
  }

  console.log(`\n✅ Trend ${trendId} fully deleted. ${signalIds.length} article(s) are now un-clustered and free to re-match on future runs.\n`);
  process.exit(0);
};

main();