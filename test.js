// cleanupByJobId.js
// Deletes all data associated with a specific pipeline job_id, across Supabase and Qdrant.
//
// Join chain used:
//   policy_signals.job_id / policy_articles_full.job_id  -->  article_id, source url, signal id
//   trend_membership.signal_id  -->  policy_signals.id
//   policy_articles_metadata.article_id, processed_urls.source_url  -->  matched via article_id/url
//   Qdrant collections (trend_matching, policy_articles, dedup_titles) keyed by article_id payload field
//
// NOTE: trend_clusters is intentionally NOT touched here — it has no job_id or article_id
// column, so there's no safe way to scope cluster deletion to a single job. A trend can be
// built from articles across multiple jobs; deleting it here could wipe cross-job data.
// If you want to clean up clusters left with zero membership after this run, do that as a
// separate, explicit step after reviewing which clusters are actually orphaned.

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
const DEDUP_COLLECTION = process.env.DEDUP_QDRANT_COLLECTION || 'dedup_titles';

const JOB_ID = process.argv[2] || 'job_1785251390234_6sx2hr';

const DRY_RUN = process.argv.includes('--dry-run');

async function del(table, column, values, useIn = true) {
  if (!values || (Array.isArray(values) && values.length === 0)) {
    console.log(`  – ${table}: skipped (no matching ${column} values)`);
    return 0;
  }

  if (DRY_RUN) {
    const { count, error } = await supabase
      .from(table)
      .select('id', { count: 'exact', head: true })
      [useIn ? 'in' : 'eq'](column, values);
    if (error) throw new Error(`[dry-run count] ${table}: ${error.message}`);
    console.log(`  – ${table}: would delete ${count ?? '?'} rows (matched on ${column})`);
    return count ?? 0;
  }

  const { error, count } = await supabase
    .from(table)
    .delete({ count: 'exact' })
    [useIn ? 'in' : 'eq'](column, values);
  if (error) throw new Error(`Failed deleting from ${table}: ${error.message}`);
  console.log(`  – ${table}: removed ${count ?? '?'} rows`);
  return count ?? 0;
}

async function qdrantDeleteByArticleIds(collection, articleIds) {
  if (!articleIds.length) {
    console.log(`  – ${collection}: skipped (no article_ids)`);
    return;
  }
  if (DRY_RUN) {
    console.log(`  – ${collection}: would delete points matching ${articleIds.length} article_id(s)`);
    return;
  }
  const result = await qdrant.delete(collection, {
    filter: {
      must: [
        {
          key: 'article_id',
          match: { any: articleIds },
        },
      ],
    },
  });
  console.log(`  – ${collection}: delete status = ${result.status}`);
}

async function cleanupByJobId() {
  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Cleaning data for job_id = ${JOB_ID}\n`);

  // 1. Gather article_ids, urls, and signal ids tied to this job
  const { data: signals, error: signalsErr } = await supabase
    .from('policy_signals')
    .select('id, article_id, source_article_url')
    .eq('job_id', JOB_ID);
  if (signalsErr) throw signalsErr;

  const { data: articles, error: articlesErr } = await supabase
    .from('policy_articles_full')
    .select('article_id, url')
    .eq('job_id', JOB_ID);
  if (articlesErr) throw articlesErr;

  const signalIds = (signals || []).map(s => s.id).filter(Boolean);
  const articleIds = [
    ...new Set([
      ...(signals || []).map(s => s.article_id),
      ...(articles || []).map(a => a.article_id),
    ].filter(Boolean)),
  ];
  const urls = [
    ...new Set([
      ...(signals || []).map(s => s.source_article_url),
      ...(articles || []).map(a => a.url),
    ].filter(Boolean)),
  ];

  console.log(`Found ${signalIds.length} signal(s), ${articleIds.length} unique article_id(s), ${urls.length} unique url(s)\n`);

  // 2. trend_membership via signal_id
  console.log('Supabase deletes:');
  await del('trend_membership', 'signal_id', signalIds);

  // 3. Direct job_id deletes
  await del('policy_signals', 'job_id', JOB_ID, false);
  await del('policy_articles_full', 'job_id', JOB_ID, false);
  await del('article_processing_log', 'job_id', JOB_ID, false);

  // 4. policy_articles_metadata via article_id
  await del('policy_articles_metadata', 'article_id', articleIds);

  // 5. processed_urls via source_url
  await del('processed_urls', 'source_url', urls);

  // 6. Qdrant deletes via article_id
  console.log('\nQdrant deletes:');
  await qdrantDeleteByArticleIds(TREND_COLLECTION, articleIds);
  await qdrantDeleteByArticleIds(POLICY_COLLECTION, articleIds);
  await qdrantDeleteByArticleIds(DEDUP_COLLECTION, articleIds);

  console.log(`\n${DRY_RUN ? '[DRY RUN] Nothing was actually deleted.' : '✅ Cleanup complete for job ' + JOB_ID}`);
  console.log('\nNote: trend_clusters was NOT touched (no reliable per-job link — see comment at top of file).');
}

cleanupByJobId().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});