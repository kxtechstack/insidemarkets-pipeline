/**
 * scripts/di-v2-playground.js
 *
 * Interactive playground for the V2 Decision Intelligence pipeline.
 *
 * This calls runV2Pipeline() — the SAME function the frontend hits via
 * /decision-intelligence-v2/chat. So what you see here is what the user
 * sees in the browser.
 *
 * Usage:
 *   node scripts/di-v2-playground.js                          # interactive REPL
 *   node scripts/di-v2-playground.js "your question here"     # one-shot
 *   node scripts/di-v2-playground.js --client <uuid>          # override client
 *   node scripts/di-v2-playground.js --industry "Cosmetics"   # override industry
 *   node scripts/di-v2-playground.js --type decision          # force type
 *   node scripts/di-v2-playground.js --verbose                # show sources + chunks
 */

require('dotenv').config();

const readline = require('readline');
const { runV2Pipeline } = require('../modules/decisionIntelligenceV2/route');
const { resolveContext } = require('../modules/decisionIntelligenceV2/chatContext/contextResolver');
const { updateState } = require('../modules/decisionIntelligenceV2/chatContext/stateUpdater');
const { loadState, saveState } = require('../modules/decisionIntelligenceV2/chatContext/stateStore');
const { v4: uuidv4 } = require('uuid');

// ─────────────────────────────────────────────────────────────────────────
// Arg parsing
// ─────────────────────────────────────────────────────────────────────────
function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const CLIENT_ID = argVal('--client', process.env.DI_CLIENT_ID || 'b61b4d3b-caeb-457b-9971-636c83688ee4');
const INDUSTRY  = argVal('--industry', process.env.DI_INDUSTRY || 'Cosmetics');
const FORCED_TYPE = argVal('--type', null);
const VERBOSE = process.argv.includes('--verbose');

// Any positional arg that isn't a flag becomes the inline question
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const INLINE_QUESTION = positional.join(' ').trim() || null;

// ─────────────────────────────────────────────────────────────────────────
// Pretty-print helpers
// ─────────────────────────────────────────────────────────────────────────
const HR = '━'.repeat(90);
const SR = '─'.repeat(90);

const shorten = (s, n = 500) => {
  if (!s) return '';
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
};

function wrapBullet(text, prefix = '   • ') {
  const width = 86;
  const words = String(text || '').split(/\s+/);
  const lines = [];
  let buf = '';
  let first = true;
  for (const w of words) {
    const p = first ? prefix : ' '.repeat(prefix.length);
    const proposed = buf ? `${buf} ${w}` : w;
    if (proposed.length + p.length > width) {
      lines.push(p + buf);
      buf = w;
      first = false;
    } else {
      buf = proposed;
    }
  }
  if (buf) lines.push((first ? prefix : ' '.repeat(prefix.length)) + buf);
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// Render the payload the way the frontend would
// ─────────────────────────────────────────────────────────────────────────
function renderAnswer(payload) {
  if (!payload) return '(no payload)';

  // ── Greeting / off-topic / clarification ───────────────────────────────
  if (payload.type === 'list' && payload.greeting) {
    console.log(`\n${payload.message || '(greeting)'}`);
    if (Array.isArray(payload.suggestions) && payload.suggestions.length) {
      console.log('\nSuggested questions:');
      payload.suggestions.forEach(s => console.log(`   • ${s}`));
    }
    return;
  }
  if (payload.type === 'list' && payload.no_data) {
    console.log(`\n${payload.message || '(no data)'}`);
    if (Array.isArray(payload.suggestions) && payload.suggestions.length) {
      console.log('\nSuggested questions:');
      payload.suggestions.forEach(s => console.log(`   • ${s}`));
    }
    return;
  }

  // ── List ───────────────────────────────────────────────────────────────
  if (payload.type === 'list') {
    const items = payload.items || [];
    console.log(`\nList: ${items.length} item(s)`);
    if (payload.message) console.log(payload.message);
    console.log();
    items.forEach((it, i) => {
      const module = it.module || '?';
      console.log(`  [${i + 1}] ${module} — ${it.title || '(untitled)'}`);
      if (it.summary) console.log(wrapBullet(shorten(it.summary, 320), '      '));
      if (it.parentLabel) console.log(`      ${it.parentLabel}`);
      if (it.url) console.log(`      ${it.url}`);
    });
    return;
  }

  // ── Decision / Inference ───────────────────────────────────────────────
  if (payload.type === 'decision' || payload.type === 'inference') {
    const r = payload.report || {};
    if (r.title) console.log(`\n${r.title}\n`);

    // Dynamic schema shape (sections array)
    if (Array.isArray(r.sections) && r.sections.length) {
      r.sections.forEach(s => {
        console.log(`▸ ${s.heading}`);
        (s.points || []).forEach(p => {
          console.log(wrapBullet(p));
        });
        console.log();
      });
    }

    // Flat shape (bodyText)
    if (r.bodyText) {
      console.log(r.bodyText);
      console.log();
    }

    if (r.bottom_line) {
      console.log(`Bottom line: ${r.bottom_line}`);
      console.log();
    }

    return;
  }

  // Fallback
  console.log(JSON.stringify(payload, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────
// Show the sources panel (what the frontend shows below the answer)
// ─────────────────────────────────────────────────────────────────────────
function renderSources(payload) {
  const sources = payload?.sources || [];
  if (sources.length === 0) {
    console.log('Sources: none');
    return;
  }
  console.log(`Sources (${sources.length}):`);
  sources.forEach((s, i) => {
    const type = s.type === 'sec' ? 'SEC' : s.type === 'client' ? 'CLIENT' : s.type === 'custom_source' ? 'PDF' : (s.type || '?');
    const title = s.title || s.source_name || '(no title)';
    const detail = s.ticker ? ` [${s.ticker} FY${s.fiscal_year} ${s.item_code || ''}]` : '';
    console.log(`  [${String(i + 1).padStart(2)}] ${type}${detail} — ${shorten(title, 90)}`);
    if (s.url && VERBOSE) console.log(`       url: ${s.url}`);
  });
}
// ─────────────────────────────────────────────────────────────────────────
// Run one question with chatContext (resolver + pipeline + updater).
// Mirrors what /chat-with-memory does on the frontend.
// ─────────────────────────────────────────────────────────────────────────
async function askWithMemory(question, session) {
  console.log('\n' + HR);
  console.log(`❯ ${question}`);
  console.log(HR);

  const t0 = Date.now();

  // Load state (facts remembered from earlier turns)
  let currentState = {};
  try {
    currentState = await loadState(session.conversationId);
  } catch (err) {
    console.log(`[loadState] failed: ${err.message}`);
  }

  // Run resolver (LLM call #1)
  let resolverResult;
  try {
    resolverResult = await resolveContext({
      conversationId: session.conversationId,
      userMessage: question,
      currentState,
    });
  } catch (err) {
    console.log(`[resolver] threw: ${err.message} — falling back to raw question`);
    resolverResult = {
      kind: 'new_question',
      standalone_query: question,
      references: [],
      context_used: [],
      new_constraints: [],
      _fallback: true,
    };
  }

  console.log(`[resolver] kind=${resolverResult.kind}`);
  console.log(`[resolver] standalone_query="${resolverResult.standalone_query}"`);
  if (resolverResult.references?.length) {
    console.log(`[resolver] references=${JSON.stringify(resolverResult.references)}`);
  }

  const skipStateUpdate =
    resolverResult.kind === 'greeting' ||
    resolverResult.kind === 'off_topic' ||
    resolverResult.kind === 'clarification';

  const queryForPipeline = skipStateUpdate ? question : resolverResult.standalone_query;

  // Run the pipeline
  let result;
  try {
    result = await runV2Pipeline({
      question: queryForPipeline,
      clientId: session.clientId,
      industry: session.industry,
      forcedType: session.forcedType || null,
    });
  } catch (err) {
    console.log(`\n[pipeline error] ${err.message}`);
    return;
  }

  const { payload, routerResult } = result;

  // Render answer
  console.log(SR);
  console.log('ANSWER');
  console.log(SR);
  renderAnswer(payload);

  console.log(SR);
  renderSources(payload);
  console.log(SR);

  // Extract a short assistantContent string (same as route.js does)
  const assistantContent =
    payload.type === 'list'
      ? `List: ${payload.items?.length ?? 0} items`
      : (payload.report?.title || '').slice(0, 200);

  // Run state updater (LLM call #2), skipped for small talk
  if (!skipStateUpdate) {
    try {
      const updaterResult = await updateState({
        conversationId: session.conversationId,
        userMessage: queryForPipeline,
        answer: assistantContent,
        currentState,
      });
      console.log(`[updater] changed_keys=[${updaterResult.changed_keys.join(', ')}]`);
      console.log(`[updater] new_state=${JSON.stringify(updaterResult.updatedState)}`);
    } catch (err) {
      console.log(`[updater] threw: ${err.message}`);
    }
  } else {
    console.log(`[updater] skipped (kind=${resolverResult.kind})`);
  }

  const ms = Date.now() - t0;
  console.log(`type=${payload.type}  ${payload.no_data ? 'no_data ' : ''}  ${ms}ms`);
}

// ─────────────────────────────────────────────────────────────────────────
// Run one question end-to-end
// ─────────────────────────────────────────────────────────────────────────
async function ask(question, opts = {}) {
  console.log('\n' + HR);
  console.log(`❯ ${question}`);
  console.log(HR);

  const t0 = Date.now();
  let result;
  try {
    result = await runV2Pipeline({
      question,
      clientId: CLIENT_ID,
      industry: INDUSTRY,
      forcedType: opts.forcedType || FORCED_TYPE || null,
    });
  } catch (err) {
    console.log(`\n[pipeline error] ${err.message}`);
    console.log(err.stack);
    return;
  }
  const ms = Date.now() - t0;

  const { payload, routerResult } = result;

  // Show router context if verbose
  if (VERBOSE && routerResult) {
    console.log(`\n[router] intent=${routerResult.intent} type=${routerResult.type}`);
    console.log(`[router] concepts=[${(routerResult.concept_keywords || []).join(', ')}] entities=[${(routerResult.entity_mentions || []).join(', ')}] sector=${routerResult.sector_term || 'none'}`);
  }

  // Show answer
  console.log(SR);
  console.log('ANSWER');
  console.log(SR);
  renderAnswer(payload);

  // Show sources
  console.log(SR);
  renderSources(payload);
  console.log(SR);

  // Timing + type
  console.log(`type=${payload.type}  ${payload.no_data ? 'no_data ' : ''}  ${ms}ms`);
}

// ─────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────
async function main() {
  if (INLINE_QUESTION) {
    // One-shot mode — check for --memory
    if (process.argv.includes('--memory')) {
      const session = {
        conversationId: uuidv4(),
        clientId: CLIENT_ID,
        industry: INDUSTRY,
        forcedType: FORCED_TYPE,
      };
      console.log(`[memory] conversation=${session.conversationId}`);
      await askWithMemory(INLINE_QUESTION, session);
    } else {
      await ask(INLINE_QUESTION);
    }
    return;
  }

  console.log('\n' + HR);
  console.log(' DI V2 Playground');
  console.log(HR);
  console.log(` clientId:   ${CLIENT_ID}`);
  console.log(` industry:   ${INDUSTRY}`);
  console.log(` forcedType: ${FORCED_TYPE || '(auto — router decides)'}`);
  console.log(` verbose:    ${VERBOSE ? 'ON' : 'off'}`);
  console.log(` memory:     ${process.argv.includes('--memory') ? 'ON (chatContext)' : 'off (raw pipeline)'}`);
  console.log('\n Commands:');
  console.log('   /memory       toggle chatContext (resolver + state)');
  console.log('   /verbose      toggle verbose');
  console.log('   /type <t>     force type (list | inference | decision | auto)');
  console.log('   /client <id>  switch client');
  console.log('   /industry <i> switch industry');
  console.log('   /quit         exit');
  console.log(HR);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

  let forcedType = FORCED_TYPE;
  let verbose = VERBOSE;
  let clientId = CLIENT_ID;
  let industry = INDUSTRY;
  let useMemory = process.argv.includes('--memory');
  let session = {
    conversationId: uuidv4(),
    clientId,
    industry,
    forcedType,
  };

  console.log(`[memory] ${useMemory ? 'ON' : 'OFF'}  conversation=${session.conversationId}`);

  const prompt = () => process.stdout.write('\n❯ ');
  prompt();

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) { prompt(); return; }

    if (trimmed === '/quit' || trimmed === 'exit' || trimmed === 'quit') { rl.close(); process.exit(0); }

    if (trimmed === '/memory') {
      useMemory = !useMemory;
      console.log(`[memory] ${useMemory ? 'ON' : 'OFF'}`);
      prompt();
      return;
    }
    if (trimmed === '/verbose') { verbose = !verbose; console.log(`[verbose] ${verbose ? 'ON' : 'OFF'}`); prompt(); return; }
    if (trimmed.startsWith('/type')) {
      const t = trimmed.split(/\s+/)[1];
      forcedType = (!t || t === 'auto') ? null : t;
      session.forcedType = forcedType;
      console.log(`[type] ${forcedType || 'auto'}`);
      prompt();
      return;
    }
    if (trimmed.startsWith('/client')) {
      const c = trimmed.split(/\s+/)[1];
      if (c) { clientId = c; session.clientId = c; console.log(`[client] ${c}`); }
      prompt();
      return;
    }
    if (trimmed.startsWith('/industry')) {
      const i = trimmed.slice('/industry'.length).trim().replace(/^["']|["']$/g, '');
      if (i) { industry = i; session.industry = i; console.log(`[industry] ${i}`); }
      prompt();
      return;
    }

    try {
      if (useMemory) {
        await askWithMemory(trimmed, session);
      } else {
        await ask(trimmed, { forcedType });
      }
    } catch (err) {
      console.log(`[turn error] ${err.message}`);
    }

    prompt();
  });

  rl.on('close', () => { console.log('\nBye.'); process.exit(0); });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});