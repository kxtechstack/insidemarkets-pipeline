/**
 * scripts/di-v2-stage1.js
 *
 * STAGE 1g diagnostic harness.
 *
 * Changes from Stage 1f:
 *   - Marks each hit with [M] (matched) or [U] (un-matched) so we can see
 *     the two-tier ordering at a glance.
 *   - Prints matched / un-matched counts in the summary line.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const {
  retrieveClientSignals,
} = require('../modules/decisionIntelligenceV2/retrieval/clientSignalsRetrieval');

function parseArgs(argv) {
  const args = {
    questionsFile: null, question: null, client: null, industry: null,
    floor: null, vectorFloor: null, topk: null, perModule: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--questions')        args.questionsFile = next();
    else if (a === '--q')           args.question = next();
    else if (a === '--client')      args.client = next();
    else if (a === '--industry')    args.industry = next();
    else if (a === '--floor')       args.floor = Number(next());
    else if (a === '--vector-floor') args.vectorFloor = Number(next());
    else if (a === '--topk')        args.topk = Number(next());
    else if (a === '--per-module')  args.perModule = Number(next());
  }
  return args;
}

const LINE = '━'.repeat(90);
const SUB  = '─'.repeat(90);

const fmt  = (n) => (typeof n === 'number' ? n.toFixed(3) : String(n));
const dstr = (d) => {
  if (!d) return 'no-date';
  try { return new Date(d).toISOString().slice(0, 10); }
  catch { return String(d).slice(0, 10); }
};
const short = (s, n) => {
  if (!s) return '';
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
};

function printUnderstanding(u) {
  console.log(' LLM UNDERSTANDING:');
  console.log(`   type:            ${u.question_type}`);
  console.log(`   primary_intent:  ${short(u.primary_intent, 140)}`);
  console.log(`   is_company_set:  ${u.is_company_set_query}`);
  if (u.time_constraint?.present) {
    console.log(
      `   time_constraint: ${u.time_constraint.value} ${u.time_constraint.unit} ` +
      `("${u.time_constraint.phrase}")`
    );
  } else {
    console.log(`   time_constraint: none`);
  }
  console.log(
    `   entities:        ${u.entity_mentions.length ? u.entity_mentions.join(', ') : '(none)'}`
  );
  console.log(
    `   concepts:        ${u.concept_keywords.length ? u.concept_keywords.join(' | ') : '(none)'}`
  );
  if (u.industry_context) {
    console.log(`   industry:        ${u.industry_context}`);
  }
  if (u._fallback) {
    console.log(`   ⚠  LLM understanding fallback was used`);
  }
}

function printWindow(tw) {
  if (tw.requested === null) {
    console.log(` TIME WINDOW:     none requested`);
    return;
  }
  const appliedLabel = tw.applied === null ? 'no filter' : `${tw.applied}d`;
  console.log(
    ` TIME WINDOW:     requested=${tw.requested}d  applied=${appliedLabel}` +
    (tw.widened ? '  ⚠ widened' : '') +
    (tw.phrase ? `  ("${tw.phrase}")` : '')
  );
}

function printHits(hits, meta) {
  if (hits.length === 0) {
    console.log(` HITS: none above floor`);
    return;
  }

  const counts = { 'Policy & Risk': 0, 'Market Dynamics': 0, 'Forward Outlook': 0, Unknown: 0 };
  for (const h of hits) counts[h.module_name] = (counts[h.module_name] || 0) + 1;

  console.log(
    ` HITS: ${hits.length}  |  ` +
    `Policy=${counts['Policy & Risk']}  MD=${counts['Market Dynamics']}  FO=${counts['Forward Outlook']}  ` +
    `| M=${meta.matchedCount || 0} U=${meta.unmatchedCount || 0}`
  );
  console.log(SUB);

  hits.forEach((h, i) => {
    const idx = String(i + 1).padStart(2, ' ');
    const mod = h.module_name.padEnd(16, ' ');
    const base = h._vector_score ?? h.score;
    const mult = h._boost_mult ?? 1.0;
    const final = h.score;
    const tag = h._matched ? '[M]' : '[U]';
    console.log(
      ` [${idx}] ${tag} final=${fmt(final)}  (vector=${fmt(base)} × boost=${mult.toFixed(2)})  | ${mod} | pub=${dstr(h.published_date)}`
    );
    console.log(`      title: ${short(h.title, 100)}`);
    console.log(`      chunk: ${short(h.chunk_text, 200)}`);

    const m = h._boost_matched || {};
    const pieces = [];
    if (m.conceptsInTitle?.length) pieces.push(`C:[${m.conceptsInTitle.join(',')}]`);
    if (m.entitiesInTitle?.length) pieces.push(`E:[${m.entitiesInTitle.join(',')}]`);
    if (pieces.length) console.log(`      boost: ${pieces.join(' ')}`);

    console.log('');
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const clientId = args.client
    || process.env.DI_CLIENT_ID
    || 'b61b4d3b-caeb-457b-9971-636c83688ee4';
  const industry = args.industry
    || process.env.DI_INDUSTRY
    || 'Cosmetics';

  const opts = {
    finalFloor:      args.floor       ?? 0.20,
    vectorFloor:     args.vectorFloor ?? 0.20,
    topK:            args.topk        ?? 15,
    perModuleLimit:  args.perModule   ?? 15,
  };

  let questions = [];
  if (args.question) {
    questions = [{ id: 'inline', question: args.question }];
  } else if (args.questionsFile) {
    const p = path.isAbsolute(args.questionsFile)
      ? args.questionsFile
      : path.resolve(process.cwd(), args.questionsFile);
    if (!fs.existsSync(p)) {
      console.error(`Questions file not found: ${p}`);
      process.exit(1);
    }
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    questions = parsed;
  } else {
    console.error('Provide --q "<question>" or --questions <file.json>');
    process.exit(1);
  }

  console.log(LINE);
  console.log(' DI V2 — STAGE 1g: hybrid retrieval (matched-first + tail)');
  console.log(LINE);
  console.log(` clientId:          ${clientId}`);
  console.log(` industry:          ${industry}`);
  console.log(` vectorFloor:       ${opts.vectorFloor}`);
  console.log(` finalFloor:        ${opts.finalFloor}`);
  console.log(` topK:              ${opts.topK}`);
  console.log(` per-module limit:  ${opts.perModuleLimit}`);
  console.log(` questions:         ${questions.length}`);
  console.log(` debug LLM:         ${process.env.DI_V2_DEBUG_LLM === '1' ? 'ON' : 'off'}`);
  console.log(LINE);

  let i = 0;
  for (const q of questions) {
    i++;
    const text = (q && q.question) ? String(q.question) : String(q);
    const id   = (q && q.id) ? ` (${q.id})` : '';
    console.log(`\n[${i}/${questions.length}] Running${id}...`);

    console.log('\n' + LINE);
    console.log(` Q: ${text}`);
    console.log(SUB);

    try {
      const result = await retrieveClientSignals(text, clientId, industry, opts);
      printUnderstanding(result.understanding);
      printWindow(result.timeWindow);
      console.log('');
      printHits(result.hits, {
        matchedCount: result.matchedCount,
        unmatchedCount: result.unmatchedCount,
      });
    } catch (err) {
      console.log(` ERROR: ${err.message}`);
      console.log(err.stack);
    }
    console.log(LINE);
  }

  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});