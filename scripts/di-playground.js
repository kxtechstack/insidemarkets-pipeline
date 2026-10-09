/**
 * scripts/di-playground.js
 *
 * Full-flow narrative trace of the V2 Decision Intelligence pipeline.
 *   - Prints every stage in detail (router, resolver, SEC, retrieval,
 *     filter, custom, handler) so you can see exactly what happened.
 *   - Also calls the REAL runV2Pipeline so the confidence gate runs
 *     and its logs appear, exactly like production.
 *
 * Usage:
 *   node scripts/di-playground.js "your question"
 *   node scripts/di-playground.js                (interactive REPL)
 *
 * Optional:
 *   DI_TRACE_CONVERSATION_ID=<uuid>   use a real conversation for chatContext
 */

require('dotenv').config();
const readline = require('readline');

const CLIENT_ID = process.env.DI_CLIENT_ID || 'b61b4d3b-caeb-457b-9971-636c83688ee4';
const INDUSTRY  = process.env.DI_INDUSTRY  || 'Cosmetics';
const USER_ID   = process.env.DI_USER_ID   || '6e19245e-a79f-4d68-917d-df179a521780';
const CONVERSATION_ID = process.env.DI_TRACE_CONVERSATION_ID || null;

const HR = '━'.repeat(78);
const SR = '─'.repeat(78);

function hr(title) { console.log('\n' + HR); if (title) console.log(' ' + title); console.log(HR); }
function stage(n, total, title) {
  console.log('\n' + SR);
  console.log(` [${n}/${total}] ${title}`);
  console.log(SR);
}
function sub(title) { console.log(`\n  ▸ ${title}`); }

// ── Lazy module loading ────────────────────────────────────────────────
let mods = null;
async function load() {
  if (mods) return mods;
  console.log('[init] loading modules...');
  const t0 = Date.now();
  mods = {
    route:          require('../modules/decisionIntelligenceV2/routing/router').route,
    resolveContext: require('../modules/decisionIntelligenceV2/chatContext/contextResolver').resolveContext,
    loadState:      require('../modules/decisionIntelligenceV2/chatContext/stateStore').loadState,
    updateState:    require('../modules/decisionIntelligenceV2/chatContext/stateUpdater').updateState,
    buildSecAnswer: require('../modules/decisionIntelligenceV2/handlers/secHandler').buildSecAnswer,
    retrieveClient: require('../modules/decisionIntelligenceV2/retrieval/clientSignalsRetrieval').retrieveClientSignals,
    retrieveCustom: require('../modules/decisionIntelligenceV2/retrieval/customSourceRetrieval').retrieveCustomSourceHits,
    normalizeConcepts: require('../modules/decisionIntelligenceV2/retrieval/filterListHits').normalizeConcepts,
    buildDecision:  require('../modules/decisionIntelligenceV2/handlers/decisionHandler').buildDecisionAnswer,
    buildInference: require('../modules/decisionIntelligenceV2/handlers/inferenceHandler').buildInferenceAnswer,
    buildListItems: require('../modules/decisionIntelligenceV2/handlers/listHandler').buildListItems,
    evaluateConfidence: require('../modules/decisionIntelligenceV2/handlers/confidenceGate').evaluateConfidence,
    runV2Pipeline:  require('../modules/decisionIntelligenceV2/route').runV2Pipeline,
  };
  console.log(`[init] loaded in ${Date.now() - t0}ms\n`);
  return mods;
}

// ── Helpers ────────────────────────────────────────────────────────────
function distribution(scores) {
  const buckets = [
    { label: '≥ 0.70',    min: 0.70,             count: 0 },
    { label: '0.55-0.69', min: 0.55, max: 0.6999, count: 0 },
    { label: '0.40-0.54', min: 0.40, max: 0.5499, count: 0 },
    { label: '0.30-0.39', min: 0.30, max: 0.3999, count: 0 },
    { label: '0.20-0.29', min: 0.20, max: 0.2999, count: 0 },
    { label: '< 0.20',                    max: 0.1999, count: 0 },
  ];
  for (const s of scores) {
    for (const b of buckets) {
      const above = b.min === undefined || s >= b.min;
      const below = b.max === undefined || s <= b.max;
      if (above && below) { b.count++; break; }
    }
  }
  for (const b of buckets) {
    console.log(`      ${b.label.padEnd(11)} : ${String(b.count).padStart(3)} hits`);
  }
}

function conceptPasses(haystack, concept) {
  const variants = [concept];
  if (!concept.includes(' ')) {
    variants.push(concept + 's');
    if (concept.endsWith('y') && concept.length > 2) variants.push(concept.slice(0, -1) + 'ies');
  }
  return variants.some(v => new RegExp(
    `(?:^|[^a-z0-9])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`, 'i'
  ).test(haystack));
}

// ── The trace ──────────────────────────────────────────────────────────
async function trace(question) {
  const m = await load();
  const startedAt = Date.now();
  const timings = {};
  const TOTAL_STAGES = 10;

  hr(`QUESTION: ${question}`);
  console.log(`clientId:  ${CLIENT_ID}`);
  console.log(`industry:  ${INDUSTRY}`);
  if (CONVERSATION_ID) console.log(`conversationId: ${CONVERSATION_ID}`);
  else console.log(`conversationId: (fresh — no chatContext persistence)`);

  let currentState = {};
  if (CONVERSATION_ID) {
    try { currentState = await m.loadState(CONVERSATION_ID); } catch {}
    sub('Prior conversation state (loaded from DB)');
    console.log(JSON.stringify(currentState, null, 2));
  }

  // ── STAGE 1 — Router ────────────────────────────────────────────────
  stage(1, TOTAL_STAGES, 'Reading the question — Router (routing/router.js)');
  console.log('  Sending the question to the router LLM...');
  let t = Date.now();
  let routerResult;
  try {
    routerResult = await m.route(question, INDUSTRY);
  } catch (err) {
    console.log(`  ❌ Router threw: ${err.message}`);
    hr('ABORTED');
    return;
  }
  timings.router = Date.now() - t;
  console.log(`  Took: ${timings.router}ms`);
  console.log('  Router returned:');
  console.log(`    intent:               ${routerResult.intent}`);
  console.log(`    type:                 ${routerResult.type}`);
  console.log(`    entity_mentions:      [${(routerResult.entity_mentions || []).join(', ')}]`);
  console.log(`    concept_keywords:     [${(routerResult.concept_keywords || []).join(', ')}]`);
  console.log(`    sector_term:          ${routerResult.sector_term ?? 'null'}`);
  console.log(`    is_company_set_query: ${routerResult.is_company_set_query}`);
  console.log(`    time_constraint:      ${JSON.stringify(routerResult.time_constraint)}`);
  console.log(`    primary_intent:       ${String(routerResult.primary_intent || '').slice(0, 120)}`);

  if (routerResult.intent !== 'market_intelligence') {
    console.log(`\n  → Not a business question. Kind = ${routerResult.intent}.`);
    console.log(`  → Pipeline short-circuits here.`);
    hr(`DONE in ${Date.now() - startedAt}ms`);
    return;
  }

  // ── STAGE 2 — Context Resolver ──────────────────────────────────────
  stage(2, TOTAL_STAGES, 'Resolving context — chatContext (contextResolver.js)');
  console.log('  Looking at: recent messages + current state + new message');
  console.log('  Sending to the resolver LLM...');
  t = Date.now();
  let resolverResult;
  try {
    resolverResult = await m.resolveContext({
      conversationId: CONVERSATION_ID,
      userMessage: question,
      currentState,
    });
  } catch (err) {
    console.log(`  ❌ Resolver threw: ${err.message} — using raw question`);
    resolverResult = { kind: 'new_question', standalone_query: question,
                       references: [], context_used: [], new_constraints: [] };
  }
  timings.resolver = Date.now() - t;
  console.log(`  Took: ${timings.resolver}ms`);
  console.log('  Resolver returned:');
  console.log(`    kind:              ${resolverResult.kind}`);
  console.log(`    standalone_query:  ${resolverResult.standalone_query}`);
  console.log(`    references:        ${JSON.stringify(resolverResult.references)}`);
  console.log(`    context_used:      ${JSON.stringify(resolverResult.context_used)}`);
  console.log(`    new_constraints:   ${JSON.stringify(resolverResult.new_constraints)}`);

  const skipUpdater = ['greeting','off_topic','clarification'].includes(resolverResult.kind);
  const queryForPipeline = skipUpdater ? question : resolverResult.standalone_query;
  console.log(`  → Small-talk? ${skipUpdater ? 'YES' : 'no'}`);
  console.log(`  → Query passed to pipeline: "${queryForPipeline}"`);

  // ── STAGE 3 — SEC Sidecar ───────────────────────────────────────────
  stage(3, TOTAL_STAGES, 'Checking SEC sidecar (handlers/secHandler.js)');
  console.log('  Looking for: named public companies + metrics in the question');
  t = Date.now();
  let secResult = null;
  try {
    secResult = await m.buildSecAnswer({
      question: queryForPipeline,
      routerResult,
      clientId: CLIENT_ID,
      industry: INDUSTRY,
    });
  } catch (err) {
    console.log(`  ❌ SEC handler threw: ${err.message}`);
  }
  timings.sec = Date.now() - t;
  console.log(`  Took: ${timings.sec}ms`);

  if (!secResult) {
    console.log('  Result: NOT SEC-shaped (no tickers, no sector, or falls through)');
    console.log('  → Continues to V2 retrieval.');
  } else if (secResult.mode === 'numeric') {
    console.log('  Result: NUMERIC — SEC fired');
    console.log(`    facts:  ${secResult.payload?.sources?.length || 0}`);
    console.log(`    chart:  ${secResult.payload?.chart ? 'yes' : 'no'}`);
    console.log('  → SEC short-circuits. Returns directly.');
    stage('FINAL', TOTAL_STAGES, 'SEC numeric answer');
    console.log(JSON.stringify(secResult.payload, null, 2).slice(0, 3000));
    hr(`DONE in ${Date.now() - startedAt}ms`);
    return;
  } else if (secResult.mode === 'framework') {
    console.log('  Result: FRAMEWORK — SEC will inject narrative chunks');
    console.log(`    chunks injected: ${secResult.injectChunks?.length || 0}`);
  } else if (secResult.mode === 'region_fallback') {
    console.log('  Result: REGION FALLBACK');
    console.log(`    payload.type: ${secResult.payload?.type}`);
    console.log('  → SEC short-circuits. Returns directly.');
    stage('FINAL', TOTAL_STAGES, 'SEC region fallback answer');
    console.log(JSON.stringify(secResult.payload, null, 2).slice(0, 3000));
    hr(`DONE in ${Date.now() - startedAt}ms`);
    return;
  }

  const secInjectChunks = (secResult?.mode === 'framework' && Array.isArray(secResult.injectChunks))
    ? secResult.injectChunks : [];

  // ── STAGE 4 — Client Retrieval ──────────────────────────────────────
  stage(4, TOTAL_STAGES, 'Retrieving client signals (retrieval/clientSignalsRetrieval.js)');

  const VECTOR_FLOOR = Number(process.env.DI_VECTOR_SCORE_FLOOR) || 0.20;
  const FINAL_FLOOR  = Number(process.env.DI_SCORE_FLOOR)        || 0.20;
  console.log(`  Vector score floor:   ${VECTOR_FLOOR}`);
  console.log(`  Final score floor:    ${FINAL_FLOOR}`);

  t = Date.now();
  let clientRetr = { hits: [], matchedCount: 0, unmatchedCount: 0 };
  try {
    clientRetr = await m.retrieveClient(queryForPipeline, CLIENT_ID, INDUSTRY, {
      precomputedUnderstanding: routerResult,
    });
  } catch (err) {
    console.log(`  ❌ Retrieval threw: ${err.message}`);
  }
  timings.retrieval = Date.now() - t;
  console.log(`  Took: ${timings.retrieval}ms`);

  const hits = clientRetr.hits || [];
  console.log(`  Hits returned by retrieval:  ${hits.length}`);
  console.log(`    matched:   ${clientRetr.matchedCount}`);
  console.log(`    unmatched: ${clientRetr.unmatchedCount}`);

  if (hits.length > 0) {
    sub('Score distribution of final hits');
    distribution(hits.map(h => h.score || 0));
    sub('Top 20 hits with scores');
    hits.slice(0, 20).forEach((h, i) => {
      const title = (h.title || 'Untitled').slice(0, 65);
      const module = h.module_name || '?';
      const matched = h._matched ? '✓' : ' ';
      console.log(`    [${String(i + 1).padStart(2)}] ${(h.score || 0).toFixed(3)} ${matched} [${module}] ${title}`);
    });
    if (hits.length > 20) console.log(`    ... +${hits.length - 20} more`);

    const maxScore = Math.max(...hits.map(h => h.score || 0));
    sub('Analysis');
    console.log(`    MAX SCORE: ${maxScore.toFixed(3)}`);
    if (maxScore >= 0.70) console.log('    → Strong relevance.');
    else if (maxScore >= 0.55) console.log('    → Moderate relevance.');
    else if (maxScore >= 0.40) console.log('    → Weak relevance. Hits are tangential at best.');
    else console.log('    → VERY WEAK. No hit is meaningfully related to the question.');
  }

  // ── STAGE 5 — Concept Filter ────────────────────────────────────────
  stage(5, TOTAL_STAGES, 'Filtering hits by concept (retrieval/filterListHits.js)');

  const conceptsInput = [
    ...(routerResult.concept_keywords || []),
    ...(routerResult.entity_mentions || []),
  ];
  console.log(`  Concepts to match (from router): [${conceptsInput.join(', ')}]`);

  let cleanConcepts = [];
  try { cleanConcepts = m.normalizeConcepts(conceptsInput); } catch {}
  console.log(`  After normalizeConcepts: [${cleanConcepts.join(', ')}]`);

  const isFrameworkQ = /\b(swot|pestle|pestel|five\s*forces|5\s*forces|porter|risk\s*analysis|risk\s*categor)/i.test(queryForPipeline);
  console.log(`  Is framework question? ${isFrameworkQ ? 'YES (filter skipped)' : 'no'}`);

  let keptClient = [];
  let droppedHits = [];
  if (isFrameworkQ) {
    keptClient = hits;
    console.log(`  → Framework — keeping all ${hits.length} hits.`);
  } else if (cleanConcepts.length === 0) {
    keptClient = hits;
    console.log(`  → No concepts to filter on — keeping all ${hits.length} hits.`);
  } else {
    for (const h of hits) {
      const haystack = `${h.title || ''} ${h.chunk_text || ''}`;
      const matchedConcept = cleanConcepts.find(c => conceptPasses(haystack, c));
      if (matchedConcept) keptClient.push({ ...h, _matchedConcept: matchedConcept });
      else droppedHits.push(h);
    }
    console.log(`  Hits kept:    ${keptClient.length} / ${hits.length}`);
    console.log(`  Hits dropped: ${droppedHits.length}`);

    sub('Kept hits — which concept matched');
    keptClient.slice(0, 20).forEach((h, i) => {
      console.log(`    [${i + 1}] "${h._matchedConcept}" matched → ${(h.title || '').slice(0, 60)}`);
    });
    if (keptClient.length > 20) console.log(`    ... +${keptClient.length - 20} more`);

    if (droppedHits.length > 0 && droppedHits.length <= 10) {
      sub('Dropped hits — no concept match');
      droppedHits.forEach((h) => {
        console.log(`    ✗ ${(h.title || '').slice(0, 65)}`);
      });
    }
  }

  // ── STAGE 6 — Custom Source Retrieval ───────────────────────────────
  stage(6, TOTAL_STAGES, 'Retrieving custom source documents (customSourceRetrieval.js)');

  const CUSTOM_FLOOR = Number(process.env.CUSTOM_SOURCE_SCORE_FLOOR) || 0.28;
  const CUSTOM_TOP_K = Number(process.env.CUSTOM_SOURCE_TOP_K) || 5;
  console.log(`  Score floor: ${CUSTOM_FLOOR}`);
  console.log(`  Top K:       ${CUSTOM_TOP_K}`);

  t = Date.now();
  let customHits = [];
  try {
    customHits = await m.retrieveCustom(queryForPipeline, CLIENT_ID);
  } catch (err) {
    console.log(`  ❌ Custom retrieval threw: ${err.message}`);
  }
  timings.custom = Date.now() - t;
  console.log(`  Took: ${timings.custom}ms`);
  console.log(`  Hits after floor: ${customHits.length}`);
  customHits.forEach((c, i) => {
    const name = c.payload?.source_name || c.payload?.title || 'Uploaded document';
    console.log(`    [${i + 1}] ${(c.score || 0).toFixed(3)}  ${name}`);
  });

  // ── STAGE 7 — Confidence Gate (preview) ────────────────────────────
  stage(7, TOTAL_STAGES, 'Confidence gate preview (handlers/confidenceGate.js)');
  const keptClientWithSec = secInjectChunks.length
    ? [...secInjectChunks, ...keptClient]
    : keptClient;
  const hasMaterial = (routerResult.type === 'decision'
    ? keptClientWithSec.length + customHits.length
    : keptClient.length + customHits.length) > 0;

  console.log(`  secInjectChunks: ${secInjectChunks.length}`);
  console.log(`  hasMaterial:     ${hasMaterial}`);

  if (hasMaterial && secInjectChunks.length === 0) {
    const gate = m.evaluateConfidence({
      clientHits: keptClient,
      customHits,
      routerResult,
    });
    console.log(`  gate.pass:   ${gate.pass}`);
    console.log(`  gate.reason: ${gate.reason}`);
    console.log(`    [client] ${JSON.stringify(gate.client)}`);
    console.log(`    [custom] ${JSON.stringify(gate.custom)}`);
  } else if (secInjectChunks.length > 0) {
    console.log(`  → Skipped (SEC framework chunks present — SEC authority overrides)`);
  } else {
    console.log(`  → Skipped (no material — handler would return no_data anyway)`);
  }

  // ── STAGE 8 — Handler (manual) ─────────────────────────────────────
  stage(8, TOTAL_STAGES, `Handler preview (${routerResult.type}) — manual call (bypasses gate)`);

  t = Date.now();
  let handlerResult;
  if (routerResult.type === 'list') {
    try {
      handlerResult = await m.buildListItems(keptClient);
      timings.handler = Date.now() - t;
      console.log(`  items: ${handlerResult.items?.length || 0}`);
    } catch (err) {
      console.log(`  ❌ List handler threw: ${err.message}`);
      handlerResult = { items: [] };
    }
  } else if (routerResult.type === 'inference') {
    try {
      handlerResult = await m.buildInference(queryForPipeline, keptClient, customHits);
      timings.handler = Date.now() - t;
    } catch (err) {
      console.log(`  ❌ Inference handler threw: ${err.message}`);
      handlerResult = { report: null, sources: [], _empty: true, _reason: err.message };
    }
  } else {
    try {
      handlerResult = await m.buildDecision(queryForPipeline, keptClientWithSec, customHits);
      timings.handler = Date.now() - t;
    } catch (err) {
      console.log(`  ❌ Decision handler threw: ${err.message}`);
      handlerResult = { report: null, sources: [], _empty: true, _reason: err.message };
    }
  }
  console.log(`  Took: ${timings.handler}ms`);

  const report = handlerResult?.report;
  if (report && Array.isArray(report.sections)) {
    sub('Schema designer produced these headings');
    report.sections.forEach((s, i) => console.log(`    ${i + 1}. ${s.heading}`));
    sub('Writer produced these bullets');
    report.sections.forEach((s, i) => {
      console.log(`\n    ${i + 1}. ${s.heading}`);
      (s.points || []).forEach(p => console.log(`       - ${String(p).slice(0, 150)}`));
    });
    if (report.bottom_line) console.log(`\n  bottom_line: ${String(report.bottom_line).slice(0, 300)}`);
  } else if (report && report.bodyText) {
    sub('Writer produced (legacy shape)');
    console.log(`    ${String(report.bodyText).slice(0, 500)}...`);
  } else if (handlerResult?._empty) {
    sub('Handler returned EMPTY');
    console.log(`    reason: ${handlerResult._reason || '(none)'}`);
  }

  // ── STAGE 9 — REAL runV2Pipeline ────────────────────────────────────
  stage(9, TOTAL_STAGES, 'REAL runV2Pipeline — same call the HTTP route makes');
  console.log('  This is what actually runs in production.');
  console.log('  Watch for: [V2 route] confidence gate BLOCKED/PASSED');
  console.log('  ⬇ Pipeline logs below.\n');
  console.log(SR);

  t = Date.now();
  let realResult;
  try {
    realResult = await m.runV2Pipeline({
      question: queryForPipeline,
      clientId: CLIENT_ID,
      industry: INDUSTRY,
      forcedType: null,
    });
  } catch (err) {
    console.log(`\n  ❌ runV2Pipeline threw: ${err.message}`);
    console.log(err.stack);
    realResult = null;
  }
  timings.realPipeline = Date.now() - t;

  console.log(SR);
  console.log(`  ⬆ Pipeline logs ended. Took: ${timings.realPipeline}ms\n`);

  if (realResult) {
    sub('Real pipeline final payload');
    const p = realResult.payload;
    console.log(`    type:      ${p.type}`);
    console.log(`    no_data:   ${p.no_data ? 'YES' : 'no'}`);
    console.log(`    report:    ${p.report ? 'yes' : 'no'}`);
    if (p.message) console.log(`    message:   ${String(p.message).slice(0, 200)}`);
    if (p.report?.title) console.log(`    title:     ${p.report.title}`);
    if (p.report?.sections) console.log(`    sections:  ${p.report.sections.length}`);
    if (p.sources?.length) console.log(`    sources:   ${p.sources.length}`);
  }

  // ── STAGE 10 — State Updater ────────────────────────────────────────
  stage(10, TOTAL_STAGES, 'State updater (chatContext — only if conversationId is set)');

  if (skipUpdater) {
    console.log(`  Skipped — resolver kind was "${resolverResult.kind}" (small talk).`);
  } else if (!CONVERSATION_ID) {
    console.log(`  Skipped — no CONVERSATION_ID set.`);
    console.log(`  To test: run with DI_TRACE_CONVERSATION_ID=<uuid>`);
  } else {
    t = Date.now();
    const answerText = report?.title || report?.bodyText || `items: ${handlerResult?.items?.length || 0}`;
    try {
      const upd = await m.updateState({
        conversationId: CONVERSATION_ID,
        userMessage: queryForPipeline,
        answer: answerText,
        currentState,
      });
      timings.updater = Date.now() - t;
      console.log(`  Took: ${timings.updater}ms`);
      console.log(`  changed_keys: [${upd.changed_keys.join(', ')}]`);
      console.log(`  state after:`);
      console.log(JSON.stringify(upd.updatedState, null, 4));
    } catch (err) {
      console.log(`  ❌ Updater threw: ${err.message}`);
    }
  }

  // ── VERDICT ─────────────────────────────────────────────────────────
  hr('VERDICT — what actually happened');
  const maxScore = hits.length > 0 ? Math.max(...hits.map(h => h.score || 0)) : 0;

  console.log(`  Router:               type=${routerResult.type}, intent=${routerResult.intent}`);
  console.log(`  Resolver:             kind=${resolverResult.kind}`);
  console.log(`  SEC:                  ${secResult ? secResult.mode : 'not fired'}`);
  console.log(`  Client hits retrieved: ${hits.length}`);
  console.log(`  Max relevance score:   ${maxScore.toFixed(3)}`);
  console.log(`  Client hits kept:      ${keptClient.length}`);
  console.log(`  Custom hits:           ${customHits.length}`);
  console.log(`  Gate decision:         ${realResult?.payload?.no_data ? 'BLOCKED → no data' : 'PASSED → report generated'}`);

  hr('TIMINGS');
  Object.entries(timings).forEach(([k, v]) => console.log(`  ${k.padEnd(14)} ${v}ms`));
  console.log(`  ${'TOTAL'.padEnd(14)} ${Date.now() - startedAt}ms`);
  console.log(HR + '\n');
}

// ── Entry point ─────────────────────────────────────────────────────────
async function main() {
  await load();
  const inlineQ = process.argv.slice(2).join(' ').trim();

  if (inlineQ) {
    await trace(inlineQ);
    process.exit(0);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  hr('DI V2 FULL TRACE — interactive mode (full detail + real pipeline)');
  console.log(`  clientId:  ${CLIENT_ID}`);
  console.log(`  industry:  ${INDUSTRY}`);
  if (CONVERSATION_ID) console.log(`  conversationId: ${CONVERSATION_ID}`);
  console.log('  Type a question. "exit" or Ctrl+C to quit.');
  console.log(HR);

  const ask = () => rl.question('\n❯ ', async (line) => {
    const q = line.trim();
    if (!q) return ask();
    if (q === 'exit' || q === 'quit') { rl.close(); return; }
    try {
      await trace(q);
    } catch (err) {
      console.log('[trace crashed]', err.message);
      console.log(err.stack);
    }
    ask();
  });
  ask();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });