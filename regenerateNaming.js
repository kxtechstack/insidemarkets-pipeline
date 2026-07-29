// regenerateNaming.js
//
// Re-runs ONLY the naming/writeup generation for trend(s) that got promoted
// to 'active' but failed to generate a name (e.g. due to an LM Studio 503).
// Does NOT touch centroid creation or the promotion status — those already
// succeeded, this just fills in name/summary/business_impact/impact/sector.
//
// Usage:
//   node regenerateNaming.js <trendId> <industry>
//   node regenerateNaming.js --missing <moduleId> <clientId> <industry>
//
// Examples:
//   node regenerateNaming.js 1ab71a6b-cdc9-4221-8666-f1113fbaa8d5 Automotive
//   node regenerateNaming.js --missing 3b9283a1c090-... some-client-id Automotive

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { generateTrendNameAndWriteup } = require('./modules/trendClustering');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const regenerateOne = async (trendId, industry) => {
  console.log(`\n[Regenerate] Trend ${trendId} — fetching client_id...`);

  const { data: trendRow, error } = await supabase
    .from('trend_clusters')
    .select('client_id, name, module_id, ring, dot_size, similar_trends')
    .eq('id', trendId)
    .single();

  if (error || !trendRow) {
    console.error(`[Regenerate] Could not find trend ${trendId}:`, error?.message);
    return;
  }

  console.log(`[Regenerate] Current name: "${trendRow.name || '(none)'}" — regenerating...`);

  const result = await generateTrendNameAndWriteup(trendId, industry, trendRow.client_id);

  if (!result) {
    console.error(`[Regenerate] Still failed for trend ${trendId}. Check LM Studio is up and reachable.`);
    return;
  }

  const { error: updateError } = await supabase
    .from('trend_clusters')
    .update({
      name: result.name,
      summary: result.summary,
      business_impact: result.business_impact,
      impact: result.impact,
      sector: result.sector,
    })
    .eq('id', trendId);

  if (updateError) {
    console.error(`[Regenerate] Failed to save result for trend ${trendId}:`, updateError.message);
    return;
  }

  // IMPORTANT: the frontend reads only from trend_snapshots, not
  // trend_clusters directly. Updating trend_clusters alone (above) is
  // invisible to the UI until a fresh snapshot is frozen -- so without
  // this, the frontend keeps showing the OLD name/summary from whenever
  // runWeeklyScoring last ran, even though the underlying trend is fixed.
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

  const { error: snapshotError } = await supabase.from('trend_snapshots').insert({
    trend_id: trendId,
    module_id: trendRow.module_id,
    client_id: trendRow.client_id,
    period_start: periodStart.toISOString().slice(0, 10),
    period_end: periodEnd.toISOString().slice(0, 10),
    name: result.name,
    sector: result.sector,
    ring: trendRow.ring || 'mid_term',
    dot_size: trendRow.dot_size || 0,
    posture: 'N/A',
    similar_trends: trendRow.similar_trends || [],
    write_up: {
      summary: result.summary,
      business_impact: result.business_impact,
      impact: result.impact,
    },
  });

  if (snapshotError) {
    console.error(`[Regenerate] Trend updated but snapshot freeze failed for ${trendId}:`, snapshotError.message);
    console.error(`[Regenerate] Frontend will still show stale data until a snapshot is written.`);
  } else {
    console.log(`[Regenerate] Snapshot refreshed for trend ${trendId} — frontend should now show the update.`);
  }

  console.log(`[Regenerate] Success — trend ${trendId} named "${result.name}" (Impact: ${result.impact})`);
};

const findMissingAndRegenerate = async (moduleId, clientId, industry) => {
  const { data: trends, error } = await supabase
    .from('trend_clusters')
    .select('id, name')
    .eq('module_id', moduleId)
    .eq('client_id', clientId)
    .eq('status', 'active')
    .or('name.is.null,name.eq.Unnamed Trend');

  if (error) {
    console.error('[Regenerate] Failed to query for missing names:', error.message);
    return;
  }

  if (!trends || trends.length === 0) {
    console.log('[Regenerate] No active trends missing a name. Nothing to do.');
    return;
  }

  console.log(`[Regenerate] Found ${trends.length} active trend(s) missing a proper name.`);
  for (const t of trends) {
    await regenerateOne(t.id, industry);
  }
};

const main = async () => {
  const args = process.argv.slice(2);

  if (args[0] === '--missing') {
    const [, moduleId, clientId, industry] = args;
    if (!moduleId || !clientId || !industry) {
      console.error('Usage: node regenerateNaming.js --missing <moduleId> <clientId> <industry>');
      process.exit(1);
    }
    await findMissingAndRegenerate(moduleId, clientId, industry);
  } else {
    const [trendId, industry] = args;
    if (!trendId || !industry) {
      console.error('Usage: node regenerateNaming.js <trendId> <industry>');
      process.exit(1);
    }
    await regenerateOne(trendId, industry);
  }

  process.exit(0);
};

main();