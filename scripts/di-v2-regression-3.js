/**
 * scripts/di-v2-regression-3.js
 *
 * REGRESSION CHECK 3: router -> retrieval -> list / inference / decision.
 *
 *   node scripts\di-v2-regression-3.js --questions scripts\test-questions.json
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { route } = require('../modules/decisionIntelligenceV2/routing/router');
const { retrieveClientSignals } = require('../modules/decisionIntelligenceV2/retrieval/clientSignalsRetrieval');
const { retrieveCustomSourceHits } = require('../modules/decisionIntelligenceV2/retrieval/customSourceRetrieval');
const { buildListItems } = require('../modules/decisionIntelligenceV2/handlers/listHandler');
const { buildInferenceAnswer } = require('../modules/decisionIntelligenceV2/handlers/inferenceHandler');
const { buildDecisionAnswer } = require('../modules/decisionIntelligenceV2/handlers/decisionHandler');

const LINE = '━'.repeat(90);

function parseArgs(argv) {
  const args = { questionsFile: null, client: null, industry: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--questions')     args.questionsFile = next();
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

async function runList(question, clientId, industry, r) {
  const issues = [];
  const t0 = Date.now();
  const retrieval = await retrieveClientSignals(question, clientId, industry, { precomputedUnderstanding: r });
  if (retrieval.hits.length === 0) issues.push('0 hits');
  else if (retrieval.matchedCount === 0) issues.push('0 matched');
  const listed = await buildListItems(retrieval.hits);
  if (listed.items.length === 0 && retrieval.hits.length > 0) issues.push('0 items from hits');
  return {
    issues,
    stats: { hits: retrieval.hits.length, matched: retrieval.matchedCount, items: listed.items.length, ms: Date.now() - t0 },
  };
}

async function runInference(question, clientId, industry, r) {
  const issues = [];
  const t0 = Date.now();
  const [clientRetr, customHits] = await Promise.all([
    retrieveClientSignals(question, clientId, industry, { precomputedUnderstanding: r }),
    retrieveCustomSourceHits(question, clientId),
  ]);
  if (clientRetr.hits.length === 0 && customHits.length === 0) issues.push('0 hits');
  else if (clientRetr.matchedCount === 0 && customHits.length === 0) issues.push('0 matched');
  const result = await buildInferenceAnswer(question, clientRetr.hits, customHits);
  if (result._empty) issues.push(`empty: ${result._reason}`);
  else if (!result.report) issues.push('no report');
  else {
    const bodyText = result.report.bodyText || '';
    if (!bodyText.trim()) issues.push('empty body');
    if (bodyText.includes('could not generate')) issues.push('placeholder');
    if (bodyText.length < 40) issues.push(`body too short (${bodyText.length})`);
    if (result.sources.length === 0) issues.push('0 sources');
  }
  return {
    issues,
    stats: { hits: clientRetr.hits.length, custom: customHits.length, sources: result.sources?.length || 0, ms: Date.now() - t0 },
  };
}

async function runDecision(question, clientId, industry, r) {
  const issues = [];
  const t0 = Date.now();
  const [clientRetr, customHits] = await Promise.all([
    retrieveClientSignals(question, clientId, industry, { precomputedUnderstanding: r }),
    retrieveCustomSourceHits(question, clientId),
  ]);
  if (clientRetr.hits.length === 0 && customHits.length === 0) issues.push('0 hits');
  else if (clientRetr.matchedCount === 0 && customHits.length === 0) issues.push('0 matched');
  const result = await buildDecisionAnswer(question, clientRetr.hits, customHits);
  if (result._empty) issues.push(`empty: ${result._reason}`);
  else if (!result.report) issues.push('no report');
  else {
    const sections = result.report.sections || [];
    if (sections.length < 4) issues.push(`only ${sections.length} sections`);
    const allEmpty = sections.every((s) => (s.points || []).every((p) => p.includes('No relevant data')));
    if (allEmpty) issues.push('all sections empty');
    if (!result.report.bottom_line) issues.push('no bottom_line');
    if (result.sources.length === 0) issues.push('0 sources');
  }
  return {
    issues,
    stats: {
      hits: clientRetr.hits.length,
      custom: customHits.length,
      sections: result.report?.sections?.length || 0,
      sources: result.sources?.length || 0,
      ms: Date.now() - t0,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const clientId = args.client || process.env.DI_CLIENT_ID || 'b61b4d3b-caeb-457b-9971-636c83688ee4';
  const industry = args.industry || process.env.DI_INDUSTRY || 'Cosmetics';

  if (!args.questionsFile) {
    console.error('Provide --questions <file.json>');
    process.exit(1);
  }
  const p = path.isAbsolute(args.questionsFile) ? args.questionsFile : path.resolve(process.cwd(), args.questionsFile);
  const questions = JSON.parse(fs.readFileSync(p, 'utf8'));

  console.log(LINE);
  console.log(' DI V2 — REGRESSION CHECK 3 (list + inference + decision)');
  console.log(LINE);
  console.log(` clientId:   ${clientId}`);
  console.log(` industry:   ${industry}`);
  console.log(` questions:  ${questions.length}`);
  console.log(LINE);

  const summary = {
    total: 0,
    list: 0, listClean: 0,
    inference: 0, inferenceClean: 0,
    decision: 0, decisionClean: 0,
    other: 0, failed: 0, totalIssues: 0,
  };

  for (const q of questions) {
    summary.total++;
    const text = (q && q.question) ? String(q.question) : String(q);
    const id = (q && q.id) ? q.id : '?';

    process.stdout.write(` [${id.padEnd(4)}] ${short(text, 56).padEnd(58)} `);

    let r;
    try {
      r = await route(text, industry);
    } catch (err) {
      console.log(`✗ router threw: ${err.message}`);
      summary.failed++;
      summary.totalIssues++;
      continue;
    }

    if (r.intent !== 'market_intelligence') {
      console.log(`- (${r.intent})`);
      summary.other++;
      continue;
    }

    try {
      let result;
      if (r.type === 'list') {
        result = await runList(text, clientId, industry, r);
        summary.list++;
        if (result.issues.length === 0) {
          console.log(`✓ [list] hits=${result.stats.hits} (${result.stats.matched}M) items=${result.stats.items} t=${result.stats.ms}ms`);
          summary.listClean++;
        } else {
          console.log(`⚠ [list] ${result.issues.join(' | ')}`);
          summary.totalIssues += result.issues.length;
        }
      } else if (r.type === 'inference') {
        result = await runInference(text, clientId, industry, r);
        summary.inference++;
        if (result.issues.length === 0) {
          console.log(`✓ [inf]  hits=${result.stats.hits} custom=${result.stats.custom} src=${result.stats.sources} t=${result.stats.ms}ms`);
          summary.inferenceClean++;
        } else {
          console.log(`⚠ [inf]  ${result.issues.join(' | ')}`);
          summary.totalIssues += result.issues.length;
        }
      } else if (r.type === 'decision') {
        result = await runDecision(text, clientId, industry, r);
        summary.decision++;
        if (result.issues.length === 0) {
          console.log(`✓ [dec]  hits=${result.stats.hits} custom=${result.stats.custom} sections=${result.stats.sections} src=${result.stats.sources} t=${result.stats.ms}ms`);
          summary.decisionClean++;
        } else {
          console.log(`⚠ [dec]  ${result.issues.join(' | ')}`);
          summary.totalIssues += result.issues.length;
        }
      } else {
        console.log(`- (${r.type})`);
        summary.other++;
      }
    } catch (err) {
      console.log(`✗ ${r.type} threw: ${err.message}`);
      summary.failed++;
      summary.totalIssues++;
    }
  }

  console.log('\n' + LINE);
  console.log(' SUMMARY');
  console.log(LINE);
  console.log(` Total questions:       ${summary.total}`);
  console.log(`  list:                  ${summary.list} (clean: ${summary.listClean})`);
  console.log(`  inference:             ${summary.inference} (clean: ${summary.inferenceClean})`);
  console.log(`  decision:              ${summary.decision} (clean: ${summary.decisionClean})`);
  console.log(`  other/skipped:         ${summary.other}`);
  console.log(`  failed:                ${summary.failed}`);
  console.log(` Total issues flagged:  ${summary.totalIssues}`);
  console.log(LINE + '\n');
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });