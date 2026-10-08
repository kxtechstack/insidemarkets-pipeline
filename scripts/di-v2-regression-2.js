/**
 * scripts/di-v2-regression-3.js
 *
 * REGRESSION CHECK 3: router + retrieval + LIST + INFERENCE + DECISION.
 *
 * Extends check 2 by running DECISION questions end-to-end, including the
 * SEC sidecar. For each decision question, the runner:
 *   1. Calls buildSecAnswer() exactly like route.js does
 *   2. If SEC returns numeric  → checks the payload (report, sources, chart)
 *   3. If SEC returns region   → checks the list vs no_data shape
 *   4. Otherwise               → falls through to buildDecisionAnswer()
 *                                with SEC chunks merged into client hits
 *
 * Flags SEC-specific outcomes so you can see at a glance whether each
 * question went through SEC or V2, and whether the result is well-formed.
 *
 * Usage:
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
const { buildSecAnswer } = require('../modules/decisionIntelligenceV2/handlers/secHandler');
const { normalizeConcepts, containsPhrase } = require('../modules/decisionIntelligenceV2/retrieval/filterListHits');

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

// ─────────────────────────────────────────────────────────────────────────
// LIST
// ─────────────────────────────────────────────────────────────────────────
async function runList(question, clientId, industry, r) {
  const issues = [];
  const t0 = Date.now();

  const retrieval = await retrieveClientSignals(question, clientId, industry, {
    precomputedUnderstanding: r,
  });

  if (retrieval.hits.length === 0) issues.push('retrieval returned 0 hits');
  else if (retrieval.matchedCount === 0) issues.push('retrieval returned 0 matched hits');

  const listed = await buildListItems(retrieval.hits);
  if (listed.items.length === 0 && retrieval.hits.length > 0) {
    issues.push(`listHandler produced 0 items from ${retrieval.hits.length} hits`);
  }
  for (const it of listed.items) {
    if (!it.title) issues.push(`item ${it.id} missing title`);
    if (!it.module || it.module === 'Unknown') issues.push(`item ${it.id} module=${it.module}`);
  }

  return {
    issues,
    mode: 'list',
    stats: {
      hits: retrieval.hits.length,
      matched: retrieval.matchedCount,
      unmatched: retrieval.unmatchedCount,
      items: listed.items.length,
      ms: Date.now() - t0,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// INFERENCE
// ─────────────────────────────────────────────────────────────────────────
async function runInference(question, clientId, industry, r) {
  const issues = [];
  const t0 = Date.now();

  const [clientRetr, customHits] = await Promise.all([
    retrieveClientSignals(question, clientId, industry, { precomputedUnderstanding: r }),
    retrieveCustomSourceHits(question, clientId),
  ]);

  if (clientRetr.hits.length === 0 && customHits.length === 0) {
    issues.push('retrieval returned 0 hits');
  } else if (clientRetr.matchedCount === 0 && customHits.length === 0) {
    issues.push('retrieval returned 0 matched hits');
  }

  const result = await buildInferenceAnswer(question, clientRetr.hits, customHits);

  if (result._empty) {
    issues.push(`inference empty: ${result._reason}`);
  } else if (!result.report) {
    issues.push('inference returned no report');
  } else {
    const bodyText = result.report.bodyText || '';
    if (!bodyText.trim()) issues.push('inference bodyText is empty');
    if (bodyText.includes('could not generate a structured answer')) {
      issues.push('inference returned placeholder text');
    }
    if (bodyText.length < 40) issues.push(`inference bodyText too short (${bodyText.length} chars)`);
    if (result.sources.length === 0) issues.push('inference returned 0 sources');
  }

  return {
    issues,
    mode: 'inference',
    stats: {
      hits: clientRetr.hits.length,
      matched: clientRetr.matchedCount,
      custom: customHits.length,
      sources: result.sources?.length || 0,
      ms: Date.now() - t0,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// DECISION — mirrors route.js
// ─────────────────────────────────────────────────────────────────────────
async function runDecision(question, clientId, industry, r) {
  const issues = [];
  const t0 = Date.now();

  // ── SEC sidecar ────────────────────────────────────────────────────
  let secResult = null;
  try {
    secResult = await buildSecAnswer({
      question,
      routerResult: r,
      clientId,
      industry,
    });
  } catch (err) {
    issues.push(`SEC handler threw: ${err.message}`);
  }

  // ── SEC numeric — short circuit ────────────────────────────────────
  if (secResult && secResult.mode === 'numeric' && secResult.payload) {
    const p = secResult.payload;
    if (!p.report || !p.report.bodyText) issues.push('SEC numeric: empty bodyText');
    if (!p.sources || p.sources.length === 0) issues.push('SEC numeric: 0 sources');
    if (!p.chart) issues.push('SEC numeric: no chart (expected for multi-value)');

    return {
      issues,
      mode: 'sec-numeric',
      stats: {
        sources: p.sources?.length || 0,
        chart: !!p.chart,
        ms: Date.now() - t0,
      },
    };
  }

  // ── SEC region fallback — short circuit ────────────────────────────
  if (secResult && secResult.mode === 'region_fallback' && secResult.payload) {
    const p = secResult.payload;
    if (p.type === 'list') {
      if (!p.items || p.items.length === 0) issues.push('SEC region: list with 0 items');
    } else if (p.no_data) {
      if (!p.message) issues.push('SEC region: no_data without message');
    } else {
      issues.push(`SEC region: unexpected payload type=${p.type}`);
    }
    return {
      issues,
      mode: 'sec-region',
      stats: {
        type: p.type,
        items: p.items?.length || 0,
        noData: !!p.no_data,
        ms: Date.now() - t0,
      },
    };
  }

  // ── Fall through to V2 decision ────────────────────────────────────
  const [clientRetr, customHits] = await Promise.all([
    retrieveClientSignals(question, clientId, industry, { precomputedUnderstanding: r }),
    retrieveCustomSourceHits(question, clientId),
  ]);

  const conceptsForFilter = [
    ...(r.concept_keywords || []),
    ...(r.entity_mentions || []),
  ];
  const isFrameworkQuestion = /\b(swot|pestle|pestel|five\s*forces|5\s*forces|porter|risk\s*analysis|risk\s*categor)/i.test(question);

  const keptClient = isFrameworkQuestion
    ? clientRetr.hits
    : (() => {
        const clean = normalizeConcepts(conceptsForFilter);
        if (clean.length === 0) return clientRetr.hits;
        return clientRetr.hits.filter((h) => {
          const hay = `${h.title || ''} ${h.chunk_text || ''}`;
          return clean.some((c) => containsPhrase(hay, c));
        });
      })();

  const secInjectChunks =
    secResult && secResult.mode === 'framework' && Array.isArray(secResult.injectChunks)
      ? secResult.injectChunks
      : [];

  const keptClientWithSec = secInjectChunks.length
    ? [...secInjectChunks, ...keptClient]
    : keptClient;

  const result = await buildDecisionAnswer(question, keptClientWithSec, customHits);

  if (result._empty) issues.push(`decision empty: ${result._reason}`);
  else if (!result.report) issues.push('decision returned no report');
  else {
    const sections = result.report.sections || [];
    if (sections.length === 0) issues.push('decision: 0 sections');
    const allEmpty =
      sections.length > 0 &&
      sections.every((s) =>
        (s.points || []).every((p) => /no relevant data/i.test(p))
      );
    if (allEmpty) issues.push('decision: all sections empty');
    if (!result.sources || result.sources.length === 0) issues.push('decision: 0 sources');
  }

  return {
    issues,
    mode: 'v2-decision',
    stats: {
      secInjected: secInjectChunks.length,
      client: keptClient.length,
      custom: customHits.length,
      sections: result.report?.sections?.length || 0,
      sources: result.sources?.length || 0,
      ms: Date.now() - t0,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const clientId = args.client || process.env.DI_CLIENT_ID || 'b61b4d3b-caeb-457b-9971-636c83688ee4';
  const industry = args.industry || process.env.DI_INDUSTRY || 'Cosmetics';

  if (!args.questionsFile) {
    console.error('Provide --questions <file.json>');
    process.exit(1);
  }
  const p = path.isAbsolute(args.questionsFile)
    ? args.questionsFile
    : path.resolve(process.cwd(), args.questionsFile);
  const questions = JSON.parse(fs.readFileSync(p, 'utf8'));

  console.log(LINE);
  console.log(' DI V2 — REGRESSION CHECK 3 (router + list + inference + decision + SEC)');
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
    secNumeric: 0, secRegionList: 0, secRegionNoData: 0,
    other: 0,
    failed: 0,
    totalIssues: 0,
  };

  for (const q of questions) {
    summary.total++;
    const text = q && q.question ? String(q.question) : String(q);
    const id = q && q.id ? q.id : '?';

    process.stdout.write(` [${String(id).padEnd(4)}] ${short(text, 55).padEnd(57)} `);

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

    let result;
    try {
      if (r.type === 'list') {
        result = await runList(text, clientId, industry, r);
        summary.list++;
        if (result.issues.length === 0) {
          console.log(
            `✓ [list] hits=${result.stats.hits} (${result.stats.matched}M/${result.stats.unmatched}U) ` +
            `items=${result.stats.items} t=${result.stats.ms}ms`
          );
          summary.listClean++;
        } else {
          console.log(`⚠ [list] ${result.issues.join(' | ')}`);
          summary.totalIssues += result.issues.length;
        }
      } else if (r.type === 'inference') {
        result = await runInference(text, clientId, industry, r);
        summary.inference++;
        if (result.issues.length === 0) {
          console.log(
            `✓ [inf]  hits=${result.stats.hits} (${result.stats.matched}M) src=${result.stats.sources} ` +
            `t=${result.stats.ms}ms`
          );
          summary.inferenceClean++;
        } else {
          console.log(`⚠ [inf]  ${result.issues.join(' | ')}`);
          summary.totalIssues += result.issues.length;
        }
      } else if (r.type === 'decision') {
        result = await runDecision(text, clientId, industry, r);
        summary.decision++;
        if (result.mode === 'sec-numeric') summary.secNumeric++;
        else if (result.mode === 'sec-region') {
          if (result.stats.type === 'list') summary.secRegionList++;
          else if (result.stats.noData) summary.secRegionNoData++;
        }

        if (result.issues.length === 0) {
          let line;
          if (result.mode === 'sec-numeric') {
            line = `src=${result.stats.sources} chart=${result.stats.chart}`;
          } else if (result.mode === 'sec-region') {
            line = `type=${result.stats.type} items=${result.stats.items} noData=${result.stats.noData}`;
          } else {
            line = `sec=${result.stats.secInjected} cli=${result.stats.client} cust=${result.stats.custom} ` +
                   `sections=${result.stats.sections} src=${result.stats.sources}`;
          }
          console.log(`✓ [${result.mode}] ${line} t=${result.stats.ms}ms`);
          summary.decisionClean++;
        } else {
          console.log(`⚠ [${result.mode}] ${result.issues.join(' | ')}`);
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
  console.log(` Total questions:        ${summary.total}`);
  console.log(`  - list questions:      ${summary.list}   (clean: ${summary.listClean})`);
  console.log(`  - inference questions: ${summary.inference}   (clean: ${summary.inferenceClean})`);
  console.log(`  - decision questions:  ${summary.decision}   (clean: ${summary.decisionClean})`);
  console.log(`      · sec-numeric:     ${summary.secNumeric}`);
  console.log(`      · sec-region list: ${summary.secRegionList}`);
  console.log(`      · sec-region nodata:${summary.secRegionNoData}`);
  console.log(`  - other/skipped:       ${summary.other}`);
  console.log(`  - failed:              ${summary.failed}`);
  console.log(` Total issues flagged:   ${summary.totalIssues}`);
  console.log(LINE + '\n');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});