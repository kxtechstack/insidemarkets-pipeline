/**
 * scripts/di-v2-regression-1.js
 *
 * REGRESSION CHECK: router -> retrieval -> list handler, across all
 * list-type questions in test-questions.json.
 *
 * Flags:
 *   - Router failures (fallback, wrong type)
 *   - Retrieval anomalies (0 hits when expected, ALL un-matched)
 *   - List handler anomalies (0 items, low item count, missing fields)
 *   - Latency outliers
 *
 * Usage:
 *   node scripts\di-v2-regression-1.js --questions scripts\test-questions.json
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

async function runOne(question, clientId, industry) {
  const issues = [];
  const t0 = Date.now();

  // Route
  let routeResult;
  const tRoute = Date.now();
  try {
    routeResult = await route(question, industry);
  } catch (err) {
    return { issues: [`router threw: ${err.message}`], routeResult: null };
  }
  const routeMs = Date.now() - tRoute;

  if (routeResult._fallback) issues.push('router used fallback');
  if (routeResult.intent !== 'market_intelligence') {
    return { issues: [`intent=${routeResult.intent} (skipped)`], routeResult, routeMs };
  }
  if (routeResult.type !== 'list') {
    return { issues: [`type=${routeResult.type} (not list — skipped)`], routeResult, routeMs };
  }

  // Retrieve
  let retrieval;
  const tRetr = Date.now();
  try {
    retrieval = await retrieveClientSignals(question, clientId, industry, {
      precomputedUnderstanding: routeResult,
    });
  } catch (err) {
    return { issues: [`retrieval threw: ${err.message}`], routeResult, routeMs };
  }
  const retrMs = Date.now() - tRetr;

  if (retrieval.hits.length === 0) {
    issues.push('retrieval returned 0 hits');
  } else if (retrieval.matchedCount === 0) {
    issues.push(`retrieval returned 0 MATCHED hits (${retrieval.hits.length} total, all un-matched)`);
  }

  // List handler
  let listed;
  const tList = Date.now();
  try {
    listed = await buildListItems(retrieval.hits);
  } catch (err) {
    return { issues: [`listHandler threw: ${err.message}`], routeResult, retrieval, routeMs, retrMs };
  }
  const listMs = Date.now() - tList;

  if (listed.items.length === 0 && retrieval.hits.length > 0) {
    issues.push(`listHandler produced 0 items from ${retrieval.hits.length} hits (join failure?)`);
  }

  // Check each item has minimal fields
  for (const it of listed.items) {
    if (!it.title) issues.push(`item ${it.id || '?'} missing title`);
    if (!it.module || it.module === 'Unknown') issues.push(`item ${it.id || '?'} has module=${it.module}`);
  }

  // Latency flags (rough)
  if (routeMs > 8000)   issues.push(`router slow: ${routeMs}ms`);
  if (retrMs > 3000)    issues.push(`retrieval slow: ${retrMs}ms`);
  if (listMs > 3000)    issues.push(`listHandler slow: ${listMs}ms`);

  return {
    issues,
    routeResult,
    retrieval: {
      hitCount: retrieval.hits.length,
      matchedCount: retrieval.matchedCount,
      unmatchedCount: retrieval.unmatchedCount,
      topScore: retrieval.hits[0]?.score,
    },
    listed: {
      itemCount: listed.items.length,
      matchedCount: listed.matchedCount,
      unmatchedCount: listed.unmatchedCount,
    },
    timing: { routeMs, retrMs, listMs, totalMs: Date.now() - t0 },
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
  console.log(' DI V2 — REGRESSION CHECK (router + retrieval + list)');
  console.log(LINE);
  console.log(` clientId:   ${clientId}`);
  console.log(` industry:   ${industry}`);
  console.log(` questions:  ${questions.length}`);
  console.log(LINE);

  const summary = {
    total: 0,
    list: 0, listClean: 0,
    otherType: 0,
    failed: 0,
    totalIssues: 0,
  };

  for (const q of questions) {
    summary.total++;
    const text = (q && q.question) ? String(q.question) : String(q);
    const id = (q && q.id) ? q.id : '?';

    process.stdout.write(` [${id.padEnd(4)}] ${short(text, 60).padEnd(62)} `);

    let result;
    try {
      result = await runOne(text, clientId, industry);
    } catch (err) {
      console.log(`✗ threw: ${err.message}`);
      summary.failed++;
      summary.totalIssues++;
      continue;
    }

    if (!result.routeResult || result.routeResult.intent !== 'market_intelligence') {
      console.log(`- (${result.routeResult?.intent || 'fail'})`);
      summary.otherType++;
      continue;
    }
    if (result.routeResult.type !== 'list') {
      console.log(`- (${result.routeResult.type})`);
      summary.otherType++;
      continue;
    }

    summary.list++;

    if (result.issues.length === 0) {
      console.log(
        `✓ hits=${result.retrieval.hitCount} (${result.retrieval.matchedCount}M/${result.retrieval.unmatchedCount}U) ` +
        `items=${result.listed.itemCount} ` +
        `t=${result.timing.totalMs}ms`
      );
      summary.listClean++;
    } else {
      console.log(`⚠ ${result.issues.join(' | ')}`);
      summary.totalIssues += result.issues.length;
    }
  }

  console.log('\n' + LINE);
  console.log(' SUMMARY');
  console.log(LINE);
  console.log(` Total questions:        ${summary.total}`);
  console.log(`  - list questions:      ${summary.list}`);
  console.log(`  - other type/intent:   ${summary.otherType}`);
  console.log(`  - failed:              ${summary.failed}`);
  console.log(` List fully clean:       ${summary.listClean} / ${summary.list}`);
  console.log(` Total issues flagged:   ${summary.totalIssues}`);
  console.log(LINE + '\n');
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });