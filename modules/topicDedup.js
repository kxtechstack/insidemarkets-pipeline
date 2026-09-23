/**
 * topicDedup.js
 * ==============
 * Embedding-based "same topic" duplicate detection using Qdrant.
 *
 * Scoped by client_id + module_id (NOT submodule_id) -- same reasoning
 * as deduplicator.js.
 *
 * ── CHANGED (this pass) ─────────────────────────────────────────────
 * Added WITHIN-BATCH dedup. Previously this function only compared each
 * article against what was ALREADY committed to Qdrant's dedup_titles
 * collection. Because commits happen LATER (in llmRelevanceProcessor via
 * commitTopicSeen, after the LLM stage), a single batch containing 14
 * syndicated copies of the same press release would find nothing to
 * compare against and let all 14 through. This was the root cause of
 * the "Grid Flexibility" trend showing 14 identical signals.
 *
 * Now, while iterating the batch, we maintain an in-memory set of
 * normalized titles AND an in-memory array of embeddings for articles
 * we've already decided to KEEP in this batch. Every subsequent article
 * is compared against both before hitting Qdrant. This collapses
 * syndicated copies to 1 at the dedup stage, which is where they belong.
 *
 * ── Also changed ────────────────────────────────────────────────────
 * commitTopicSeen now returns a boolean (true = committed, false = failed)
 * instead of swallowing errors silently. Callers can log a warning but
 * should not abort — the article is already stored, only the dedup marker
 * failed, which is recoverable.
 */

const { QdrantClient } = require('@qdrant/js-client-rest');
const { pipeline } = require('@xenova/transformers');
const { v4: uuidv4 } = require('uuid');

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;

const DEDUP_COLLECTION = 'dedup_titles';
const VECTOR_SIZE = 384;
const SIMILARITY_THRESHOLD = 0.68;
const RECENCY_WINDOW_DAYS = 60;

const qdrant = new QdrantClient({
  url: QDRANT_URL,
  apiKey: QDRANT_API_KEY,
});

let embedderPromise = null;
const getEmbedder = () => {
  if (!embedderPromise) {
    console.log('[TopicDedup] Loading embedding model (first call only)...');
    embedderPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return embedderPromise;
};

const embedText = async (text) => {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
};

// ── Cosine similarity (in-memory, for within-batch comparison) ─────────────
// Vectors from Xenova's all-MiniLM-L6-v2 with normalize:true are already
// unit-length, so cosine == dot product. But we keep the full formula for
// safety against any future embedding source that isn't pre-normalized.
const cosineSimilarity = (a, b) => {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
};

const stripSourceSuffix = (title) => {
  return title
    .split(/\s[|｜»]\s|\s-\s(?=[A-Z][\w\s.&]*$)/)[0]
    .trim();
};

const normalizeTitle = (title) =>
  stripSourceSuffix(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const SNIPPET_LENGTH = 400;

const buildEmbeddingText = (article) => {
  const title = stripSourceSuffix(article.title || '');
  let snippet = '';

  if (article.text) {
    const cleaned = article.text
      .replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    snippet = cleaned.slice(0, SNIPPET_LENGTH);
  }

  return snippet ? `${title}. ${snippet}` : title;
};

const setupDedupCollection = async () => {
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some(c => c.name === DEDUP_COLLECTION);

  if (!exists) {
    await qdrant.createCollection(DEDUP_COLLECTION, {
      vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
    });
    console.log(`[TopicDedup] Collection '${DEDUP_COLLECTION}' created.`);
  }

  const indexFields = [
    { name: 'client_id', schema: 'keyword' },
    { name: 'module_id', schema: 'keyword' },
    { name: 'published_date_ts', schema: 'integer' },
    { name: 'normalized_title', schema: 'keyword' },
  ];

  for (const field of indexFields) {
    try {
      await qdrant.createPayloadIndex(DEDUP_COLLECTION, {
        field_name: field.name,
        field_schema: field.schema,
      });
    } catch (err) {
      if (!err.message.includes('already exists')) {
        console.log(`[TopicDedup] Index note for '${field.name}': ${err.message}`);
      }
    }
  }
};

/**
 * @param {Array} articles - articles that already passed the URL dedup check
 * @param {String} clientId
 * @param {String} moduleId
 * @returns {Promise<Array>} unique articles (same-topic duplicates removed)
 */
const removeSameTopicArticles = async (articles, clientId, moduleId) => {
  if (!articles || articles.length === 0) return [];

  await setupDedupCollection();

  const cutoffTs = Date.now() - RECENCY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const uniqueArticles = [];

  // ── WITHIN-BATCH state (new) ──────────────────────────────────────────
  // These track what we've decided to KEEP in this specific call, so
  // syndicated copies within the same fetch never reach Qdrant comparison.
  const batchNormalizedTitles = new Set();
  const batchVectors = []; // [{ vector, title, url }]

  let withinBatchDropped = 0;

  for (const article of articles) {
    if (!article.title) {
      uniqueArticles.push(article);
      continue;
    }

    const normalizedTitle = normalizeTitle(article.title);

    // ── CHECK 1: exact title within this batch ────────────────────────
    if (batchNormalizedTitles.has(normalizedTitle)) {
      withinBatchDropped++;
      console.log(`[DUPLICATE-BATCH-EXACT] module=${moduleId} | "${article.title}" ~ identical title in same batch`);
      continue;
    }

    const textForEmbedding = buildEmbeddingText(article);
    const vector = await embedText(textForEmbedding);

    // ── CHECK 2: embedding similarity within this batch ───────────────
    let batchMatch = null;
    let batchBestScore = 0;
    for (const kept of batchVectors) {
      const score = cosineSimilarity(vector, kept.vector);
      if (score > batchBestScore) {
        batchBestScore = score;
        batchMatch = kept;
      }
    }

    if (batchMatch && batchBestScore >= SIMILARITY_THRESHOLD) {
      withinBatchDropped++;
      console.log(
        `[DUPLICATE-BATCH] module=${moduleId} score=${batchBestScore.toFixed(3)} | "${article.title}" ~ "${batchMatch.title}" (both in same batch)`
      );
      continue;
    }

    // ── CHECK 3: exact title already in Qdrant (cross-run) ────────────
    const exactMatch = await qdrant.scroll(DEDUP_COLLECTION, {
      filter: {
        must: [
          { key: 'client_id', match: { value: clientId } },
          { key: 'module_id', match: { value: moduleId } },
          { key: 'normalized_title', match: { value: normalizedTitle } },
          { key: 'published_date_ts', range: { gte: cutoffTs } },
        ],
      },
      limit: 1,
    });

    if (exactMatch.points.length > 0) {
      console.log(`[DUPLICATE-EXACT] module=${moduleId} | "${article.title}" ~ identical title already seen`);
      continue;
    }

    // ── CHECK 4: embedding similarity already in Qdrant (cross-run) ───
    const searchResultRaw = await qdrant.search(DEDUP_COLLECTION, {
      vector,
      limit: 1,
      filter: {
        must: [
          { key: 'client_id', match: { value: clientId } },
          { key: 'module_id', match: { value: moduleId } },
          { key: 'published_date_ts', range: { gte: cutoffTs } },
        ],
      },
      with_payload: true,
    });

    const topMatch = searchResultRaw[0];

    if (topMatch && topMatch.score >= SIMILARITY_THRESHOLD) {
      console.log(
        `[DUPLICATE] module=${moduleId} score=${topMatch.score.toFixed(3)} | "${article.title}" ~ "${topMatch.payload.title}"`
      );
      continue;
    }

    if (topMatch) {
      console.log(
        `[no match] module=${moduleId} best score=${topMatch.score.toFixed(3)} (below ${SIMILARITY_THRESHOLD}) | "${article.title}" vs "${topMatch.payload.title}"`
      );
    }

    // ── KEEP ──────────────────────────────────────────────────────────
    // Add to within-batch trackers so subsequent articles in this same
    // call are compared against it, then push to results.
    batchNormalizedTitles.add(normalizedTitle);
    batchVectors.push({ vector, title: article.title, url: article.url });
    uniqueArticles.push(article);
  }

  console.log(
    `[TopicDedup] module=${moduleId}: ${uniqueArticles.length} unique out of ${articles.length} (${withinBatchDropped} dropped within batch)`
  );
  return uniqueArticles;
};

/**
 * Commits a single article's topic embedding to the dedup collection.
 * Returns true on success, false on failure. A failed commit means the
 * article may be re-processed on a future run (dedup won't recognize it),
 * which is recoverable and should be logged, not thrown.
 */
const commitTopicSeen = async (article, clientId, moduleId) => {
  if (!article || !article.title) return false;
  try {
    const normalizedTitle = normalizeTitle(article.title);
    const textForEmbedding = buildEmbeddingText(article);
    const vector = await embedText(textForEmbedding);
    const publishedTs = article.publishedDate
      ? new Date(article.publishedDate).getTime()
      : Date.now();

    await qdrant.upsert(DEDUP_COLLECTION, {
      wait: true,
      points: [{
        id: uuidv4(),
        vector,
        payload: {
          client_id: clientId,
          module_id: moduleId,
          title: article.title,
          normalized_title: normalizedTitle,
          url: article.url,
          published_date_ts: publishedTs,
        },
      }],
    });
    return true;
  } catch (err) {
    console.error(`[TopicDedup] commitTopicSeen FAILED for "${article.url}": ${err.message}`, err.stack);
    return false;
  }
};

module.exports = {
  removeSameTopicArticles,
  commitTopicSeen,
};