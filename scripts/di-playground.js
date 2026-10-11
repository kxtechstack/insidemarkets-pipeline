/**
 * scripts/di-playground.js
 *
 * Interactive terminal playground for the Decision Intelligence pipeline.
 * Shows every stage of the answer flow (intent → schema design → retrieval
 * → writer LLM → final report) so you can see exactly what's happening
 * without digging through server logs.
 *
 * Usage:
 *   node scripts/di-playground.js
 *   node scripts/di-playground.js "your question here"
 *   node scripts/di-playground.js --path inference "your question"
 *   node scripts/di-playground.js --path decision "your question"
 */

require('dotenv').config();

const readline = require('readline');

// ── Path selection ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
let forcedPath = null;
const pathArgIdx = args.indexOf('--path');
if (pathArgIdx !== -1) {
  forcedPath = args[pathArgIdx + 1];
  args.splice(pathArgIdx, 2);
}
const inlineQuestion = args.join(' ').trim() || null;

// ── Config ──────────────────────────────────────────────────────────────
const CLIENT_ID = process.env.DI_CLIENT_ID || 'b61b4d3b-caeb-457b-9971-636c83688ee4';
const INDUSTRY  = process.env.DI_INDUSTRY  || 'Cosmetics';

// ── Helpers ─────────────────────────────────────────────────────────────
const HR = '━'.repeat(80);
const SR = '─'.repeat(80);

function banner(title) {
  console.log('\n' + HR);
  console.log(' ' + title);
  console.log(HR);
}

function section(title) {
  console.log('\n' + SR);
  console.log(' ' + title);
  console.log(SR);
}

function time(label, fn) {
  return async (...a) => {
    const t0 = Date.now();
    const r = await fn(...a);
    console.log(`   (${label}: ${Date.now() - t0}ms)`);
    return r;
  };
}

// ── Lazy-load modules so we fail fast if env is broken ─────────────────
let modules = null;
async function loadModules() {
  if (modules) return modules;
  console.log('[init] loading modules...');
  const t0 = Date.now();
  modules = {
    classifyIntent:   require('../modules/decisionIntelligence/classifyIntent').classifyIntent,
    classifyQuestion: require('../modules/decisionIntelligence/classifyQuestion').classifyQuestion,
    designSchema:     require('../modules/decisionIntelligence/schemaDesigner').designSchema,
    retrieveClientData: require('../modules/decisionIntelligence/retrieveClientData').retrieveClientData,
    retrieveCustomSourceData: require('../modules/decisionIntelligence/customSourceRetrieval').retrieveCustomSourceData,
    generateInferenceAnswer: require('../modules/decisionIntelligence/generateInferenceAnswer').generateInferenceAnswer,
    extractIntent:    require('../modules/decisionIntelligence/secRetrieval').extractIntent,
    getAllCompanies:  require('../modules/decisionIntelligence/secRetrieval').getAllCompanies,
    retrieveForIntent: require('../modules/decisionIntelligence/secRetrieval').retrieveForIntent,
    generateAnswer:   require('../modules/decisionIntelligence/generateAnswer').generateAnswer,
    resolveCompanySet: require('../modules/decisionIntelligence/resolveCompanySet').resolveCompanySet,
  };
  console.log(`[init] modules loaded in ${Date.now() - t0}ms\n`);
  return modules;
}

// ── The main pipeline runner ────────────────────────────────────────────
async function runPipeline(question) {
  const m = await loadModules();
  const startedAt = Date.now();

  banner(`QUESTION: ${question}`);
  console.log(`clientId: ${CLIENT_ID}`);
  console.log(`industry: ${INDUSTRY}`);
  console.log(`forced path: ${forcedPath || '(auto — classifier decides)'}`);

  // ── Stage 0: Intent gate ──────────────────────────────────────────
  section('STAGE 0 — Intent classification');
  let intentResult;
  try {
    intentResult = await time('intent', m.classifyIntent)(question);
    console.log(`   intent: ${intentResult.intent}`);
    console.log(`   message: ${intentResult.message || '(none)'}`);
    console.log(`   reasoning: ${intentResult.reasoning || '(none)'}`);
  } catch (err) {
    console.log(`   [error] ${err.message}`);
    return;
  }

  if (intentResult.intent !== 'market_intelligence') {
    console.log('\n   → pipeline would short-circuit here (not a market-intelligence question)');
    console.log(`   → reply: ${intentResult.message}`);
    return;
  }

  // ── Stage 1: Path classification ──────────────────────────────────
  section('STAGE 1 — Question type classification');
  let path = forcedPath;
  let classifierReasoning = '(forced)';
  if (!path) {
    const cls = await time('classify', m.classifyQuestion)(question);
    path = cls.type;
    classifierReasoning = cls.reasoning || '(none)';
  }
  console.log(`   type: ${path}`);
  console.log(`   reasoning: ${classifierReasoning}`);

  // ── Stage 2: Schema design ────────────────────────────────────────
  section('STAGE 2 — Schema design (Call 1)');
  let schema = null;
  if (path === 'inference' || path === 'decision') {
    schema = await time('schema', m.designSchema)(question);
    if (schema) {
      console.log(`   designed ${schema.sections.length} sections:`);
      schema.sections.forEach((s, i) => {
        console.log(`   ${i + 1}. ${s.heading}`);
        s.points.forEach(p => console.log(`      - ${p}`));
      });
    } else {
      console.log('   [fallback] schema design returned null — legacy shape will be used');
    }
  } else {
    console.log(`   (skipped — ${path} questions use a fixed shape)`);
  }

  // ── Stage 3: Retrieval ────────────────────────────────────────────
  section('STAGE 3 — Retrieval');

  let clientSignals = [];
  let customSources = [];
  let secResult = { chunks: [], facts: [], sources: [] };

  const t3 = Date.now();
  [clientSignals, customSources] = await Promise.all([
    time('client', m.retrieveClientData)(question, CLIENT_ID, INDUSTRY),
    time('custom', m.retrieveCustomSourceData)(question, CLIENT_ID),
  ]);
  console.log(`   total retrieval: ${Date.now() - t3}ms`);

  console.log(`\n   CLIENT SIGNALS (${clientSignals.length}):`);
  clientSignals.slice(0, 10).forEach((r, i) => {
    console.log(`   [${i + 1}] score=${(r.score || 0).toFixed(3)} | ${(r.payload?.title || '').slice(0, 80)}`);
  });
  if (clientSignals.length > 10) console.log(`   ... +${clientSignals.length - 10} more`);

  console.log(`\n   CUSTOM SOURCES (${customSources.length}):`);
  customSources.slice(0, 5).forEach((r, i) => {
    console.log(`   [${i + 1}] score=${(r.score || 0).toFixed(3)} | ${r.payload?.source_name || r.payload?.title || ''}`);
  });

  if (path === 'decision') {
    console.log('\n   → decision path — checking for SEC retrieval...');
    try {
      const intent = await m.extractIntent(question, m.getAllCompanies);
      const setFilter = await m.resolveCompanySet(question);
      if (setFilter) {
        console.log(`   company-set resolved: sector=${setFilter.sector}, subsector=${setFilter.subsectorTerm}`);
      }
      if (intent.tickers.length > 0) {
        console.log(`   tickers detected: ${intent.tickers.join(', ')}`);
        secResult = await time('sec', m.retrieveForIntent)(question, intent);
        console.log(`   SEC chunks: ${secResult.chunks.length}, SEC facts: ${secResult.facts.length}`);
      } else {
        console.log('   no tickers detected — SEC retrieval skipped');
      }
    } catch (err) {
      console.log(`   [sec error] ${err.message}`);
    }
  }

  // ── Stage 4: Writer / answer generation ───────────────────────────
  section('STAGE 4 — Writer (Call 2) + answer assembly');
  const t4 = Date.now();

  let result;
  try {
    if (path === 'inference') {
      result = await m.generateInferenceAnswer(question, clientSignals, customSources);
    } else {
      const intent = await m.extractIntent(question, m.getAllCompanies);
      result = await m.generateAnswer(
        question, intent, secResult.chunks, secResult.facts,
        CLIENT_ID, INDUSTRY, customSources
      );
    }
  } catch (err) {
    console.log(`   [writer error] ${err.message}`);
    console.log(err.stack);
    return;
  }
  console.log(`   total writer stage: ${Date.now() - t4}ms`);

  // ── Stage 5: Final payload ────────────────────────────────────────
  section('STAGE 5 — Final response');

  const { report, sources = [], _empty, _reason, chart, chartMeta } = result || {};

  if (_empty) {
    console.log(`   [empty] ${_reason || 'no data'}`);
    return;
  }

  if (report) {
    console.log(`   title: ${report.title || '(none)'}`);

    if (Array.isArray(report.sections) && report.sections.length > 0) {
      console.log(`   [dynamic shape] ${report.sections.length} sections:\n`);
      report.sections.forEach((s, i) => {
        console.log(`   ${i + 1}. ${s.heading}`);
        (s.points || []).forEach(p => console.log(`      - ${p}`));
        console.log('');
      });
    } else {
      console.log('   [legacy shape]');
      if (report.outlook)  console.log(`   outlook: ${(Array.isArray(report.outlook) ? report.outlook.join(' ') : report.outlook).slice(0, 200)}`);
      if (report.analysis) console.log(`   analysis: ${(Array.isArray(report.analysis) ? report.analysis.join(' ') : report.analysis).slice(0, 200)}...`);
      if (report.key_facts) console.log(`   key_facts: ${report.key_facts.length} bullets`);
    }

    if (report.bottom_line) console.log(`\n   bottom_line: ${report.bottom_line}`);
  }

  console.log(`\n   SOURCES (${sources.length}):`);
  sources.slice(0, 10).forEach((s, i) => {
    console.log(`   [${i + 1}] ${s.type || '?'} | ${(s.title || '').slice(0, 70)} | ${s.url || '(no url)'}`);
  });

  if (chart) console.log(`   chart: present (${(chart.length / 1024).toFixed(1)} KB base64)`);
  if (chartMeta) console.log(`   chartMeta: ${JSON.stringify(chartMeta)}`);

  console.log(`\n   ─── TOTAL PIPELINE TIME: ${Date.now() - startedAt}ms ───`);
}

// ── Entry point ─────────────────────────────────────────────────────────
async function main() {
  await loadModules();

  if (inlineQuestion) {
    await runPipeline(inlineQuestion);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('\n' + HR);
  console.log('  DI Playground — interactive mode');
  console.log(`  clientId: ${CLIENT_ID}`);
  console.log(`  industry: ${INDUSTRY}`);
  console.log('  Type a question, press Enter. Type "exit" or Ctrl+C to quit.');
  console.log('  Prefix with "inference:" or "decision:" to force a path.');
  console.log(HR);

  const prompt = () => rl.question('\n❯ ', async (line) => {
    const q = line.trim();
    if (!q) return prompt();
    if (q.toLowerCase() === 'exit' || q.toLowerCase() === 'quit') {
      rl.close();
      return;
    }

    let forcedPathLocal = forcedPath;
    let actualQuestion = q;
    if (/^inference:/i.test(q))      { forcedPathLocal = 'inference'; actualQuestion = q.replace(/^inference:\s*/i, ''); }
    else if (/^decision:/i.test(q))  { forcedPathLocal = 'decision';  actualQuestion = q.replace(/^decision:\s*/i, ''); }

    const savedForced = forcedPath;
    forcedPath = forcedPathLocal;
    try {
      await runPipeline(actualQuestion);
    } catch (err) {
      console.log('[pipeline crashed]', err.message);
      console.log(err.stack);
    } finally {
      forcedPath = savedForced;
    }
    prompt();
  });

  prompt();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});