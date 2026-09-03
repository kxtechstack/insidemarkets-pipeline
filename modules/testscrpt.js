// Standalone simulation of enrichOrCreateInsight's matching logic.
// No Supabase/Qdrant — in-memory cards, real embeddings, real cosine sim.
// Mirrors: embed article -> compare to each card's CENTROID (mean of all
// member embeddings, same as updateInsightCentroid) -> merge if >= threshold
// else create new card. Filtered by submodule, same as findExistingInsight.

const { pipeline } = require('@xenova/transformers');

const CARD_SIMILARITY_THRESHOLD = 0.70; // same constant as your code

let embedderPromise = null;
const getEmbedder = () => {
  if (!embedderPromise) embedderPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  return embedderPromise;
};
const embedText = async (text) => {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
};

const cosineSimilarity = (a, b) => {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

const mean = (vectors) => {
  const dim = vectors[0].length;
  const out = new Array(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) out[i] += v[i];
  for (let i = 0; i < dim; i++) out[i] /= vectors.length;
  return out;
};

// ── Test signals ─────────────────────────────────────────────────────────
// group: for our own bookkeeping (what SHOULD merge with what), not seen by algorithm
// submodule: real filter the algorithm uses
const signals = [
  // Group A — Remedy $20M Series A, 3 different articles about the SAME event (from screenshot)
  { group: 'A-remedy', submodule: 'Investment Activity', title: 'LVMH Repositions Beauty Portfolio as Luxury Demand Wanes', text: 'Remedy, a dermatologist-developed skin care brand, announced a $20 million Series A funding round led by L Catterton, a private equity firm affiliated with LVMH. The capital will support product development, clinical research, and inventory expansion across DTC, Amazon, and Target channels.' },
  { group: 'A-remedy', submodule: 'Investment Activity', title: 'L Catterton Secures $20 Million to Propel Dermatologist-Led Skincare', text: 'L Catterton has led a $20 million Series A investment into Remedy, a dermatologist-founded skincare brand, to accelerate clinical research and retail distribution.' },
  { group: 'A-remedy', submodule: 'Investment Activity', title: 'Remedy Science Secures $20 Million to Scale Clinical Dermocosmetics', text: 'Remedy Science raised $20 million in Series A funding to scale its dermatologist-backed skincare line, reshaping product, supply, and regulatory strategy.' },

  // Group B — Dolce Glow $11M Series A, 2 articles about the SAME event (from screenshot)
  { group: 'B-dolceglow', submodule: 'Investment Activity', title: "CAVU Consumer Partners Fuels Dolce Glow's Rapid Expansion with $11M Series A", text: "Dolce Glow, a self-tanning brand that has quickly become Sephora's top seller, closed an $11 million Series A led by CAVU Consumer Partners. The capital will fund inventory, retail distribution, product innovation and team expansion." },
  { group: 'B-dolceglow', submodule: 'Investment Activity', title: 'Dolce Glow Secures $11 Million Series A, Amplifying Its Position as Sephora Top Seller', text: "Dolce Glow's $11 million Series A, backed by celebrities and CAVU, fuels clean-beauty innovation and rapid retail growth in a booming self-tanning market." },

  // Group C — DIFFERENT funding events, same submodule. Should NOT merge with each other or A/B.
  { group: 'C-inglot', submodule: 'Investment Activity', title: 'Family-Run Cosmetics Can Scale via Growth Capital Without Losing Control', text: 'Inglot partners with Avallon to grow globally, keeping family control and ethical manufacturing intact.' },
  { group: 'C-merit', submodule: 'Investment Activity', title: "Strategic Investment Accelerates Minimalist Brand's Global Expansion", text: "Merit's new investment fuels global growth, adds board expertise, and reinforces its minimalist, multifunctional product strategy across North America, the UK, and beyond." },
  { group: 'C-macquarie', submodule: 'Investment Activity', title: 'Macquarie Expands into Korean ODMs, Broadening Consumer Goods Portfolio', text: "Macquarie's acquisition of Hwaseong Cosmetics and Naukos marks a strategic shift into consumer goods, potentially reshaping ODM consolidation in Korea." },
  { group: 'C-saltair', submodule: 'Investment Activity', title: 'Bootstrapped Personal-Care Brands Attract Rapid Institutional Exit', text: "TSG backs Saltair, keeping community ethos intact while scaling the brand globally." },
  { group: 'C-beclinical', submodule: 'Investment Activity', title: 'Evidence-Driven Anti-Aging Brands Attract Early-Stage Capital in India', text: "Be Clinical's ₹21 crore seed round confirms investor confidence in vertically integrated, evidence-based anti-aging skincare in India." },
  { group: 'C-ciflavors', submodule: 'Investment Activity', title: "KKR's CiFLAVORS Acquisition Fuels Japan Beauty Consolidation", text: "KKR's purchase of CiFLAVORS, backed by founder reinvestment, highlights PE interest in Japanese beauty brands with global potential." },
  { group: 'C-diamondwipes', submodule: 'Investment Activity', title: 'Equity and Debt Mix Drives Cosmetics Funding Strategy', text: "River Associates' purchase of Diamond Wipes marks a strategic push to scale contract-manufacturing services across the beauty and personal-care sector." },
  { group: 'C-helloklean', submodule: 'Investment Activity', title: 'Water-Filtered Beauty Tech Reshapes Gulf Cosmetics Market', text: "Hello Klean's smart, water-powered filter drives rapid Gulf growth, leveraging Brita's expertise to tailor products for desalinated water and unlock subscription revenue." },
  { group: 'C-rael', submodule: 'Investment Activity', title: 'Sustainable Period-Care Brands Gain Private-Equity Backing to Challenge Legacy Giants', text: "Private-equity investment propels clean-period-care brand Rael toward scaling and cross-category expansion, threatening legacy players." },
  { group: 'C-phitku', submodule: 'Investment Activity', title: 'Private-Equity Drives Premium B2C Shift', text: "Phitku's rapid exit shows bootstrapped personal-care brands can secure institutional capital and strategic support within a year of launch." },

  // Group E — BORDERLINE. Related-ish to Group A/C topic but a genuinely different
  // company/event. This is the interesting test: should it merge or not?
  { group: 'E-borderline-lcatterton2', submodule: 'Investment Activity', title: 'L Catterton Backs Second Dermocosmetics Brand in New Funding Round', text: 'L Catterton has led an additional funding round into a second dermatologist-led skincare brand, continuing its push into clinical, evidence-backed dermocosmetics.' },
  { group: 'E-borderline-sephora-yepoda', submodule: 'Investment Activity', title: 'K-Beauty Brands Deepen U.S. Presence Through Sustainable Offerings', text: "Sephora's partnership with Yepoda shows U.S. K-Beauty's pivot to sustainable, science-backed products amid explosive e-commerce growth." },

  // Group D — completely different submodule (AI Adoption). Should NEVER merge with anything above.
  { group: 'D-natura', submodule: 'AI Adoption', title: 'Generative AI Transforms Real-Time Margin Analysis in Cosmetics Finance', text: 'Natura&Co uses SAP-embedded generative AI to cut margin reporting time from days to minutes, turning finance into a strategic partner.' },
  { group: 'D-loreal-tryon', submodule: 'AI Adoption', title: 'AI-Powered Conversational Try-On Boosts Beauty Engagement', text: "L'Oréal's ChatGPT integration delivers virtual try-on, AI-driven discovery, and research tools, redefining consumer interaction and product innovation." },
  { group: 'D-amorepacific', submodule: 'AI Adoption', title: 'AI-Ready Data Cuts Cosmetics R&D Time from Weeks to Minutes', text: "AmorePacific's AI-Ready Data Hub slashes R&D timelines, turning weeks of research into minutes with its LEMON assistant, proving data integration and generative AI drive rapid product launch." },
  { group: 'D-boticario', submodule: 'AI Adoption', title: 'AI Skin Assessment Drives 80% Skincare Lift in Brazil', text: "Grupo Boticário's AI tool, Meu Botik, lifts skincare sales by 80% across 4,000 stores using mobile devices and privacy-protected biometrics." },
  { group: 'D-loreal-openai', submodule: 'AI Adoption', title: "L'Oréal's Strategic AI Alliance with OpenAI: Cost Cuts, Collaboration", text: "L'Oréal's strategic alliance with OpenAI focuses on cost cuts and collaborative AI tooling across marketing and product functions." },
  { group: 'D-loreal-nvidia', submodule: 'AI Adoption', title: "L'Oréal and NVIDIA Forge a New Era of AI-Driven Beauty Innovation", text: "L'Oréal and NVIDIA are partnering to accelerate AI-driven beauty innovation across simulation, personalization and manufacturing." },
  { group: 'D-cosmax', submodule: 'AI Adoption', title: 'COSMAX Leverages AI to Transform End-to-End Cosmetic Manufacturing', text: 'COSMAX is deploying AI across its manufacturing pipeline to transform end-to-end cosmetic production and quality control.' },
];

// Shuffle order like real-world arrival (deterministic shuffle so it's reproducible)
const shuffled = [...signals];
const seed = [11,3,17,0,20,7,1,14,9,4,18,2,12,6,19,15,8,16,5,13,10];
const ordered = seed.map(i => shuffled[i]);

(async () => {
  const cardsBySubmodule = {}; // submodule -> array of { id, group, members: [{title, group, vec}], centroid }
  let nextCardId = 1;
  const log = [];

  for (const sig of ordered) {
    const vec = await embedText(sig.text);
    const bucket = (cardsBySubmodule[sig.submodule] ||= []);

    // find best match among existing cards in same submodule (mirrors findExistingInsight)
    let best = null;
    for (const card of bucket) {
      const score = cosineSimilarity(vec, card.centroid);
      if (!best || score > best.score) best = { card, score };
    }

    if (best && best.score >= CARD_SIMILARITY_THRESHOLD) {
      best.card.members.push({ title: sig.title, group: sig.group, vec });
      best.card.centroid = mean(best.card.members.map(m => m.vec));
      log.push({ title: sig.title, group: sig.group, action: 'MERGED', cardId: best.card.id, score: best.score, into: best.card.members[0].title });
    } else {
      const card = { id: nextCardId++, members: [{ title: sig.title, group: sig.group, vec }], centroid: vec };
      bucket.push(card);
      log.push({ title: sig.title, group: sig.group, action: 'NEW CARD', cardId: card.id, score: best ? best.score : null, into: null });
    }
  }

  console.log('\n=== DECISION LOG (order signals were processed) ===\n');
  for (const l of log) {
    const scoreStr = l.score !== null ? l.score.toFixed(3) : '  —  ';
    const flag = l.action === 'MERGED'
      ? (l.score < 0.75 ? ' ⚠ borderline merge' : '')
      : (l.score !== null && l.score > 0.60 ? ' ⚠ borderline miss (close but created new card)' : '');
    console.log(`[score ${scoreStr}] ${l.action.padEnd(9)} card#${l.cardId}  "${l.title}"  (real group: ${l.group})${flag}`);
  }

  console.log('\n=== FINAL CARDS ===\n');
  for (const [submodule, cards] of Object.entries(cardsBySubmodule)) {
    console.log(`--- ${submodule} ---`);
    for (const card of cards) {
      const groups = new Set(card.members.map(m => m.group));
      const mixed = groups.size > 1 ? '  ⚠ MIXED GROUPS — likely wrong merge' : '';
      console.log(`  Card #${card.id} (${card.members.length} signal${card.members.length > 1 ? 's' : ''})${mixed}`);
      for (const m of card.members) console.log(`     - [${m.group}] ${m.title}`);
    }
    console.log('');
  }
})();