/**
 * test-dedup.js
 * ==============
 * Standalone test — no Qdrant, no server needed.
 * Re-embeds real title pairs pulled from your production logs and checks
 * whether stripSourceSuffix() + the new SIMILARITY_THRESHOLD correctly
 * classify them as DUPLICATE or NOT DUPLICATE.
 *
 * Run:  node test-dedup.js
 */

const { pipeline } = require('@xenova/transformers');

const SIMILARITY_THRESHOLD = 0.75; // keep in sync with topicDedup.js

// ── Same function you're adding to topicDedup.js — paste it here too ────────
const stripSourceSuffix = (title) => {
  return title
    .split(/\s[|｜»]\s|\s-\s(?=[A-Z][\w\s.&]*$)/)[0]
    .trim();
};

// ── Test cases pulled straight from your logs ────────────────────────────────
// expected: true  -> these SHOULD be flagged as duplicates
// expected: false -> these SHOULD stay as separate articles
const testCases = [
  {
    a: 'Asaya raises Rs 88cr Series A as melanin-focused skincare expansion',
    b: 'Indian Skincare Brand Asaya Raises $9.2 Million | BeautyMatter',
    expected: true,
    note: 'same funding round, different currency/wording — the hard case',
  },
  {
    a: 'Asaya Raises ₹88 Cr at ₹400 Cr Valuation — StartupFox',
    b: 'Indian Skincare Brand Asaya Raises $9.2 Million | BeautyMatter',
    expected: true,
  },
  {
    a: 'D2C Skincare Brand Asaya Bags ₹88 Cr, Eyes Offline Retail Entry | TechnologyTangle',
    b: 'Indian Skincare Brand Asaya Raises $9.2 Million | BeautyMatter',
    expected: true,
  },
  {
    a: 'Asaya Raises ₹88 Crore At ₹400 Crore Valuation To Scale Science-Led Skincare » startuporiginals.in',
    b: 'Indian Skincare Brand Asaya Raises $9.2 Million | BeautyMatter',
    expected: true,
  },
  {
    a: 'Naturis Cosmetics Raises Rs 100 Crore in Maiden Funding Round Led By Sharrp Ventures - The Brand Beats',
    b: 'Funding News: Naturis Cosmetics Raises Rs 100 Crore to Expand Manufacturing and R&D Capabilities',
    expected: true,
  },
  {
    a: 'Contract manufacturer Naturis Cosmetics raises Rs 100 crore led by Sharrp Ventures - The Economic Times',
    b: 'Naturis Cosmetics Raises Rs 100 Crore in Maiden Funding Round Led By Sharrp Ventures - The Brand Beats',
    expected: true,
  },
  {
    a: 'KKR to acquire Japanese beauty platform Ci FLAVORS | Retail Asia',
    b: 'KKR acquires Japanese beauty and lifestyle group Ci Flavors - Premium Beauty News',
    expected: true,
  },
  {
    a: "KKR To Acquire Japan's Ci Flavors For Undisclosed Terms",
    b: 'KKR acquires Japanese beauty and lifestyle group Ci Flavors - Premium Beauty News',
    expected: true,
  },
  // ── genuine non-duplicates — should stay separate ──────────────────────────
  {
    a: 'India Digest: Naturis Cosmetics, Reo.Dev secure fresh funding',
    b: 'Funding News: Naturis Cosmetics Raises Rs 100 Crore to Expand Manufacturing and R&D Capabilities',
    expected: false,
    note: 'roundup article mentioning Naturis, not the same single-company story',
  },
  {
    a: 'Be Clinical raises Rs 21 crore in seed round led by Sauce - The Economic Times',
    b: 'Asaya raises Rs 88cr Series A as melanin-focused skincare expansion',
    expected: false,
  },
  {
    a: 'Avon North America Acquired By Regent, Appoints New CEO',
    b: 'KKR acquires Japanese beauty and lifestyle group Ci Flavors - Premium Beauty News',
    expected: false,
  },
];

let embedder;
const getEmbedder = async () => {
  if (!embedder) {
    console.log('Loading embedding model (first run only, takes a few seconds)...\n');
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return embedder;
};

const embed = async (text) => {
  const model = await getEmbedder();
  const output = await model(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
};

// vectors are normalized, so dot product === cosine similarity
const cosineSim = (v1, v2) => v1.reduce((sum, val, i) => sum + val * v2[i], 0);

const run = async () => {
  let pass = 0;
  let fail = 0;

  for (const { a, b, expected, note } of testCases) {
    const cleanA = stripSourceSuffix(a);
    const cleanB = stripSourceSuffix(b);

    const [vecA, vecB] = await Promise.all([embed(cleanA), embed(cleanB)]);
    const score = cosineSim(vecA, vecB);

    const predictedDuplicate = score >= SIMILARITY_THRESHOLD;
    const correct = predictedDuplicate === expected;
    correct ? pass++ : fail++;

    console.log(`${correct ? '✅ PASS' : '❌ FAIL'}  score=${score.toFixed(3)}  expected=${expected ? 'DUPLICATE' : 'not dup'}  got=${predictedDuplicate ? 'DUPLICATE' : 'not dup'}`);
    console.log(`   A: "${cleanA}"`);
    console.log(`   B: "${cleanB}"`);
    if (note) console.log(`   note: ${note}`);
    console.log('');
  }

  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed. Threshold = ${SIMILARITY_THRESHOLD}`);
};

run();