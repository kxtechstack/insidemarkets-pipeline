// cleanupForwardModule.js

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
const POLICY_COLLECTION = process.env.POLICY_QDRANT_COLLECTION || 'policy_articles';

const MODULE_ID = '2eb989fd-0ea0-4320-b73a-f7eb8b970473'; // Forward Outlook

async function cleanupForwardModule() {
  console.log('Cleaning Forward Outlook module...');

  // Get all trend IDs for this module
  const { data: trends, error: trendErr } = await supabase
    .from('trend_clusters')
    .select('id')
    .eq('module_id', MODULE_ID);

  if (trendErr) throw trendErr;

  if (trends?.length) {
    const trendIds = trends.map(t => t.id);

    await supabase
      .from('trend_membership')
      .delete()
      .in('trend_id', trendIds);

    await supabase
      .from('trend_snapshots')
      .delete()
      .in('trend_id', trendIds);
  }

  await supabase
    .from('trend_clusters')
    .delete()
    .eq('module_id', MODULE_ID);

  await supabase
    .from('policy_signals')
    .delete()
    .eq('module_id', MODULE_ID);

  await supabase
    .from('policy_articles_metadata')
    .delete()
    .eq('module_id', MODULE_ID);

  await supabase
    .from('policy_articles_full')
    .delete()
    .eq('module_id', MODULE_ID);

  await supabase
    .from('processed_urls')
    .delete()
    .eq('module_id', MODULE_ID);
    

  // Remove vectors from Qdrant
  await qdrant.delete(TREND_COLLECTION, {
    filter: {
      must: [
        {
          key: 'module_id',
          match: {
            value: MODULE_ID,
          },
        },
      ],
    },
  });

  await qdrant.delete(POLICY_COLLECTION, {
    filter: {
      must: [
        {
          key: 'module_id',
          match: {
            value: MODULE_ID,
          },
        },
      ],
    },
  });

  console.log('✅ Forward Outlook module cleaned successfully.');
}

cleanupForwardModule().catch(err => {
  console.error(err);
  process.exit(1);
});