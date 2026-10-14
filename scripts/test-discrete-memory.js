/**
 * scripts/test-discrete-memory.js
 *
 * Tests the discrete-memory state store directly (bypassing the resolver
 * and pipeline). Verifies that saveState/loadState round-trip correctly
 * and that the shape matches what the resolver expects.
 *
 * Usage:
 *   node scripts/test-discrete-memory.js
 */

require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const store = require('../modules/decisionIntelligenceV2/chatContext/discreteStateStore');

const HR = '━'.repeat(90);
let pass = 0, fail = 0;

// Stable stringify — sorts object keys recursively, so two objects with
// the same content but different key insertion order compare equal.
function stableStringify(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

function check(label, actual, expected) {
  const a = stableStringify(actual);
  const e = stableStringify(expected);
  if (a === e) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.log(`  ✗ ${label}`);
    console.log(`      expected: ${e}`);
    console.log(`      actual:   ${a}`);
    fail++;
  }
}

async function cleanup(convId) {
  await supabase
    .from('di_conversation_memories')
    .delete()
    .eq('conversation_id', convId);
}

(async () => {
  console.log('\n' + HR);
  console.log(' Discrete memory store test');
  console.log(HR);

  const convId = uuidv4();
  console.log(` conversation: ${convId}\n`);

  await cleanup(convId);

  // ── Test 1 — empty load
  console.log('Test 1 — loadState on empty conversation');
  check('returns {}', await store.loadState(convId), {});

  // ── Test 2 — write scalars
  console.log('\nTest 2 — saveState with scalar facts');
  await store.saveState(convId, {
    topic: 'SWOT analysis',
    market: 'Korea',
    metric: 'revenue',
    timeframe: 'last 3 years',
  });
  const s1 = await store.loadState(convId);
  check('all 4 scalars present', s1, {
    topic: 'SWOT analysis',
    market: 'Korea',
    metric: 'revenue',
    timeframe: 'last 3 years',
  });

  // ── Test 3 — overwrite a scalar
  console.log('\nTest 3 — saveState overwrites a scalar');
  await store.saveState(convId, { market: 'Japan' });
  const s2 = await store.loadState(convId);
  check('market updated, others kept', s2, {
    topic: 'SWOT analysis',
    market: 'Japan',
    metric: 'revenue',
    timeframe: 'last 3 years',
  });

  // ── Test 4 — entities array
  console.log('\nTest 4 — entities array');
  await store.saveState(convId, { entities: ['Apple'] });
  const s3 = await store.loadState(convId);
  check('entities = [Apple]', s3.entities, ['Apple']);

  // ── Test 5 — append to entities
  console.log('\nTest 5 — append to entities');
  await store.saveState(convId, { entities: ['Microsoft'] });
  const s4 = await store.loadState(convId);
  check('entities = [Apple, Microsoft]',
    Array.isArray(s4.entities) ? s4.entities.slice().sort() : s4.entities,
    ['Apple', 'Microsoft']);

  // ── Test 6 — dedupe entities
  console.log('\nTest 6 — dedupe entities');
  await store.saveState(convId, { entities: ['Apple', 'Apple'] });
  const s5 = await store.loadState(convId);
  check('entities still [Apple, Microsoft]',
    Array.isArray(s5.entities) ? s5.entities.slice().sort() : s5.entities,
    ['Apple', 'Microsoft']);

  // ── Test 7 — null deletes a scalar
  console.log('\nTest 7 — null deletes a scalar');
  await store.saveState(convId, { timeframe: null });
  const s6 = await store.loadState(convId);
  check('timeframe gone', 'timeframe' in s6, false);
  check('others kept', s6.topic, 'SWOT analysis');

  // ── Test 8 — null deletes entities
  console.log('\nTest 8 — null deletes entities');
  await store.saveState(convId, { entities: null });
  const s7 = await store.loadState(convId);
  check('entities gone', 'entities' in s7, false);

  // ── Test 9 — clearState wipes everything
  console.log('\nTest 9 — clearState');
  await store.clearState(convId);
  const s8 = await store.loadState(convId);
  check('everything gone', s8, {});

  // ── Test 10 — three-way merge in one call
  console.log('\nTest 10 — multi-key saveState');
  await store.saveState(convId, {
    topic: 'revenue comparison',
    entities: ['Amazon', 'Dell'],
    metric: 'revenue',
    timeframe: 'last 3 years',
  });
  const s9 = await store.loadState(convId);
  check('all 4 keys, entities array',
    { ...s9, entities: Array.isArray(s9.entities) ? s9.entities.slice().sort() : s9.entities },
    {
      topic: 'revenue comparison',
      metric: 'revenue',
      timeframe: 'last 3 years',
      entities: ['Amazon', 'Dell'],
    });

  await cleanup(convId);

  console.log('\n' + HR);
  console.log(` Passed: ${pass}  Failed: ${fail}`);
  console.log(HR + '\n');
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});