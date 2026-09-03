/**
 * cleanupTestData.js
 * Clears ALL test data for one client_id — Supabase rows AND Qdrant
 * points — so a re-run of testFullPipeline.js compares against a clean
 * slate instead of leftover cards/centroids from previous runs.
 *
 * Usage:
 *   docker exec -e TEST_CLIENT_ID=<uuid> -it app-test-app-1 node modules/cleanupTestData.js
 */
const { createClient } = require('@supabase/supabase-js');
const { QdrantClient } = require('@qdrant/js-client-rest');

const CLIENT_ID = process.env.TEST_CLIENT_ID;
if (!CLIENT_ID) {
  console.error('❌ Set TEST_CLIENT_ID');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});

const DEDUP_COLLECTION = 'dedup_titles';
const INSIGHT_CENTROID_COLLECTION = process.env.INSIGHT_CENTROID_QDRANT_COLLECTION || 'market_insights_centroids';

(async () => {
  console.log(`Cleaning up test data for client ${CLIENT_ID}...\n`);

  console.log('Deleting Supabase rows...');
  const { data: insights } = await supabase.from('market_insights').select('id').eq('client_id', CLIENT_ID);
  const insightIds = (insights || []).map(i => i.id);
  if (insightIds.length > 0) {
    await supabase.from('market_insight_members').delete().in('insight_id', insightIds);
    console.log(`  deleted market_insight_members for ${insightIds.length} card(s)`);
  }
  await supabase.from('market_dynamics_signals').delete().eq('client_id', CLIENT_ID);
  await supabase.from('market_insights').delete().eq('client_id', CLIENT_ID);
  console.log('  deleted market_dynamics_signals + market_insights rows');

  console.log('\nDeleting Qdrant points...');
  for (const collection of [DEDUP_COLLECTION, INSIGHT_CENTROID_COLLECTION]) {
    try {
      await qdrant.delete(collection, {
        filter: { must: [{ key: 'client_id', match: { value: CLIENT_ID } }] },
      });
      console.log(`  cleared ${collection}`);
    } catch (err) {
      console.log(`  skip ${collection}: ${err.message}`);
    }
  }

  console.log('\n✅ Done. Safe to re-run testFullPipeline.js now.');
  process.exit(0);
})();