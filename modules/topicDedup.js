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
const { createClient } = require('@supabase/supabase-js');
const { PLACES } = require('./placeNames');

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;

const DEDUP_COLLECTION = 'dedup_titles';
const VECTOR_SIZE = 384;
const RECENCY_WINDOW_DAYS = 60;

// ── When are two articles "the same news"? ───────────────────────────────
// A real run showed that the meaning score alone cannot decide: real copies of one
// story scored 0.68-0.89, and DIFFERENT stories from the same regulator scored 0.71-0.83
// (e.g. two different China NIDC notices, two different Indonesia BPOM rules). So:
//   score >= SAME_SCORE                -> same news
//   MAYBE_SCORE <= score < SAME_SCORE  -> compare the SPECIFIC words of the two headlines
//                                          (no AI call): same news when at least 40% of them
//                                          match and no numbers contradict each other
//   score < MAYBE_SCORE                -> different news
// "Specific words" leave out country names, short organisation names (NIDC, BPOM),
// action words (adds, revises...), general rule/news words and the client's own
// industry words. On the 10 real pairs of the 13 Nov run this was right 9 of 10 times
// (the score alone at 0.68: 4 of 10). When unsure, the article is KEPT: a lost story
// is worse than a copy, and the later checks still catch most copies.
const SAME_SCORE = Number(process.env.TOPIC_SAME_SCORE) || 0.90;
const MAYBE_SCORE = Number(process.env.TOPIC_MAYBE_SCORE) || 0.68;
const SIMILARITY_THRESHOLD = MAYBE_SCORE;          // (old name, still used below)
const MAX_CANDIDATES = 3;          // closest earlier articles looked at
const MIN_WORD_OVERLAP = 0.4;      // share of specific headline words that must match

const qdrant = new QdrantClient({
  url: QDRANT_URL,
  apiKey: QDRANT_API_KEY,
});

// NEW: a dropped connection to Qdrant ("fetch failed / other side closed", seen twice on 13 Nov)
// is tried once more after 2 seconds, instead of stopping the whole run.
const NETWORK_BLIP = /fetch failed|other side closed|socket|ECONNRESET|ETIMEDOUT|UND_ERR/i;
const retryOnce = (fn, name) => async (...args) => {
  try {
    return await fn(...args);
  } catch (e) {
    if (!NETWORK_BLIP.test(`${e && e.message} ${e && e.cause && (e.cause.code || e.cause.message)}`)) throw e;
    console.log(`[TopicDedup] Qdrant ${name} failed (${e.message}) - trying once more in 2 seconds`);
    await new Promise((r) => setTimeout(r, 2000));
    return fn(...args);
  }
};
for (const m of ['getCollections', 'createCollection', 'scroll', 'search', 'upsert']) {
  if (typeof qdrant[m] === 'function') qdrant[m] = retryOnce(qdrant[m].bind(qdrant), m);
}

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

// ── "Same news?" by headline words (no AI) ─────────────────────────────────
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const GENERAL_NEWS_WORDS = new Set(`a an the and or of on in to for by at as from with under after amid into over about its their is are be
will has have more further related matters what you your how why who this that these those all new latest
news regulatory regulation regulations rule rules update updates updated issue issues issued release releases released
announce announces announced guideline guidelines notice notices law laws policy policies draft drafts government ministry
authority authorities regulator regulators industry product products market markets company companies group report reports
say says take takes effect effects change changes changed public comment comments information procedure procedures requirement
requirements standard standards safety technical management sector official officials plan plans
crack cracks cracked cracking crackdown down strict action actions target targets targeted take taken against
2024 2025 2026 2027 january february march april may june july august september october november december
jan feb mar apr jun jul aug sep sept oct nov dec ahead approaching looms looming imminent seen amid more than over`.split(/\s+/));
// action words: in HEADLINES of copies they vary ("Amends" / "Corrects"), so they are ignored there.
// In the AI's own short signal titles they say WHAT happened ("Extends" vs "Mandates" vs "Delays"),
// so the strict check (signal titles) keeps them.
const ACTION_WORDS = new Set(`propose proposes proposed revise revises revised revising amend amends amended correct corrects corrected
add adds added adding confirm confirms confirmed implement implements implemented optimize optimise seek seeks extend extends extended
reveal reveals revoke revokes resume resumes lift lifts raid raids raided launch launches set sets introduce introduces introduced`.split(/\s+/));
// every word of every country / region name (placeNames.js) and the usual "-ese / -ian" forms:
// a place says WHERE, not WHAT happened (places are compared separately, see countriesIn)
const PLACE_WORDS = new Set([
  ...Object.entries(PLACES).flatMap(([name, forms]) => [name, ...forms])
    .flatMap((x) => String(x).toLowerCase().replace(/[^a-z ]+/g, ' ').split(' ')).filter((w) => w.length >= 2),
  ...`indonesian chinese indian korean japanese european singaporean malaysian british american emirati saudi qatari egyptian
  thai vietnamese filipino australian canadian mexican brazilian argentinian chilean colombian nigerian kenyan moroccan french
  german italian spanish portuguese dutch belgian swiss austrian irish swedish norwegian danish finnish polish czech greek
  romanian hungarian russian ukrainian pakistani bangladeshi turkish israeli african asian gulf global`.split(/\s+/),
]);
PLACE_WORDS.delete('us'); PLACE_WORDS.delete('in'); PLACE_WORDS.delete('is'); PLACE_WORDS.delete('it');
const ACRONYM = /\b[A-Z]{2,6}\b/g;   // short organisation names: NIDC, BPOM, HSA, FDA...

const clientWordsCache = new Map();   // clientId -> words of the client's industry
const getClientIndustryWords = async (clientId) => {
  const hit = clientWordsCache.get(clientId);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.words;
  let industry = '';
  try {
    const { data } = await supabase.schema('admin').from('clients').select('industry').eq('id', clientId).maybeSingle();
    industry = (data && data.industry) || '';
  } catch (e) { /* none */ }
  const words = new Set(String(industry).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).flatMap((w) => [w, w.replace(/s$/, '')]));
  clientWordsCache.set(clientId, { at: Date.now(), words });
  return words;
};

// countries named in a headline: two headlines about DIFFERENT countries are different news
const COUNTRY_CODE = { indonesia: 'id', indonesian: 'id', china: 'cn', chinese: 'cn', india: 'in', indian: 'in', korea: 'kr', korean: 'kr',
  japan: 'jp', japanese: 'jp', eu: 'eu', europe: 'eu', european: 'eu', singapore: 'sg', singaporean: 'sg', malaysia: 'my', malaysian: 'my',
  uk: 'gb', britain: 'gb', british: 'gb', england: 'gb', usa: 'us', america: 'us', american: 'us', uae: 'ae', emirates: 'ae', saudi: 'sa',
  qatar: 'qa', egypt: 'eg', thailand: 'th', thai: 'th', vietnam: 'vn', philippines: 'ph', australia: 'au', canada: 'ca', brazil: 'br',
  mexico: 'mx', taiwan: 'tw', myanmar: 'mm', pakistan: 'pk', turkey: 'tr', france: 'fr', germany: 'de', italy: 'it', spain: 'es' };
const countriesIn = (title) => new Set(String(title || '').toLowerCase().replace(/[\u2019']s\b/g, '').split(/[^a-z]+/)
  .map((w) => COUNTRY_CODE[w]).filter(Boolean));

const stemWord = (w) => w.replace(/ies$/, 'y').replace(/([^s])s$/, '$1');
const isGeneral = (w, keepActions) => GENERAL_NEWS_WORDS.has(w) || (!keepActions && ACTION_WORDS.has(w));
const specificWords = (title, industryWords, keepActions = false) => [...new Set(stripSourceSuffix(String(title || ''))
  .replace(ACRONYM, ' ').toLowerCase().replace(/[’']s\b/g, '').replace(/[’']/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
  .filter((w) => w.length >= 2 && !isGeneral(w, keepActions) && !PLACE_WORDS.has(w))
  .map(stemWord)
  .filter((w) => !isGeneral(w, keepActions) && !industryWords.has(w)))];
// numbers in a headline, also inside words ("Rp16" -> 16), years ignored
const numbersOf = (words) => words.map((w) => (w.match(/\d+/) || [''])[0]).filter((n) => n && !GENERAL_NEWS_WORDS.has(n));

/**
 * Compares the specific words of two titles. Returns { same, overlap, shared, clash }.
 *  headlines (default):  3+ shared words and 40%+, or exactly 2 shared words and 60%+
 *  strict (AI signal titles, opts.strict): action words kept, 3+ shared words and 50%+
 * Different numbers ("Rp16 billion" / "Rp9 billion") or different countries = different news.
 * Real run 13 Nov: "halal certification" or "illegal production" alone are a TOPIC shared by
 * many different news items, so 2 words are not enough unless they are most of the title.
 */
const compareHeadlines = (titleA, titleB, industryWords, opts = {}) => {
  const strict = !!opts.strict;
  const A = specificWords(titleA, industryWords, strict);
  const B = specificWords(titleB, industryWords, strict);
  const shared = A.filter((w) => B.includes(w));
  const smaller = Math.min(A.length, B.length);
  const overlap = smaller ? shared.length / smaller : 0;
  const numsA = numbersOf(A);
  const numsB = numbersOf(B);
  const placesA = countriesIn(titleA);
  const placesB = countriesIn(titleB);
  const clash = (numsA.length > 0 && numsB.length > 0 && !numsA.some((n) => numsB.includes(n)))
    || (placesA.size > 0 && placesB.size > 0 && ![...placesA].some((c) => placesB.has(c)));
  // one shared word is never enough (real run 13 Nov: two weekly round-ups shared only "review")
  const enough = strict
    ? shared.length >= 3 && overlap >= 0.5
    : (shared.length >= 3 && overlap >= MIN_WORD_OVERLAP) || (shared.length === 2 && overlap >= 0.6);
  const same = enough && !clash;
  return { same, overlap, shared, clash, sizes: [A.length, B.length] };
};

/**
 * Goes through the closest earlier articles (best score first) and decides if this
 * article is the same news as one of them. candidates: [{ score, title }]
 * Returns the matching candidate (with .why) or null.
 */
const findSameNews = async (article, candidates, label, clientId) => {
  const industryWords = clientId ? await getClientIndustryWords(clientId) : new Set();
  for (const c of [...candidates].sort((x, y) => y.score - x.score).slice(0, MAX_CANDIDATES)) {
    if (c.score < MAYBE_SCORE) break;
    if (c.score >= SAME_SCORE) return { ...c, why: `score ${c.score.toFixed(3)}` };
    const h = compareHeadlines(article.title, c.title, industryWords);
    console.log(`[SAME-CHECK] ${label} score=${c.score.toFixed(3)} words ${Math.round(h.overlap * 100)}% [${h.shared.join(', ')}]${h.clash ? ' numbers differ' : ''} -> ${h.same ? 'SAME' : 'DIFFERENT'} | "${article.title}" vs "${c.title}"`);
    if (h.same) return { ...c, why: `score ${c.score.toFixed(3)}, ${Math.round(h.overlap * 100)}% same words` };
  }
  return null;
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
    const batchCandidates = batchVectors.map((kept) => ({ score: cosineSimilarity(vector, kept.vector), title: kept.title }));
    const batchMatch = await findSameNews(article, batchCandidates, `module=${moduleId} (same batch)`, clientId);
    if (batchMatch) {
      withinBatchDropped++;
      console.log(`[DUPLICATE-BATCH] module=${moduleId} ${batchMatch.why} | "${article.title}" ~ "${batchMatch.title}" (both in same batch)`);
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
      limit: MAX_CANDIDATES,
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
    const savedMatch = await findSameNews(article,
      searchResultRaw.map((p) => ({ score: p.score, title: p.payload.title })), `module=${moduleId}`, clientId);
    if (savedMatch) {
      console.log(`[DUPLICATE] module=${moduleId} ${savedMatch.why} | "${article.title}" ~ "${savedMatch.title}"`);
      continue;
    }

    if (topMatch) {
      console.log(
        `[no match] module=${moduleId} best score=${topMatch.score.toFixed(3)} (different news) | "${article.title}" vs "${topMatch.payload.title}"`
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

// ── "Being processed" check (one more duplicate guard) ───────────────────────
// A client's sub-searches of the same module are scheduled at the same minute
// and run together. removeSameTopicArticles only compares against news already
// SAVED, and nothing is saved until the AI step ends - so each sub-search kept
// its own copy and the same news was saved 3 times (3 copies, 3 sub-searches,
// minutes apart). claimArticle runs right before the AI reads an article:
//   1. is the same news being processed right now by another sub-search?  -> skip
//   2. was it saved since this run started (by another sub-search)?        -> skip
//   3. otherwise the article stays "claimed" until release() is called (after it is saved).
// One server process: the claims live in memory.
const inFlight = new Map();   // `${clientId}:${moduleId}` -> [{ id, url, normalizedTitle, vector, title }]
let claimCounter = 0;

const sameUrl = (a, b) => {
  const clean = (u) => String(u || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  return Boolean(a && b) && clean(a) === clean(b);
};

const claimArticle = async (article, clientId, moduleId) => {
  const noClaim = { ok: true, release: () => {} };
  if (!article || !article.title) return noClaim;
  const key = `${clientId}:${moduleId}`;
  const normalizedTitle = normalizeTitle(article.title);
  let vector;
  try { vector = await embedText(buildEmbeddingText(article)); } catch (e) { return noClaim; }

  // 1. being processed right now by another sub-search
  for (const other of inFlight.get(key) || []) {
    const score = cosineSimilarity(vector, other.vector);
    // only clear cases here (this step must not wait for anything - see below)
    if (sameUrl(article.url, other.url) || (normalizedTitle && normalizedTitle === other.normalizedTitle) || score >= SAME_SCORE) {
      return { ok: false, release: () => {}, reason: `Duplicate: the same news is being processed by another search right now ("${other.title}")` };
    }
  }

  // Claim it NOW, in the same step as the check above (no waiting in between).
  // FIXED: the claim used to be written only after the Qdrant check below, which
  // waits for Qdrant - so 3 sub-searches arriving together all checked during that
  // wait, all saw "nobody", and all 3 went on to the AI.
  const id = ++claimCounter;
  if (!inFlight.has(key)) inFlight.set(key, []);
  inFlight.get(key).push({ id, url: article.url, normalizedTitle, vector, title: article.title });
  const release = () => {
    const list = (inFlight.get(key) || []).filter((x) => x.id !== id);
    if (list.length) inFlight.set(key, list); else inFlight.delete(key);
  };

  // 2. saved since this run started (another sub-search finished it first)
  try {
    const cutoffTs = Date.now() - RECENCY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const must = [
      { key: 'client_id', match: { value: clientId } },
      { key: 'module_id', match: { value: moduleId } },
      { key: 'published_date_ts', range: { gte: cutoffTs } },
    ];
    const exact = normalizedTitle ? await qdrant.scroll(DEDUP_COLLECTION, {
      filter: { must: [...must, { key: 'normalized_title', match: { value: normalizedTitle } }] }, limit: 1,
    }) : { points: [] };
    if (exact.points.length) { release(); return { ok: false, release: () => {}, reason: 'Duplicate: the same title was already handled' }; }
    const found = await qdrant.search(DEDUP_COLLECTION, { vector, limit: MAX_CANDIDATES, filter: { must }, with_payload: true });
    const match = await findSameNews(article, found.map((p) => ({ score: p.score, title: p.payload.title })), `module=${moduleId} (claim)`, clientId);
    if (match) {
      release();
      return { ok: false, release: () => {}, reason: `Duplicate: same news already handled ("${match.title}", ${match.why})` };
    }
  } catch (e) {
    console.log(`[TopicDedup] claim check could not read Qdrant (${e.message}) - continuing`);
  }

  // 3. claimed: release() is called after the article is saved (or failed)
  return { ok: true, release };
};

module.exports = {
  removeSameTopicArticles,
  commitTopicSeen,
  claimArticle,
  normalizeTitle, // exported for tests
  findSameNews,   // exported for tests
  compareHeadlines,
  SAME_SCORE,
  MAYBE_SCORE,
};