/**
 * scripts/test-engram-memory.js
 *
 * SANDBOX TEST — does not touch the existing chatContext.
 *
 * Runs a sample conversation through Engram's memory engine and
 * prints what it remembers, so we can compare against the current
 * state-updater output.
 *
 * Usage:
 *   node scripts/test-engram-memory.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const ENGRAM_DB_PATH = path.join(__dirname, '..', 'engram-test.db');

let NeuralBrain;
try {
  ({ NeuralBrain } = require('@engram-ai-memory/core'));
} catch (err) {
  console.error('Engram not installed. Run:');
  console.error('  npm install @engram-ai-memory/core');
  process.exit(1);
}

const HR = '━'.repeat(90);

const CONVERSATION = [
  { role: 'user', content: 'give me swot analysis for estee lauder' },
  { role: 'assistant', content: 'Estee Lauder SWOT Analysis: Strengths include global presence and diverse portfolio. Weaknesses include trailing peers and reliance on traditional retail. Opportunities include Puig acquisition and emerging markets. Threats include regulatory changes and DTC competition.' },
  { role: 'user', content: 'microsoft' },
  { role: 'assistant', content: 'Microsoft SWOT Analysis: Strengths include brand reputation and comprehensive product suite. Weaknesses include competition and vendor lock-in. Opportunities include AI and cloud growth. Threats include regulatory scrutiny and market changes.' },
  { role: 'user', content: 'what about apple' },
  { role: 'assistant', content: 'Apple SWOT Analysis: Strengths include brand loyalty and ecosystem. Weaknesses include iPhone dependence and high R&D costs. Opportunities include emerging markets and AI. Threats include competition and regulatory challenges.' },
  { role: 'user', content: 'revenue?' },
  { role: 'assistant', content: 'Apple FY2025 revenue was $416.16B. Microsoft FY2025 revenue was $281.72B.' },
];

// Helper — prints whatever shape the recall() call returned.
function printRecall(recallResult, label = '[recall]') {
  if (!recallResult || typeof recallResult !== 'object') {
    console.log(` ${label} returned non-object: ${String(recallResult).slice(0, 200)}`);
    return;
  }

  console.log(` ${label} keys=${Object.keys(recallResult).join(', ')}`);

  if (typeof recallResult.context === 'string' && recallResult.context.length > 0) {
    console.log(` ${label} context.length=${recallResult.context.length}`);
    console.log(`\n --- CONTEXT RETURNED ---`);
    console.log(recallResult.context.slice(0, 1200));
    console.log(' --- END ---\n');
    return;
  }

  if (Array.isArray(recallResult.memories)) {
    console.log(` ${label} memories=${recallResult.memories.length}`);
    recallResult.memories.slice(0, 5).forEach((m, j) => {
      const txt = typeof m === 'string' ? m : (m.content || JSON.stringify(m));
      console.log(`   [${j + 1}] ${String(txt).slice(0, 160)}`);
    });
    return;
  }

  console.log(` ${label} unexpected shape:`);
  console.log(JSON.stringify(recallResult, null, 2).slice(0, 800));
}

(async () => {
  console.log('\n' + HR);
  console.log(' Engram sandbox test — does NOT touch current chatContext');
  console.log(HR);
  console.log(` DB path: ${ENGRAM_DB_PATH}`);
  console.log(HR);

  if (fs.existsSync(ENGRAM_DB_PATH)) {
    fs.unlinkSync(ENGRAM_DB_PATH);
    console.log(' [setup] deleted old test DB');
  }

  const brain = new NeuralBrain({
    dbPath: ENGRAM_DB_PATH,
    defaultSource: 'test-conversation',
  });

  await brain.initialize();
  console.log(' [setup] Engram initialized\n');

  for (let i = 0; i < CONVERSATION.length; i++) {
    const msg = CONVERSATION[i];
    const label = `${msg.role.toUpperCase()} (turn ${i + 1})`;

    console.log(`${HR}`);
    console.log(` ${label}`);
    console.log(`${HR}`);
    console.log(` Content: "${msg.content.slice(0, 100)}${msg.content.length > 100 ? '...' : ''}"`);

    let storeResult;
    try {
      storeResult = await brain.store({
        content: msg.content,
        type: msg.role === 'user' ? 'episodic' : 'semantic',
        importance: 0.7,
      });
      const id = storeResult?.memory?.id || storeResult?.id || '?';
      console.log(` [store] id=${id}`);
    } catch (err) {
      console.log(` [store] ERROR: ${err.message}`);
    }

    const nextMsg = CONVERSATION[i + 1];
    if (nextMsg) {
      const recallQuery = nextMsg.content;
      console.log(`\n [recall] for next message: "${recallQuery}"`);
      try {
        const recallResult = await brain.recall(recallQuery);
        printRecall(recallResult, '[recall]');
      } catch (err) {
        console.log(` [recall] ERROR: ${err.message}`);
      }
    }

    console.log('');
  }

  console.log(`${HR}`);
  console.log(' FINAL ENGRAM STATE');
  console.log(`${HR}`);

  try {
    const allMemories = await brain.search('*');
    if (Array.isArray(allMemories)) {
      console.log(` Total memories stored: ${allMemories.length}`);
      allMemories.slice(0, 20).forEach((m, i) => {
        const txt = typeof m === 'string' ? m : (m.content || JSON.stringify(m));
        console.log(`   [${i + 1}] ${String(txt).slice(0, 120)}`);
      });
    } else {
      console.log(` search('*') returned:`, JSON.stringify(allMemories).slice(0, 400));
    }
  } catch (err) {
    console.log(` [search] ERROR: ${err.message}`);
  }

  try {
    const stats = await brain.stats();
    console.log(`\n Stats: ${JSON.stringify(stats, null, 2)}`);
  } catch (err) {
    console.log(` [stats] ERROR: ${err.message}`);
  }

  console.log(`\n${HR}`);
  console.log(' CROSS-TURN RETRIEVAL TEST');
  console.log(`${HR}`);
  const crossQuery = 'What revenue numbers do we have for the companies discussed?';
  console.log(` Query: "${crossQuery}"`);
  try {
    const crossResult = await brain.recall(crossQuery);
    printRecall(crossResult, '[cross]');
  } catch (err) {
    console.log(` [cross] ERROR: ${err.message}`);
  }

  try { await brain.shutdown(); } catch (err) { /* ignore */ }
  console.log('\n [done] Engram shutdown\n');
})().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});