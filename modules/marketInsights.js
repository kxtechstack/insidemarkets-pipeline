const { createClient } = require('@supabase/supabase-js');
const { callLLM } = require('./llmClient');

const { pipeline } = require('@xenova/transformers');


const { QdrantClient } = require('@qdrant/js-client-rest');
const { standardPlaces } = require('./placeNames');

// one way of writing countries (same as Policy and CI)
const standardCountry = (value) => standardPlaces(value).join(', ') || 'Global';


const qdrantClient = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});

const INSIGHT_CENTROID_COLLECTION = process.env.INSIGHT_CENTROID_QDRANT_COLLECTION || 'market_insights_centroids';

let embedderPromise = null;
const getEmbedder = () => {
  if (!embedderPromise) embedderPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  return embedderPromise;
};
const embedText = async (text) => {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
};

const cosineSimilarity = (a, b) => {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

// Base threshold for cross-company topic matching in Tier 2. Anything
// below this is a different topic entirely; anything above is a
// candidate merge that then has to clear the dynamic threshold below.
const CARD_SIMILARITY_THRESHOLD = 0.55;

// As a card grows, raise the bar for accepting new members. A 55-member
// card should be very hard to extend; a 3-member card should be easy.
// This prevents runaway drift where the centroid magnetically attracts
// every article with shared vocabulary (e.g. all macro-economic articles
// collapsing into one card). Increases linearly from 0 (small card) to
// +0.15 (card with 60+ signals).
const MAX_EXTRA_THRESHOLD = 0.15;
const computeDynamicThreshold = (existingSignalCount) => {
  const growthPenalty = Math.min(
    MAX_EXTRA_THRESHOLD,
    (existingSignalCount / 60) * MAX_EXTRA_THRESHOLD
  );
  return CARD_SIMILARITY_THRESHOLD + growthPenalty;
};

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const setupInsightCentroidCollection = async () => {
  const collections = await qdrantClient.getCollections();
  const exists = collections.collections.some(c => c.name === INSIGHT_CENTROID_COLLECTION);

  if (!exists) {
    await qdrantClient.createCollection(INSIGHT_CENTROID_COLLECTION, {
      vectors: { size: 384, distance: 'Cosine' },
    });
    console.log(`[MarketInsights] Created Qdrant collection '${INSIGHT_CENTROID_COLLECTION}'`);
  }

  const indexFields = ['insight_id', 'module_id', 'client_id', 'industry', 'submodule_id'];
  for (const field of indexFields) {
    try {
      await qdrantClient.createPayloadIndex(INSIGHT_CENTROID_COLLECTION, {
        field_name: field,
        field_schema: 'keyword',
      });
    } catch (err) {
      if (!err.message.includes('already exists')) {
        console.log(`[MarketInsights] Index note for '${field}': ${err.message}`);
      }
    }
  }
};

// ── Compute and store a card's centroid ──────────────────────────────────────
// FROZEN: only the first 3 founding members (by join order) ever contribute
// to the centroid. This stops the centroid drifting toward a generic
// "topic average" as a card grows, which was making blobs easier to join
// the more members they already had.
const POLICY_COLLECTION = process.env.POLICY_QDRANT_COLLECTION || 'policy_articles';

const updateInsightCentroid = async (insightId) => {
  const { data: insight, error } = await supabase
    .from('market_insights')
    .select('client_id, module_id, submodule_id, signal_id, centroid_point_id')
    .eq('id', insightId)
    .single();

  if (error || !insight) {
    console.log(`  [Centroid] Could not load insight ${insightId}: ${error?.message}`);
    return;
  }

  const { data: clientRow, error: clientError } = await supabase
    .schema('admin')
    .from('clients')
    .select('industry')
    .eq('id', insight.client_id)
    .single();

  if (clientError || !clientRow) {
    console.log(`  [Centroid] Could not resolve industry for client ${insight.client_id}: ${clientError?.message}`);
    return;
  }

  const industry = clientRow.industry;

  const { data: members, error: membersError } = await supabase
    .from('market_insight_members')
    .select('article_id, joined_at')
    .eq('insight_id', insightId)
    .order('joined_at', { ascending: true })
    .limit(3);

  if (membersError || !members || members.length === 0) {
    console.log(`  [Centroid] No members found for insight ${insightId}`);
    return;
  }

  const articleIds = members.map(m => m.article_id);

  const points = await qdrantClient.scroll(POLICY_COLLECTION, {
    filter: {
      must: [{ key: 'article_id', match: { any: articleIds } }],
    },
    with_vector: true,
    with_payload: false,
    limit: 500,
  });

  if (!points.points || points.points.length === 0) {
    console.log(`  [Centroid] No vectors found in Qdrant for insight ${insightId}`);
    return;
  }

  const vectors = points.points.map(p => p.vector);
  const dim = vectors[0].length;
  const centroid = new Array(dim).fill(0);

  for (const vec of vectors) {
    for (let i = 0; i < dim; i++) centroid[i] += vec[i];
  }
  for (let i = 0; i < dim; i++) centroid[i] /= vectors.length;

  const { v4: uuidv4 } = require('uuid');
  const centroidPointId = insight.centroid_point_id || uuidv4();

  await qdrantClient.upsert(INSIGHT_CENTROID_COLLECTION, {
    points: [{
      id: centroidPointId,
      vector: centroid,
      payload: {
        insight_id: insightId,
        module_id: insight.module_id,
        submodule_id: insight.submodule_id,
        signal_id: insight.signal_id || null,
        client_id: insight.client_id,
        industry,
      },
    }],
  });

  if (!insight.centroid_point_id) {
    await supabase
      .from('market_insights')
      .update({ centroid_point_id: centroidPointId })
      .eq('id', insightId);
  }

  console.log(`  [Centroid] Updated centroid for insight ${insightId}`);
};

const deleteInsightCentroid = async (insightId) => {
  const { data: insight, error } = await supabase
    .from('market_insights')
    .select('centroid_point_id')
    .eq('id', insightId)
    .single();

  if (error || !insight || !insight.centroid_point_id) {
    console.log(`  [Centroid] No centroid to delete for insight ${insightId}`);
    return;
  }

  await qdrantClient.delete(INSIGHT_CENTROID_COLLECTION, {
    points: [insight.centroid_point_id],
  });

  console.log(`  [Centroid] Deleted centroid for insight ${insightId}`);
};

const SIMILAR_INSIGHTS_LIMIT = 3;

const findSimilarInsights = async (insightId) => {
  const { data: insight, error } = await supabase
    .from('market_insights')
    .select('client_id, module_id, submodule_id, centroid_point_id')
    .eq('id', insightId)
    .single();

  if (error || !insight || !insight.centroid_point_id) {
    console.log(`  [SimilarInsights] No centroid found for insight ${insightId}, skipping`);
    return [];
  }

  const { data: clientRow, error: clientError } = await supabase
    .schema('admin')
    .from('clients')
    .select('industry')
    .eq('id', insight.client_id)
    .single();

  if (clientError || !clientRow) {
    console.log(`  [SimilarInsights] Could not resolve industry for client ${insight.client_id}`);
    return [];
  }
  const industry = clientRow.industry;

  const points = await qdrantClient.retrieve(INSIGHT_CENTROID_COLLECTION, {
    ids: [insight.centroid_point_id],
    with_vector: true,
  });

  if (!points || points.length === 0) {
    console.log(`  [SimilarInsights] Centroid vector not found in Qdrant for insight ${insightId}`);
    return [];
  }

  const ownVector = points[0].vector;

  const searchResult = await qdrantClient.search(INSIGHT_CENTROID_COLLECTION, {
    vector: ownVector,
    filter: {
      must: [
        { key: 'module_id', match: { value: insight.module_id } },
        { key: 'client_id', match: { value: insight.client_id } },
        { key: 'industry', match: { value: industry } },
      ],
    },
    limit: SIMILAR_INSIGHTS_LIMIT + 1,
    with_payload: true,
  });

  const otherInsightIds = searchResult
    .filter(r => r.payload.insight_id !== insightId)
    .slice(0, SIMILAR_INSIGHTS_LIMIT)
    .map(r => ({ insight_id: r.payload.insight_id, score: r.score }));

  if (otherInsightIds.length === 0) {
    console.log(`  [SimilarInsights] No similar insights found for ${insightId}`);
    return [];
  }

  const { data: relatedInsights } = await supabase
    .from('market_insights')
    .select('id, title')
    .in('id', otherInsightIds.map(t => t.insight_id));

  const titleById = {};
  (relatedInsights || []).forEach(t => { titleById[t.id] = t.title; });

  const results = otherInsightIds.map(t => ({
    insight_id: t.insight_id,
    title: titleById[t.insight_id] || 'Untitled Insight',
    score: t.score,
  }));

  console.log(`  [SimilarInsights] Insight ${insightId} — found ${results.length} similar insight(s)`);
  return results;
};

const getDimensionName = async (submoduleId) => {
  const { data } = await supabase
    .schema('admin')
    .from('submodules')
    .select('submodule_name')
    .eq('id', submoduleId)
    .single();
  return data?.submodule_name || null;
};

const repairAndParseJson = (rawContent) => {
  let cleaned = rawContent.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  const firstBrace = cleaned.indexOf('{');
  if (firstBrace !== -1) {
    let depth = 0;
    let endIndex = -1;
    for (let i = firstBrace; i < cleaned.length; i++) {
      if (cleaned[i] === '{') depth++;
      else if (cleaned[i] === '}') {
        depth--;
        if (depth === 0) { endIndex = i; break; }
      }
    }
    if (endIndex !== -1) cleaned = cleaned.slice(firstBrace, endIndex + 1);
  }

  cleaned = cleaned
    .replace(/\\u(?![0-9a-fA-F]{4})/g, '')
    .replace(/[\u0000-\u001F]+/g, ' ')
    .replace(/\]"\s*\}/g, ']}')
    .replace(/"\s*\}\s*\}/g, '"}');

  try {
    return JSON.parse(cleaned);
  } catch (parseErr) {
    try {
      return JSON.parse(cleaned.replace(/\\"/g, '"'));
    } catch (unescapeErr) {
      try {
        const repaired = cleaned.replace(
          /"(title|summary|country)"\s*:\s*"((?:[^"\\]|\\.)*)"/g,
          (match, key, value) => `"${key}": "${value}"`
        );
        return JSON.parse(repaired);
      } catch (repairErr) {
        let repaired2 = cleaned;
        const quoteCount = (repaired2.match(/(?<!\\)"/g) || []).length;
        if (quoteCount % 2 !== 0) repaired2 += '"';
        const openBrackets = (repaired2.match(/\[/g) || []).length;
        const closeBrackets = (repaired2.match(/\]/g) || []).length;
        for (let i = 0; i < openBrackets - closeBrackets; i++) repaired2 += ']';
        const openBraces = (repaired2.match(/\{/g) || []).length;
        const closeBraces = (repaired2.match(/\}/g) || []).length;
        for (let i = 0; i < openBraces - closeBraces; i++) repaired2 += '}';
        return JSON.parse(repaired2);
      }
    }
  }
};

const calculateRelevanceLevel = (signalCount) => {
  if (signalCount >= 7) return 'Critical';
  if (signalCount >= 4) return 'High';
  if (signalCount >= 2) return 'Medium';
  return 'Low';
};

// ── Find the card a new signal belongs to ─────────────────────────────────────────
// CHANGED (16 Nov, card check: 24% of cards had signals of another sub-category, 48% had a signal
// about something else, 38% had copies). New rule - a card is a group of signals about ONE theme
// inside ONE sub-category (e.g. "Funding rounds announced"):
//   1. candidates = this client's cards in the SAME sub-category, updated in the last FIT_DAYS days
//   2. keep the closest FIT_MAX_CANDIDATES by meaning (score >= FIT_MIN_SCORE)
//   3. no candidate -> new card (no AI). Candidates -> ONE small AI question: "which card is this
//      signal part of, or none?" (same idea as Competitive Intelligence). AI fails -> new card
//      (a separate card is better than a wrong merge).
const FIT_DAYS = Number(process.env.MD_CARD_FIT_DAYS) || 30;
const FIT_MIN_SCORE = Number(process.env.MD_CARD_FIT_MIN_SCORE) || 0.45;
const FIT_MAX_CANDIDATES = 3;

const CARD_FIT_DEFAULT = `A new market signal is below, and up to 3 existing cards. A card is a group of signals about ONE specific theme or trend (for example "Scalp-serum brands raise early-stage funding").

Does the new signal belong to one of the cards? It belongs only when it is about the SAME specific theme as the signals already on that card (same kind of event, same kind of companies or products). A different theme, a different kind of company or a different kind of event is NOT the same card, even in the same industry.

NEW SIGNAL: {signal_title}
{signal_summary}

{cards}

Answer with JSON only: {"card": the card number, or 0 when it belongs to none, "reason": "one short sentence"}`;

let cardFitPromptCache = null;
const getCardFitPrompt = async () => {
  if (cardFitPromptCache && Date.now() - cardFitPromptCache.at < 10 * 60e3) return cardFitPromptCache.text;
  let text = CARD_FIT_DEFAULT;
  try {
    const { data } = await supabase.from('prompts').select('prompt_template').eq('id', 'market_card_fit_v1').eq('is_active', true).maybeSingle();
    if (data && data.prompt_template) text = data.prompt_template;
  } catch (e) { /* use the default */ }
  cardFitPromptCache = { at: Date.now(), text };
  return text;
};

/** The AI picks the card (1..n) or 0. Returns { index, reason, failed? } */
const askCardFit = async (signal, cards) => {
  try {
    const cardsText = cards.map((c, i) => `CARD ${i + 1}: ${c.title}\nSignals on it: ${(c.memberTitles || []).slice(0, 6).map((t) => `"${t}"`).join('; ') || 'none listed'}`).join('\n\n');
    const prompt = (await getCardFitPrompt())
      .replace(/{signal_title}/g, () => String(signal.title || '').slice(0, 300))
      .replace(/{signal_summary}/g, () => String(signal.summary || '').slice(0, 500))
      .replace(/{cards}/g, () => cardsText);
    const raw = await callLLM([
      { role: 'system', content: 'You are a strict classifier. You only respond with valid JSON, nothing else.' },
      { role: 'user', content: prompt },
    ], { temperature: 0, max_tokens: 80, timeout: 60000 });
    const parsed = repairAndParseJson(String(raw || '{}'));
    const n = Number(parsed.card);
    if (!Number.isInteger(n) || n < 0 || n > cards.length) return { index: -1, reason: `AI answered "${parsed.card}"`, failed: true };
    return { index: n - 1, reason: String(parsed.reason || '').slice(0, 200) };
  } catch (e) {
    return { index: -1, reason: `AI check failed (${e.message})`, failed: true };
  }
};

const findExistingInsight = async (clientId, moduleId, submoduleId, signalId, articleEmbedding, organization, signal = {}) => {
  if (!signalId) return null;   // no sub-category: never join (it would land under the wrong column)
  const since = new Date(Date.now() - FIT_DAYS * 864e5).toISOString();
  const { data: recent, error } = await supabase
    .from('market_insights')
    .select('*')
    .eq('client_id', clientId)
    .eq('module_id', moduleId)
    .eq('signal_id', signalId)
    .gte('last_enriched_at', since)
    .order('last_enriched_at', { ascending: false })
    .limit(50);
  if (error) { console.log(`  [CardMatch] lookup error: ${error.message} - new card`); return null; }
  if (!recent || !recent.length) { console.log('  [CardMatch] no recent card in this sub-category - new card'); return null; }

  // meaning score against each card (its centroid; title + summary when there is no centroid yet)
  const withCentroid = recent.filter((c) => c.centroid_point_id);
  const vecById = new Map();
  if (withCentroid.length) {
    try {
      const pts = await qdrantClient.retrieve(INSIGHT_CENTROID_COLLECTION, { ids: withCentroid.map((c) => c.centroid_point_id), with_vector: true });
      (pts || []).forEach((p) => vecById.set(String(p.id), p.vector));
    } catch (e) { /* fall back to title + summary */ }
  }
  const scored = [];
  for (const c of recent) {
    let v = c.centroid_point_id ? vecById.get(String(c.centroid_point_id)) : null;
    if (!v) v = await embedText(`${c.title || ''}. ${c.summary || ''}`);
    scored.push({ card: c, score: cosineSimilarity(articleEmbedding, v) });
  }
  const top = scored.filter((x) => x.score >= FIT_MIN_SCORE).sort((a, b) => b.score - a.score).slice(0, FIT_MAX_CANDIDATES);
  if (!top.length) {
    console.log(`  [CardMatch] ${recent.length} recent card(s) in this sub-category, none close enough (best ${Math.max(...scored.map((x) => x.score)).toFixed(3)}) - new card`);
    return null;
  }

  // the signals already on the candidate cards (so the AI sees what each card is really about)
  for (const t of top) {
    const { data: members } = await supabase.from('market_dynamics_signals').select('signal_title')
      .eq('insight_id', t.card.id).order('published_date', { ascending: false }).limit(6);
    t.card.memberTitles = (members || []).map((m) => m.signal_title);
  }
  const ai = await askCardFit(signal, top.map((t) => t.card));
  console.log(`  [CardMatch] candidates: ${top.map((t, i) => `${i + 1}) "${t.card.title}" ${t.score.toFixed(2)}`).join(' | ')} -> AI: ${ai.index >= 0 ? `card ${ai.index + 1}` : 'none'} (${ai.reason})`);
  return ai.index >= 0 ? top[ai.index].card : null;
};

const cleanText = (text) => {
  if (!text) return text;
  return text
    .replace(/^\*+/, '').replace(/\*+$/, '')
    .replace(/^title:\s*/i, '')
    .trim();
};

// opts.members (used by scripts/cleanMarketData.js): write a card for a NEW group of saved signals
// [{ signal_title, summary, organization }] instead of reading the card's signals from the database.
const generateInsightWriteup = async (existingCard, newArticleText, industry, opts = {}) => {
  const { data: promptRow, error } = await supabase
    .from('prompts')
    .select('prompt_template')
    .eq('id', 'market_dynamics_writeup_v1')
    .eq('is_active', true)
    .single();

  if (error || !promptRow) {
    throw new Error(`Could not load market_dynamics_writeup_v1 prompt: ${error?.message}`);
  }

  let companiesCovered = [];
  if (opts.members) {
    companiesCovered = [...new Set(opts.members.map((s) => s.organization).filter((o) => o && o !== 'Unknown'))];
  } else if (existingCard) {
    const { data: memberSignals } = await supabase
      .from('market_dynamics_signals')
      .select('organization')
      .eq('insight_id', existingCard.id);
    companiesCovered = [...new Set((memberSignals || []).map(s => s.organization).filter(Boolean))];
  }

  // CHANGED: the rewrite sees EVERY signal on the card (newest 15), so the title and summary describe
  // all of them, not only the old card text + the newest article (the title drifted before)
  let memberList = '';
  if (opts.members) {
    memberList = opts.members.slice(0, 15).map((m, i) => `${i + 1}. ${m.signal_title}${m.organization && m.organization !== 'Unknown' ? ` (${m.organization})` : ''}: ${String(m.summary || '').slice(0, 200)}`).join('\n');
  } else if (existingCard) {
    const { data: members } = await supabase.from('market_dynamics_signals').select('signal_title, summary, organization, published_date')
      .eq('insight_id', existingCard.id).order('published_date', { ascending: false }).limit(15);
    memberList = (members || []).map((m, i) => `${i + 1}. ${m.signal_title}${m.organization && m.organization !== 'Unknown' ? ` (${m.organization})` : ''}: ${String(m.summary || '').slice(0, 200)}`).join('\n');
  }
  const existingText = opts.members
    ? `CARD BEING BUILT FROM THESE SAVED SIGNALS:\nCompanies covered: ${companiesCovered.join(', ') || 'unknown'}\nSIGNALS ON THIS CARD:\n${memberList}\nWrite the title and summary so they describe ALL the signals above (the newest one is repeated below).`
    : existingCard
    ? `EXISTING CARD:\nTitle: ${existingCard.title}\nSummary: ${existingCard.summary}\nCompanies already covered by this card so far: ${companiesCovered.join(', ') || 'unknown'}\nSIGNALS ALREADY ON THIS CARD:\n${memberList || 'none listed'}\nRewrite the title and summary so they describe ALL the signals above plus the new article, not only the newest one.`
    : 'EXISTING CARD: none — this is the first signal for this topic.';

  const finalPrompt = promptRow.prompt_template
  .replace(/{industry}/g, industry)
  .replace(/{existing_card}/g, existingText)
  .replace(/{new_article}/g, newArticleText);

  const raw = await callLLM([
    { role: 'system', content: 'You only respond with valid JSON, nothing else.' },
    { role: 'user', content: finalPrompt },
  ], { temperature: 0.4, max_tokens: 600, timeout: 90000 });

  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  const parsed = repairAndParseJson(raw);

  return {
    title: cleanText(parsed.title),
    summary: cleanText(parsed.summary),
    short_summary: cleanText(parsed.short_summary),
    business_impact: Array.isArray(parsed.business_impact) ? parsed.business_impact.map(cleanText) : [],
    country: standardCountry(parsed.country || existingCard?.country || 'Global'),
  };
};

// ── Card importance: how close the card is to the CLIENT (same rule as Policy) ─────────
// CHANGED: before, importance only counted articles (7+ = Critical), so a busy topic that has
// nothing to do with the client was "Critical". Now: client / competitor named, the client's
// focus areas and countries - the same decideImpact the Policy module uses.
const cardImpact = async (clientId, writeup, organizations) => {
  const lrp = require('./llmRelevanceProcessor');   // loaded here (not at the top): the two files use each other
  const profile = await lrp.getClientProfile(clientId);
  const text = `${writeup.title || ''}. ${writeup.summary || ''} ${(writeup.business_impact || []).join(' ')} Companies: ${(organizations || []).join(', ')}`;
  return lrp.decideImpact(
    { signal_title: writeup.title, summary: writeup.summary, country: writeup.country, focus_matches: [], avoid_matches: [] },
    { title: writeup.title || '', text },
    profile,
  );
};

// update / insert that falls back when the impact_reason column is not added yet
const withoutReason = (row) => { const r = { ...row }; delete r.impact_reason; return r; };
const missingReasonColumn = (error) => error && /impact_reason/.test(error.message || '');

/** Takes an article back out of its card (used when saving the article fails after the card step). */
const undoInsightMember = async (articleId) => {
  const { data: members } = await supabase.from('market_insight_members').select('insight_id').eq('article_id', articleId);
  await supabase.from('market_insight_members').delete().eq('article_id', articleId);
  for (const m of members || []) {
    const { data: card } = await supabase.from('market_insights').select('id, signal_count').eq('id', m.insight_id).maybeSingle();
    if (!card) continue;
    if ((card.signal_count || 1) <= 1) {
      try { await deleteInsightCentroid(card.id); } catch (e) { /* nothing to delete */ }
      await supabase.from('market_insights').delete().eq('id', card.id);
    } else {
      await supabase.from('market_insights').update({ signal_count: card.signal_count - 1 }).eq('id', card.id);
    }
  }
};

// Main entry point — called once per relevant Market Dynamics article.
const enrichOrCreateInsight = async (clientId, moduleId, submoduleId, signalId, articleId, articleText, industry, organization, signal = {}) => {
  await setupInsightCentroidCollection();
  const articleEmbedding = await embedText((articleText || '').slice(0, 4000));
  const existing = await findExistingInsight(clientId, moduleId, submoduleId, signalId, articleEmbedding, organization,
    { title: signal.title, summary: signal.summary || String(articleText || '').slice(0, 500) });

  // the AI write-up first: if it fails, nothing has been changed yet
  const writeup = await generateInsightWriteup(existing, articleText, industry);
  const category = await getDimensionName(submoduleId);

  // companies on the card (for the importance rule)
  let organizations = organization && organization !== 'Unknown' ? [organization] : [];
  if (existing) {
    const { data: memberSignals } = await supabase.from('market_dynamics_signals').select('organization').eq('insight_id', existing.id);
    organizations = [...new Set([...organizations, ...(memberSignals || []).map((s) => s.organization).filter((o) => o && o !== 'Unknown')])];
  }
  const impact = await cardImpact(clientId, writeup, organizations);
  console.log(`  [Impact] card: ${impact.impact_level} - ${impact.impact_reason}`);

  const centroidSafe = async (id) => {   // a centroid problem does not undo the card (it is rebuilt next time)
    try { await updateInsightCentroid(id); } catch (e) { console.log(`  [Centroid] could not update for ${id}: ${e.message}`); }
  };

  if (existing) {
    const patch = {
      title: writeup.title,
      summary: writeup.summary,
      short_summary: writeup.short_summary,
      business_impact: writeup.business_impact,
      country: writeup.country,
      category,
      signal_count: existing.signal_count + 1,
      relevance_level: impact.impact_level,
      impact_reason: impact.impact_reason,
      last_enriched_at: new Date().toISOString(),
    };
    let { error: upErr } = await supabase.from('market_insights').update(patch).eq('id', existing.id);
    if (missingReasonColumn(upErr)) ({ error: upErr } = await supabase.from('market_insights').update(withoutReason(patch)).eq('id', existing.id));
    if (upErr) return { status: 'error', error: `card update: ${upErr.message}` };

    const { error: memErr } = await supabase.from('market_insight_members').insert({ insight_id: existing.id, article_id: articleId });
    if (memErr) {
      // put the card back as it was
      const back = { title: existing.title, summary: existing.summary, short_summary: existing.short_summary, business_impact: existing.business_impact,
        country: existing.country, category: existing.category, signal_count: existing.signal_count, relevance_level: existing.relevance_level,
        last_enriched_at: existing.last_enriched_at };
      await supabase.from('market_insights').update(back).eq('id', existing.id);
      return { status: 'error', error: `card member: ${memErr.message}` };
    }
    await centroidSafe(existing.id);
    console.log(`  [MarketDynamics] Enriched existing card "${writeup.title}" (now ${existing.signal_count + 1} signals)`);
    return { status: 'enriched', insightId: existing.id };
  }

  const newRow = {
    client_id: clientId,
    module_id: moduleId,
    submodule_id: submoduleId,
    signal_id: signalId,
    title: writeup.title,
    summary: writeup.summary,
    short_summary: writeup.short_summary,
    business_impact: writeup.business_impact,
    country: writeup.country,
    category,
    signal_count: 1,
    relevance_level: impact.impact_level,
    impact_reason: impact.impact_reason,
    last_enriched_at: new Date().toISOString(),
  };
  let { data: newInsight, error } = await supabase.from('market_insights').insert(newRow).select().single();
  if (missingReasonColumn(error)) ({ data: newInsight, error } = await supabase.from('market_insights').insert(withoutReason(newRow)).select().single());

  if (error || !newInsight) {
    console.error('  [MarketDynamics] Failed to create insight:', error ? error.message : 'no row returned');
    return { status: 'error', error: error ? error.message : 'no row returned' };
  }

  const { error: memErr } = await supabase.from('market_insight_members').insert({ insight_id: newInsight.id, article_id: articleId });
  if (memErr) {
    await supabase.from('market_insights').delete().eq('id', newInsight.id);
    return { status: 'error', error: `card member: ${memErr.message}` };
  }
  await centroidSafe(newInsight.id);
  console.log(`  [MarketDynamics] Created new card "${writeup.title}"`);
  return { status: 'created', insightId: newInsight.id };
};

module.exports = { getDimensionName, askCardFit, findExistingInsight, generateInsightWriteup, enrichOrCreateInsight, setupInsightCentroidCollection, updateInsightCentroid, findSimilarInsights, deleteInsightCentroid, undoInsightMember, cardImpact, calculateRelevanceLevel };