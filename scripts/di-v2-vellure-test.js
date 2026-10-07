/**
 * scripts/di-v2-vellure-test.js
 *
 * Full-pipeline verification against the Vellure Cosmetics client.
 * All three question types use the deterministic concept filter now.
 * No LLM filter.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { route } = require('../modules/decisionIntelligenceV2/routing/router');
const { retrieveClientSignals } = require('../modules/decisionIntelligenceV2/retrieval/clientSignalsRetrieval');
const { retrieveCustomSourceHits } = require('../modules/decisionIntelligenceV2/retrieval/customSourceRetrieval');
const { filterListHits, normalizeConcepts, containsPhrase } = require('../modules/decisionIntelligenceV2/retrieval/filterListHits');
const { buildListItems } = require('../modules/decisionIntelligenceV2/handlers/listHandler');
const { buildInferenceAnswer } = require('../modules/decisionIntelligenceV2/handlers/inferenceHandler');
const { buildDecisionAnswer } = require('../modules/decisionIntelligenceV2/handlers/decisionHandler');

const LINE = '━'.repeat(100);
const SUB  = '─'.repeat(100);

const VERBOSE = process.env.DI_V2_TRACE_VERBOSE === '1';
const CHUNK_PREVIEW = VERBOSE ? 3000 : 300;

const short = (s, n) => {
  if (!s) return '';
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
};

// Deterministic filter for inference/decision — mirrors route.js
function filterForInferenceOrDecision(clientHits, concepts) {
  const clean = normalizeConcepts(concepts);
  if (clean.length === 0) return clientHits;
  return clientHits.filter((h) => {
    const haystack = `${h.title || ''} ${h.chunk_text || ''}`;
    return clean.some((c) => containsPhrase(haystack, c));
  });
}

async function runOne(q, clientId, industry) {
  const { id, question, type: expectedType, expectTopic } = q;

  console.log('\n' + LINE);
  console.log(` [${id}] ${question}`);
  console.log(`  expected type: ${expectedType} | expected topic: ${expectTopic || 'n/a'}`);
  console.log(LINE);

  const t0 = Date.now();
  const routerResult = await route(question, industry);
  console.log(`\n ROUTER (${Date.now() - t0}ms):`);
  console.log(`   intent:    ${routerResult.intent}`);
  console.log(`   type:      ${routerResult.type}`);
  console.log(`   concepts:  [${(routerResult.concept_keywords || []).join(', ')}]`);
  console.log(`   entities:  [${(routerResult.entity_mentions || []).join(', ')}]`);
  console.log(`   time:      ${routerResult.time_constraint?.present ? routerResult.time_constraint.value + ' ' + routerResult.time_constraint.unit : 'none'}`);

  if (routerResult.intent !== 'market_intelligence') {
    console.log(`\n → SHORT-CIRCUIT: ${routerResult.primary_intent}`);
    return { id, type: routerResult.intent, retrieved: 0, filtered: 0, result: 'short-circuit' };
  }

  const t1 = Date.now();
  const clientRetr = await retrieveClientSignals(question, clientId, industry, {
    precomputedUnderstanding: routerResult,
  });
  const customHits = routerResult.type === 'list'
    ? []
    : await retrieveCustomSourceHits(question, clientId);
  console.log(`\n RETRIEVAL (${Date.now() - t1}ms):`);
  console.log(`   client hits: ${clientRetr.hits.length} (matched ${clientRetr.matchedCount}, un-matched ${clientRetr.unmatchedCount})`);
  console.log(`   custom hits: ${customHits.length}${routerResult.type === 'list' ? ' (list — custom not used)' : ''}`);

  console.log(`\n   CLIENT HITS:`);
  clientRetr.hits.slice(0, 10).forEach((h, i) => {
    const m = h._matched ? 'M' : 'U';
    console.log(`   [${String(i + 1).padStart(2)}] [${m}] ${h.score.toFixed(3)} | ${h.module_name} | ${short(h.title, 90)}`);
    console.log(`        ${short(h.chunk_text, CHUNK_PREVIEW)}`);
  });

  if (customHits.length > 0) {
    console.log(`\n   CUSTOM HITS:`);
    customHits.slice(0, 8).forEach((c, i) => {
      const p = c.payload || {};
      console.log(`   [${String(i + 1).padStart(2)}] ${c.score.toFixed(3)} | ${short(p.source_name, 40)} | chunk ${p.chunk_index}`);
      console.log(`        ${short(p.chunk_text, CHUNK_PREVIEW)}`);
    });
  }

  // ── Filter ──────────────────────────────────────────────────────────
  const t2 = Date.now();
  const conceptsForFilter = [
    ...(routerResult.concept_keywords || []),
    ...(routerResult.entity_mentions || []),
  ];

  let keptClient, keptCustom;
  if (routerResult.type === 'list') {
    keptClient = filterListHits(clientRetr.hits, conceptsForFilter);
    keptCustom = [];
  } else {
    keptClient = filterForInferenceOrDecision(clientRetr.hits, conceptsForFilter);
    keptCustom = customHits;
  }

  console.log(`\n FILTER (${Date.now() - t2}ms):`);
  console.log(`   kept client: ${keptClient.length}/${clientRetr.hits.length}`);
  console.log(`   kept custom: ${keptCustom.length}/${customHits.length}`);

  console.log(`\n   VERDICTS (client):`);
  clientRetr.hits.forEach((h, i) => {
    const kept = keptClient.includes(h);
    const flag = kept ? '✓ KEEP' : '✗ DROP';
    console.log(`   [${String(i + 1).padStart(2)}] ${flag} | ${short(h.title, 80)}`);
  });

  const hasMaterial = keptClient.length + keptCustom.length > 0;

  const t3 = Date.now();
  let summary = {
    id,
    type: routerResult.type,
    retrieved: clientRetr.hits.length,
    filtered: keptClient.length + keptCustom.length,
    result: '',
  };

  if (!hasMaterial) {
    console.log(`\n HANDLER: no material — no-data`);
    summary.result = 'no-data';
    return summary;
  }

  if (routerResult.type === 'list') {
    const handlerResult = await buildListItems(keptClient);
    console.log(`\n HANDLER (${Date.now() - t3}ms): list — ${handlerResult.items.length} items`);
    handlerResult.items.forEach((it, i) => {
      console.log(`   [${String(i + 1).padStart(2)}] ${it.module} | ${short(it.title, 90)}`);
      console.log(`        ${short(it.summary, CHUNK_PREVIEW)}`);
    });
    summary.result = `list:${handlerResult.items.length}`;
  } else if (routerResult.type === 'inference') {
    const handlerResult = await buildInferenceAnswer(question, keptClient, keptCustom);
    if (handlerResult._empty) {
      console.log(`\n HANDLER: inference empty — ${handlerResult._reason}`);
      summary.result = 'inference-empty';
    } else {
      console.log(`\n HANDLER (${Date.now() - t3}ms): inference`);
      console.log(`   title: ${handlerResult.report.title}`);
      console.log(`   body (${handlerResult.report.bodyText.length} chars): ${short(handlerResult.report.bodyText, 400)}`);
      console.log(`   sources: ${handlerResult.sources.length}`);
      summary.result = `inference:${handlerResult.sources.length}src`;
    }
  } else if (routerResult.type === 'decision') {
    const handlerResult = await buildDecisionAnswer(question, keptClient, keptCustom);
    if (handlerResult._empty) {
      console.log(`\n HANDLER: decision empty — ${handlerResult._reason}`);
      summary.result = 'decision-empty';
    } else {
      console.log(`\n HANDLER (${Date.now() - t3}ms): decision`);
      console.log(`   title: ${handlerResult.report.title}`);
      console.log(`   sections: ${handlerResult.report.sections.length}`);
      handlerResult.report.sections.forEach((s) => {
        console.log(`   ▸ ${s.heading} (${s.points.length} points)`);
      });
      summary.result = `decision:${handlerResult.report.sections.length}sec`;
    }
  }

  return summary;
}

async function main() {
  const path_ = path.resolve(process.cwd(), 'scripts/vellure-test-questions.json');
  const config = JSON.parse(fs.readFileSync(path_, 'utf8'));

  const clientId = config.clientId;
  const industry = config.industry;
  const questions = config.questions;

  console.log(LINE);
  console.log(' DI V2 — VELLURE COSMETICS TEST SUITE');
  console.log(LINE);
  console.log(` clientId:  ${clientId}`);
  console.log(` industry:  ${industry}`);
  console.log(` questions: ${questions.length}`);

  const summaries = [];
  for (const q of questions) {
    try {
      const r = await runOne(q, clientId, industry);
      summaries.push(r);
    } catch (err) {
      console.log(`\n ❌ ERROR: ${err.message}`);
      summaries.push({ id: q.id, type: q.type, result: 'error', error: err.message });
    }
  }

  console.log('\n\n' + LINE);
  console.log(' SUMMARY');
  console.log(LINE);
  summaries.forEach((s) => {
    const line = ` [${s.id.padEnd(4)}] ${(s.type || '?').padEnd(15)} | retrieved=${String(s.retrieved ?? '-').padStart(3)} | filtered=${String(s.filtered ?? '-').padStart(3)} | ${s.result}`;
    console.log(line);
  });
  console.log(LINE);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });