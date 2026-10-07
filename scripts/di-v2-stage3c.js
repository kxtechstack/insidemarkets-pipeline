/**
 * scripts/di-v2-stage3c.js
 *
 * STAGE 3c harness — router -> retrieval -> decision handler.
 *
 *   node scripts\di-v2-stage3c.js --q "SWOT analysis for cosmetics industry"
 *   node scripts\di-v2-stage3c.js --q "Should we enter the K-beauty market?"
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { route } = require('../modules/decisionIntelligenceV2/routing/router');
const { retrieveClientSignals } = require('../modules/decisionIntelligenceV2/retrieval/clientSignalsRetrieval');
const { retrieveCustomSourceHits } = require('../modules/decisionIntelligenceV2/retrieval/customSourceRetrieval');
const { buildDecisionAnswer } = require('../modules/decisionIntelligenceV2/handlers/decisionHandler');

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

function wrapBullet(text, firstPrefix = '     • ', contPrefix = '       ', width = 80) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let buf = '';
  let isFirst = true;

  for (const word of words) {
    const prefixLen = (isFirst ? firstPrefix : contPrefix).length;
    const proposed = buf ? `${buf} ${word}` : word;
    if (proposed.length + prefixLen > width) {
      lines.push((isFirst ? firstPrefix : contPrefix) + buf);
      buf = word;
      isFirst = false;
    } else {
      buf = proposed;
    }
  }
  if (buf) lines.push((isFirst ? firstPrefix : contPrefix) + buf);
  return lines.join('\n');
}

function wrapText(text, prefix = '   ', width = 80) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let buf = '';
  for (const word of words) {
    const proposed = buf ? `${buf} ${word}` : word;
    if (proposed.length + prefix.length > width) {
      lines.push(prefix + buf);
      buf = word;
    } else {
      buf = proposed;
    }
  }
  if (buf) lines.push(prefix + buf);
  return lines.join('\n');
}

async function runOne(question, clientId, industry) {
  console.log('\n' + LINE);
  console.log(` Q: ${question}`);
  console.log(SUB);

  const r = await route(question, industry);
  console.log(` ROUTE: ${r.intent} / ${r.type}`);

  if (r.intent !== 'market_intelligence') {
    console.log(`   reply: ${r.primary_intent}`);
    console.log(LINE);
    return;
  }
  if (r.type !== 'decision') {
    console.log(`   (skipped — this harness only handles decision questions)`);
    console.log(LINE);
    return;
  }

  const t0 = Date.now();
  const [clientRetr, customHits] = await Promise.all([
    retrieveClientSignals(question, clientId, industry, { precomputedUnderstanding: r }),
    retrieveCustomSourceHits(question, clientId),
  ]);
  console.log(
    ` RETRIEVAL: client=${clientRetr.hits.length} (${clientRetr.matchedCount}M/${clientRetr.unmatchedCount}U) ` +
    `custom=${customHits.length} in ${Date.now() - t0}ms`
  );

  const t1 = Date.now();
  const result = await buildDecisionAnswer(question, clientRetr.hits, customHits);
  console.log(` DECISION: ${Date.now() - t1}ms`);

  if (result._empty) {
    console.log(`   EMPTY: ${result._reason}`);
    console.log(LINE);
    return;
  }

  console.log(SUB);
  console.log(` Title: ${result.report.title}`);
  console.log('');
  for (const s of result.report.sections) {
    console.log(` ▸ ${s.heading}`);
    for (const p of s.points) {
      console.log(wrapBullet(p));
    }
    console.log('');
  }
  if (result.report.bottom_line) {
    console.log(' Bottom line:');
    console.log(wrapText(result.report.bottom_line));
  }
  console.log('');
  console.log(` Sources: ${result.sources.length}`);
  result.sources.slice(0, 10).forEach((s, i) => {
    if (s.type === 'client') {
      console.log(`   [${i + 1}] client  | ${s.module.padEnd(16)} | ${short(s.title, 65)}`);
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
  console.log(' DI V2 — STAGE 3c: decision handler');
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