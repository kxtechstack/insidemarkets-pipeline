/**
 * scripts/di-v2-custom-chunks-full.js
 *
 * Dumps the FULL text of every custom source chunk retrieved for a question.
 * Used to verify whether an inference answer is grounded or hallucinated.
 *
 *   node scripts\di-v2-custom-chunks-full.js --q "your question"
 *   node scripts\di-v2-custom-chunks-full.js --q "..." --limit 10
 */

require('dotenv').config();

const { retrieveCustomSourceHits } = require('../modules/decisionIntelligenceV2/retrieval/customSourceRetrieval');

const LINE = '━'.repeat(90);
const SUB  = '─'.repeat(90);

function parseArgs(argv) {
  const args = { question: null, client: null, limit: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--q')           args.question = next();
    else if (a === '--client') args.client = next();
    else if (a === '--limit')  args.limit = Number(next());
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.question) {
    console.error('Provide --q "<question>"');
    process.exit(1);
  }
  const clientId = args.client || process.env.DI_CLIENT_ID || 'b61b4d3b-caeb-457b-9971-636c83688ee4';

  console.log(LINE);
  console.log(` Q: ${args.question}`);
  console.log(` clientId: ${clientId}`);
  console.log(LINE);

  const hits = await retrieveCustomSourceHits(args.question, clientId, { limit: args.limit });
  console.log(` Hits: ${hits.length}\n`);

  hits.forEach((h, i) => {
    const p = h.payload || {};
    console.log(SUB);
    console.log(` [${i + 1}] score=${h.score.toFixed(3)} | ${p.source_name} | chunk ${p.chunk_index}`);
    console.log(SUB);
    console.log(p.chunk_text || '(empty)');
    console.log('');
  });

  console.log(LINE);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });