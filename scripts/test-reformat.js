/**
 * scripts/test-reformat.js
 *
 * Tests reformat requests end-to-end.
 */

require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');

const { resolveContext } = require('../modules/decisionIntelligenceV2/chatContext/contextResolver');
const { reformatPreviousAnswer } = require('../modules/decisionIntelligenceV2/chatContext/reformatter');
const { loadState } = require('../modules/decisionIntelligenceV2/chatContext/stateStore');
const { runV2Pipeline } = require('../modules/decisionIntelligenceV2/route');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const CLIENT_ID = process.env.DI_CLIENT_ID || 'b61b4d3b-caeb-457b-9971-636c83688ee4';
const INDUSTRY  = process.env.DI_INDUSTRY  || 'Cosmetics';

const HR = '━'.repeat(90);

async function appendAssistant(conversationId, content, type, payload) {
  const { error } = await supabase.from('di_messages').insert({
    conversation_id: conversationId,
    role: 'assistant',
    content,
    type,
    payload,
  });
  if (error) console.log(`  [!] appendAssistant failed: ${error.message}`);
}

async function appendUser(conversationId, content) {
  const { error } = await supabase.from('di_messages').insert({
    conversation_id: conversationId,
    role: 'user',
    content,
  });
  if (error) console.log(`  [!] appendUser failed: ${error.message}`);
}

const SCENARIOS = [
  {
    name: 'bullet_points',
    initialQ: 'what is happening in the korean beauty market',
    reformat: 'give me this in 4 bullet points',
  },
  {
    name: 'summarize',
    initialQ: 'what is the update of glossier',
    reformat: 'summarize that',
  },
  {
    name: 'shorter',
    initialQ: 'what is happening in the cosmetics industry',
    reformat: 'make it shorter',
  },
  {
    name: 'table',
    initialQ: 'what are the major policy changes in the last week',
    reformat: 'put this in a table',
  },
];

async function runScenario(s) {
  const convId = uuidv4();
  console.log('\n' + HR);
  console.log(` Scenario: ${s.name}`);
  console.log(HR);

  // Create the parent conversation row first — di_messages has an FK on
  // conversation_id and the insert will silently fail without it.
  const { error: convErr } = await supabase
    .from('di_conversations')
    .insert({
      id: convId,
      client_id: String(CLIENT_ID),
      user_id: '6e19245e-a79f-4d68-917d-df179a521780',
      title: String(s.initialQ).slice(0, 80),
    });
  if (convErr) {
    console.log(`  ✗ FAIL — could not create conversation: ${convErr.message}`);
    return false;
  }

  console.log(`\n[turn 1] "${s.initialQ}"`);
  const currentState1 = await loadState(convId);
  const resolver1 = await resolveContext({
    conversationId: convId,
    userMessage: s.initialQ,
    currentState: currentState1,
  });
  console.log(`  [resolver] kind=${resolver1.kind}`);

  await appendUser(convId, s.initialQ);

  const pipeline = await runV2Pipeline({
    question: resolver1.standalone_query,
    clientId: CLIENT_ID,
    industry: INDUSTRY,
    forcedType: null,
  });
  const payload1 = pipeline.payload;
  const content1 = payload1.type === 'list'
    ? `List: ${(payload1.items || []).length} items`
    : (payload1.report?.title || '').slice(0, 200);
  console.log(`  [pipeline] type=${payload1.type} title="${content1}"`);
  await appendAssistant(convId, content1, payload1.type, payload1);

  console.log(`\n[turn 2] "${s.reformat}"`);
  const currentState2 = await loadState(convId);
  const resolver2 = await resolveContext({
    conversationId: convId,
    userMessage: s.reformat,
    currentState: currentState2,
  });
  console.log(`  [resolver] kind=${resolver2.kind}`);
  console.log(`  [resolver] standalone_query="${resolver2.standalone_query}"`);

  if (resolver2.kind !== 'reformat') {
    console.log(`  ✗ FAIL — resolver should have classified this as kind=reformat`);
    return false;
  }

  const reformat = await reformatPreviousAnswer({
    conversationId: convId,
    instruction: resolver2.standalone_query,
  });

  if (!reformat.payload) {
    console.log(`  ✗ FAIL — reformatter returned no payload`);
    console.log(`       previousFound=${reformat.previousFound}`);
    console.log(`       error=${reformat.error || '(none)'}`);
    return false;
  }

  const report = reformat.payload.report || {};
  console.log(`  [reformat] title="${report.title || ''}"`);
  console.log(`  [reformat] sections=${(report.sections || []).length}`);
  (report.sections || []).forEach(s => {
    console.log(`     ▸ ${s.heading}`);
    (s.points || []).forEach(p => console.log(`        • ${p.slice(0, 100)}`));
  });
  console.log(`  ✓ PASS`);
  return true;
}

(async () => {
  console.log('\n' + HR);
  console.log(' Reformat test');
  console.log(HR);

  let passed = 0, failed = 0;
  for (const s of SCENARIOS) {
    const ok = await runScenario(s);
    if (ok) passed++; else failed++;
  }

  console.log('\n' + HR);
  console.log(` Passed: ${passed}  Failed: ${failed}`);
  console.log(HR + '\n');
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => { console.error('Fatal:', err); process.exit(1); });
