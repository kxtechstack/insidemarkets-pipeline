// delete-client-module-data.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { QdrantClient } = require('@qdrant/js-client-rest');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const qdrant = new QdrantClient({ url: process.env.QDRANT_URL, apiKey: process.env.QDRANT_API_KEY, checkCompatibility: false });
const CLIENT_ID = 'b61b4d3b-caeb-457b-9971-636c83688ee4';
const MODULE_ID = '55c5ee19-bfca-468b-81b3-b89ca4f303c8';
const POLICY_COLLECTION = process.env.POLICY_QDRANT_COLLECTION || 'policy_articles';

async function deleteAll() {
  // 1. Delete from Qdrant - policy_articles
  try {
    const qdrantResult = await qdrant.delete(POLICY_COLLECTION, {
      filter: {
        must: [
          { key: 'client_id', match: { value: CLIENT_ID } },
          { key: 'module_id', match: { value: MODULE_ID } },
        ],
      },
      wait: true,
    });
    console.log('Qdrant policy_articles delete result:', qdrantResult.status);
  } catch (err) {
    console.log('Qdrant policy_articles delete error:', err.message);
  }

  // 1b. Delete from Qdrant - dedup_titles (topic dedup collection)
  try {
    const dedupResult = await qdrant.delete('dedup_titles', {
      filter: {
        must: [
          { key: 'client_id', match: { value: CLIENT_ID } },
          { key: 'module_id', match: { value: MODULE_ID } },
        ],
      },
      wait: true,
    });
    console.log('Qdrant dedup_titles delete result:', dedupResult.status);
  } catch (err) {
    console.log('Qdrant dedup_titles delete error:', err.message);
  }

  // 2. Delete market_insight_members FIRST (references market_insights — must go before market_insights)
  try {
    const { data: insights } = await supabase
      .from('market_insights')
      .select('id')
      .eq('client_id', CLIENT_ID)
      .eq('module_id', MODULE_ID);
    const insightIds = (insights || []).map(i => i.id);
    if (insightIds.length > 0) {
      const { error, count } = await supabase
        .from('market_insight_members')
        .delete({ count: 'exact' })
        .in('insight_id', insightIds);
      console.log(error ? `market_insight_members: ERROR - ${error.message}` : `market_insight_members: deleted ${count} rows`);
    } else {
      console.log('market_insight_members: no matching insight IDs, skipped');
    }
  } catch (err) {
    console.log('market_insight_members: ERROR -', err.message);
  }

  // 3. Delete remaining Supabase tables, scoped by client_id + module_id
  const tables = [
    'market_dynamics_signals',
    'market_insights',
    'policy_articles_metadata',
    'policy_articles_full',
    'policy_signals',
    'processed_urls',
    'daily_highlights',
  ];
  for (const table of tables) {
    const { error, count } = await supabase
      .from(table)
      .delete({ count: 'exact' })
      .eq('client_id', CLIENT_ID)
      .eq('module_id', MODULE_ID);
    if (error) {
      console.log(`${table}: ERROR - ${error.message}`);
    } else {
      console.log(`${table}: deleted ${count} rows`);
    }
  }

  // 4. article_processing_log and pipeline_job_status use submodule_id, not module_id directly
  try {
    const { data: submodules } = await supabase
      .schema('admin')
      .from('submodules')
      .select('id')
      .eq('module_id', MODULE_ID);
    const submoduleIds = (submodules || []).map(s => s.id);
    if (submoduleIds.length > 0) {
      const { error: logErr, count: logCount } = await supabase
        .from('article_processing_log')
        .delete({ count: 'exact' })
        .eq('client_id', CLIENT_ID)
        .in('submodule_id', submoduleIds);
      console.log(logErr ? `article_processing_log: ERROR - ${logErr.message}` : `article_processing_log: deleted ${logCount} rows`);

      const { error: jobErr, count: jobCount } = await supabase
        .from('pipeline_job_status')
        .delete({ count: 'exact' })
        .eq('client_id', CLIENT_ID)
        .in('submodule_id', submoduleIds);
      console.log(jobErr ? `pipeline_job_status: ERROR - ${jobErr.message}` : `pipeline_job_status: deleted ${jobCount} rows`);
    }
  } catch (err) {
    console.log('submodule-scoped cleanup: ERROR -', err.message);
  }

  console.log('Done.');
}
deleteAll();