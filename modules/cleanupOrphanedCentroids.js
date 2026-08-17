/**
 * cleanupOrphanedCentroids.js
 * =============================
 * One-time cleanup script. Finds points in the market_insights_centroids
 * Qdrant collection whose insight_id no longer exists in the
 * market_insights Supabase table (e.g. cards deleted during testing/dedup
 * cleanup, whose centroid was never removed from Qdrant), and deletes
 * those orphaned points.
 *
 * Run with: node modules/cleanupOrphanedCentroids.js
 * (place this file in modules/ alongside marketInsights.js before running,
 * so its require paths resolve correctly)
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { QdrantClient } = require('@qdrant/js-client-rest');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const qdrantClient = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});

const INSIGHT_CENTROID_COLLECTION = process.env.INSIGHT_CENTROID_QDRANT_COLLECTION || 'market_insights_centroids';

const run = async () => {
  console.log(`[Cleanup] Scanning collection '${INSIGHT_CENTROID_COLLECTION}' for orphaned centroids...`);

  // Step 1 — scroll through ALL points in the centroid collection
  let allPoints = [];
  let nextOffset = undefined;

  do {
    const result = await qdrantClient.scroll(INSIGHT_CENTROID_COLLECTION, {
      limit: 200,
      offset: nextOffset,
      with_payload: true,
      with_vector: false,
    });
    allPoints.push(...result.points);
    nextOffset = result.next_page_offset;
  } while (nextOffset);

  console.log(`[Cleanup] Found ${allPoints.length} total centroid point(s) in Qdrant`);

  if (allPoints.length === 0) {
    console.log('[Cleanup] Nothing to check. Done.');
    return;
  }

  // Step 2 — check which insight_ids actually exist in market_insights
  const insightIds = [...new Set(allPoints.map(p => p.payload.insight_id).filter(Boolean))];

  const { data: existingInsights, error } = await supabase
    .from('market_insights')
    .select('id')
    .in('id', insightIds);

  if (error) {
    console.error('[Cleanup] Failed to query market_insights:', error.message);
    return;
  }

  const existingIdSet = new Set((existingInsights || []).map(r => r.id));

  // Step 3 — find points whose insight_id is NOT in the existing set
  const orphanedPoints = allPoints.filter(p => !existingIdSet.has(p.payload.insight_id));

  console.log(`[Cleanup] ${orphanedPoints.length} orphaned point(s) found out of ${allPoints.length} total`);

  if (orphanedPoints.length === 0) {
    console.log('[Cleanup] No orphans. Done.');
    return;
  }

  orphanedPoints.forEach(p => {
    console.log(`  - point ${p.id} -> insight_id ${p.payload.insight_id} (no matching market_insights row)`);
  });

  // Step 4 — delete the orphaned points
  const orphanedPointIds = orphanedPoints.map(p => p.id);

  await qdrantClient.delete(INSIGHT_CENTROID_COLLECTION, {
    points: orphanedPointIds,
  });

  console.log(`[Cleanup] Deleted ${orphanedPointIds.length} orphaned centroid point(s). Done.`);
};

run().catch(err => {
  console.error('[Cleanup] Fatal error:', err.message);
  process.exit(1);
});