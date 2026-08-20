// delete-all-client-data.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { QdrantClient } = require('@qdrant/js-client-rest');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const qdrant = new QdrantClient({ url: process.env.QDRANT_URL, apiKey: process.env.QDRANT_API_KEY, checkCompatibility: false });
const CLIENT_ID = '3567cc72-f9da-419b-a803-c9c5579e86bf'; // <-- confirm this is the right client before running
const POLICY_COLLECTION = process.env.POLICY_QDRANT_COLLECTION || 'policy_articles';
const CUSTOM_SOURCE_COLLECTION = 'custom_source_content';

async function deleteAll() {
  // 1. Qdrant collections — filter by client_id only now, no module_id
  for (const collection of [POLICY_COLLECTION, 'dedup_titles', CUSTOM_SOURCE_COLLECTION]) {
    try {
      const result = await qdrant.delete(collection, {
        filter: { must: [{ key: 'client_id', match: { value: CLIENT_ID } }] },
        wait: true,
      });
      console.log(`Qdrant ${collection} delete result:`, result.status);
    } catch (err) {
      console.log(`Qdrant ${collection} delete error:`, err.message);
    }
  }

  // 2. market_insight_members FIRST (references market_insights)
  try {
    const { data: insights } = await supabase.from('market_insights').select('id').eq('client_id', CLIENT_ID);
    const insightIds = (insights || []).map(i => i.id);
    if (insightIds.length > 0) {
      const { error, count } = await supabase.from('market_insight_members').delete({ count: 'exact' }).in('insight_id', insightIds);
      console.log(error ? `market_insight_members: ERROR - ${error.message}` : `market_insight_members: deleted ${count} rows`);
    } else {
      console.log('market_insight_members: no matching insight IDs, skipped');
    }
  } catch (err) {
    console.log('market_insight_members: ERROR -', err.message);
  }

  // 3. trend_membership FIRST (references trend_clusters — Forward Outlook)
  try {
    const { data: clusters } = await supabase.from('trend_clusters').select('id').eq('client_id', CLIENT_ID);
    const clusterIds = (clusters || []).map(c => c.id);
    if (clusterIds.length > 0) {
      const { error, count } = await supabase.from('trend_membership').delete({ count: 'exact' }).in('trend_cluster_id', clusterIds);
      console.log(error ? `trend_membership: ERROR - ${error.message}` : `trend_membership: deleted ${count} rows`);
    } else {
      console.log('trend_membership: no matching cluster IDs, skipped');
    }
  } catch (err) {
    console.log('trend_membership: ERROR -', err.message);
  }

  // 4. Remaining Supabase tables, scoped by client_id only (all modules)
  const tables = [
    'market_dynamics_signals',
    'market_insights',
    'policy_articles_metadata',
    'policy_articles_full',
    'policy_signals',
    'trend_signals',        // Forward Outlook — separate table since the July migration
    'trend_clusters',       // Forward Outlook — after trend_membership above
    'trend_snapshots',      // Forward Outlook weekly scoring history
    'processed_urls',
    'daily_highlights',
    'custom_source_content',
    'custom_source_run_log',
    'article_processing_log',
    'pipeline_job_status',
  ];
  for (const table of tables) {
    const { error, count } = await supabase.from(table).delete({ count: 'exact' }).eq('client_id', CLIENT_ID);
    console.log(error ? `${table}: ERROR - ${error.message}` : `${table}: deleted ${count} rows`);
  }

  // 5. hidden_articles / bookmarks — reference policy_signal_id / trend_cluster_id /
  //    market_insight_id, not client_id directly, so can't filter by client_id here.
  //    Deleting the parent rows above cascades these IF the FKs are ON DELETE CASCADE
  //    (confirmed true for trend_cluster_id per your earlier migration notes — NOT
  //    independently confirmed for policy_signal_id / market_insight_id). Worth a
  //    manual check after running: SELECT count(*) FROM hidden_articles WHERE
  //    policy_signal_id NOT IN (SELECT id FROM policy_signals); if that's nonzero,
  //    add an explicit delete-by-user or delete-orphans step.

  // 6. Reset schedule config on admin.prompts (columns now live here, not a
  //    separate table) — clears source/frequency/schedule_time/is_active for
  //    every submodule of this client so the scheduler won't fire stale times
  //    on old prompts. Prompt rows themselves (prompt_text) are left intact —
  //    remove this block if you want to keep old schedules for reference.
  try {
    const { error, count } = await supabase
      .schema('admin')
      .from('prompts')
      .update({ source: null, frequency: null, schedule_time: null, is_active: true })
      .eq('client_id', CLIENT_ID)
      .select();
    console.log(error ? `admin.prompts schedule reset: ERROR - ${error.message}` : `admin.prompts schedule reset: ${count} rows updated`);
  } catch (err) {
    console.log('admin.prompts schedule reset: ERROR -', err.message);
  }

  console.log('Done.');
}
deleteAll();