/**
 * test-mem0.js
 * =============
 * Tests the Mem0 adapter logic for topic switching.
 * 
 * Run: node scripts/test-mem0.js
 */

require('dotenv').config();

async function testMem0() {
  console.log('[Test] Loading mem0Adapter...');

  let adapter;
  try {
    adapter = require('../modules/decisionIntelligenceV2/chatContext/mem0Adapter');
  } catch (err) {
    console.error('[Test] Failed to load adapter:', err.message);
    process.exit(1);
  }

  const testConvId = 'test-conv-' + Date.now();
  console.log(`[Test] Using conversation: ${testConvId}`);

  // ── Test 1: Initial State (L'Oreal) ──────────────────────────────
  console.log('\n[Test] 1. Saving initial state for L\'Oreal...');
  try {
    await adapter.saveState(testConvId, {
      topic: 'recent news',
      entities: ['L\'Oreal']
    });
    console.log('[Test] saveState returned OK');
  } catch (err) {
    console.error('[Test] saveState failed:', err.message);
  }

  // ── Test 2: Load State ───────────────────────────────────────────
  console.log('\n[Test] 2. Loading current state...');
  try {
    const state = await adapter.loadState(testConvId);
    console.log('[Test] loadState returned:');
    console.log(JSON.stringify(state, null, 2));
    if (state.entities && state.entities.includes("L'Oreal")) {
      console.log("✅ PASS: L'Oreal is in the state.");
    } else {
      console.log("❌ FAIL: L'Oreal is missing from the state.");
    }
  } catch (err) {
    console.error('[Test] loadState failed:', err.message);
  }

  // ── Test 3: Clear L'Oreal, switch to Industry ────────────────────
  console.log('\n[Test] 3. Simulating switch to Cosmetics Industry...');
  console.log('[Test] Clearing old entities and saving new industry topic...');
  try {
    // In our new logic, we clear entities when moving from a company to an industry
    await adapter.saveState(testConvId, {
      topic: 'SWOT analysis',
      entities: null // This tells mem0 to clear the old entities
    });
    
    // Now save the new industry focus
    await adapter.saveState(testConvId, {
      industry: 'Cosmetics'
    });

    const state = await adapter.loadState(testConvId);
    console.log('[Test] After switch, state is:');
    console.log(JSON.stringify(state, null, 2));
    
    if (!state.entities || !state.entities.includes("L'Oreal")) {
      console.log("✅ PASS: L'Oreal was successfully removed from state.");
    } else {
      console.log("❌ FAIL: L'Oreal is still in the state! The context will break.");
    }
  } catch (err) {
    console.error('[Test] merge failed:', err.message);
  }

  // ── Test 4: clearState ────────────────────────────────────────────
  console.log('\n[Test] 4. Calling clearState...');
  try {
    await adapter.clearState(testConvId);
    console.log('[Test] clearState returned OK');
  } catch (err) {
    console.error('[Test] clearState failed:', err.message);
  }

  console.log('\n[Test] Done.');
  process.exit(0);
}

testMem0().catch((err) => {
  console.error('[Test] Fatal error:', err);
  process.exit(1);
});