// mergeTrends.js
//
// Merges SOURCE trend into TARGET trend:
//   1. Reassigns all trend_membership rows from source -> target
//   2. Deletes source's centroid vector from Qdrant (if it had one)
//   3. Deletes source's trend_snapshots rows
//   4. Deletes the source trend_clusters row
//   5. Recomputes target's centroid using the combined signal set
//   6. Regenerates target's name/summary/business_impact/impact/sector
//      using ALL combined signals
//   7. Freezes a fresh trend_snapshots row so the frontend picks it up
//
// The underlying policy_signals rows are never touched -- only which
// trend they're grouped under changes.
//
// Usage: node mergeTrends.js <sourceTrendId> <targetTrendId> <industry>

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { QdrantClient } = require('@qdrant/js-client-rest');
const {
  updateTrendCentroid,
  generateTrendNameAndWriteup,
} = require('./modules/trendClustering');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});

const TREND_COLLECTION = process.env.TREND_QDRANT_COLLECTION || 'trend_matching';

const main = async () => {
  const [sourceId, targetId, industry] = process.argv.slice(2);
  if (!sourceId || !targetId || !industry) {
    console.error('Usage: node mergeTrends.js <sourceTrendId> <targetTrendId> <industry>');
    process.exit(1);
  }

  const { data: sourceTrend, error: sourceError } = await supabase
    .from('trend_clusters')
    .select('id, name, centroid_point_id, client_id, module_id')
    .eq('id', sourceId)
    .single();

  const { data: targetTrend, error: targetError } = await supabase
    .from('trend_clusters')
    .select('id, name, client_id')
    .eq('id', targetId)
    .single();

  if (sourceError || !sourceTrend) {
    console.error('Could not find source trend:', sourceError?.message);
    process.exit(1);
  }
  if (targetError || !targetTrend) {
    console.error('Could not find target trend:', targetError?.message);
    process.exit(1);
  }

  console.log(`\nMerging "${sourceTrend.name}" (${sourceId}) INTO "${targetTrend.name}" (${targetId})\n`);

  // 1. Get source's members
  const { data: sourceMembers, error: membersError } = await supabase
    .from('trend_membership')
    .select('id, signal_id')
    .eq('trend_id', sourceId);

  if (membersError) {
    console.error('Failed to fetch source memberships:', membersError.message);
    process.exit(1);
  }

  console.log(`Found ${sourceMembers?.length || 0} signal(s) in source trend.`);

  // Check which of these signals are ALREADY in the target (avoid duplicate rows)
  const { data: targetMembers } = await supabase
    .from('trend_membership')
    .select('signal_id')
    .eq('trend_id', targetId);

  const targetSignalIds = new Set((targetMembers || []).map(m => m.signal_id));

  let reassigned = 0;
  let skippedAlreadyPresent = 0;

  for (const member of sourceMembers || []) {
    if (targetSignalIds.has(member.signal_id)) {
      // Already in target -- just remove the source's now-redundant row
      await supabase.from('trend_membership').delete().eq('id', member.id);
      skippedAlreadyPresent++;
      continue;
    }

    const { error: updateError } = await supabase
      .from('trend_membership')
      .update({ trend_id: targetId })
      .eq('id', member.id);

    if (updateError) {
      console.error(`  Failed to reassign membership row ${member.id}:`, updateError.message);
      continue;
    }
    reassigned++;
  }

  console.log(`Reassigned ${reassigned} signal(s) to target. Skipped ${skippedAlreadyPresent} already present.`);

  // 2. Delete source's centroid vector from Qdrant, if it exists
  if (sourceTrend.centroid_point_id) {
    try {
      await qdrant.delete(TREND_COLLECTION, { points: [sourceTrend.centroid_point_id] });
      console.log('Deleted source centroid vector from Qdrant.');
    } catch (err) {
      console.error('Warning: failed to delete source centroid vector:', err.message);
    }
  }

  // 3. Delete source's trend_snapshots
  const { error: snapshotDeleteError } = await supabase
    .from('trend_snapshots')
    .delete()
    .eq('trend_id', sourceId);
  if (snapshotDeleteError) {
    console.error('Warning: failed to delete source snapshots:', snapshotDeleteError.message);
  } else {
    console.log('Deleted source trend_snapshots rows.');
  }

  // 4. Delete the source trend_clusters row
  const { error: clusterDeleteError } = await supabase
    .from('trend_clusters')
    .delete()
    .eq('id', sourceId);
  if (clusterDeleteError) {
    console.error('Failed to delete source trend_clusters row:', clusterDeleteError.message);
    process.exit(1);
  }
  console.log('Deleted source trend_clusters row.');

  // 5. Recompute target's centroid using the now-combined signal set
  await updateTrendCentroid(targetId);
  console.log('Recomputed target centroid with combined signals.');

  // 6. Regenerate target's writeup using ALL combined signals
  console.log('\nRegenerating writeup for merged trend...');
  const result = await generateTrendNameAndWriteup(targetId, industry, targetTrend.client_id);

  if (!result) {
    console.error('Writeup regeneration failed -- merge is complete but writeup is stale. Re-run regenerateNaming.js on the target manually.');
    process.exit(1);
  }

  const memberCount = (await supabase
    .from('trend_membership')
    .select('id', { count: 'exact', head: true })
    .eq('trend_id', targetId)).count;

  await supabase.from('trend_clusters').update({
    name: result.name,
    summary: result.summary,
    business_impact: result.business_impact,
    impact: result.impact,
    sector: result.sector,
    last_named_signal_count: memberCount,
  }).eq('id', targetId);

  console.log(`Target trend renamed/updated: "${result.name}" (Impact: ${result.impact})`);

  // 7. Freeze a fresh snapshot so the frontend reflects this immediately
  const { data: refreshedTarget } = await supabase
    .from('trend_clusters')
    .select('ring, dot_size, similar_trends, module_id, client_id')
    .eq('id', targetId)
    .single();

  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

  const { error: newSnapshotError } = await supabase.from('trend_snapshots').insert({
    trend_id: targetId,
    module_id: refreshedTarget.module_id,
    client_id: refreshedTarget.client_id,
    period_start: periodStart.toISOString().slice(0, 10),
    period_end: periodEnd.toISOString().slice(0, 10),
    name: result.name,
    sector: result.sector,
    ring: refreshedTarget.ring || 'mid_term',
    dot_size: refreshedTarget.dot_size || 0,
    posture: 'N/A',
    similar_trends: refreshedTarget.similar_trends || [],
    write_up: {
      summary: result.summary,
      business_impact: result.business_impact,
      impact: result.impact,
    },
  });

  if (newSnapshotError) {
    console.error('Warning: failed to freeze new snapshot:', newSnapshotError.message);
  } else {
    console.log('Fresh snapshot frozen -- frontend should now show the merged trend.');
  }

  console.log('\n✅ Merge complete.\n');
  process.exit(0);
};

main();