/**
 * scripts/di-v2-stage3a.js
 *
 * STAGE 3a harness — run router -> retrieval -> list handler on a question.
 *
 *   node scripts\di-v2-stage3a.js --q "List recent funding rounds in cosmetics"
 *   node scripts\di-v2-stage3a.js --questions scripts\test-questions.json
 *
 * Env:
 *   DI_V2_DEBUG_LLM=1   dump raw LLM output from the router
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { route } = require('../modules/decisionIntelligenceV2/routing/router');
const { retrieveClientSignals } = require('../modules/decisionIntelligenceV2/retrieval/clientSignalsRetrieval');
const { buildListItems } = require('../modules/decisionIntelligenceV2/handlers/listHandler');

const LINE = '━'.repeat(90);
const SUB  = '─'.repeat(90);

function parseArgs(argv) {
  const args = { questionsFile: null, question: null, client: null, industry: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--questions')     args.questionsFile = next();
    else if (a === '--q')        args.question = next();
    else if (a === '--client')   args.client = next();
    else if (a === '--industry') args.industry = next();
  }
  return args;
}

const short = (s, n) => {
  if (!s) return '';
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
};

async function runOne(question, clientId, industry, expected) {
  console.log('\n' + LINE);
  console.log(` Q: ${question}`);
  console.log(SUB);

  // 1. Route
  const r = await route(question, industry);
  console.log(` ROUTE: ${r.intent} / ${r.type}`);

  if (r.intent !== 'market_intelligence') {
    console.log(`   reply: ${r.primary_intent}`);
    console.log(LINE);
    return;
  }
  if (r.type !== 'list') {
    console.log(`   (skipped — this harness only handles list questions)`);
    console.log(LINE);
    return;
  }

  // 2. Retrieve
  const t0 = Date.now();
  const { hits, matchedCount, unmatchedCount } = await retrieveClientSignals(
    question, clientId, industry, { precomputedUnderstanding: r }
  );
  const retrMs = Date.now() - t0;
  console.log(` RETRIEVAL: ${hits.length} hits (${matchedCount} matched, ${unmatchedCount} un-matched) in ${retrMs}ms`);

  // 3. Build items
  const t1 = Date.now();
  const { items, matchedCount: mC, unmatchedCount: uC } = await buildListItems(hits);
  const listMs = Date.now() - t1;
  console.log(` LIST:      ${items.length} items (${mC} matched, ${uC} un-matched) in ${listMs}ms`);

  if (items.length === 0) {
    console.log(`   (no items — empty result)`);
    console.log(LINE);
    return;
  }

  console.log(SUB);
  items.forEach((it, i) => {
    const tag = it.matched ? '[M]' : '[U]';
    console.log(` [${String(i + 1).padStart(2, ' ')}] ${tag} ${it.module.padEnd(16)} | ${short(it.title, 80)}`);
    console.log(`      ${short(it.summary, 180)}`);
    if (it.parentLabel) console.log(`      ${it.parentLabel}`);
    if (it.url) console.log(`      ${it.url}`);
    console.log('');
  });
  console.log(LINE);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const clientId = args.client || process.env.DI_CLIENT_ID || 'b61b4d3b-caeb-457b-9971-636c83688ee4';
  const industry = args.industry || process.env.DI_INDUSTRY || 'Cosmetics';

  let questions = [];
  if (args.question) {
    questions = [{ id: 'inline', question: args.question }];
  } else if (args.questionsFile) {
    const p = path.isAbsolute(args.questionsFile)
      ? args.questionsFile
      : path.resolve(process.cwd(), args.questionsFile);
    questions = JSON.parse(fs.readFileSync(p, 'utf8'));
  } else {
    console.error('Provide --q "<question>" or --questions <file.json>');
    process.exit(1);
  }

  console.log(LINE);
  console.log(' DI V2 — STAGE 3a: list handler');
  console.log(LINE);
  console.log(` clientId:   ${clientId}`);
  console.log(` industry:   ${industry}`);
  console.log(` questions:  ${questions.length}`);
  console.log(LINE);

  for (const q of questions) {
    const text = (q && q.question) ? String(q.question) : String(q);
    try {
      await runOne(text, clientId, industry, q);
    } catch (err) {
      console.log(` ERROR: ${err.message}`);
      console.log(err.stack);
    }
  }

  console.log('\nDone.\n');
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });