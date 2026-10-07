/**
 * scripts/di-v2-audit-relevance.js
 *
 * For a question, retrieves hits (client + custom) and asks the LLM to
 * judge each chunk's relevance independently. Prints an audit table so we
 * can see exactly which retrieved chunks are on-topic and which are noise.
 *
 *   node scripts\di-v2-audit-relevance.js --q "List recent funding rounds in our Cosmetics industry"
 */

require('dotenv').config();

const { callLLM } = require('../modules/llmClient');
const { route } = require('../modules/decisionIntelligenceV2/routing/router');
const { retrieveClientSignals } = require('../modules/decisionIntelligenceV2/retrieval/clientSignalsRetrieval');
const { retrieveCustomSourceHits } = require('../modules/decisionIntelligenceV2/retrieval/customSourceRetrieval');

const LINE = '━'.repeat(90);
const SUB  = '─'.repeat(90);

function parseArgs(argv) {
  const args = { question: null, client: null, industry: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--q')           args.question = next();
    else if (a === '--client') args.client = next();
    else if (a === '--industry') args.industry = next();
  }
  return args;
}

const show = (s, n) => {
  if (!s) return '';
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
};

const AUDIT_PROMPT = `You are a strict relevance auditor.

Given a QUESTION and a CHUNK of text retrieved from a client's data, judge whether the chunk is genuinely USEFUL for answering the question.

Return ONLY this JSON:
{
  "relevant": true | false,
  "score": <0-100>,
  "reason": "<one short sentence>"
}

Rules:
- relevant = true only if the chunk contains information that directly helps answer the question.
- A chunk is NOT relevant if it merely shares keywords but talks about a different topic, industry, or event.
- A chunk about a different industry than the question implies is NOT relevant.
- Be strict. When in doubt, mark it not relevant.
- score: 0 = completely unrelated, 100 = perfect answer material.
- Return ONLY the JSON. No markdown. No explanation.`;

async function auditOne(question, chunk, label) {
  const userPrompt = `QUESTION:\n${question}\n\nCHUNK (${label}):\n${chunk.slice(0, 2000)}`;
  let raw;
  try {
    raw = await callLLM(
      [
        { role: 'system', content: AUDIT_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0, max_tokens: 200, timeout: 30000 }
    );
  } catch (err) {
    return { relevant: null, score: null, reason: `audit LLM failed: ${err.message}` };
  }

  const stripped = String(raw || '').trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/```\s*$/, '')
    .trim();
  const first = stripped.indexOf('{');
  if (first === -1) return { relevant: null, score: null, reason: 'audit: no JSON' };
  let depth = 0, end = -1;
  for (let i = first; i < stripped.length; i++) {
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return { relevant: null, score: null, reason: 'audit: unbalanced JSON' };

  try {
    const parsed = JSON.parse(stripped.slice(first, end + 1));
    return {
      relevant: parsed.relevant === true,
      score: typeof parsed.score === 'number' ? parsed.score : null,
      reason: parsed.reason || '',
    };
  } catch {
    return { relevant: null, score: null, reason: 'audit: parse failed' };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.question) {
    console.error('Provide --q "<question>"');
    process.exit(1);
  }
  const clientId = args.client || process.env.DI_CLIENT_ID || 'b61b4d3b-caeb-457b-9971-636c83688ee4';
  const industry = args.industry || process.env.DI_INDUSTRY || 'Cosmetics';

  console.log(LINE);
  console.log(' DI V2 — RETRIEVAL RELEVANCE AUDIT');
  console.log(LINE);
  console.log(` Q:         ${args.question}`);
  console.log(` industry:  ${industry}`);

  const routerResult = await route(args.question, industry);
  console.log(` intent:    ${routerResult.intent}`);
  console.log(` type:      ${routerResult.type}`);
  console.log(` concepts:  ${routerResult.concept_keywords.join(', ')}`);
  console.log(` entities:  ${routerResult.entity_mentions.join(', ')}`);

  const [clientRetr, customHits] = await Promise.all([
    retrieveClientSignals(args.question, clientId, industry, { precomputedUnderstanding: routerResult }),
    retrieveCustomSourceHits(args.question, clientId),
  ]);

  console.log(`\n Client hits: ${clientRetr.hits.length}`);
  console.log(` Custom hits: ${customHits.length}`);

  // Audit client hits
  if (clientRetr.hits.length) {
    console.log('\n' + LINE);
    console.log(' AUDIT — CLIENT HITS');
    console.log(LINE);
    for (let i = 0; i < clientRetr.hits.length; i++) {
      const h = clientRetr.hits[i];
      const verdict = await auditOne(
        args.question,
        `${h.title}\n${h.chunk_text}`,
        `client hit ${i + 1}`
      );
      const flag = verdict.relevant === true ? '✓ KEEP' : verdict.relevant === false ? '✗ DROP' : '? UNKNOWN';
      console.log(`\n [${String(i + 1).padStart(2)}] ${flag}  score=${verdict.score ?? '?'}  | retrieval=${h.score.toFixed(3)}  | ${h.module_name}`);
      console.log(`      title: ${h.title}`);
      console.log(`      chunk: ${show(h.chunk_text, 260)}`);
      console.log(`      audit: ${verdict.reason}`);
    }
  }

  // Audit custom hits
  if (customHits.length) {
    console.log('\n' + LINE);
    console.log(' AUDIT — CUSTOM SOURCE HITS');
    console.log(LINE);
    for (let i = 0; i < customHits.length; i++) {
      const c = customHits[i];
      const p = c.payload || {};
      const verdict = await auditOne(
        args.question,
        `${p.source_name}\n${p.chunk_text}`,
        `custom hit ${i + 1}`
      );
      const flag = verdict.relevant === true ? '✓ KEEP' : verdict.relevant === false ? '✗ DROP' : '? UNKNOWN';
      console.log(`\n [${String(i + 1).padStart(2)}] ${flag}  score=${verdict.score ?? '?'}  | retrieval=${c.score.toFixed(3)}  | ${p.source_name} | chunk ${p.chunk_index}`);
      console.log(`      chunk: ${show(p.chunk_text, 260)}`);
      console.log(`      audit: ${verdict.reason}`);
    }
  }

  // Summary
  console.log('\n' + LINE);
  console.log(' DONE');
  console.log(LINE);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });