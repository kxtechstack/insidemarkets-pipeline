require('dotenv').config();

const { updateState } = require('../modules/decisionIntelligenceV2/chatContext/stateUpdater');
const { saveState, loadState, clearState } = require('../modules/decisionIntelligenceV2/chatContext/stateStore');

const CID = '33333333-3333-4333-8333-333333333333';

function show(label, before, userMessage, answer, result) {
  console.log(`\n--- ${label} ---`);
  console.log(`before:        ${JSON.stringify(before)}`);
  console.log(`user:          ${JSON.stringify(userMessage)}`);
  console.log(`changed_keys:  ${JSON.stringify(result.changed_keys)}`);
  console.log(`after:         ${JSON.stringify(result.updatedState)}`);
}

(async () => {
  console.log('=== State updater local test ===\n');

  // ── Case 1: empty state, first business question
  await clearState(CID);
  let before = {};
  let result = await updateState({
    conversationId: CID,
    userMessage: 'What is the optimal pricing strategy for our B2B SaaS product in Saudi Arabia?',
    answer: 'Value-based pricing is recommended for the upper-mid segment in Saudi Arabia.',
    currentState: before,
  });
  show('Case 1 — first business question', before, 'optimal pricing strategy', 'answer', result);

  // ── Case 2: add segment without touching market/product
  before = await loadState(CID);
  result = await updateState({
    conversationId: CID,
    userMessage: 'What if we target SMEs instead?',
    answer: 'For SMEs, a freemium-to-tiered model works better.',
    currentState: before,
  });
  show('Case 2 — target segment changes', before, 'SMEs', 'answer', result);

  // ── Case 3: market change replaces prior
  before = await loadState(CID);
  result = await updateState({
    conversationId: CID,
    userMessage: 'Actually, let\u2019s look at UAE instead.',
    answer: 'For the UAE, the competitive landscape differs...',
    currentState: before,
  });
  show('Case 3 — market changes to UAE', before, 'Actually let’s look at UAE', 'answer', result);

  // ── Case 4: greeting — no state change
  before = await loadState(CID);
  result = await updateState({
    conversationId: CID,
    userMessage: 'hi',
    answer: 'Hi! What can I help with?',
    currentState: before,
  });
  show('Case 4 — greeting, no change', before, 'hi', 'Hi!...', result);

  // ── Case 5: entities added
  before = await loadState(CID);
  result = await updateState({
    conversationId: CID,
    userMessage: 'Compare Estée Lauder and Ulta on their recent revenue.',
    answer: 'Estée Lauder FY2025 was $14.33B; Ulta FY2025 was $11.30B.',
    currentState: before,
  });
  show('Case 5 — entities added', before, 'Compare EL and ULTA', 'answer', result);

  // ── Case 6: open question resolved
  await clearState(CID);
  await saveState(CID, {
    entities: ['EL', 'ULTA'],
    topic: 'revenue comparison',
    open_questions: ['show chart'],
  });
  before = await loadState(CID);
  result = await updateState({
    conversationId: CID,
    userMessage: 'yes',
    answer: 'Here is the chart...',
    currentState: before,
  });
  show('Case 6 — open question resolved', before, 'yes', 'Here is the chart...', result);

  // ── Cleanup
  await clearState(CID);

  console.log('\n=== done ===');
  process.exit(0);
})();