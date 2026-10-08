/**
 * scripts/context-playground.js
 *
 * Interactive REPL for testing the chatContext layer end-to-end.
 *
 * Flow per turn:
 *   1. Load conversation state
 *   2. Load recent messages (for context resolver)
 *   3. Persist user message
 *   4. Run context resolver → kind + standalone_query
 *   5. If kind is greeting/off_topic/clarification:
 *        - pass raw message to existing V2 pipeline
 *        - SKIP state updater
 *      Else:
 *        - pass standalone_query to existing V2 pipeline
 *        - run state updater with the answer
 *   6. Persist assistant message
 *   7. Print answer + new state
 *
 * Nothing is wired to the live route. This script calls the same
 * functions the wrapper route will call.
 *
 * Usage:
 *   node scripts/context-playground.js                 # new conversation
 *   node scripts/context-playground.js <conversationId># resume
 */

require('dotenv').config();

const readline = require('readline');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');

const { resolveContext } = require('../modules/decisionIntelligenceV2/chatContext/contextResolver');
const { updateState } = require('../modules/decisionIntelligenceV2/chatContext/stateUpdater');
const { loadState, saveState, clearState } = require('../modules/decisionIntelligenceV2/chatContext/stateStore');
const { runV2Pipeline } = require('../modules/decisionIntelligenceV2/route');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ─────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────
const CLIENT_ID = process.env.PLAYGROUND_CLIENT_ID || 'b61b4d3b-caeb-457b-9971-636c83688ee4';
const INDUSTRY = process.env.PLAYGROUND_INDUSTRY || 'Cosmetics';
const USER_ID = process.env.PLAYGROUND_USER_ID || '6e19245e-a79f-4d68-917d-df179a521780';

// ─────────────────────────────────────────────────────────────────────────
// Message persistence (mirrors what route.js does)
// ─────────────────────────────────────────────────────────────────────────
async function ensureConversation(conversationId, firstQuestion) {
  const { data: existing } = await supabase
    .from('di_conversations')
    .select('id')
    .eq('id', conversationId)
    .maybeSingle();

  if (existing) return;

  await supabase.from('di_conversations').insert({
    id: conversationId,
    client_id: String(CLIENT_ID),
    user_id: USER_ID,
    title: String(firstQuestion || '').slice(0, 80),
  });
}

async function appendMessage(conversationId, role, content, type = null, payload = null) {
  await supabase.from('di_messages').insert({
    conversation_id: conversationId,
    role,
    content,
    type,
    payload,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// One turn
// ─────────────────────────────────────────────────────────────────────────
async function processTurn({ conversationId, userMessage }) {
  // 1. Load current state
  const currentState = await loadState(conversationId);

  // 2. Persist user message BEFORE resolver reads recent messages
  await ensureConversation(conversationId, userMessage);
  await appendMessage(conversationId, 'user', userMessage);

  // 3. Resolve context
  console.log('\n[resolver] running...');
  const resolverResult = await resolveContext({
    conversationId,
    userMessage,
    currentState,
  });

  console.log(`[resolver] kind: ${resolverResult.kind}`);
  console.log(`[resolver] standalone: ${resolverResult.standalone_query}`);
  if (resolverResult.references.length) {
    console.log(`[resolver] references: ${JSON.stringify(resolverResult.references)}`);
  }
  if (resolverResult.context_used.length) {
    console.log(`[resolver] context_used: ${JSON.stringify(resolverResult.context_used)}`);
  }
  if (resolverResult.new_constraints.length) {
    console.log(`[resolver] new_constraints: ${JSON.stringify(resolverResult.new_constraints)}`);
  }

  // 4. Choose which query to send to the pipeline
  const skipStateUpdate =
    resolverResult.kind === 'greeting' ||
    resolverResult.kind === 'off_topic' ||
    resolverResult.kind === 'clarification';

  const queryForPipeline = skipStateUpdate
    ? userMessage
    : resolverResult.standalone_query;

  if (skipStateUpdate) {
    console.log(`[pipeline] small-talk kind — passing raw message, skipping state updater`);
  } else {
    console.log(`[pipeline] passing standalone query to V2 pipeline`);
  }

  // 5. Run existing V2 pipeline (UNCHANGED — this is the same function the live route uses)
  console.log('[pipeline] running V2 pipeline...');
  let pipelineResult;
  try {
    pipelineResult = await runV2Pipeline({
      question: queryForPipeline,
      clientId: CLIENT_ID,
      industry: INDUSTRY,
      forcedType: null,
    });
  } catch (err) {
    console.error(`[pipeline] threw: ${err.message}`);
    return;
  }

  const payload = pipelineResult.payload;
  const routerResult = pipelineResult.routerResult;

  console.log(`[pipeline] router.type=${routerResult.type} intent=${routerResult.intent}`);

  // 6. Render answer for the terminal
  const answerText = renderAnswer(payload);
  console.log('\n────────────  ANSWER  ────────────');
  console.log(answerText);
  console.log('──────────────────────────────────');

  // 7. Persist assistant message
  await appendMessage(
    conversationId,
    'assistant',
    answerText,
    payload.type,
    payload
  );

  // 8. State updater (skip for small-talk kinds)
  if (skipStateUpdate) {
    console.log('[updater] skipped (small-talk kind)');
  } else {
    console.log('\n[updater] running...');
    const updaterResult = await updateState({
      conversationId,
      userMessage: resolverResult.standalone_query,
      answer: answerText,
      currentState,
    });
    console.log(`[updater] changed_keys: ${JSON.stringify(updaterResult.changed_keys)}`);
  }

  // 9. Print final state
  const finalState = await loadState(conversationId);
  console.log(`\n[state] ${JSON.stringify(finalState, null, 2)}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Answer renderer — shows the shape of the response
// ─────────────────────────────────────────────────────────────────────────
function renderAnswer(payload) {
  if (!payload) return '(no payload)';

  // Greeting / off-topic / clarification
  if (payload.type === 'list' && payload.greeting) {
    return payload.message || '(greeting)';
  }
  if (payload.type === 'list' && payload.no_data) {
    let out = payload.message || '(no data)';
    if (Array.isArray(payload.suggestions) && payload.suggestions.length) {
      out += '\n\nSuggestions:\n' + payload.suggestions.map((s) => `- ${s}`).join('\n');
    }
    return out;
  }

  // List
  if (payload.type === 'list') {
    const items = payload.items || [];
    let out = `List: ${items.length} item(s)`;
    if (payload.message) out += `\n\n${payload.message}`;
    out += '\n';
    for (const it of items.slice(0, 10)) {
      out += `  [${it.module || '?'}] ${it.title || '(untitled)'}\n`;
    }
    if (items.length > 10) out += `  ... ${items.length - 10} more\n`;
    return out;
  }

  // Decision / inference
  if (payload.type === 'decision' || payload.type === 'inference') {
    const r = payload.report || {};
    let out = '';

    if (r.title) out += `${r.title}\n\n`;

    // Dynamic schema shape
    if (Array.isArray(r.sections) && r.sections.length) {
      for (const s of r.sections) {
        out += `## ${s.heading}\n`;
        for (const p of s.points || []) out += `- ${p}\n`;
        out += '\n';
      }
    }

    // Flat shape
    if (r.bodyText) out += `${r.bodyText}\n`;

    if (r.bottom_line) out += `\nBottom line: ${r.bottom_line}\n`;

    if (payload.chart) out += `\n[chart: ${payload.chartMeta?.chartType || 'rendered'}]\n`;

    if (Array.isArray(payload.sources)) {
      out += `\nSources (${payload.sources.length}):\n`;
      for (const s of payload.sources.slice(0, 8)) {
        const label = s.type === 'sec' ? 'SEC' : (s.module || s.type || '?');
        out += `  [${label}] ${s.title || s.url || '(untitled)'}\n`;
      }
    }

    return out;
  }

  return JSON.stringify(payload, null, 2);
}

// ─────────────────────────────────────────────────────────────────────────
// REPL
// ─────────────────────────────────────────────────────────────────────────
async function main() {
  const arg = process.argv[2];

  let conversationId;
  if (arg && arg !== 'new') {
    conversationId = arg;
    console.log(`Resuming conversation ${conversationId}`);
  } else {
    conversationId = uuidv4();
    console.log(`Starting new conversation ${conversationId}`);
    console.log(`(to resume later: node scripts/context-playground.js ${conversationId})`);
  }

  console.log(`\nclient:   ${CLIENT_ID}`);
  console.log(`industry: ${INDUSTRY}`);
  console.log(`\nType a message and press Enter. Ctrl+C to quit.\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  const prompt = () => process.stdout.write('\nYou: ');

  prompt();

  rl.on('line', async (line) => {
    const userMessage = line.trim();
    if (!userMessage) { prompt(); return; }

    if (userMessage === '/state') {
      const s = await loadState(conversationId);
      console.log(`[state] ${JSON.stringify(s, null, 2)}`);
      prompt();
      return;
    }

    if (userMessage === '/clear') {
      await clearState(conversationId);
      console.log('[state] cleared');
      prompt();
      return;
    }

    if (userMessage === '/quit') {
      rl.close();
      process.exit(0);
    }

    try {
      await processTurn({ conversationId, userMessage });
    } catch (err) {
      console.error('[turn] error:', err.message);
      console.error(err.stack);
    }

    prompt();
  });

  rl.on('close', () => {
    console.log('\nBye.');
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});