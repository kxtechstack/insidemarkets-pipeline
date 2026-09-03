// test-fixes-scale.js
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { QdrantClient } = require('@qdrant/js-client-rest');
const { pipeline } = require('@xenova/transformers');
const { v4: uuidv4 } = require('uuid');
const { enrichOrCreateInsight, findExistingInsight, deleteInsightCentroid } = require('./marketInsights');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const qdrant = new QdrantClient({ url: process.env.QDRANT_URL, apiKey: process.env.QDRANT_API_KEY });

let embedderPromise = null;
const embedText = async (text) => {
  if (!embedderPromise) embedderPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  const embedder = await embedderPromise;
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
};

// ── Isolated test identity — never touches real client data ────────────────
const TEST_CLIENT_ID = uuidv4();
const MODULE_ID = '55c5ee19-bfca-468b-81b3-b89ca4f303c8'; // real Market Dynamics module (global taxonomy, safe to reuse)
const SUBMODULE_ID = '89304c37-09d1-4d85-b6a6-78e3d234b94f'; // real Technology Adoption Signals submodule
const INDUSTRY = 'Cosmetics & Beauty';

// ── 5 event types × 3 orgs = 15 ground-truth clusters ───────────────────────
const EVENT_TYPES = [
  { id: 'ai_partnership', base: (org) => `${org} announces a strategic partnership with a major AI company to bring generative AI tools into its product development and marketing workflows.` },
  { id: 'funding_round', base: (org) => `${org} closes a new funding round led by venture investors to accelerate its beauty technology platform and expand into new markets.` },
  { id: 'store_rollout', base: (org) => `${org} rolls out an AI-powered skin diagnostic tool across thousands of its retail stores after a successful pilot program.` },
  { id: 'sustainable_packaging', base: (org) => `${org} unveils a new sustainable packaging initiative aiming to eliminate single-use plastic across its core product lines by 2030.` },
  { id: 'new_factory', base: (org) => `${org} opens a new manufacturing facility dedicated to producing its skincare and color cosmetics lines with reduced water usage.` },
];

const ORGS = ["L'Oréal", 'Estée Lauder', 'Shiseido'];

// Paraphrase templates — same underlying event, different wording, to
// simulate different publishers covering the same story.
const VARIANT_WRAPPERS = [
  (t) => t,
  (t) => `In a major industry move, ${t}`,
  (t) => `${t} Analysts say this signals a broader shift in the sector.`,
  (t) => `Breaking: ${t}`,
  (t) => `${t} The company says this is part of a multi-year strategic roadmap.`,
  (t) => `Industry sources confirm that ${t}`,
];

const results = { correctMatch: [], correctNoMatch: [], wrongMatch: [], missedMatch: [] };

async function seedCards() {
  console.log(`\nSeeding 15 ground-truth cards under test client ${TEST_CLIENT_ID}...\n`);

  // Need one real signal_id from the global signals table (FK requirement)
  const { data: anySignal } = await supabase
    .schema('admin')
    .from('signals')
    .select('id')
    .eq('module_id', MODULE_ID)
    .limit(1)
    .single();

  if (!anySignal) throw new Error('Could not find any signal row for Market Dynamics module — cannot seed test cards.');
  const signalId = anySignal.id;

  const seeded = {}; // key: `${eventType}|${org}` -> insightId

  for (const eventType of EVENT_TYPES) {
    for (const org of ORGS) {
      const text = eventType.base(org);
      const articleId = uuidv4();

      const result = await enrichOrCreateInsight(
        TEST_CLIENT_ID, MODULE_ID, SUBMODULE_ID, signalId, articleId, text, INDUSTRY, org
      );

      if (result.status === 'error') {
        console.log(`  FAILED to seed ${eventType.id}/${org}: ${result.error}`);
        continue;
      }

      // enrichOrCreateInsight doesn't write market_dynamics_signals itself —
      // that's normally done by the caller (storeRelevantArticle). Do it here
      // so findExistingInsight's org-overlap check has data to check against.
      await supabase.from('market_dynamics_signals').insert({
        article_id: articleId,
        client_id: TEST_CLIENT_ID,
        module_id: MODULE_ID,
        submodule_id: SUBMODULE_ID,
        signal_id: signalId,
        signal_title: text.slice(0, 80),
        summary: text,
        organization: org,
        category: 'Innovation & Product',
        country: 'Global',
        source_url: `https://test.local/${articleId}`,
        published_date: new Date().toISOString(),
        insight_id: result.insightId,
      });

      seeded[`${eventType.id}|${org}`] = result.insightId;
      console.log(`  Seeded ${eventType.id} / ${org} -> card ${result.insightId}`);
    }
  }

  return seeded;
}

async function runQueries(seeded) {
  console.log(`\nRunning ~${EVENT_TYPES.length * ORGS.length * VARIANT_WRAPPERS.length} test queries (read-only, no LLM calls)...\n`);

  for (const eventType of EVENT_TYPES) {
    for (const org of ORGS) {
      const expectedCardId = seeded[`${eventType.id}|${org}`];
      if (!expectedCardId) continue;

      for (const wrap of VARIANT_WRAPPERS) {
        const variantText = wrap(eventType.base(org));
        const embedding = await embedText(variantText.slice(0, 4000));

        // Case: SAME org, SAME topic -> should match expectedCardId
        const matchSame = await findExistingInsight(TEST_CLIENT_ID, MODULE_ID, SUBMODULE_ID, embedding, org);
        logResult('same-org+same-topic', eventType.id, org, org, expectedCardId, matchSame, true);

        // Case: DIFFERENT org, SAME topic -> should NOT match expectedCardId
        const otherOrg = ORGS.find(o => o !== org);
        const matchDiffOrg = await findExistingInsight(TEST_CLIENT_ID, MODULE_ID, SUBMODULE_ID, embedding, otherOrg);
        logResult('diff-org+same-topic', eventType.id, org, otherOrg, expectedCardId, matchDiffOrg, false);
      }
    }

    // Case: SAME org, DIFFERENT topic -> should NOT match this org's OTHER event cards
    const sampleOrg = ORGS[0];
    const otherEventType = EVENT_TYPES.find(e => e.id !== eventType.id);
    const crossTopicText = otherEventType.base(sampleOrg);
    const crossEmbedding = await embedText(crossTopicText.slice(0, 4000));
    const wrongCardForTopic = seeded[`${eventType.id}|${sampleOrg}`];
    const matchCrossTopic = await findExistingInsight(TEST_CLIENT_ID, MODULE_ID, SUBMODULE_ID, crossEmbedding, sampleOrg);
    logResult('same-org+diff-topic', eventType.id, sampleOrg, sampleOrg, wrongCardForTopic, matchCrossTopic, false);
  }
}

function logResult(caseType, eventTypeId, articleOrg, queryOrg, expectedCardId, actualCard, shouldMatch) {
  const matchedExpected = actualCard && actualCard.id === expectedCardId;

  if (shouldMatch && matchedExpected) {
    results.correctMatch.push({ caseType, eventTypeId, articleOrg, queryOrg });
  } else if (!shouldMatch && !matchedExpected) {
    results.correctNoMatch.push({ caseType, eventTypeId, articleOrg, queryOrg });
  } else if (shouldMatch && !matchedExpected) {
    results.missedMatch.push({ caseType, eventTypeId, articleOrg, queryOrg, got: actualCard?.id || 'null' });
  } else {
    results.wrongMatch.push({ caseType, eventTypeId, articleOrg, queryOrg, expectedCardId, gotCardId: actualCard.id });
  }
}

async function cleanup(seeded) {
  console.log('\nCleaning up all test data...\n');
  await supabase.from('market_dynamics_signals').delete().eq('client_id', TEST_CLIENT_ID);
  await supabase.from('market_insight_members').delete().in('insight_id', Object.values(seeded));
  for (const insightId of Object.values(seeded)) {
    await deleteInsightCentroid(insightId);
  }
  await supabase.from('market_insights').delete().eq('client_id', TEST_CLIENT_ID);
  console.log('Cleanup done.');
}

(async () => {
  let seeded = {};
  try {
    seeded = await seedCards();
    await runQueries(seeded);

    const total = results.correctMatch.length + results.correctNoMatch.length + results.wrongMatch.length + results.missedMatch.length;
    console.log('\n========== SUMMARY ==========');
    console.log(`Total queries: ${total}`);
    console.log(`Correct matches (same org+topic merged correctly): ${results.correctMatch.length}`);
    console.log(`Correct rejections (diff org / diff topic kept separate): ${results.correctNoMatch.length}`);
    console.log(`WRONG matches (should NOT have merged): ${results.wrongMatch.length}`);
    console.log(`MISSED matches (should have merged but didn't): ${results.missedMatch.length}`);

    if (results.wrongMatch.length > 0) {
      console.log('\n--- Wrong matches (over-merging — the bug we are fixing) ---');
      console.log(JSON.stringify(results.wrongMatch, null, 2));
    }
    if (results.missedMatch.length > 0) {
      console.log('\n--- Missed matches (under-merging — worth reviewing) ---');
      console.log(JSON.stringify(results.missedMatch, null, 2));
    }

    const accuracy = ((results.correctMatch.length + results.correctNoMatch.length) / total * 100).toFixed(1);
    console.log(`\nOverall accuracy: ${accuracy}%`);

  } catch (err) {
    console.error('\nTest script error:', err);
  } finally {
    if (Object.keys(seeded).length > 0) await cleanup(seeded);
    process.exit(0);
  }
})();