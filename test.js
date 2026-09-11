require('dotenv').config();
const { classifyQuestion } = require('./modules/decisionIntelligence/classifyQuestion');

// 50 fresh questions, none copied from the prompt's own examples.
// "expected" is my best guess at the correct answer -- if the script
// disagrees with a result you think is actually right, that's useful
// signal too (maybe my expectation is wrong, not the classifier).
const questions = [
  // ---- LIST (client's own data, enumerable items) ----
  { q: "What new sunscreen products launched in Europe this quarter?", expected: "list" },
  { q: "Which countries have banned parabens in cosmetics?", expected: "list" },
  { q: "What certifications are required to sell skincare in South Korea?", expected: "list" },
  { q: "List recent M&A deals in the beauty industry", expected: "list" },
  { q: "What packaging regulations apply to cosmetics in California?", expected: "list" },
  { q: "Which ingredients did the FDA flag this year?", expected: "list" },
  { q: "Show me recent product recalls in personal care", expected: "list" },
  { q: "What labeling requirements exist for fragrance allergens in the EU?", expected: "list" },
  { q: "List indie skincare brands that raised funding recently", expected: "list" },
  { q: "What new patents were filed for anti-aging serums?", expected: "list" },
  { q: "Which retailers expanded their beauty sections this year?", expected: "list" },
  { q: "What import duties apply to cosmetics in Brazil?", expected: "list" },
  { q: "List upcoming trade shows for the beauty industry", expected: "list" },
  { q: "What are the animal testing bans currently in effect globally?", expected: "list" },

  // ---- INFERENCE (analysis of client's own data) ----
  { q: "How has demand for clean beauty products shifted this year?", expected: "inference" },
  { q: "Why did our competitor's social engagement spike last month?", expected: "inference" },
  { q: "How is the halal cosmetics market evolving?", expected: "inference" },
  { q: "What's driving the growth in K-beauty exports?", expected: "inference" },
  { q: "How have raw material costs trended for our category?", expected: "inference" },
  { q: "Is consumer interest in sustainable packaging increasing or declining?", expected: "inference" },
  { q: "How has funding activity in beauty startups changed recently?", expected: "inference" },
  { q: "What impact did the halal certification mandate have on the market?", expected: "inference" },
  { q: "How does our brand sentiment compare to last quarter?", expected: "inference" },
  { q: "Why are retailers reducing shelf space for legacy brands?", expected: "inference" },
  { q: "How has the regulatory burden changed for indie brands this year?", expected: "inference" },
  { q: "What's the trend in private label skincare growth?", expected: "inference" },

  // ---- DECISION: SEC numeric ----
  { q: "What was Microsoft's net income in 2022?", expected: "decision" },
  { q: "Show me Nike's revenue over the last 4 years", expected: "decision" },
  { q: "What are Coca-Cola's total assets?", expected: "decision" },
  { q: "Compare Walmart and Target's cash flow in 2023", expected: "decision" },
  { q: "What was Procter & Gamble's R&D spending last year?", expected: "decision" },

  // ---- DECISION: frameworks ----
  { q: "Do a PESTLE analysis of Nestle", expected: "decision" },
  { q: "What are Unilever's main risk factors?", expected: "decision" },
  { q: "Porter's five forces analysis for Estee Lauder", expected: "decision" },
  { q: "Give me a risk breakdown for L'Oreal", expected: "decision" },
  { q: "SWOT for Colgate-Palmolive", expected: "decision" },

  // ---- DECISION: broad strategic judgment ----
  { q: "Should we enter the Southeast Asian market next year?", expected: "decision" },
  { q: "Is it a good time to acquire a smaller indie brand?", expected: "decision" },
  { q: "How should we position our brand against premium competitors?", expected: "decision" },
  { q: "What's the best pricing strategy for our new product line?", expected: "decision" },
  { q: "Should we invest more in D2C or wholesale channels?", expected: "decision" },
  { q: "Is now the right time to expand into men's grooming?", expected: "decision" },
  { q: "What's our biggest competitive threat over the next 2 years?", expected: "decision" },

  // ---- Tricky/ambiguous mixes (worth watching closely) ----
  { q: "List the SWOT factors for Apple", expected: "decision" }, // "list" phrasing but genuinely a framework
  { q: "How does Apple's SWOT compare to Samsung's?", expected: "decision" },
  { q: "What are the risks disclosed by JPMorgan and how have they changed?", expected: "decision" },
  { q: "Compare the list of banned ingredients between the EU and US", expected: "list" }, // "compare" phrasing but genuinely enumerable
  { q: "How many new regulations were introduced in the EU this quarter?", expected: "list" },
  { q: "What is the trend in the number of product recalls over time?", expected: "inference" },
  { q: "Give me Apple's revenue trend and a SWOT analysis", expected: "decision" },
  { q: "List all companies we track and their latest revenue", expected: "decision" }, // needs SEC data, not just client data
];

(async () => {
  let correct = 0;
  const misses = [];

  for (const { q, expected } of questions) {
    const { type, reasoning } = await classifyQuestion(q);
    const pass = type === expected;
    if (pass) correct++; else misses.push({ q, expected, got: type, reasoning });

    console.log(`${pass ? 'PASS' : 'FAIL'} | expected: ${expected.padEnd(10)} got: ${type.padEnd(10)} | ${q}`);
  }

  console.log(`\n\nScore: ${correct}/${questions.length}`);
  if (misses.length) {
    console.log('\n--- MISSES ---');
    misses.forEach(m => console.log(`Q: ${m.q}\n  expected ${m.expected}, got ${m.got}\n  reasoning: ${m.reasoning}\n`));
  }
})();