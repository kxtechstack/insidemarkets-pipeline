/**
 * scripts/di-v2-test-custom.js
 *
 * Diagnostic: verifies custom source retrieval works end-to-end.
 *
 *   node scripts\di-v2-test-custom.js --q "what does the NIQ report say about fragrance?"
 *   node scripts\di-v2-test-custom.js --q "how do I develop a marketing strategy?"
 *
 * Shows:
 *   1. Raw custom source hits (score + source + chunk text)
 *   2. Whether they got included in the LLM context
 *   3. The full inference answer
 *   4. The custom sources cited
 */

require('dotenv').config();

const { QdrantClient } = require('@qdrant/js-client-rest');
const { pipeline } = require('@xenova/transformers');
const { buildInferenceAnswer } = require('../modules/decisionIntelligenceV2/handlers/inferenceHandler');
const { retrieveCustomSourceHits } = require('../modules/decisionIntelligenceV2/retrieval/customSourceRetrieval');

const LINE = '━'.repeat(90);
const SUB  = '─'.repeat(90);

function parseArgs(argv) {
  const args = { question: null, client: null, minScore: null, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--q')           args.question = next();
    else if (a === '--client') args.client = next();
    else if (a === '--min-score') args.minScore = Number(next());
    else if (a === '--limit')  args.limit = Number(next());
  }
  return args;
}

const short = (s, n) => {
  if (!s) return '';
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
};

const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});
const COLLECTION = process.env.CUSTOM_SOURCE_QDRANT_COLLECTION || 'custom_source_content';

let embedderPromise = null;
const getEmbedder = () => {
  if (!embedderPromise) {
    embedderPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return embedderPromise;
};
const embedText = async (text) => {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
};

async function rawSearch(question, clientId, limit) {
  const vector = await embedText(question);
  const hits = await qdrant.search(COLLECTION, {
    vector,
    limit: limit ?? 15,
    filter: { must: [{ key: 'client_id', match: { value: clientId } }] },
    with_payload: true,
  });
  return hits;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.question) {
    console.error('Provide --q "<question>"');
    process.exit(1);
  }

  const clientId = args.client || process.env.DI_CLIENT_ID || 'b61b4d3b-caeb-457b-9971-636c83688ee4';

  console.log(LINE);
  console.log(' DI V2 — CUSTOM SOURCE DIAGNOSTIC');
  console.log(LINE);
  console.log(` Q: ${args.question}`);
  console.log(` clientId: ${clientId}`);
  console.log(LINE);

  // ── Step 1: RAW vector search (no threshold) — see what ALL hits look like
  console.log('\n STEP 1 — Raw vector search (no floor) — top 15');
  console.log(SUB);
  const rawHits = await rawSearch(args.question, clientId, 15);
  rawHits.forEach((h, i) => {
    const p = h.payload || {};
    console.log(` [${String(i + 1).padStart(2)}] score=${h.score.toFixed(3)} | ${short(p.source_name, 40)} | chunk ${p.chunk_index}`);
    console.log(`      ${short(p.chunk_text, 160)}`);
  });

  // ── Step 2: Retrieve with production settings (floor applied)
  console.log('\n STEP 2 — Retrieval with production settings');
  console.log(SUB);
  const opts = {};
  if (args.limit)    opts.limit    = args.limit;
  if (args.minScore) opts.minScore = args.minScore;
  const prodHits = await retrieveCustomSourceHits(args.question, clientId, opts);
  console.log(` Hits after floor: ${prodHits.length}`);
  prodHits.forEach((h, i) => {
    const p = h.payload || {};
    console.log(` [${String(i + 1).padStart(2)}] score=${h.score.toFixed(3)} | ${short(p.source_name, 40)} | chunk ${p.chunk_index}`);
  });

  // ── Step 3: Inference handler (no client hits, only custom)
  console.log('\n STEP 3 — Inference answer using ONLY custom sources');
  console.log(SUB);
  const result = await buildInferenceAnswer(args.question, [], prodHits);

  if (result._empty) {
    console.log(` EMPTY: ${result._reason}`);
  } else {
    console.log(` Title: ${result.report.title}`);
    console.log('');
    const body = result.report.bodyText || '';
    for (const line of body.split('\n')) {
      if (line.length <= 76) { console.log('   ' + line); continue; }
      let buf = '';
      for (const word of line.split(' ')) {
        if ((buf + ' ' + word).trim().length > 76) {
          console.log('   ' + buf.trim());
          buf = word;
        } else {
          buf = (buf + ' ' + word).trim();
        }
      }
      if (buf) console.log('   ' + buf);
    }
    console.log('');
    console.log(` Sources cited: ${result.sources.length}`);
    result.sources.forEach((s, i) => {
      if (s.type === 'custom_source') {
        console.log(`   [${i + 1}] custom | ${s.source_name} | chunk ${s.chunk_index}`);
      } else {
        console.log(`   [${i + 1}] ${s.type} | ${short(s.title, 70)}`);
      }
    });
  }

  console.log('\n' + LINE);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });