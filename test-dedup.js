/**
 * test-dedup.js
 * ==============
 * Standalone test — no Qdrant, no server, no LLM. Pure embedding-only check,
 * mirrors the actual logic in topicDedup.js exactly (stripSourceSuffix +
 * single SIMILARITY_THRESHOLD).
 *
 * Run:  node test-dedup.js
 * (or:  docker exec -it app-test-app-1 node test-dedup.js)
 */

const { pipeline } = require('@xenova/transformers');

const SIMILARITY_THRESHOLD = 0.78; // keep in sync with topicDedup.js

// ── Same function as topicDedup.js — kept in sync manually ──────────────────
const stripSourceSuffix = (title) => {
  return title
    .split(/\s[|｜»]\s|\s-\s(?=[A-Z][\w\s.&]*$)/)[0]
    .trim();
};

// ── Test cases pulled straight from your logs ────────────────────────────────
// expected: true  -> these SHOULD be flagged as duplicates
// expected: false -> these SHOULD stay as separate articles
//
// NOTE: the Asaya cases below are a KNOWN LIMITATION of embedding-only dedup —
// same funding round, very different wording/currency. They're expected to
// keep FAILING here. That's documented, not a bug to chase.
const testCases = [
  {
    a: 'Asaya raises Rs 88cr Series A as melanin-focused skincare expansion',
    b: 'Indian Skincare Brand Asaya Raises $9.2 Million | BeautyMatter',
    expected: true,
    note: 'KNOWN LIMITATION — different currency/wording, embedding-only will miss this',
  },
  {
    a: 'Asaya Raises ₹88 Cr at ₹400 Cr Valuation — StartupFox',
    b: 'Indian Skincare Brand Asaya Raises $9.2 Million | BeautyMatter',
    expected: true,
    note: 'KNOWN LIMITATION',
  },
  {
    a: 'D2C Skincare Brand Asaya Bags ₹88 Cr, Eyes Offline Retail Entry | TechnologyTangle',
    b: 'Indian Skincare Brand Asaya Raises $9.2 Million | BeautyMatter',
    expected: true,
    note: 'KNOWN LIMITATION',
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

  // ── additional cases — different modules/topics, not just beauty funding ───

  // Regulatory/policy — same rule, different outlets
  {
    a: 'RBI tightens norms for digital lending apps, mandates disclosure of all fees',
    b: 'India central bank imposes new digital lending disclosure rules - Reuters',
    expected: true,
  },
  {
    a: 'EU finalizes AI Act enforcement timeline for high-risk systems',
    b: 'European Union sets deadlines for AI Act compliance | TechCrunch',
    expected: true,
  },
  {
    a: 'FTC opens antitrust probe into cloud computing pricing practices',
    b: 'US regulator investigates cloud pricing over antitrust concerns - Bloomberg',
    expected: true,
  },
  {
    a: 'SEBI proposes stricter disclosure norms for related-party transactions',
    b: 'RBI tightens norms for digital lending apps, mandates disclosure of all fees',
    expected: false,
    note: 'different regulator, different topic — should NOT match',
  },

  // M&A — same deal worded very differently (harder cases, similar to Asaya)
  {
    a: 'Nestle to sell bottled water brands to private equity firm for $4.3 billion',
    b: 'Nestle divests water business in $4.3B deal with One Rock Capital - WSJ',
    expected: true,
  },
  {
    a: 'Adobe abandons $20 billion Figma acquisition after regulatory pushback',
    b: 'Adobe, Figma call off merger amid antitrust scrutiny | The Verge',
    expected: true,
  },
  {
    a: 'Adobe abandons $20 billion Figma acquisition after regulatory pushback',
    b: 'Figma reports record Q3 revenue growth, plans IPO in 2026',
    expected: false,
    note: 'same companies, unrelated stories — should NOT match',
  },

  // Leadership changes — same event, different framing
  {
    a: 'Starbucks CEO Laxman Narasimhan steps down, Brian Niccol to take over',
    b: 'Starbucks names Chipotle chief Brian Niccol as new CEO - CNBC',
    expected: true,
  },
  {
    a: 'Starbucks CEO Laxman Narasimhan steps down, Brian Niccol to take over',
    b: 'Starbucks Q3 same-store sales decline for third straight quarter',
    expected: false,
    note: 'same company, different story — should NOT match',
  },

  // Product launches — same launch, different angle
  {
    a: 'OpenAI launches GPT-5 with major reasoning and coding upgrades',
    b: 'OpenAI unveils GPT-5, its most capable model yet | Ars Technica',
    expected: true,
  },
  {
    a: 'OpenAI launches GPT-5 with major reasoning and coding upgrades',
    b: 'Anthropic releases Claude Opus 5 with extended context window',
    expected: false,
    note: 'different companies, similar topic — should NOT match',
  },

  // Layoffs — same round, different numbers reported (like the Asaya currency issue)
  {
    a: 'Amazon to cut 14,000 corporate jobs as part of restructuring',
    b: 'Amazon layoffs hit corporate workforce, about 14,000 roles affected - NYT',
    expected: true,
  },
  {
    a: 'Amazon to cut 14,000 corporate jobs as part of restructuring',
    b: 'Amazon layoffs to affect roughly 10% of corporate staff, sources say',
    expected: true,
    note: 'same event, different reported numbers — hard case like Asaya',
  },

  // Near-identical titles, trivial rewording (should be easy passes)
  {
    a: 'Tesla recalls 1.8 million vehicles over door handle defect',
    b: 'Tesla issues recall for 1.8M vehicles due to door handle issue',
    expected: true,
  },
  {
    a: 'Tesla recalls 1.8 million vehicles over door handle defect',
    b: "Tesla's Cybertruck production ramps up at Texas Gigafactory",
    expected: false,
  },

  // Numbers-only difference, same story, different currency (like Asaya but simpler)
  {
    a: 'Zepto raises $350 million in Series G funding round',
    b: 'Zepto secures ₹2,900 crore in fresh funding led by Motilal Oswal',
    expected: true,
    note: 'same round, different currency — hard case like Asaya',
  },
  {
    a: 'Zepto raises $350 million in Series G funding round',
    b: 'Blinkit expands dark store network to 15 new cities',
    expected: false,
  },

  // Follow-up/update articles about the same underlying story (ambiguous — judgment call)
  {
    a: 'Boeing 737 MAX grounded after mid-air door plug incident',
    b: 'FAA grounds Boeing 737 MAX fleet following door plug blowout - AP',
    expected: true,
  },
  {
    a: 'Boeing 737 MAX grounded after mid-air door plug incident',
    b: 'Boeing shares fall 8% as investigation into MAX incident widens',
    expected: false,
    note: 'follow-up market reaction story, not the same event report — should NOT match',
  },

  // Same company, same broad topic, different quarters/events (should NOT match)
  {
    a: 'Reliance Jio crosses 500 million subscribers in India',
    b: 'Reliance Jio launches new 5G plans starting at Rs 199',
    expected: false,
  },

  // Completely unrelated pair, sanity check
  {
    a: 'Paris 2026 Olympics organizers unveil new stadium design',
    b: 'Coca-Cola launches limited edition mango flavor in Southeast Asia',
    expected: false,
  },

  // ── real case flagged by Govind, from market_dynamics_signals ──────────────
  // Both published 2026-07-22, same underlying piece about VC activity in beauty
  {
    a: 'Venture Capital Persists in Beauty Despite a Shift Toward Debt Financing',
    b: 'Venture Capital Persists in Beauty, Even as DTC Brands Shift Toward Debt',
    expected: true,
    note: 'Govind-flagged real duplicate — same date, near-identical title',
  },
  {
    a: 'Venture Capital Persists in Beauty Despite a Shift Toward Debt Financing',
    b: 'Sixpence Secures 2 Billion Won Seed Round',
    expected: false,
    note: 'unrelated signal bundled on the same card — sanity check, should NOT match',
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