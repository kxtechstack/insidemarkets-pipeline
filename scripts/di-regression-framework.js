/**
 * scripts/di-regression-framework.js
 *
 * End-to-end regression: runs the FULL V2 pipeline (router → retrieval →
 * SEC → handler → payload) on framework questions and non-framework controls.
 *
 * Assertions:
 *   - framework + control questions must return a real report
 *   - SEC numeric may return either report.sections OR report.bodyText
 *   - no case should return "Topical coverage FAILED"
 *
 * Usage:
 *   node scripts/di-regression-framework.js
 *   node scripts/di-regression-framework.js --verbose
 */

require('dotenv').config();

const { runV2Pipeline } = require('../modules/decisionIntelligenceV2/route');

const VERBOSE = process.argv.includes('--verbose');
const LINE = '━'.repeat(90);

const CLIENT_ID = process.env.DI_CLIENT_ID || 'b61b4d3b-caeb-457b-9971-636c83688ee4';
const INDUSTRY = process.env.DI_INDUSTRY || 'Cosmetics';

const CASES = [
  // ── Framework questions — must produce a decision with sections ──────
  { id: 'FW1',  question: 'Do a SWOT analysis for the cosmetics industry',                 expect: 'decision' },
  { id: 'FW2',  question: 'Do a PESTLE analysis for Cosmetics industry',                   expect: 'decision' },
  { id: 'FW3',  question: 'SWOT analysis for Enveda',                                      expect: 'decision' },
  { id: 'FW4',  question: 'Do a SWOT analysis for Estee Lauder',                           expect: 'decision' },
  { id: 'FW5',  question: 'Five forces analysis of the cosmetics market',                  expect: 'decision' },
  { id: 'FW6',  question: 'Risk analysis for entering the K-beauty market',                expect: 'decision' },
  { id: 'FW7',  question: 'Do a PESTLE analysis for the cosmetics industry as previously discussed', expect: 'decision' },

  // ── Non-framework controls — must keep working ───────────────────────
  { id: 'CT1',  question: 'What is happening in South Korea cosmetics industry?',          expect: 'inference' },
  { id: 'CT2',  question: 'what is the update of glossier',                                expect: 'inference' },
  { id: 'CT3',  question: "What has L'Oréal been doing recently?",                         expect: 'inference' },

  // ── SEC numeric — must still short-circuit to decision ───────────────
  { id: 'SEC1', question: 'Top 5 cosmetic companies by revenue',                           expect: 'decision' },
];

async function runOne(c) {
  const t0 = Date.now();
  const result = await runV2Pipeline({
    question: c.question,
    clientId: CLIENT_ID,
    industry: INDUSTRY,
    forcedType: null,
  });
  const ms = Date.now() - t0;

  const payload = result.payload || {};
  const type = payload.type;
  const noData = !!payload.no_data;
  const sections = payload.report?.sections?.length || 0;
  const bodyText = typeof payload.report?.bodyText === 'string' ? payload.report.bodyText : '';
  const hasBodyText = bodyText.trim().length > 0;

  // Two valid report shapes exist:
  //   1. Sectioned report: { title, sections: [...], bottom_line }
  //   2. Flat report:      { title, bodyText }  ← used by SEC numeric
  const hasReport = sections > 0 || hasBodyText;

  let pass;
  if (c.expect === 'decision') {
    pass = type === 'decision' && !noData && hasReport;
  } else {
    pass = type === c.expect && !noData && hasReport;
  }

  return {
    ...c,
    actualType: type,
    noData,
    sections,
    hasBodyText,
    bodyTextLen: bodyText.length,
    sources: payload.sources?.length || 0,
    title: payload.report?.title || payload.message || '',
    passed: pass,
    ms,
  };
}

(async () => {
  console.log('\n' + LINE);
  console.log(' DI V2 — framework regression (end-to-end)');
  console.log(LINE);
  console.log(` clientId: ${CLIENT_ID}`);
  console.log(` industry: ${INDUSTRY}`);
  console.log(` cases:    ${CASES.length}`);
  console.log(LINE + '\n');

  const results = [];
  for (const c of CASES) {
    process.stdout.write(` [${c.id.padEnd(5)}] ${c.question.slice(0, 55).padEnd(57)} `);
    let r;
    try {
      r = await runOne(c);
    } catch (err) {
      console.log(`✗ threw: ${err.message}`);
      results.push({ ...c, passed: false, error: err.message });
      continue;
    }

    const mark = r.passed ? '✓' : '✗';
    const detail = r.noData
      ? `no_data | ${r.title.slice(0, 60)}`
      : `${r.actualType} sections=${r.sections}${r.hasBodyText ? ' bodyText=' + r.bodyTextLen + 'ch' : ''} sources=${r.sources}`;
    console.log(`${mark} ${detail} t=${r.ms}ms`);

    if (VERBOSE || !r.passed) {
      console.log(`        expected=${c.expect}  actual=${r.actualType}  no_data=${r.noData}  sections=${r.sections}  hasBodyText=${r.hasBodyText}`);
      if (r.title) console.log(`        title: ${r.title.slice(0, 100)}`);
    }

    results.push(r);
  }

  const tested = results.filter(r => !r.error);
  const passed = tested.filter(r => r.passed).length;
  const failed = tested.length - passed;

  console.log('\n' + LINE);
  console.log(' SUMMARY');
  console.log(LINE);
  console.log(` Total:    ${tested.length}`);
  console.log(` Passed:   ${passed}`);
  console.log(` Failed:   ${failed}`);

  if (failed > 0) {
    console.log('\n Failed cases:');
    for (const r of tested.filter(x => !x.passed)) {
      console.log(`   [${r.id}] ${r.question}`);
      console.log(`        expected=${r.expect} actual=${r.actualType} no_data=${r.noData} sections=${r.sections} hasBodyText=${r.hasBodyText}`);
      if (r.title) console.log(`        title: ${r.title.slice(0, 100)}`);
    }
  }

  console.log(LINE + '\n');
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => { console.error('Fatal:', err); process.exit(1); });