require('dotenv').config();
const { designSchema } = require('./modules/decisionIntelligence/schemaDesigner');
const { callLLM } = require('./modules/llmClient');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function loadPrompt() {
  const { data } = await supabase
    .from('prompts')
    .select('prompt_template')
    .eq('id', 'decision_intelligence_inference_v2')
    .single();
  return data.prompt_template;
}

async function test(question, context) {
  console.log('\n========================================');
  console.log('Q:', question);
  console.log('========================================');

  const systemPrompt = await loadPrompt();
  const schema = await designSchema(question);

  if (!schema) {
    console.log('[skip] no schema designed — would fall back to legacy shape');
    return;
  }

  console.log('Designed headings:');
  schema.sections.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.heading}`);
    s.points.forEach(p => console.log(`     - ${p}`));
  });

  let dynamicInstructions = '';
  const headingsBlock = schema.sections
    .map((s, i) => {
      const pts = s.points.length ? '\n' + s.points.map(p => `  - ${p}`).join('\n') : '';
      return `${i + 1}. ${s.heading}${pts}`;
    })
    .join('\n\n');

  dynamicInstructions = `\n\nIMPORTANT — DYNAMIC FORMAT: Structure your answer using EXACTLY these headings and sub-points, in this exact order. Do NOT add, rename, remove, or reorder any section. Fill each section with content from the retrieved context only.\n\n${headingsBlock}\n\nReturn JSON: { "title": "...", "sections": [{ "heading": "<exact heading>", "points": ["..."] }], "bottom_line": "..." }\n`;

  const userPrompt = `Context:\n${context}\n\nQuestion: ${question}${dynamicInstructions}`;

  const raw = await callLLM(
    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    { temperature: 0.1, max_tokens: 2500, timeout: 180000 }
  );

  console.log('\nRAW RESPONSE (first 2000 chars):');
  console.log(raw.slice(0, 2000));
  console.log('...\n');
}

// Generic placeholder context — replace with real retrieved signals if you have them locally
const placeholderContext = `[1] Retail market analysis for GCC region covering subscription-based entertainment and consumer services, competitive landscape including Netflix, Shahid, OSN, and regional players.

[2] Online grocery adoption in Saudi Arabia: consumer preferences, loyalty program effectiveness, delivery and payment infrastructure, and adoption drivers.

[3] E-commerce channel strategy: marketplace vs direct-to-consumer tradeoffs, cost structures, customer acquisition economics, and channel conflict considerations.

[4] Competitive loyalty program landscape: regional and global benchmarks, points mechanics, tiering, partnership structures, and gaps in current market offerings.`;

(async () => {
  const questions = [
    'How should we price a new subscription product against Netflix and Shahid in the GCC?',
    'What drives repeat purchase in online grocery among Saudi households?',
    'Should we sell through Noon and Amazon, or build a direct-to-consumer site first?',
    'What are our competitors doing on loyalty programmes, and where is the gap?',
  ];
  for (const q of questions) {
    await test(q, placeholderContext);
  }
})();