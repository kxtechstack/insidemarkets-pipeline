require('dotenv').config();
const store = require('../modules/decisionIntelligenceV2/chatContext/stateStore');

// Fixed set of 50 test conversations, so re-runs are deterministic.
const IDS = Array.from({ length: 50 }, (_, i) =>
  `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`
);

// Track pass/fail
let pass = 0, fail = 0;

// Key-order-insensitive stringify so Supabase jsonb key reordering
// doesn't cause false failures.
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
  if (a === e) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}\n      expected: ${e}\n      actual:   ${a}`); }
}

async function clearAll() {
  for (const id of IDS) await store.clearState(id);
}

(async () => {
  console.log('\n=== 1. Clear any prior state ===');
  await clearAll();
  console.log(`  cleared ${IDS.length} conversations`);

  console.log('\n=== 2. Empty loads for all 50 ===');
  for (const id of IDS) {
    const s = await store.loadState(id);
    if (Object.keys(s).length !== 0) { fail++; console.log(`  ✗ ${id} not empty:`, s); }
  }
  console.log(`  ✓ all 50 empty`);

  console.log('\n=== 3. Write to all 50 in parallel ===');
  await Promise.all(IDS.map((id, i) =>
    store.saveState(id, { n: i, market: 'M' + i, product: 'P' + i })
  ));
  console.log(`  wrote 50`);

  console.log('\n=== 4. Read back all 50, verify ===');
  const reads = await Promise.all(IDS.map(id => store.loadState(id)));
  for (let i = 0; i < 50; i++) {
    check(`conv ${i}: n/market/product`,
      reads[i],
      { n: i, market: 'M' + i, product: 'P' + i });
  }

  console.log('\n=== 5. Merge: add a nested object ===');
  await store.saveState(IDS[0], {
    details: { segment: 'SMEs', region: 'MENA', model: { type: 'SaaS', tier: 'gold' } }
  });
  check('nested merge',
    await store.loadState(IDS[0]),
    { n: 0, market: 'M0', product: 'P0',
      details: { segment: 'SMEs', region: 'MENA', model: { type: 'SaaS', tier: 'gold' } } }
  );

  console.log('\n=== 6. Merge: overwrite nested subkey ===');
  await store.saveState(IDS[0], {
    details: { segment: 'Enterprise' }
  });

  // DEBUG block — inspect exactly what came back
  const rawCheck = await store.loadState(IDS[0]);
  console.log('  DEBUG raw state after test 6:', JSON.stringify(rawCheck));
  console.log('  DEBUG typeof rawCheck:', typeof rawCheck);
  console.log('  DEBUG typeof rawCheck.details:', typeof rawCheck.details);
  console.log('  DEBUG rawCheck.details:', JSON.stringify(rawCheck.details));
  console.log('  DEBUG rawCheck keys:', Object.keys(rawCheck));

  check('nested overwrite (top of details replaced entirely)',
    rawCheck.details,
    { segment: 'Enterprise' }
  );

  console.log('\n=== 7. Delete a top-level key via null ===');
  await store.saveState(IDS[1], { product: null });
  const s1 = await store.loadState(IDS[1]);
  check('product deleted', s1.product === undefined, true);
  check('other keys intact', { n: s1.n, market: s1.market }, { n: 1, market: 'M1' });

  console.log('\n=== 8. Unicode + emoji + quotes ===');
  await store.saveState(IDS[2], {
    text: 'Ünïcode ✓ 日本語 🎯 "quotes" \'single\' \\backslash\\',
    newline: 'line1\nline2',
    tab: 'col1\tcol2',
  });
  const s2 = await store.loadState(IDS[2]);
  check('unicode emoji quotes survive', s2.text, 'Ünïcode ✓ 日本語 🎯 "quotes" \'single\' \\backslash\\');
  check('newlines survive', s2.newline, 'line1\nline2');
  check('tabs survive', s2.tab, 'col1\tcol2');

  console.log('\n=== 9. Arrays, numbers, booleans ===');
  await store.saveState(IDS[3], {
    competitors: ['A', 'B', 'C'],
    priority: 42,
    pi: 3.14159,
    flag: true,
    off: false,
    nothing: null,
  });
  const s3 = await store.loadState(IDS[3]);
  check('arrays', s3.competitors, ['A', 'B', 'C']);
  check('int', s3.priority, 42);
  check('float', s3.pi, 3.14159);
  check('bool true', s3.flag, true);
  check('bool false', s3.off, false);
  check('null removed', s3.nothing === undefined, true);

  console.log('\n=== 10. Large payload (~100 KB) ===');
  const big = 'x'.repeat(100 * 1024);
  await store.saveState(IDS[4], { big });
  const s4 = await store.loadState(IDS[4]);
  check('100KB string survives', s4.big.length, big.length);
  check('100KB content matches', s4.big === big, true);

  console.log('\n=== 11. Rapid sequential updates to same conv ===');
  for (let i = 0; i < 20; i++) {
    await store.saveState(IDS[5], { counter: i });
  }
  check('last write wins', (await store.loadState(IDS[5])).counter, 19);

  console.log('\n=== 12. Parallel updates to same conv (race) ===');
  await Promise.all([
    store.saveState(IDS[6], { a: 1 }),
    store.saveState(IDS[6], { b: 2 }),
    store.saveState(IDS[6], { c: 3 }),
  ]);
  const s6 = await store.loadState(IDS[6]);
  console.log(`  result: ${JSON.stringify(s6)}`);
  const hasAnyKey = 'a' in s6 || 'b' in s6 || 'c' in s6;
  check('no crash on parallel writes', hasAnyKey, true);

  console.log('\n=== 13. Invalid conversation_id ===');
  check('null id → {}', await store.loadState(null), {});
  check('empty id → {}', await store.loadState(''), {});
  check('undefined id → {}', await store.loadState(undefined), {});

  console.log('\n=== 14. Cleanup all ===');
  await clearAll();
  console.log(`  cleared`);

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
})();