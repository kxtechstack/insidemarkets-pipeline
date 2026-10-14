/**
 * scripts/di-suggested-questions-audit.js
 *
 * Runs every suggested question through the FULL local V2 pipeline and
 * reports, per question:
 *   - router classification (intent / type / concepts / entities / sector)
 *   - how many client hits / custom hits came back
 *   - how many passed the concept filter
 *   - coverage decision + reason
 *   - final outcome (decision / inference / list / no_data)
 *   - if no_data, why
 *
 * Purpose: sort the 30 suggested questions into buckets:
 *   - WORKS: pipeline produces a report
 *   - LEGIT_NO_DATA: client genuinely has no matching signals
 *   - PIPELINE_BUG: data exists but pipeline failed to find it
 *
 * Usage:
 *   node scripts/di-suggested-questions-audit.js
 *   node scripts/di-suggested-questions-audit.js --client <uuid>
 *   node scripts/di-suggested-questions-audit.js --industry "Cosmetics & Beauty"
 *   node scripts/di-suggested-questions-audit.js --verbose
 */

require('dotenv').config();

const { runV2Pipeline } = require('../modules/decisionIntelligenceV2/route');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const VERBOSE = process.argv.includes('--verbose');

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// Defaults to Vellure Cosmetics (from vellure-test-questions.json).
const CLIENT_ID = argVal('--client', process.env.DI_CLIENT_ID || 'b61b4d3b-caeb-457b-9971-636c83688ee4');
const INDUSTRY  = argVal('--industry', process.env.DI_INDUSTRY || 'Cosmetics');

const LINE = '━'.repeat(100);

// ── The 30 questions from the Question Library ───────────────────────────
// Grouped by tab. Order matches the UI.
const QUESTIONS = [
  // ── Decision Intelligence (10) ─────────────────────────────────────
  { id: 'DI-1',  category: 'Decision Intelligence', q: 'Should we adjust our compliance approach given recent regulatory changes?' },
  { id: 'DI-2',  category: 'Decision Intelligence', q: 'How would you characterize the current investment climate in Cosmetics industry?' },
  { id: 'DI-3',  category: 'Decision Intelligence', q: 'What partnership or joint venture patterns are common in Cosmetics industry right now?' },
  { id: 'DI-4',  category: 'Decision Intelligence', q: 'Is acquiring a local manufacturing facility viable for certification acceleration?' },
  { id: 'DI-5',  category: 'Decision Intelligence', q: 'Do a PESTLE analysis for Cosmetics industry' },
  { id: 'DI-6',  category: 'Decision Intelligence', q: 'What emerging technologies are most likely to disrupt our market?' },
  { id: 'DI-7',  category: 'Decision Intelligence', q: 'How should we strategically defend market share against emerging Cosmetics competitors?' },
  { id: 'DI-8',  category: 'Decision Intelligence', q: 'How should we restructure our Cosmetics supply chain to reduce concentration risk?' },
  { id: 'DI-9',  category: 'Decision Intelligence', q: 'Should we introduce a premium Cosmetics tier priced above our current top segment?' },
  { id: 'DI-10', category: 'Decision Intelligence', q: 'What partnership model would accelerate our Cosmetics growth fastest?' },

  // ── Inference (10) ─────────────────────────────────────────────────
  { id: 'IN-1',  category: 'Inference', q: 'How has the competitors pricing changed in last week?' },
  { id: 'IN-2',  category: 'Inference', q: 'How are regional port delays impacting shipping lead times for raw materials?' },
  { id: 'IN-3',  category: 'Inference', q: 'How has organic search volume for our top category grown relative to alternatives?' },
  { id: 'IN-4',  category: 'Inference', q: 'What implications arise from major competitor patent expiries?' },
  { id: 'IN-5',  category: 'Inference', q: 'How does social commerce conversion rate compare against traditional brand storefronts?' },
  { id: 'IN-6',  category: 'Inference', q: 'How has demand in Cosmetics shifted over the last 90 days?' },
  { id: 'IN-7',  category: 'Inference', q: 'How will raw material price changes affect Cosmetics gross margins next quarter?' },
  { id: 'IN-8',  category: 'Inference', q: 'How has consumer sentiment towards Cosmetics shifted recently?' },
  { id: 'IN-9',  category: 'Inference', q: 'How are recent regulatory changes affecting Cosmetics operating costs?' },
  { id: 'IN-10', category: 'Inference', q: 'How quickly is new technology being adopted in the Cosmetics sector?' },

  // ── List (10) ──────────────────────────────────────────────────────
  { id: 'LI-1',  category: 'List', q: 'What are the major policy changes in last one week?' },
  { id: 'LI-2',  category: 'List', q: 'What ingredients were newly added to the restricted list this month?' },
  { id: 'LI-3',  category: 'List', q: 'List recent funding rounds in our Cosmetics industry' },
  { id: 'LI-4',  category: 'List', q: 'What are the current import tariff rates for our core products across key markets?' },
  { id: 'LI-5',  category: 'List', q: 'What clinical trial protocols are mandated for our product category?' },
  { id: 'LI-6',  category: 'List', q: 'List the top 10 competitors operating in the Cosmetics market.' },
  { id: 'LI-7',  category: 'List', q: 'List the major Cosmetics regulatory changes recorded in the last 30 days.' },
  { id: 'LI-8',  category: 'List', q: 'List the new entrants that have appeared in the Cosmetics sector this year.' },
  { id: 'LI-9',  category: 'List', q: 'List the emerging technologies gaining traction in Cosmetics.' },
  { id: 'LI-10', category: 'List', q: 'List recent consolidation or merger activity in Cosmetics sector.' },
];

// ─────────────────────────────────────────────────────────────────────────
// Run one question through the pipeline and capture everything
// ─────────────────────────────────────────────────────────────────────────
async function runOne(item) {
  const t0 = Date.now();

  // We want to see the router's raw output too. Run it separately first
  // so we get the classification before the pipeline runs.
  const { route } = require('../modules/decisionIntelligenceV2/routing/router');
  let routerResult;
  try {
    routerResult = await route(item.q, INDUSTRY);
  } catch (err) {
    return { ...item, error: `router threw: ${err.message}`, ms: Date.now() - t0 };
  }

  // Now run the full pipeline.
  let result;
  try {
    result = await runV2Pipeline({
      question: item.q,
      clientId: CLIENT_ID,
      industry: INDUSTRY,
      forcedType: null,
    });
  } catch (err) {
    return { ...item, routerResult, error: `pipeline threw: ${err.message}`, ms: Date.now() - t0 };
  }

  const payload = result.payload || {};
  const type = payload.type;
  const noData = !!payload.no_data;
  const sections = payload.report?.sections?.length || 0;
  const bodyText = typeof payload.report?.bodyText === 'string' ? payload.report.bodyText : '';
  const items = Array.isArray(payload.items) ? payload.items.length : 0;
  const sources = Array.isArray(payload.sources) ? payload.sources.length : 0;

  // Bucket:
  //   - WORKS          : pipeline produced a report or a list with items
  //   - LEGIT_NO_DATA  : no_data but router classified as market_intelligence
  //                      (further triage done by hand)
  //   - ROUTED_AWAY    : intent was greeting/off_topic/clarification
  let bucket;
  if (noData) bucket = 'NO_DATA';
  else if (routerResult.intent !== 'market_intelligence') bucket = 'ROUTED_AWAY';
  else if (type === 'list' && items > 0) bucket = 'WORKS';
  else if ((type === 'decision' || type === 'inference') && (sections > 0 || bodyText.length > 0)) bucket = 'WORKS';
  else bucket = 'EMPTY';

  return {
    ...item,
    routerIntent: routerResult.intent,
    routerType: routerResult.type,
    concepts: (routerResult.concept_keywords || []).join(', '),
    entities: (routerResult.entity_mentions || []).join(', '),
    sectorTerm: routerResult.sector_term || '',
    actualType: type,
    noData,
    sections,
    hasBodyText: bodyText.length > 0,
    items,
    sources,
    bucket,
    reason: noData ? (payload.message || '').slice(0, 220) : '',
    ms: Date.now() - t0,
  };
}

// ─────────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n' + LINE);
  console.log(' DI V2 — suggested questions audit');
  console.log(LINE);
  console.log(` clientId: ${CLIENT_ID}`);
  console.log(` industry: ${INDUSTRY}`);
  console.log(` questions: ${QUESTIONS.length}`);
  console.log(LINE + '\n');

  const results = [];
  for (const item of QUESTIONS) {
    process.stdout.write(` [${item.id.padEnd(5)}] ${item.q.slice(0, 62).padEnd(64)} `);
    const r = await runOne(item);
    results.push(r);

    if (r.error) {
      console.log(`✗ ${r.error}`);
      continue;
    }

    const tag =
      r.bucket === 'WORKS' ? '✓' :
      r.bucket === 'NO_DATA' ? '—' :
      r.bucket === 'ROUTED_AWAY' ? '·' :
      r.bucket === 'EMPTY' ? '?' : '✗';

    const detail =
      r.bucket === 'WORKS'
        ? `${r.actualType} sec=${r.sections} items=${r.items} src=${r.sources}`
        : r.bucket === 'NO_DATA'
          ? `no_data`
          : r.bucket === 'ROUTED_AWAY'
            ? `intent=${r.routerIntent}`
            : `empty (type=${r.actualType})`;

    console.log(`${tag} ${detail} | t=${r.ms}ms`);
    console.log(`        router: intent=${r.routerIntent} type=${r.routerType} concepts=[${r.concepts}] entities=[${r.entities}] sector=${r.sectorTerm}`);

    if (VERBOSE && r.bucket === 'NO_DATA') {
      console.log(`        reason: ${r.reason}`);
    }
  }

  // Bucket summary
  const works = results.filter(r => r.bucket === 'WORKS');
  const noData = results.filter(r => r.bucket === 'NO_DATA');
  const routedAway = results.filter(r => r.bucket === 'ROUTED_AWAY');
  const empty = results.filter(r => r.bucket === 'EMPTY');
  const errored = results.filter(r => r.error);

  console.log('\n' + LINE);
  console.log(' SUMMARY');
  console.log(LINE);
  console.log(` Total:        ${results.length}`);
  console.log(` ✓ WORKS:      ${works.length}`);
  console.log(` — NO_DATA:    ${noData.length}`);
  console.log(` · ROUTED_AWAY:${routedAway.length}`);
  console.log(` ? EMPTY:      ${empty.length}`);
  console.log(` ✗ ERRORS:     ${errored.length}`);
  console.log(LINE);

  if (noData.length > 0) {
    console.log('\n NO_DATA questions (need triage — real gap or pipeline bug?):');
    for (const r of noData) {
      console.log(`   [${r.id}] ${r.q}`);
      console.log(`        router: concepts=[${r.concepts}] entities=[${r.entities}] sector=${r.sectorTerm}`);
      console.log(`        reason: ${r.reason}`);
    }
  }

  if (empty.length > 0) {
    console.log('\n EMPTY (unexpected shape):');
    for (const r of empty) {
      console.log(`   [${r.id}] ${r.q} | type=${r.actualType}`);
    }
  }

  if (routedAway.length > 0) {
    console.log('\n ROUTED_AWAY (greeting/off_topic/clarification — should not happen for these):');
    for (const r of routedAway) {
      console.log(`   [${r.id}] ${r.q} | intent=${r.routerIntent}`);
    }
  }

  console.log('\n' + LINE + '\n');
})().catch((err) => { console.error('Fatal:', err); process.exit(1); });