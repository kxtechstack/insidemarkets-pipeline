/**
 * scripts/di-v2-trace.js
 *
 * Full-pipeline tracer. Shows every stage of the V2 pipeline for one question:
 *   1. Router
 *   2. Retrieval (client signals, custom sources only for inference/decision)
 *   2b. Filter — deterministic for list, LLM-based for inference/decision
 *   3. Handler
 *   4. Sources
 *
 *   node scripts\di-v2-trace.js --q "your question"
 *   node scripts\di-v2-trace.js --q "..." --type list|inference|decision
 *
 * Env:
 *   DI_V2_TRACE_VERBOSE=1   print full chunk text (no truncation)
 */

require('dotenv').config();

const { route } = require('../modules/decisionIntelligenceV2/routing/router');
const { retrieveClientSignals } = require('../modules/decisionIntelligenceV2/retrieval/clientSignalsRetrieval');
const { retrieveCustomSourceHits } = require('../modules/decisionIntelligenceV2/retrieval/customSourceRetrieval');
const { filterRelevantChunks } = require('../modules/decisionIntelligenceV2/retrieval/relevanceFilter');
const { filterListHits } = require('../modules/decisionIntelligenceV2/retrieval/filterListHits');
const { buildListItems } = require('../modules/decisionIntelligenceV2/handlers/listHandler');
const { buildInferenceAnswer } = require('../modules/decisionIntelligenceV2/handlers/inferenceHandler');
const { buildDecisionAnswer } = require('../modules/decisionIntelligenceV2/handlers/decisionHandler');

const LINE = '━'.repeat(90);
const SUB  = '─'.repeat(90);

const VERBOSE = process.env.DI_V2_TRACE_VERBOSE === '1';
const CHUNK_LIMIT = VERBOSE ? 5000 : 400;
const MIN_CHUNK_SCORE = 80;

function parseArgs(argv) {
  const args = { question: null, client: null, industry: null, type: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--q')           args.question = next();
    else if (a === '--client') args.client = next();
    else if (a === '--industry') args.industry = next();
    else if (a === '--type')   args.type = next();
  }
  return args;
}

const show = (s, n) => {
  if (!s) return '';
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
};

function stageHeader(n, title) {
  console.log('\n' + LINE);
  console.log(` STAGE ${n} — ${title}`);
  console.log(LINE);
}

function subHeader(title) {
  console.log('\n' + SUB);
  console.log(` ${title}`);
  console.log(SUB);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.question) {
    console.error('Provide --q "<question>"');
    process.exit(1);
  }
  const clientId = args.client || process.env.DI_CLIENT_ID || 'b61b4d3b-caeb-457b-9971-636c83688ee4';
  const industry = args.industry || process.env.DI_INDUSTRY || 'Cosmetics';

  console.log(LINE);
  console.log(' DI V2 — FULL PIPELINE TRACE');
  console.log(LINE);
  console.log(` Q:          ${args.question}`);
  console.log(` clientId:   ${clientId}`);
  console.log(` industry:   ${industry}`);
  console.log(` forcedType: ${args.type || '(auto)'}`);
  console.log(` verbose:    ${VERBOSE ? 'ON' : 'off (set DI_V2_TRACE_VERBOSE=1 for full text)'}`);

  const tTotal = Date.now();

  // ─────────────────────────────────────────────────────────────────────
  stageHeader(1, 'Router');
  const t0 = Date.now();
  let routerResult;
  if (args.type) {
    const valid = ['list', 'inference', 'decision'];
    if (!valid.includes(args.type)) {
      console.error(`Invalid --type "${args.type}". Must be list|inference|decision.`);
      process.exit(1);
    }
    routerResult = {
      intent: 'market_intelligence',
      type: args.type,
      time_constraint: { present: false, value: null, unit: null, phrase: null },
      entity_mentions: [],
      concept_keywords: [],
      is_company_set_query: false,
      primary_intent: args.question,
      _fallback: false,
    };
  } else {
    routerResult = await route(args.question, industry);
  }
  console.log(` intent:          ${routerResult.intent}`);
  console.log(` type:            ${routerResult.type}`);
  console.log(` is_company_set:  ${routerResult.is_company_set_query}`);
  console.log(` entities:        ${routerResult.entity_mentions.length ? routerResult.entity_mentions.join(', ') : '(none)'}`);
  console.log(` concepts:        ${routerResult.concept_keywords.length ? routerResult.concept_keywords.join(' | ') : '(none)'}`);
  if (routerResult.time_constraint?.present) {
    console.log(` time:            ${routerResult.time_constraint.value} ${routerResult.time_constraint.unit} ("${routerResult.time_constraint.phrase}")`);
  } else {
    console.log(` time:            none`);
  }
  console.log(` primary_intent:  ${show(routerResult.primary_intent, 200)}`);
  console.log(` fallback:        ${routerResult._fallback ? '⚠ YES' : 'no'}`);
  console.log(` (${Date.now() - t0}ms)`);

  if (routerResult.intent !== 'market_intelligence') {
    console.log('\n → Non-market-intelligence intent — pipeline short-circuits here.');
    console.log(` → reply would be: ${routerResult.primary_intent}`);
    console.log('\n' + LINE);
    console.log(` TOTAL TIME: ${Date.now() - tTotal}ms`);
    console.log(LINE + '\n');
    return;
  }

  // ─────────────────────────────────────────────────────────────────────
  stageHeader(2, 'Retrieval');

  const t1 = Date.now();
  const clientRetr = await retrieveClientSignals(args.question, clientId, industry, {
    precomputedUnderstanding: routerResult,
  });
  const customHits = routerResult.type === 'list'
    ? []
    : await retrieveCustomSourceHits(args.question, clientId);
  const retrMs = Date.now() - t1;

  console.log(` Client hits: ${clientRetr.hits.length}  (matched ${clientRetr.matchedCount} / un-matched ${clientRetr.unmatchedCount})`);
  console.log(` Custom hits: ${customHits.length}${routerResult.type === 'list' ? ' (list — custom not used)' : ''}`);
  if (clientRetr.timeWindow?.requested !== null) {
    console.log(` Time window: requested=${clientRetr.timeWindow.requested}d applied=${clientRetr.timeWindow.applied ?? 'none'} widened=${clientRetr.timeWindow.widened}`);
  }
  console.log(` (${retrMs}ms)`);

  subHeader(`Client hits (${clientRetr.hits.length})`);
  clientRetr.hits.forEach((h, i) => {
    const tag = h._matched ? '[M]' : '[U]';
    console.log(` [${String(i + 1).padStart(2)}] ${tag} score=${h.score.toFixed(3)} | ${h.module_name} | ${h.title}`);
    const m = h._boost_matched || {};
    if (m.conceptsInTitle?.length || m.entitiesInTitle?.length) {
      const pieces = [];
      if (m.conceptsInTitle?.length) pieces.push(`C=[${m.conceptsInTitle.join(',')}]`);
      if (m.entitiesInTitle?.length) pieces.push(`E=[${m.entitiesInTitle.join(',')}]`);
      console.log(`      boost: ${pieces.join(' ')}`);
    }
    console.log(`      chunk: ${show(h.chunk_text, CHUNK_LIMIT)}`);
    console.log('');
  });

  if (customHits.length > 0) {
    subHeader(`Custom source hits (${customHits.length})`);
    customHits.forEach((c, i) => {
      const p = c.payload || {};
      console.log(` [${String(i + 1).padStart(2)}] score=${c.score.toFixed(3)} | ${p.source_name} | chunk ${p.chunk_index}`);
      console.log(`      chunk: ${show(p.chunk_text, CHUNK_LIMIT)}`);
      console.log('');
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  stageHeader('2b', routerResult.type === 'list'
    ? 'Filter (deterministic — concept in title or body)'
    : 'Filter (LLM — batched relevance audit)');

  const tFilter = Date.now();

  let filterResult;

  if (routerResult.type === 'list') {
    const concepts = routerResult.concept_keywords || [];
    const filtered = filterListHits(clientRetr.hits, concepts);

    filterResult = {
      keptClientHits: filtered,
      keptCustomHits: [],
      verdicts: clientRetr.hits.map((h, i) => {
        const matched = filtered.includes(h);
        return {
          index: i + 1,
          kind: 'client',
          label: `[CLIENT] ${h.title || 'Untitled'}${h.module_name ? ' | ' + h.module_name : ''}`,
          relevant: matched,
          score: matched ? 100 : 0,
          reason: matched ? 'concept matched in title or body' : 'no concept matched',
        };
      }),
      filterRan: true,
    };
  } else {
    filterResult = await filterRelevantChunks(
      args.question,
      clientRetr.hits,
      customHits,
      { minScore: MIN_CHUNK_SCORE }
    );
  }

  const filterMs = Date.now() - tFilter;
  console.log(` filterRan:  ${filterResult.filterRan}`);
  console.log(` kept client: ${filterResult.keptClientHits.length}/${clientRetr.hits.length}`);
  console.log(` kept custom: ${filterResult.keptCustomHits.length}/${customHits.length}`);
  console.log(` (${filterMs}ms)`);

  subHeader('Verdicts');
  if (filterResult.verdicts.length === 0) {
    console.log(' (no verdicts)');
  } else {
    filterResult.verdicts.forEach((v) => {
      const flag = v.relevant ? '✓ KEEP' : '✗ DROP';
      console.log(` [${String(v.index).padStart(2)}] ${flag}  score=${v.score ?? '?'}  | ${v.kind} | ${v.label}`);
      if (v.reason) console.log(`      reason: ${v.reason}`);
    });
  }

  const filteredClient = filterResult.keptClientHits;
  const filteredCustom = filterResult.keptCustomHits;
  const hasMaterial = filteredClient.length + filteredCustom.length > 0;

  // ─────────────────────────────────────────────────────────────────────
  stageHeader(3, 'Handler');
  console.log(` Input: client=${filteredClient.length}, custom=${filteredCustom.length} (hasMaterial=${hasMaterial})`);

  let handlerResult;

  if (!hasMaterial) {
    console.log(`\n → No chunks passed the filter.`);
    console.log(` → Real V2 route would return no-data for this question.`);
    console.log('\n' + LINE);
    console.log(` TOTAL TIME: ${Date.now() - tTotal}ms`);
    console.log(LINE + '\n');
    return;
  }

  if (routerResult.type === 'list') {
    const t2 = Date.now();
    handlerResult = await buildListItems(filteredClient);
    console.log(` items:          ${handlerResult.items.length}`);
    console.log(` matched:        ${handlerResult.matchedCount}`);
    console.log(` un-matched:     ${handlerResult.unmatchedCount}`);
    console.log(` (${Date.now() - t2}ms)`);

    subHeader('Items');
    handlerResult.items.forEach((it, i) => {
      console.log(` [${String(i + 1).padStart(2)}] ${it.matched ? '[M]' : '[U]'} ${it.module} | ${it.title}`);
      console.log(`      ${show(it.summary, CHUNK_LIMIT)}`);
      if (it.parentLabel) console.log(`      ${it.parentLabel}`);
      console.log('');
    });

  } else if (routerResult.type === 'inference') {
    const t2 = Date.now();
    handlerResult = await buildInferenceAnswer(args.question, filteredClient, filteredCustom);
    console.log(` empty:          ${handlerResult._empty ? 'yes' : 'no'}`);
    if (handlerResult._empty) {
      console.log(` reason:         ${handlerResult._reason}`);
    } else {
      console.log(` title:          ${handlerResult.report.title}`);
      console.log(` bodyText (${handlerResult.report.bodyText.length} chars):`);
      console.log(SUB);
      console.log(handlerResult.report.bodyText);
      console.log(SUB);
      console.log(` sources:        ${handlerResult.sources.length}`);
    }
    console.log(` (${Date.now() - t2}ms)`);

  } else if (routerResult.type === 'decision') {
    const t2 = Date.now();
    handlerResult = await buildDecisionAnswer(args.question, filteredClient, filteredCustom);
    console.log(` empty:          ${handlerResult._empty ? 'yes' : 'no'}`);
    if (handlerResult._empty) {
      console.log(` reason:         ${handlerResult._reason}`);
    } else {
      console.log(` title:          ${handlerResult.report.title}`);
      console.log(` sections:       ${handlerResult.report.sections.length}`);
      console.log(SUB);
      handlerResult.report.sections.forEach((s) => {
        console.log(` ▸ ${s.heading}`);
        (s.points || []).forEach((p) => console.log(`     • ${p}`));
        console.log('');
      });
      if (handlerResult.report.bottom_line) {
        console.log(` Bottom line: ${handlerResult.report.bottom_line}`);
      }
      console.log(SUB);
      console.log(` sources:        ${handlerResult.sources.length}`);
    }
    console.log(` (${Date.now() - t2}ms)`);
  }

  // ─────────────────────────────────────────────────────────────────────
  stageHeader(4, 'Sources cited');
  if (handlerResult && handlerResult.sources && handlerResult.sources.length > 0) {
    handlerResult.sources.forEach((s, i) => {
      if (s.type === 'client') {
        console.log(` [${String(i + 1).padStart(2)}] CLIENT | ${s.module} | ${s.title}`);
      } else if (s.type === 'custom_source') {
        console.log(` [${String(i + 1).padStart(2)}] CUSTOM | ${s.source_name} | chunk ${s.chunk_index}`);
      } else {
        console.log(` [${String(i + 1).padStart(2)}] ${s.type} | ${s.title || s.source_name}`);
      }
    });
  } else {
    console.log(' (no sources cited — normal for list responses)');
  }

  console.log('\n' + LINE);
  console.log(` TOTAL TIME: ${Date.now() - tTotal}ms`);
  console.log(LINE + '\n');
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });