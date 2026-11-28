/**
 * modules/customSources/embedText.js
 *
 * Turns text into a search vector (384 numbers).
 *
 * The same model and the same settings as the rest of the platform
 * (llmRelevanceProcessor.embedText and the DI chat): Xenova/all-MiniLM-L6-v2,
 * mean pooling, normalized. So custom pieces and questions from the DI chat
 * can be compared.
 *
 * It is loaded here on its own (not borrowed from llmRelevanceProcessor.js),
 * because that file also starts a Redis connection, which the custom
 * sources do not need.
 */

const MODEL = 'Xenova/all-MiniLM-L6-v2';

let modelPromise = null;
function loadModel() {
  if (!modelPromise) {
    const { pipeline } = require('@xenova/transformers');
    modelPromise = pipeline('feature-extraction', MODEL).catch((e) => {
      modelPromise = null; // try again next time
      throw e;
    });
  }
  return modelPromise;
}

async function embedText(text) {
  const model = await loadModel();
  const output = await model(String(text), { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

module.exports = { embedText, MODEL };
