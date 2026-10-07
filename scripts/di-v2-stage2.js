/**
 * scripts/di-v2-stage2.js — Stage 2 harness with summary
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { route } = require('../modules/decisionIntelligenceV2/routing/router');

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

function short(s, n) {
  if (!s) return '';
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
}

async function runOne(text, industry, expected) {
  console.log('\n' + LINE);
  console.log(` Q: ${text}`);
  console.log(SUB);

  const t0 = Date.now();
  let result;
  try {
    result = await route(text, industry);
  } catch (err) {
    console.log(` ERROR: ${err.message}`);
    console.log(LINE);
    return { intentMatch: null, typeMatch: null, companySetMatch: null };
  }
  const ms = Date.now() - t0;

  console.log(` INTENT:      ${result.intent}  (${ms}ms)`);

  if (result.intent !== 'market_intelligence') {
    console.log(`   reply:     ${result.primary_intent}`);
    if (expected?.expectedIntent && expected.expectedIntent !== result.intent) {
      console.log(`   ⚠ expected intent "${expected.expectedIntent}" but got "${result.intent}"`);
    } else if (expected?.expectedIntent) {
      console.log(`   ✓ intent matches`);
    }
    console.log(LINE);
    return {
      intentMatch: expected?.expectedIntent ? expected.expectedIntent === result.intent : null,
      typeMatch: null,
      companySetMatch: null,
    };
  }

  console.log(` TYPE:        ${result.type}`);
  if (result.time_constraint?.present) {
    console.log(
      `   time:      ${result.time_constraint.value} ${result.time_constraint.unit} ` +
      `("${result.time_constraint.phrase}")`
    );
  }
  console.log(
    `   entities:  ${result.entity_mentions.length ? result.entity_mentions.join(', ') : '(none)'}`
  );
  console.log(
    `   concepts:  ${result.concept_keywords.length ? result.concept_keywords.join(' | ') : '(none)'}`
  );
  console.log(`   company_set: ${result.is_company_set_query}`);
  console.log(`   intent:    ${short(result.primary_intent, 140)}`);

  let intentMatch = null;
  let typeMatch = null;
  let companySetMatch = null;

  if (expected?.expectedIntent) {
    intentMatch = expected.expectedIntent === result.intent;
    if (!intentMatch) console.log(`   ⚠ expected intent "${expected.expectedIntent}" but got "${result.intent}"`);
  }

  if (expected?.ambiguous) {
    console.log(`   [ambiguous — no expected type enforced]`);
  } else if (expected?.expectedType) {
    typeMatch = expected.expectedType === result.type;
    if (!typeMatch) console.log(`   ⚠ expected type "${expected.expectedType}" but got "${result.type}"`);
    else console.log(`   ✓ type matches "${expected.expectedType}"`);
  }

  if (expected?.expectedCompanySet !== undefined) {
    companySetMatch = expected.expectedCompanySet === result.is_company_set_query;
    if (!companySetMatch) console.log(`   ⚠ expected company_set=${expected.expectedCompanySet} but got ${result.is_company_set_query}`);
  }

  if (result._fallback) console.log(`   ⚠ fallback was used`);

  console.log(LINE);
  return { intentMatch, typeMatch, companySetMatch };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const industry = args.industry || process.env.DI_INDUSTRY || 'Cosmetics';

  let questions = [];
  if (args.question) {
    questions = [{ id: 'inline', question: args.question }];
  } else if (args.questionsFile) {
    const p = path.isAbsolute(args.questionsFile)
      ? args.questionsFile
      : path.resolve(process.cwd(), args.questionsFile);
    questions = JSON.parse(fs.readFileSync(p, 'utf8'));
  } else {
    console.error('Provide --q "<question>" or --questions <file.json>');
    process.exit(1);
  }

  console.log(LINE);
  console.log(' DI V2 — STAGE 2: unified router');
  console.log(LINE);
  console.log(` industry:   ${industry}`);
  console.log(` questions:  ${questions.length}`);
  console.log(` debug LLM:  ${process.env.DI_V2_DEBUG_LLM === '1' ? 'ON' : 'off'}`);
  console.log(LINE);

  const summary = {
    total: questions.length,
    intentChecked: 0, intentMatched: 0,
    typeChecked: 0, typeMatched: 0,
    companySetChecked: 0, companySetMatched: 0,
    fallbacks: 0,
  };

  for (const q of questions) {
    const text = (q && q.question) ? String(q.question) : String(q);
    try {
      const r = await runOne(text, industry, q);
      if (r.intentMatch !== null) { summary.intentChecked++; if (r.intentMatch) summary.intentMatched++; }
      if (r.typeMatch !== null)   { summary.typeChecked++;   if (r.typeMatch)   summary.typeMatched++; }
      if (r.companySetMatch !== null) { summary.companySetChecked++; if (r.companySetMatch) summary.companySetMatched++; }
    } catch (err) {
      console.log(` Fatal: ${err.message}`);
    }
  }

  console.log('\n' + LINE);
  console.log(' SUMMARY');
  console.log(LINE);
  console.log(` Total:                ${summary.total}`);
  console.log(` Intent checked:       ${summary.intentChecked}   matched: ${summary.intentMatched}`);
  console.log(` Type checked:         ${summary.typeChecked}   matched: ${summary.typeMatched}`);
  console.log(` CompanySet checked:   ${summary.companySetChecked}   matched: ${summary.companySetMatched}`);
  console.log(LINE + '\n');
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });