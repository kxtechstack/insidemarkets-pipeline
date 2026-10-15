/**
 * test-mem0.js
 * =============
 * Standalone test for the Mem0 adapter.
 * Verifies Novita LLM + FastEmbed + Qdrant all work together.
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

  // ── Test 1: saveState ─────────────────────────────────────────────
  console.log('\n[Test] 1. Calling saveState...');
  try {
    await adapter.saveState(testConvId, {
      topic: 'SWOT analysis',
      entities: ['Estee Lauder', 'Microsoft'],
      market: 'Korea',
    });
    console.log('[Test] saveState returned OK');
  } catch (err) {
    console.error('[Test] saveState failed:', err.message);
  }

  // ── Test 2: loadState ─────────────────────────────────────────────
  console.log('\n[Test] 2. Calling loadState...');
  try {
    const state = await adapter.loadState(testConvId);
    console.log('[Test] loadState returned:');
    console.log(JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[Test] loadState failed:', err.message);
  }

  // ── Test 3: updateState (merge) ───────────────────────────────────
  console.log('\n[Test] 3. Merging new state...');
  try {
    await adapter.saveState(testConvId, {
      entities: ['Amazon'],
    });
    const state = await adapter.loadState(testConvId);
    console.log('[Test] After merge:');
    console.log(JSON.stringify(state, null, 2));
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