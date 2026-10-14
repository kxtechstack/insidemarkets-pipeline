/**
 * scripts/diagnose-li5.js
 *
 * Shows the article_ids of every hit at each stage of the list pipeline
 * for a given question, and cross-checks each against the three signal
 * tables in Supabase. This is the drop-off diagnostic.
 *
 * Usage:
 *   node scripts/diagnose-li5.js
 *   node scripts/diagnose-li5.js "List recent funding rounds in our Cosmetics industry"
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const { route } = require('../modules/decisionIntelligenceV2/routing/router');
const { retrieveClientSignals } = require('../modules/decisionIntelligenceV2/retrieval/clientSignalsRetrieval');
const { filterListHits } = require('../modules/decisionIntelligenceV2/retrieval/filterListHits');
const { selectRelevantHitsForList } = require('../modules/decisionIntelligenceV2/handlers/topicalCoverage');
const { buildListItems } = require('../modules/decisionIntelligenceV2/handlers/listHandler');

const CLIENT_ID = process.env.DI_CLIENT_ID || 'b61b4d3b-caeb-457b-9971-636c83688ee4';
const INDUSTRY  = process.env.DI_INDUSTRY  || 'Cosmetics';
const QUESTION  = process.argv[2] || 'What clinical trial protocols are mandated for our product category?';

const POLICY_MODULE_ID = '777a2b2e-8bb2-44ef-a4f2-1c0c1e03b960';
const MD_MODULE_ID     = '55c5ee19-bfca-468b-81b3-b89ca4f303c8';
const FO_MODULE_ID     = '2eb989fd-0ea0-4320-b73a-f7eb8b970473';

const MODULE_NAMES = {
  [POLICY_MODULE_ID]: 'Policy',
  [MD_MODULE_ID]:     'MarketDyn',
  [FO_MODULE_ID]:     'ForwardOutlook',
};

async function checkSupabase(articleIds) {
  if (articleIds.length === 0) return new Map();

  const [policy, md, fo] = await Promise.all([
    supabase.from('policy_signals').select('article_id, is_duplicate').in('article_id', articleIds),
    supabase.from('market_dynamics_signals').select('article_id, is_duplicate').in('article_id', articleIds),
    supabase.from('trend_signals').select('article_id, is_duplicate').in('article_id', articleIds),
  ]);

  const map = new Map();
  for (const id of articleIds) map.set(id, { policy: null, md: null, fo: null });

  for (const r of policy.data || []) map.get(r.article_id).policy = r.is_duplicate;
  for (const r of md.data     || []) map.get(r.article_id).md     = r.is_duplicate;
  for (const r of fo.data     || []) map.get(r.article_id).fo     = r.is_duplicate;

  return map;
}

(async () => {
  console.log('\n' + '━'.repeat(100));
  console.log(` Diagnosing: "${QUESTION}"`);
  console.log('━'.repeat(100));

  // 1. Router
  const r = await route(QUESTION, INDUSTRY);
  console.log(`\n[1] ROUTER`);
  console.log(`    type=${r.type} concepts=[${r.concept_keywords.join(', ')}]`);

  // 2. Retrieval
  const retrieval = await retrieveClientSignals(QUESTION, CLIENT_ID, INDUSTRY, {
    precomputedUnderstanding: r,
  });
  console.log(`\n[2] RETRIEVAL — ${retrieval.hits.length} hits`);

  // 3. Concept filter
  const filtered = filterListHits(retrieval.hits, [
    ...(r.concept_keywords || []),
    ...(r.entity_mentions || []),
  ]);
  console.log(`\n[3] FILTERED — ${filtered.length} kept`);

  // 4. Supabase cross-check of filtered hits
  const filteredIds = filtered.map(h => h.article_id).filter(Boolean);
  const dbMap = await checkSupabase(filteredIds);

  console.log(`\n[4] FILTERED HITS — checking Supabase presence`);
  filtered.forEach((h, i) => {
    const id = h.article_id;
    const db = dbMap.get(id) || {};
    const inPolicy = db.policy === false ? 'policy:OK' : db.policy === true ? 'policy:DUP' : '';
    const inMD     = db.md     === false ? 'md:OK'     : db.md     === true ? 'md:DUP'     : '';
    const inFO     = db.fo     === false ? 'fo:OK'     : db.fo     === true ? 'fo:DUP'     : '';
    const tags = [inPolicy, inMD, inFO].filter(Boolean).join(' | ') || '❌ NOT IN ANY TABLE';
    console.log(`    [${String(i + 1).padStart(2)}] mod=${(MODULE_NAMES[h.module_id] || '?').padEnd(14)} article=${id}`);
    console.log(`         title="${h.title.slice(0, 70)}"`);
    console.log(`         supabase: ${tags}`);
  });

  // 5. LLM selection
  const selected = await selectRelevantHitsForList(QUESTION, filtered);
  console.log(`\n[5] LLM SELECTION — ${selected.length} selected`);

  selected.forEach((h, i) => {
    const id = h.article_id;
    const db = dbMap.get(id) || {};
    const inPolicy = db.policy === false ? 'policy:OK' : db.policy === true ? 'policy:DUP' : '';
    const inMD     = db.md     === false ? 'md:OK'     : db.md     === true ? 'md:DUP'     : '';
    const inFO     = db.fo     === false ? 'fo:OK'     : db.fo     === true ? 'fo:DUP'     : '';
    const tags = [inPolicy, inMD, inFO].filter(Boolean).join(' | ') || '❌ NOT IN ANY TABLE';
    console.log(`    [${String(i + 1).padStart(2)}] mod=${(MODULE_NAMES[h.module_id] || '?').padEnd(14)} article=${id}`);
    console.log(`         title="${h.title.slice(0, 70)}"`);
    console.log(`         supabase: ${tags}`);
  });

  // 6. buildListItems
  const listed = await buildListItems(selected);
  console.log(`\n[6] buildListItems — ${listed.items.length} items`);

  if (listed.items.length > 0) {
    listed.items.forEach((it, i) => {
      console.log(`    [${i + 1}] ${it.module} | ${it.title}`);
    });
  } else {
    console.log(`    ⚠️  Zero items produced. The drop-off is inside buildListItems.`);
    console.log(`       Cause: the selected hits' article_ids either don't exist in any`);
    console.log(`       of the three signal tables, OR all matching rows have is_duplicate=true.`);
  }

  console.log('\n' + '━'.repeat(100) + '\n');
})().catch((err) => { console.error('Fatal:', err); process.exit(1); });