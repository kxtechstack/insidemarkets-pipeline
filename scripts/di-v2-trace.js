/**
 * scripts/di-v2-trace.js
 *
 * Full-pipeline tracer. Shows every stage of the V2 pipeline for one question:
 *   1. Router
 *   2. Retrieval (client signals + custom sources)
 *   2b. Filter — deterministic concept matching for all question types
 *   3. Handler
 *   4. Sources
 *
 * Two modes:
 *   node scripts\di-v2-trace.js                          → interactive REPL
 *   node scripts\di-v2-trace.js --q "your question"      → one-shot trace
 *   node scripts\di-v2-trace.js --q "..." --client <id> --industry "Cosmetics"
 *   node scripts\di-v2-trace.js --q "..." --type decision
 *
 * In interactive mode, prefix with "list:", "inference:", or "decision:"
 * to force a path for that single turn.
 *
 * Env:
 *   DI_V2_TRACE_VERBOSE=1   print full chunk text (no truncation)
 */

require('dotenv').config();

const readline = require('readline');

const { route } = require('../modules/decisionIntelligenceV2/routing/router');
const { retrieveClientSignals } = require('../modules/decisionIntelligenceV2/retrieval/clientSignalsRetrieval');
const { retrieveCustomSourceHits } = require('../modules/decisionIntelligenceV2/retrieval/customSourceRetrieval');
const { filterListHits, normalizeConcepts, containsPhrase } = require('../modules/decisionIntelligenceV2/retrieval/filterListHits');
const { buildListItems } = require('../modules/decisionIntelligenceV2/handlers/listHandler');
const { buildInferenceAnswer } = require('../modules/decisionIntelligenceV2/handlers/inferenceHandler');
const { buildDecisionAnswer } = require('../modules/decisionIntelligenceV2/handlers/decisionHandler');

const LINE = '━'.repeat(90);
const SUB  = '─'.repeat(90);

const VERBOSE = process.env.DI_V2_TRACE_VERBOSE === '1';
const CHUNK_LIMIT = VERBOSE ? 5000 : 400;

const DEFAULT_CLIENT_ID = process.env.DI_CLIENT_ID || 'b61b4d3b-caeb-457b-9971-636c83688ee4';
const DEFAULT_INDUSTRY  = process.env.DI_INDUSTRY  || 'Cosmetics';

function parseArgs(argv) {
  const args = { question: null, client: null, industry: null, type: null, user: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--q')           args.question = next();
    else if (a === '--client') args.client = next();
    else if (a === '--industry') args.industry = next();
    else if (a === '--type')   args.type = next();
    else if (a === '--user')   args.user = next();
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

// Deterministic filter for inference / decision — mirrors route.js
function filterForInferenceOrDecision(clientHits, concepts) {
  const clean = normalizeConcepts(concepts);
  if (clean.length === 0) return clientHits;
  return clientHits.filter((h) => {
    const haystack = `${h.title || ''} ${h.chunk_text || ''}`;
    return clean.some((c) => containsPhrase(haystack, c));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Run the full trace for one question. Returns nothing (prints stages).
// ─────────────────────────────────────────────────────────────────────────
async function traceOne({ question, clientId, industry, userName, forcedType }) {
  console.log(LINE);
  console.log(' DI V2 — FULL PIPELINE TRACE');
  console.log(LINE);
  console.log(` Q:          ${question}`);
  console.log(` clientId:   ${clientId}`);
  console.log(` industry:   ${industry}`);
  console.log(` forcedType: ${forcedType || '(auto)'}`);
  console.log(` verbose:    ${VERBOSE ? 'ON' : 'off (set DI_V2_TRACE_VERBOSE=1 for full text)'}`);

  const tTotal = Date.now();

  // ─────────────────────────────────────────────────────────────────────
  stageHeader(1, 'Router');
  const t0 = Date.now();
  let routerResult;
  if (forcedType) {
    const valid = ['list', 'inference', 'decision'];
    if (!valid.includes(forcedType)) {
      console.error(`Invalid --type "${forcedType}". Must be list|inference|decision.`);
      return;
    }
    routerResult = {
      intent: 'market_intelligence',
      type: forcedType,
      time_constraint: { present: false, value: null, unit: null, phrase: null },
      entity_mentions: [],
      concept_keywords: [],
      sector_term: null,
      is_company_set_query: false,
      primary_intent: question,
      user_message: null,
      _fallback: false,
    };
  } else {
    routerResult = await route(question, industry, { userName });
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
  console.log(` user_message:    ${show(routerResult.user_message, 200)}`);
  console.log(` fallback:        ${routerResult._fallback ? '⚠ YES' : 'no'}`);
  console.log(` (${Date.now() - t0}ms)`);

  if (routerResult.intent !== 'market_intelligence') {
    console.log('\n → Non-market-intelligence intent — pipeline short-circuits here.');
    console.log(` → reply would be: ${routerResult.user_message || routerResult.primary_intent}`);
    console.log('\n' + LINE);
    console.log(` TOTAL TIME: ${Date.now() - tTotal}ms`);
    console.log(LINE + '\n');
    return;
  }

  // ─────────────────────────────────────────────────────────────────────
  stageHeader(2, 'Retrieval');

  const t1 = Date.now();
  const clientRetr = await retrieveClientSignals(question, clientId, industry, {
    precomputedUnderstanding: routerResult,
  });
  const customHits = routerResult.type === 'list'
    ? []
    : await retrieveCustomSourceHits(question, clientId);
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
  stageHeader('2b', 'Filter (deterministic — concept in title or body)');

  const tFilter = Date.now();
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

  console.log(` normalized concepts: [${normalizeConcepts(conceptsForFilter).join(', ')}]`);
  console.log(` kept client: ${keptClient.length}/${clientRetr.hits.length}`);
  console.log(` kept custom: ${keptCustom.length}/${customHits.length}`);
  console.log(` (${Date.now() - tFilter}ms)`);

  subHeader('Verdicts (client)');
  clientRetr.hits.forEach((h, i) => {
    const kept = keptClient.includes(h);
    console.log(` [${String(i + 1).padStart(2)}] ${kept ? '✓ KEEP' : '✗ DROP'} | ${h.title}`);
  });

  const hasMaterial = keptClient.length + keptCustom.length > 0;

  // ─────────────────────────────────────────────────────────────────────
  stageHeader(3, 'Handler');
  console.log(` Input: client=${keptClient.length}, custom=${keptCustom.length} (hasMaterial=${hasMaterial})`);

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
    handlerResult = await buildListItems(keptClient);
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
    handlerResult = await buildInferenceAnswer(question, keptClient, keptCustom);
    console.log(` empty:          ${handlerResult._empty ? 'yes' : 'no'}`);
    if (handlerResult._empty) {
      console.log(` reason:         ${handlerResult._reason}`);
    } else {
      console.log(` title:          ${handlerResult.report.title}`);

      if (Array.isArray(handlerResult.report.sections)) {
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
      } else if (typeof handlerResult.report.bodyText === 'string') {
        console.log(` bodyText (${handlerResult.report.bodyText.length} chars):`);
        console.log(SUB);
        console.log(handlerResult.report.bodyText);
        console.log(SUB);
      } else {
        console.log(` [unknown report shape] ${JSON.stringify(handlerResult.report).slice(0, 200)}`);
      }
      console.log(` sources:        ${handlerResult.sources.length}`);
    }
    console.log(` (${Date.now() - t2}ms)`);

  } else if (routerResult.type === 'decision') {
    const t2 = Date.now();
    handlerResult = await buildDecisionAnswer(question, keptClient, keptCustom);
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

// ─────────────────────────────────────────────────────────────────────────
// One-shot mode — called when --q is provided
// ─────────────────────────────────────────────────────────────────────────
async function runOnce() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.question) {
    console.error('Provide --q "<question>"');
    process.exit(1);
  }
  const clientId = args.client || DEFAULT_CLIENT_ID;
  const industry = args.industry || DEFAULT_INDUSTRY;

  // Optional: look up user's first name for personalized greeting test
  let userName = null;
  if (args.user) {
    try {
      const { createClient } = require('@supabase/supabase-js');
      const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
      const { data } = await supa
        .schema('admin')
        .from('client_users')
        .select('first_name')
        .eq('id', args.user)
        .maybeSingle();
      userName = data?.first_name || null;
      console.log(`[trace] resolved user_name="${userName}" for userId=${args.user}`);
    } catch (err) {
      console.log(`[trace] user first-name lookup failed: ${err.message}`);
    }
  }

  await traceOne({
    question: args.question,
    clientId,
    industry,
    userName,
    forcedType: args.type || null,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Interactive mode — REPL for one question at a time
// ─────────────────────────────────────────────────────────────────────────
async function interactive() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Optional: parse --user from argv for personalized greetings
  const args = parseArgs(process.argv.slice(2));
  let userName = null;
  if (args.user) {
    try {
      const { createClient } = require('@supabase/supabase-js');
      const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
      const { data } = await supa
        .schema('admin')
        .from('client_users')
        .select('first_name')
        .eq('id', args.user)
        .maybeSingle();
      userName = data?.first_name || null;
      console.log(`[trace] resolved user_name="${userName}" for userId=${args.user}`);
    } catch (err) {
      console.log(`[trace] user first-name lookup failed: ${err.message}`);
    }
  }

  console.log(LINE);
  console.log(' DI V2 — interactive trace');
  console.log(LINE);
  console.log(` clientId: ${DEFAULT_CLIENT_ID}`);
  console.log(` industry: ${DEFAULT_INDUSTRY}`);
  console.log('');
  console.log(' Type a question and press Enter.');
  console.log(' Prefix with "list:", "inference:", or "decision:" to force a path.');
  console.log(' Type "exit" or Ctrl+C to quit.');
  console.log(LINE);

  const prompt = () => rl.question('\n❯ ', async (line) => {
    const q = (line || '').trim();
    if (!q) return prompt();
    if (q.toLowerCase() === 'exit' || q.toLowerCase() === 'quit') {
      rl.close();
      return;
    }

    // Detect "type: question" prefix to force a path for this turn only
    let forcedForTurn = null;
    let actualQ = q;
    const prefixMatch = q.match(/^(list|inference|decision):\s*(.+)$/i);
    if (prefixMatch) {
      forcedForTurn = prefixMatch[1].toLowerCase();
      actualQ = prefixMatch[2].trim();
    }

    try {
      await traceOne({
        question: actualQ,
        clientId: DEFAULT_CLIENT_ID,
        industry: DEFAULT_INDUSTRY,
        userName,
        forcedType: forcedForTurn,
      });
    } catch (err) {
      console.log('[pipeline error]', err.message);
      console.log(err.stack);
    }
    prompt();
  });

  prompt();
}

// ─────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────
(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.question) {
    runOnce().catch((err) => { console.error('Fatal:', err); process.exit(1); });
  } else {
    interactive().catch((err) => { console.error('Fatal:', err); process.exit(1); });
  }
})();