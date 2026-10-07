/**
 * scripts/di-v2-stage3b.js
 *
 * STAGE 3b harness — router -> retrieval (client + custom) -> inference handler.
 *
 *   node scripts\di-v2-stage3b.js --q "what updates on glossier"
 *   node scripts\di-v2-stage3b.js --questions scripts\test-questions.json
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { route } = require('../modules/decisionIntelligenceV2/routing/router');
const { retrieveClientSignals } = require('../modules/decisionIntelligenceV2/retrieval/clientSignalsRetrieval');
const { retrieveCustomSourceHits } = require('../modules/decisionIntelligenceV2/retrieval/customSourceRetrieval');
const { buildInferenceAnswer } = require('../modules/decisionIntelligenceV2/handlers/inferenceHandler');

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

async function runOne(question, clientId, industry) {
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
  if (r.type !== 'inference') {
    console.log(`   (skipped — this harness only handles inference questions)`);
    console.log(LINE);
    return;
  }

  // 2. Retrieve — client + custom in parallel
  const t0 = Date.now();
  const [clientRetr, customHits] = await Promise.all([
    retrieveClientSignals(question, clientId, industry, { precomputedUnderstanding: r }),
    retrieveCustomSourceHits(question, clientId),
  ]);
  const retrMs = Date.now() - t0;
  console.log(
    ` RETRIEVAL: client=${clientRetr.hits.length} (${clientRetr.matchedCount}M/${clientRetr.unmatchedCount}U) ` +
    `custom=${customHits.length}  in ${retrMs}ms`
  );

  // 3. Inference answer
  const t1 = Date.now();
  const result = await buildInferenceAnswer(question, clientRetr.hits, customHits);
  const ansMs = Date.now() - t1;

  if (result._empty) {
    console.log(` INFERENCE: empty — ${result._reason}  (${ansMs}ms)`);
    console.log(LINE);
    return;
  }

  console.log(` INFERENCE: ${ansMs}ms`);
  console.log(SUB);
  console.log(` Title: ${result.report.title}`);
  console.log('');
  // Body — wrap at ~76 chars for readability
  const body = result.report.bodyText || '';
  for (const line of body.split('\n')) {
    if (line.length <= 76) { console.log('   ' + line); continue; }
    let buf = '';
    for (const word of line.split(' ')) {
      if ((buf + ' ' + word).trim().length > 76) {
        console.log('   ' + buf.trim());
        buf = word;
      } else {
        buf = (buf + ' ' + word).trim();
      }
    }
    if (buf) console.log('   ' + buf);
  }
  console.log('');
  console.log(` Sources: ${result.sources.length}`);
  result.sources.forEach((s, i) => {
    if (s.type === 'client') {
      console.log(`   [${i + 1}] client  | ${s.module.padEnd(16)} | ${short(s.title, 70)}`);
    } else {
      console.log(`   [${i + 1}] custom  | ${short(s.source_name, 40)} | chunk ${s.chunk_index}`);
    }
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
    const p = path.isAbsolute(args.questionsFile) ? args.questionsFile : path.resolve(process.cwd(), args.questionsFile);
    questions = JSON.parse(fs.readFileSync(p, 'utf8'));
  } else {
    console.error('Provide --q "<question>" or --questions <file.json>');
    process.exit(1);
  }

  console.log(LINE);
  console.log(' DI V2 — STAGE 3b: inference handler');
  console.log(LINE);
  console.log(` clientId:   ${clientId}`);
  console.log(` industry:   ${industry}`);
  console.log(` questions:  ${questions.length}`);
  console.log(LINE);

  for (const q of questions) {
    const text = (q && q.question) ? String(q.question) : String(q);
    try {
      await runOne(text, clientId, industry);
    } catch (err) {
      console.log(` ERROR: ${err.message}`);
      console.log(err.stack);
    }
  }

  console.log('\nDone.\n');
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });