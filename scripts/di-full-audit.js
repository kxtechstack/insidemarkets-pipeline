/**
 * scripts/di-full-audit.js
 *
 * Deep audit: for each suggested question, run the full pipeline and print:
 *   1. Router output
 *   2. Retrieval summary
 *   3. The actual chunks that were passed to the writer (truncated)
 *   4. The final answer (sections + bullets, or list items)
 *   5. The sources cited
 *
 * Manual grounding check: after running this, you can eyeball whether
 * each bullet is actually supported by one of the chunks shown above it.
 *
 * Reworded questions are baked in (see REWORDED_QUESTIONS below).
 *
 * Usage:
 *   node scripts/di-full-audit.js
 *   node scripts/di-full-audit.js --only DI,IN
 *   node scripts/di-full-audit.js --q "single question here"
 *   node scripts/di-full-audit.js --chunk-max 600
 */

require('dotenv').config();

const { runV2Pipeline } = require('../modules/decisionIntelligenceV2/route');
const { route } = require('../modules/decisionIntelligenceV2/routing/router');
const { retrieveClientSignals } = require('../modules/decisionIntelligenceV2/retrieval/clientSignalsRetrieval');
const { retrieveCustomSourceHits } = require('../modules/decisionIntelligenceV2/retrieval/customSourceRetrieval');
const { normalizeConcepts, containsPhrase } = require('../modules/decisionIntelligenceV2/retrieval/filterListHits');

// ─────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────
function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const CLIENT_ID = argVal('--client', process.env.DI_CLIENT_ID || 'b61b4d3b-caeb-457b-9971-636c83688ee4');
const INDUSTRY  = argVal('--industry', process.env.DI_INDUSTRY || 'Cosmetics');
const ONLY      = argVal('--only', null);      // e.g. "DI,IN"
const SINGLE_Q  = argVal('--q', null);
const CHUNK_MAX = Number(argVal('--chunk-max', 500));

const LINE = '━'.repeat(100);
const SUB  = '─'.repeat(100);

// ─────────────────────────────────────────────────────────────────────────
// Reworded questions — the 30 original, with the 11 problem cases reworked
// to use vocabulary the client's data can actually support.
// ─────────────────────────────────────────────────────────────────────────
const QUESTIONS = [
  // ── Decision Intelligence (10) ──────────────────────────────────────
  { id: 'DI-1',  cat: 'Decision Intelligence',
    q: 'What recent regulatory changes are affecting the cosmetics industry?',
    changed: true,
    original: 'Should we adjust our compliance approach given recent regulatory changes?' },

  { id: 'DI-2',  cat: 'Decision Intelligence',
    q: 'How would you characterize the current investment climate in Cosmetics industry?' },

  { id: 'DI-3',  cat: 'Decision Intelligence',
    q: 'List recent partnership or joint venture activity in the Cosmetics industry.',
    changed: true,
    original: 'What partnership or joint venture patterns are common in Cosmetics industry right now?',
    note: 'Changed from inference to list — "list recent X" matches how our signals are structured.' },

  { id: 'DI-4',  cat: 'Decision Intelligence',
    q: 'What regulatory certifications are required for manufacturing cosmetics in key markets?',
    changed: true,
    original: 'Is acquiring a local manufacturing facility viable for certification acceleration?' },

  { id: 'DI-5',  cat: 'Decision Intelligence',
    q: 'Do a PESTLE analysis for Cosmetics industry' },

  { id: 'DI-6',  cat: 'Decision Intelligence',
    q: 'What emerging technologies are being adopted in the cosmetics industry?',
    changed: true,
    original: 'What emerging technologies are most likely to disrupt our market?' },

  { id: 'DI-7',  cat: 'Decision Intelligence',
    q: 'What competitive moves are emerging Cosmetics players making in the market?',
    changed: true,
    original: 'How should we strategically defend market share against emerging Cosmetics competitors?' },

  { id: 'DI-8',  cat: 'Decision Intelligence',
    q: 'What supply chain developments are affecting the cosmetics industry?',
    changed: true,
    original: 'How should we restructure our Cosmetics supply chain to reduce concentration risk?' },

  { id: 'DI-9',  cat: 'Decision Intelligence',
    q: 'Should we introduce a premium Cosmetics tier priced above our current top segment?' },

  { id: 'DI-10', cat: 'Decision Intelligence',
    q: 'What partnership activity is happening in the Cosmetics industry?',
    changed: true,
    original: 'What partnership model would accelerate our Cosmetics growth fastest?' },

  // ── Inference (10) ──────────────────────────────────────────────────
  { id: 'IN-1',  cat: 'Inference',
    q: 'How is pricing evolving in the Cosmetics industry?',
    changed: true,
    original: 'How has the competitors pricing changed in last week?' },

  { id: 'IN-2',  cat: 'Inference',
    q: 'What supply chain disruptions are affecting cosmetics ingredient sourcing?',
    changed: true,
    original: 'How are regional port delays impacting shipping lead times for raw materials?' },

  { id: 'IN-3',  cat: 'Inference',
    q: 'What consumer search trends are emerging in the Cosmetics industry?',
    changed: true,
    original: 'How has organic search volume for our top category grown relative to alternatives?' },

  { id: 'IN-4',  cat: 'Inference',
    q: 'What patent activity is happening in the cosmetics and beauty industry?' },

  { id: 'IN-5',  cat: 'Inference',
    q: 'How is social commerce reshaping the cosmetics retail landscape?',
    changed: true,
    original: 'How does social commerce conversion rate compare against traditional brand storefronts?' },

  { id: 'IN-6',  cat: 'Inference',
    q: 'How has demand in Cosmetics shifted over the last 90 days?' },

  { id: 'IN-7',  cat: 'Inference',
    q: 'How are raw material cost changes affecting the Cosmetics industry?' },

  { id: 'IN-8',  cat: 'Inference',
    q: 'How has consumer sentiment towards Cosmetics shifted recently?' },

  { id: 'IN-9',  cat: 'Inference',
    q: 'How are recent regulatory changes affecting Cosmetics operating costs?' },

  { id: 'IN-10', cat: 'Inference',
    q: 'How quickly is new technology being adopted in the Cosmetics sector?' },

  // ── List (10) ───────────────────────────────────────────────────────
  { id: 'LI-1',  cat: 'List',
    q: 'What are the major policy changes in last one week?' },

  { id: 'LI-2',  cat: 'List',
    q: 'What ingredients were newly added to the restricted list this month?' },

  { id: 'LI-3',  cat: 'List',
    q: 'List recent funding rounds in our Cosmetics industry' },

  { id: 'LI-4',  cat: 'List',
    q: 'What are the current import tariff rates for our core products across key markets?' },

  { id: 'LI-5',  cat: 'List',
    q: 'What clinical trial protocols are mandated for our product category?' },

  { id: 'LI-6',  cat: 'List',
    q: 'List recent competitive moves by major Cosmetics players.',
    changed: true,
    original: 'List the top 10 competitors operating in the Cosmetics market.',
    note: 'Reworded — the client data tracks signals (news about what companies DO), not a ranked list of top players.' },

  { id: 'LI-7',  cat: 'List',
    q: 'List the major Cosmetics regulatory changes recorded in the last 30 days.' },

  { id: 'LI-8',  cat: 'List',
    q: 'List the new entrants that have appeared in the Cosmetics sector this year.' },

  { id: 'LI-9',  cat: 'List',
    q: 'List the emerging technologies gaining traction in Cosmetics.' },

  { id: 'LI-10', cat: 'List',
    q: 'List recent consolidation or merger activity in Cosmetics sector.' },
];

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────
const shorten = (s, n) => {
  if (!s) return '';
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
};

function filterForInferenceOrDecision(clientHits, concepts) {
  const clean = normalizeConcepts(concepts);
  if (clean.length === 0) return clientHits;
  return clientHits.filter((h) => {
    const haystack = `${h.title || ''} ${h.chunk_text || ''}`;
    return clean.some((c) => containsPhrase(haystack, c));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Run one question deeply
// ─────────────────────────────────────────────────────────────────────────
async function auditOne(item) {
  console.log('\n' + LINE);
  console.log(` [${item.id}] ${item.cat}${item.changed ? '  [REWORDED]' : ''}`);
  console.log(` Q: ${item.q}`);
  if (item.changed && item.original) {
    console.log(` OLD: ${item.original}`);
    if (item.note) console.log(` NOTE: ${item.note}`);
  }
  console.log(LINE);

  const tStart = Date.now();

  // ── 1. Router ──────────────────────────────────────────────────────
  const routerResult = await route(item.q, INDUSTRY);
  console.log(`\n[1] ROUTER`);
  console.log(`    intent:    ${routerResult.intent}`);
  console.log(`    type:      ${routerResult.type}`);
  console.log(`    concepts:  [${(routerResult.concept_keywords || []).join(', ')}]`);
  console.log(`    entities:  [${(routerResult.entity_mentions || []).join(', ')}]`);
  console.log(`    sector:    ${routerResult.sector_term || '(none)'}`);
  console.log(`    time:      ${routerResult.time_constraint?.present ? `${routerResult.time_constraint.value} ${routerResult.time_constraint.unit}` : 'none'}`);

  if (routerResult.intent !== 'market_intelligence') {
    console.log(`\n    → Non-market-intelligence. Pipeline would short-circuit here.`);
    return { id: item.id, bucket: 'ROUTED_AWAY', routerResult };
  }

  // ── 2. Retrieval ───────────────────────────────────────────────────
  const isFramework = /\b(swot|pestle|pestel|five\s*forces|5\s*forces|porter|risk\s*analysis|risk\s*categor)/i.test(item.q);

  const [clientRetr, customHits] = await Promise.all([
    retrieveClientSignals(item.q, CLIENT_ID, INDUSTRY, { precomputedUnderstanding: routerResult }),
    retrieveCustomSourceHits(item.q, CLIENT_ID),
  ]);

  const conceptsForFilter = [
    ...(routerResult.concept_keywords || []),
    ...(routerResult.entity_mentions || []),
  ];

  let keptClient;
  let keptCustom;
  if (routerResult.type === 'list') {
    const { filterListHits } = require('../modules/decisionIntelligenceV2/retrieval/filterListHits');
    keptClient = filterListHits(clientRetr.hits, conceptsForFilter);
    keptCustom = [];
  } else if (isFramework) {
    keptClient = clientRetr.hits;
    keptCustom = customHits;
  } else {
    keptClient = filterForInferenceOrDecision(clientRetr.hits, conceptsForFilter);
    keptCustom = customHits;
  }

  console.log(`\n[2] RETRIEVAL`);
  console.log(`    client hits:  ${clientRetr.hits.length} total, ${keptClient.length} kept after filter`);
  console.log(`    custom hits:  ${customHits.length}${routerResult.type === 'list' ? ' (list — custom not used)' : ''}`);
  console.log(`    framework?   ${isFramework}`);

  // ── 3. The actual chunks passed to the writer ─────────────────────
  console.log(`\n[3] CHUNKS PASSED TO WRITER (top 6 client + top 3 custom)`);

  console.log(`\n    ── CLIENT CHUNKS ──`);
  const clientChunksForDisplay = keptClient.slice(0, 6);
  if (clientChunksForDisplay.length === 0) {
    console.log(`    (none)`);
  }
  clientChunksForDisplay.forEach((h, i) => {
    console.log(`\n    [${i + 1}] ${h.module_name || '?'} — ${shorten(h.title, 90)}`);
    console.log(`        chunk: ${shorten(h.chunk_text, CHUNK_MAX)}`);
    console.log(`        url:   ${h.url || '(none)'}`);
  });

  if (keptCustom.length > 0) {
    console.log(`\n    ── CUSTOM SOURCE CHUNKS ──`);
    keptCustom.slice(0, 3).forEach((c, i) => {
      const p = c.payload || {};
      console.log(`\n    [${i + 1}] ${p.source_name || '?'} — chunk ${p.chunk_index}`);
      console.log(`        chunk: ${shorten(p.chunk_text, CHUNK_MAX)}`);
    });
  }

  // ── 4. Final answer ────────────────────────────────────────────────
  const pipelineResult = await runV2Pipeline({
    question: item.q,
    clientId: CLIENT_ID,
    industry: INDUSTRY,
    forcedType: null,
  });

  const payload = pipelineResult.payload || {};

  console.log(`\n[4] FINAL ANSWER`);
  console.log(`    type:      ${payload.type}`);
  if (payload.no_data) console.log(`    no_data:   YES`);
  if (payload.message) console.log(`    message:   ${shorten(payload.message, 200)}`);

  if (payload.type === 'list' && Array.isArray(payload.items)) {
    console.log(`    items:     ${payload.items.length}`);
    payload.items.slice(0, 10).forEach((it, i) => {
      console.log(`      [${i + 1}] ${it.module || '?'} — ${shorten(it.title, 90)}`);
      if (it.summary) console.log(`          ${shorten(it.summary, 160)}`);
    });
  }

  if ((payload.type === 'decision' || payload.type === 'inference') && payload.report) {
    const r = payload.report;
    console.log(`    title:     ${r.title || '(none)'}`);
    if (Array.isArray(r.sections)) {
      console.log(`    sections:  ${r.sections.length}`);
      r.sections.forEach((s, si) => {
        console.log(`\n      ▸ ${s.heading}`);
        (s.points || []).forEach((p) => {
          console.log(`        • ${shorten(p, 240)}`);
        });
      });
    }
    if (r.bodyText) {
      console.log(`    bodyText:  ${shorten(r.bodyText, 400)}`);
    }
    if (r.bottom_line) {
      console.log(`\n    bottom_line: ${shorten(r.bottom_line, 300)}`);
    }
  }

  // ── 5. Sources ─────────────────────────────────────────────────────
  console.log(`\n[5] SOURCES CITED (${(payload.sources || []).length})`);
  (payload.sources || []).slice(0, 12).forEach((s, i) => {
    const label = s.type === 'sec' ? 'SEC' : s.type === 'client' ? 'CLIENT' : s.type === 'custom_source' ? 'CUSTOM' : '?';
    const title = s.title || s.source_name || '(no title)';
    const detail = s.ticker ? ` [${s.ticker} FY${s.fiscal_year} ${s.item_code}]` : '';
    console.log(`    [${i + 1}] ${label}${detail} — ${shorten(title, 90)}`);
    if (s.url) console.log(`        url: ${s.url}`);
  });

  // ── Summary ────────────────────────────────────────────────────────
  const elapsed = Date.now() - tStart;
  let bucket;
  if (payload.no_data) bucket = 'NO_DATA';
  else if (payload.type === 'list' && (payload.items || []).length > 0) bucket = 'WORKS';
  else if ((payload.type === 'decision' || payload.type === 'inference') && payload.report) bucket = 'WORKS';
  else bucket = 'EMPTY';

  console.log(`\n[RESULT] ${bucket}  (${elapsed}ms)`);

  return { id: item.id, bucket, elapsed, routerResult, payload };
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────
(async () => {
  let questions = QUESTIONS;
  if (SINGLE_Q) {
    questions = [{ id: 'INLINE', cat: 'Inline', q: SINGLE_Q }];
  } else if (ONLY) {
    const cats = ONLY.split(',').map(c => c.trim().toUpperCase());
    const idPrefixes = cats.map(c => c.toLowerCase() + '-');
    questions = QUESTIONS.filter(q => idPrefixes.some(p => q.id.toLowerCase().startsWith(p)));
  }

  console.log('\n' + LINE);
  console.log(' DI V2 — full audit (rewritten questions)');
  console.log(LINE);
  console.log(` clientId: ${CLIENT_ID}`);
  console.log(` industry: ${INDUSTRY}`);
  console.log(` questions: ${questions.length}`);
  console.log(` chunk preview: ${CHUNK_MAX} chars`);
  console.log(LINE);

  const results = [];
  for (const item of questions) {
    try {
      const r = await auditOne(item);
      results.push(r);
    } catch (err) {
      console.log(`\n[ERROR] ${item.id}: ${err.message}`);
      results.push({ id: item.id, bucket: 'ERROR', error: err.message });
    }
  }

  // Summary
  const works = results.filter(r => r.bucket === 'WORKS').length;
  const noData = results.filter(r => r.bucket === 'NO_DATA').length;
  const routedAway = results.filter(r => r.bucket === 'ROUTED_AWAY').length;
  const empty = results.filter(r => r.bucket === 'EMPTY').length;
  const errored = results.filter(r => r.bucket === 'ERROR').length;

  console.log('\n' + LINE);
  console.log(' SUMMARY');
  console.log(LINE);
  console.log(` Total:         ${results.length}`);
  console.log(` ✓ WORKS:       ${works}`);
  console.log(` — NO_DATA:     ${noData}`);
  console.log(` · ROUTED_AWAY: ${routedAway}`);
  console.log(` ? EMPTY:       ${empty}`);
  console.log(` ✗ ERRORS:      ${errored}`);

  if (noData > 0) {
    console.log(`\n Questions still returning no_data:`);
    results.filter(r => r.bucket === 'NO_DATA').forEach(r => {
      console.log(`   [${r.id}]`);
    });
  }

  console.log(LINE + '\n');
})().catch((err) => { console.error('Fatal:', err); process.exit(1); });