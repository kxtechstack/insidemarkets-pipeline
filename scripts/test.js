/**
 * scripts/test-list.js
 *
 * Runs LIST questions straight through runV2Pipeline (no chat memory involved).
 * Includes all 10 questions from the "Question Library > List" tab, plus extra
 * regression questions.
 *
 * Automatic checks:
 *   1. every dated item is inside the requested date window
 *   2. no repeated titles
 *   3. optional "must include" / "must NOT include" title patterns
 *   4. same question gives the same list on repeat runs
 *   5. two wordings of the same question give (nearly) the same list
 *   6. REVIEW flag: item has none of the topic words for that question
 *      (a hint only. A person still has to read the report.)
 *
 * It also writes scripts/list-test-report.md, so you can read every answer
 * (date, module, category, title, link) and show it to your manager.
 *
 * Run (PowerShell, from C:\Users\kxblr\kx-pipeline):
 *   node scripts/test-list.js
 *
 * Options (all optional):
 *   $env:ONLY="library"    only the 10 Question Library questions
 *   $env:ONLY="extra"      only the extra regression questions
 *   $env:REPEATS=1         runs per question (default 2, more = slower)
 *   $env:SHOW_LOGS=1       show the full pipeline logs
 *   $env:TEST_CLIENT_ID="..."  $env:TEST_INDUSTRY="Cosmetics"
 */
try { require('dotenv').config(); } catch (_) { /* dotenv not installed: use existing environment */ }
const fs = require('fs');
const path = require('path');

// ── EDIT THESE IF NEEDED ───────────────────────────────────────────────
// Copy clientId + industry from the top of scripts/test-playground.js
const ROUTE_PATH = process.env.ROUTE_PATH || '../modules/decisionIntelligenceV2/route';
const CLIENT_ID  = process.env.TEST_CLIENT_ID || 'b61b4d3b-caeb-457b-9971-636c83688ee4';
const INDUSTRY   = process.env.TEST_INDUSTRY  || 'Cosmetics';
const REPEATS    = Number(process.env.REPEATS || 2);
const ONLY       = String(process.env.ONLY || '').toLowerCase();
// ───────────────────────────────────────────────────────────────────────

// days   = date window the question asks for (checked automatically)
// topic  = words an on-topic item should contain (REVIEW hint, not a hard fail)
// group  = questions in the same group must give nearly the same list
// mustInclude / mustNotInclude = regex checked against item titles (hard check)
const LIBRARY_TESTS = [
  { name: 'Weekly regulatory changes', q: 'What are the major policy changes in last one week?', days: 7,
    topic: /(regulat|polic|law|\bact\b|rule|ban|bill|legislat|compliance|enforce|directive|standard|mandate|tariff|amend|guidance|reform)/i },
  { name: 'Banned ingredients update', q: 'What ingredients were newly added to the restricted list this month?', days: 30,
    topic: /(ingredient|restrict|ban|prohibit|allergen|substance|limit|chemical|safety|pfas|fragrance|preservative|list)/i },
  { name: 'Funding rounds', q: 'List recent funding rounds in our Cosmetics industry', days: 30,
    topic: /(fund|raise|invest|financ|capital|round|secures|series [a-d]|seed|stake|backed|venture|ipo|valuation|million|billion|€|\$)/i,
    mustNotInclude: /(expands european presence|distribution partnership)/i },
  { name: 'Trade tariff adjustments', q: 'What are the current import tariff rates for our core products across key markets?',
    topic: /(tariff|duty|duties|import|export|customs|trade|section 232|levy|quota)/i },
  { name: 'Clinical trial protocols', q: 'What clinical trial protocols are mandated for our product category?',
    topic: /(clinical|trial|protocol|study|testing|safety|efficacy|fda|regulat|dermatolog|test)/i },
  { name: 'Competitive moves', q: 'List recent competitive moves by major Cosmetics players.', days: 30,
    topic: /(launch|acqui|merger|partner|expan|invest|rebrand|collaborat|open|introduc|raise|deal|stake|brand|l.or[eé]al|est[eé]e|shiseido|unilever|coty|amorepacific|lg h&h|beiersdorf|proya|natura)/i },
  { name: 'Cosmetics regulatory changes (30d)', q: 'List the major Cosmetics regulatory changes recorded in the last 30 days.', days: 30,
    topic: /(regulat|polic|law|\bact\b|rule|ban|bill|legislat|compliance|enforce|directive|standard|mandate|amend|guidance|reform)/i },
  { name: 'Market entrants', q: 'List the new entrants that have appeared in the Cosmetics sector this year.', days: 365,
    topic: /(launch|debut|enter|new brand|startup|start-up|founded|emerg|introduc|unveil|new entrant|spin|opens|first)/i,
    mustNotInclude: /(expands european presence|distribution)/i },
  { name: 'Technology shifts', q: 'List the emerging technologies gaining traction in Cosmetics.',
    topic: /(technolog|\bai\b|innovation|biotech|pdrn|microbiome|fermentation|nano|patent|platform|digital|formula|delivery|peptide|mitochondri|longevity|probiotic)/i },
  { name: 'Industry consolidation', q: 'List recent consolidation or merger activity in Cosmetics sector.', days: 30,
    topic: /(merger|acqui|consolidat|buyout|takeover|deal|stake|combine|purchase|m&a)/i },
];

const EXTRA_TESTS = [
  { name: '5 days',            q: 'recent regulatory fillings in last 5 days', days: 5 },
  { name: '7 days',            q: 'recent regulatory fillings in last 7 days', days: 7 },
  { name: 'quarter (List...)', q: 'List the most recent regulatory fillings recorded this quarter', days: 90, group: 'quarter' },
  { name: 'quarter (Give...)', q: 'Give the recent regulatory fillings recorded this quarter',      days: 90, group: 'quarter' },
  { name: 'Slovakia',          q: 'What new regulations has Slovakia implemented to combat greenwashing?', mustInclude: /slovakia/i },
];

let TESTS = [...LIBRARY_TESTS, ...EXTRA_TESTS];
if (ONLY === 'library') TESTS = LIBRARY_TESTS;
if (ONLY === 'extra') TESTS = EXTRA_TESTS;

if (CLIENT_ID.startsWith('PASTE')) {
  console.log('Set CLIENT_ID at the top of scripts/test-list.js (copy it from scripts/test-playground.js).');
  process.exit(1);
}

const { runV2Pipeline } = require(ROUTE_PATH);

// ── helpers ────────────────────────────────────────────────────────────
const realLog = console.log;
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const short = (d) => (d ? String(d).slice(0, 10) : 'no date');

function ageInDays(dateStr) {
  if (!dateStr) return null;
  const t = new Date(dateStr).getTime();
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 86400000;
}

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

async function runOnce(question) {
  if (!process.env.SHOW_LOGS) console.log = () => {};
  try {
    const out = await runV2Pipeline({ question, clientId: CLIENT_ID, industry: INDUSTRY, forcedType: process.env.FORCE_LIST ? 'list' : undefined });
    return out.payload || out;
  } finally {
    console.log = realLog;
  }
}

function checkOne(test, payload) {
  const fails = [];
  const notes = [];
  const items = payload.items || [];
  const titles = items.map((i) => norm(i.title));

  if (payload.type !== 'list') fails.push(`answered as "${payload.type}", not a list`);

  // 1. date window
  if (test.days) {
    const tooOld = [];
    let undated = 0;
    for (const it of items) {
      const age = ageInDays(it.publishedDate);
      if (age === null) { undated++; continue; }
      if (age > test.days + 1) tooOld.push(`${short(it.publishedDate)} | ${it.title}`);
    }
    if (tooOld.length) fails.push(`items OLDER than ${test.days} days:\n        ${tooOld.join('\n        ')}`);
    if (undated) notes.push(`${undated} item(s) have no date (date not checked)`);
  }

  // 2. repeated titles
  const dupes = titles.filter((t, i) => titles.indexOf(t) !== i);
  if (dupes.length) fails.push(`repeated titles: ${[...new Set(dupes)].join(' | ')}`);

  // 3. title patterns
  if (test.mustInclude && !items.some((i) => test.mustInclude.test(i.title || ''))) {
    fails.push(`no item title matches ${test.mustInclude}`);
  }
  if (test.mustNotInclude) {
    const bad = items.filter((i) => test.mustNotInclude.test(i.title || '')).map((i) => i.title);
    if (bad.length) fails.push(`should NOT be shown: ${bad.join(' | ')}`);
  }

  // 6. REVIEW hint: no topic word in title / summary / category
  const review = [];
  if (test.topic) {
    for (const it of items) {
      const text = `${it.title || ''} ${it.summary || ''} ${it.category || ''}`;
      if (!test.topic.test(text)) review.push(it.title);
    }
  }

  return { fails, notes, titles, items, review, noData: Boolean(payload.no_data), message: payload.message || '' };
}

// ── main ───────────────────────────────────────────────────────────────
(async () => {
  let failCount = 0;
  let warnCount = 0;
  const firstRunTitles = {};
  const report = [];

  realLog(`\nClient: ${CLIENT_ID} | Industry: ${INDUSTRY} | Repeats: ${REPEATS} | Questions: ${TESTS.length}`);
  realLog(`Today: ${new Date().toISOString().slice(0, 10)}\n`);

  for (const test of TESTS) {
    realLog('─'.repeat(78));
    realLog(`▶ ${test.name}: "${test.q}"${test.days ? `   [window ${test.days}d]` : ''}`);

    const runs = [];
    for (let r = 1; r <= REPEATS; r++) {
      try {
        runs.push(checkOne(test, await runOnce(test.q)));
      } catch (err) {
        runs.push({ error: err.message, fails: [`ERROR: ${err.message}`], notes: [], titles: [], items: [], review: [] });
      }
    }

    const first = runs[0];
    firstRunTitles[test.name] = first.titles;

    if (first.error) {
      realLog(`   ❌ ${first.error}`);
    } else if (first.noData || first.items.length === 0) {
      realLog('   (no-data answer: "I don\'t have relevant data…"). Check if that is correct for your data.');
    } else {
      realLog(`   ${first.items.length} item(s):`);
      for (const it of first.items) {
        const flag = first.review.includes(it.title) ? '  ⚠️ REVIEW' : '';
        realLog(`     ${short(it.publishedDate)} | ${it.title}${flag}`);
      }
    }

    const allFails = [...new Set(runs.flatMap((r) => r.fails))];
    const allNotes = [...new Set(runs.flatMap((r) => r.notes))];
    if (allFails.length === 0) realLog('   ✅ date window / duplicates / title checks passed');
    for (const f of allFails) { realLog(`   ❌ ${f}`); failCount++; }
    for (const n of allNotes) realLog(`   ℹ️  ${n}`);
    if (first.review && first.review.length) {
      realLog(`   ⚠️  ${first.review.length} of ${first.items.length} item(s) have none of the expected topic words. Read them in the report.`);
      warnCount++;
    }

    // 4. stability across repeats
    let stability = 'n/a';
    if (runs.length > 1 && !runs.some((r) => r.error)) {
      const worst = Math.min(...runs.slice(1).map((r) => jaccard(runs[0].titles, r.titles)));
      if (worst === 1) { stability = `same on all ${runs.length} runs`; realLog(`   ✅ ${stability}`); }
      else if (worst >= 0.8) { stability = `small difference (${(worst * 100).toFixed(0)}% overlap)`; realLog(`   ⚠️  ${stability}`); warnCount++; }
      else { stability = `CHANGES between runs (${(worst * 100).toFixed(0)}% overlap)`; realLog(`   ❌ ${stability}`); failCount++; }
    }

    report.push({ test, first, allFails, stability });
  }

  // 5. wordings of the same question
  const groups = {};
  for (const t of TESTS) if (t.group) (groups[t.group] = groups[t.group] || []).push(t.name);
  const groupLines = [];
  for (const [g, names] of Object.entries(groups)) {
    realLog('─'.repeat(78));
    for (let i = 1; i < names.length; i++) {
      const sim = jaccard(firstRunTitles[names[0]], firstRunTitles[names[i]]);
      const pct = (sim * 100).toFixed(0);
      const ok = sim >= 0.5;
      const line = `${ok ? '✅' : '❌'} group "${g}": "${names[0]}" vs "${names[i]}" overlap ${pct}%${ok ? '' : ' (too different)'}`;
      realLog(line);
      groupLines.push(line);
      if (!ok) failCount++;
    }
  }

  // ── report file ──────────────────────────────────────────────────────
  const md = [];
  md.push('# List test report');
  md.push(`Date: ${new Date().toISOString().slice(0, 10)} | Client: ${CLIENT_ID} | Industry: ${INDUSTRY}\n`);
  for (const { test, first, allFails, stability } of report) {
    md.push(`## ${test.name}`);
    md.push(`**Question:** ${test.q}  `);
    md.push(`**Window:** ${test.days ? `${test.days} days` : 'none'} | **Items:** ${first.items.length} | **Stability:** ${stability}  `);
    md.push(`**Checks:** ${allFails.length === 0 ? 'passed' : 'FAILED: ' + allFails.join(' ; ').replace(/\n\s*/g, ' / ')}\n`);
    if (first.items.length === 0) {
      md.push(`_No-data answer._ ${first.message || ''}\n`);
    } else {
      md.push('| Date | Module | Category | Title | Topic hint |');
      md.push('|---|---|---|---|---|');
      for (const it of first.items) {
        const flag = first.review.includes(it.title) ? 'REVIEW' : 'ok';
        const title = String(it.title || '').replace(/\|/g, '/');
        const link = it.url ? `[${title}](${it.url})` : title;
        md.push(`| ${short(it.publishedDate)} | ${it.module || ''} | ${it.category || ''} | ${link} | ${flag} |`);
      }
      md.push('');
    }
  }
  if (groupLines.length) { md.push('## Same question, different wording'); md.push(groupLines.join('  \n')); }
  const reportPath = path.join(__dirname, 'list-test-report.md');
  fs.writeFileSync(reportPath, md.join('\n'), 'utf8');

  realLog('═'.repeat(78));
  realLog(failCount === 0
    ? `ALL CHECKS PASSED (${warnCount} warning(s))`
    : `${failCount} CHECK(S) FAILED, ${warnCount} warning(s)`);
  realLog(`Full answers written to: ${reportPath}`);
  process.exit(failCount === 0 ? 0 : 1);
})().catch((err) => {
  console.log = realLog;
  console.error('Test script crashed:', err);
  process.exit(1);
});