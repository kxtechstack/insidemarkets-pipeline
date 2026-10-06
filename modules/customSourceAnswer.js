const { callLLM } = require('./llmClient');

const answerFromCustomChunks = async (question, chunks) => {
  if (chunks.length === 0) {
    return { answer: null, sources: [] };
  }

  const excerpts = chunks
    .map((c, i) => `[${i + 1}] (source: ${c.source_name})\n${c.text}`)
    .join('\n\n');

  const systemPrompt = [
    'You answer business questions using ONLY the numbered excerpts provided.',
    'Rules:',
    '- If the excerpts do not cover the question, say so plainly. Do not use outside knowledge to fill gaps.',
    '- Write the answer in your own words. Do not copy sentences from the excerpts.',
    '- Keep every number, date, and percentage exactly as written in the excerpts, attached to the same label.',
    '- Cite excerpts inline as [1], [2], etc.',
  ].join('\n');

  const userPrompt = `Question: ${question}\n\nExcerpts:\n${excerpts}`;

  const answer = await callLLM(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    { temperature: 0.2, max_tokens: 1200, timeout: 120000 }
  );

  const sources = [...new Set(chunks.map(c => c.source_name))];
  return { answer, sources };
};

module.exports = { answerFromCustomChunks };