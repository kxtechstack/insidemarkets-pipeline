/**
 * scripts/askCustomSources.js
 *
 * Search test for custom sources (no AI writing, only search).
 * Uses the real Qdrant, Supabase and search model, like the chat will.
 * Each piece shows how it was found: its meaning score (0 to 1) and its place
 * in the word search ("-" = not found that way).
 *
 * Run:
 *   node scripts/askCustomSources.js
 *       runs every question in scripts/customSourceQuestions.json and says
 *       PASS when a right page is in the top 3, FAIL when not.
 *   node scripts/askCustomSources.js "your question"
 *       one question, for the client in the questions file.
 *   node scripts/askCustomSources.js "your question" --client <clientId>
 *       one question, for another client.
 */

require('dotenv').config();
const path = require('path');
const { searchCustomSources } = require('../modules/customSources/searchCustomSources');

const TOP = 3; // a right page must be in the first 3 pieces

const short = (text, max = 220) => {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}...` : one;
};

const pagesOf = (hit) => (hit.pageFrom === null ? 'no page'
  : hit.pageFrom === hit.pageTo ? `p${hit.pageFrom}` : `p${hit.pageFrom}-${hit.pageTo}`);

function printHits(hits) {
  if (!hits.length) {
    console.log('    (nothing found)');
    return;
  }
  hits.forEach((h, i) => {
    const how = `${h.meaningScore === null ? 'meaning -' : `meaning ${h.meaningScore.toFixed(2)}`}, ${h.wordPlace === null ? 'words -' : `words #${h.wordPlace}`}`;
    console.log(`    ${i + 1}. (${how})  ${h.sourceName}  ${pagesOf(h)}${h.heading ? `  [${short(h.heading, 70)}]` : ''}`);
    console.log(`       ${short(h.text)}`);
  });
}

async function main() {
  const file = require(path.join(__dirname, 'customSourceQuestions.json'));
  const args = process.argv.slice(2);
  const clientFlag = args.indexOf('--client');
  const clientId = clientFlag >= 0 ? args[clientFlag + 1] : file.clientId;
  const question = args.filter((a, i) => clientFlag < 0 || (i !== clientFlag && i !== clientFlag + 1))[0];

  const search = async (q) => {
    const found = await searchCustomSources({ question: q, clientId, limit: 5 });
    if (found.wordSearch === 'off') console.log(`    (word search is off: ${found.wordSearchProblem}. Meaning search only.)`);
    return found.results;
  };

  // One question
  if (question) {
    console.log(`\nQ: ${question}`);
    printHits(await search(question));
    return;
  }

  // The whole list
  const like = String(file.sourceLike || '').toLowerCase();
  let passed = 0;
  const failed = [];
  for (const item of file.questions) {
    const hits = await search(item.q);
    const isRight = (h) => (!like || `${h.sourceName} ${h.title}`.toLowerCase().includes(like))
      && h.pageFrom !== null && item.pages.some((p) => p >= h.pageFrom && p <= h.pageTo);
    const rank = hits.findIndex(isRight) + 1;
    const ok = rank > 0 && rank <= TOP;
    if (ok) passed += 1; else failed.push(item.q);
    console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${item.q}`);
    console.log(`    expected: page ${item.pages.join(' or ')} (${item.answer})${rank ? `, found at place ${rank}` : ', not in the top 5'}`);
    printHits(hits);
  }
  console.log(`\n${passed} of ${file.questions.length} questions found the right page in the top ${TOP}.`);
  if (failed.length) console.log(`Not found:\n  - ${failed.join('\n  - ')}`);
}

main().catch((e) => {
  console.error('Search test crashed:', e.message);
  process.exitCode = 1;
});
