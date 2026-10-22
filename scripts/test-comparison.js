require('dotenv').config();
const readline = require('readline');
const { runV2Pipeline } = require('../modules/decisionIntelligenceV2/route');

const TEST_CLIENT_ID = 'b61b4d3b-caeb-457b-9971-636c83688ee4'; // YOUR CLIENT ID
const TEST_INDUSTRY = 'Cosmetics';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function ask(question) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`❓ QUESTION: "${question}"`);
  console.log(`${'='.repeat(70)}\n`);

  try {
    const result = await runV2Pipeline({
      question,
      clientId: TEST_CLIENT_ID,
      industry: TEST_INDUSTRY,
      forcedType: null,
    });

    const { payload, routerResult } = result;

    console.log(`\n${'─'.repeat(70)}`);
    console.log(`📋 ROUTER CLASSIFICATION`);
    console.log(`${'─'.repeat(70)}`);
    console.log(`Type       : ${routerResult.type}`);
    console.log(`Intent     : ${routerResult.intent}`);
    console.log(`Is Comp?   : ${routerResult.is_company_set_query}`);
    console.log(`Concepts   : [${(routerResult.concept_keywords || []).join(', ')}]`);
    console.log(`Entities   : [${(routerResult.entity_mentions || []).join(', ')}]`);

    console.log(`\n${'─'.repeat(70)}`);
    console.log(`💬 FINAL ANSWER`);
    console.log(`${'─'.repeat(70)}`);

    if (payload.no_data) {
      console.log(`❌ NO DATA`);
      console.log(`Message: ${payload.message}`);
      if (payload.suggestions && payload.suggestions.length) {
        console.log(`\n💡 Suggestions:`);
        payload.suggestions.forEach((s, i) => console.log(`   ${i + 1}. ${s}`));
      }
    } else if (payload.type === 'list') {
      console.log(`📝 LIST RESPONSE — ${payload.items.length} items`);
      payload.items.forEach((it, i) => {
        console.log(`   [${i + 1}] ${it.title}`);
        if (it.summary) console.log(`       ${it.summary.slice(0, 150)}...`);
      });
    } else {
      const r = payload.report || {};
      console.log(`Title: ${r.title}`);
      if (r.sections) {
        r.sections.forEach(s => {
          console.log(`\n## ${s.heading}`);
          (s.points || []).forEach(p => console.log(`   • ${p}`));
        });
      }
      if (r.bodyText) console.log(`\n${r.bodyText}`);
      if (r.bottom_line) console.log(`\nBottom Line: ${r.bottom_line}`);
    }

    if (payload.sources && payload.sources.length) {
      console.log(`\n${'─'.repeat(70)}`);
      console.log(`📚 SOURCES (${payload.sources.length})`);
      console.log(`${'─'.repeat(70)}`);
      payload.sources.forEach((s, i) => {
        const tag = s.type === 'sec' ? '[SEC]' : s.type === 'client' ? '[CLIENT]' : '[CUSTOM]';
        console.log(`   ${tag} ${s.title}`);
      });
    }

    console.log(`\n${'═'.repeat(70)}\n`);
  } catch (err) {
    console.error(`\n❌ PIPELINE ERROR: ${err.message}\n`);
  }
}

function promptUser() {
  rl.question('Type a question (or "exit"): ', async (input) => {
    const text = input.trim();
    if (text.toLowerCase() === 'exit' || text.toLowerCase() === 'quit') {
      rl.close();
      process.exit(0);
    }
    if (text.length > 0) {
      await ask(text);
    }
    promptUser();
  });
}

console.log('Comparison Test Playground. Type "exit" to quit.');
promptUser();