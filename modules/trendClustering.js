const { QdrantClient } = require('@qdrant/js-client-rest');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
const { callLLM } = require('./llmClient');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});

const TREND_COLLECTION = process.env.TREND_QDRANT_COLLECTION || 'trend_matching';

// Fetches this client's ICP context (competitors, sectors, focus areas) so
// trend write-ups can judge impact specifically for this client, not just
// the industry in general. Returns null if no ICP data exists -- callers
// must fall back gracefully.
const getClientContext = async (clientId) => {
  try {
    const { data, error } = await supabase
      .schema('admin')
      .from('client_icp')
      .select('context_json')
      .eq('client_id', clientId)
      .single();

    if (error || !data || !data.context_json) {
      console.log(`[ClientContext] No ICP data found for client ${clientId}, using industry-only reasoning.`);
      return null;
    }

    const ctx = data.context_json;
    const lines = [];

    if (Array.isArray(ctx.competitors) && ctx.competitors.length > 0) {
      lines.push(`Known competitors: ${ctx.competitors.join(', ')}`);
    }
    if (Array.isArray(ctx.core_sectors) && ctx.core_sectors.length > 0) {
      lines.push(`Core sectors: ${ctx.core_sectors.join(', ')}`);
    }
    if (Array.isArray(ctx.focus_products_services) && ctx.focus_products_services.length > 0) {
      lines.push(`Focus products/services: ${ctx.focus_products_services.join(', ')}`);
    }
    if (Array.isArray(ctx.geographic_focus) && ctx.geographic_focus.length > 0) {
      lines.push(`Geographic focus: ${ctx.geographic_focus.join(', ')}`);
    }
    if (Array.isArray(ctx.sectors_to_avoid) && ctx.sectors_to_avoid.length > 0) {
      lines.push(`Lower priority / not core focus for this client: ${ctx.sectors_to_avoid.join(', ')}`);
    }

    if (lines.length === 0) return null;
    return lines.join('\n');

  } catch (err) {
    console.log(`[ClientContext] Error fetching context for client ${clientId}: ${err.message}. Falling back to industry-only reasoning.`);
    return null;
  }
};

// Fetches just the competitors array for the grounding check and the
// multi-signal override below. Same pattern as llmRelevanceProcessor.js's
// getCompetitorsList.
const getCompetitorsList = async (clientId) => {
  try {
    const { data } = await supabase
      .schema('admin')
      .from('client_icp')
      .select('context_json')
      .eq('client_id', clientId)
      .single();
    return data?.context_json?.competitors || [];
  } catch (err) {
    return [];
  }
};

// Deterministic safety net — the writeup prompt tells the model to
// only credit a competitor if that competitor's name literally appears in
// the signals text, but this 3B model does not reliably follow that
// instruction (it pulls competitor names from the client context and
// inserts them into the summary/business_impact even when the signals
// never mention them). This checks every competitor name the model used
// against the ACTUAL signals text in code, and strips/downgrades any
// fabricated competitor claim before it's stored.
const applyCompetitorGroundingCheck = (result, signalsText, competitors, signals) => {
  if (!Array.isArray(competitors) || competitors.length === 0) return result;

  const signalsLower = signalsText.toLowerCase();

  // Find any competitor the model mentioned in its output that does NOT
  // appear anywhere in the actual signals text it was given.
  const hallucinated = competitors.filter(comp => {
    const compLower = comp.toLowerCase();
    const mentionedInOutput =
      (result.summary || '').toLowerCase().includes(compLower) ||
      (result.business_impact || []).some(b => (b || '').toLowerCase().includes(compLower));
    const presentInSignals = signalsLower.includes(compLower);
    return mentionedInOutput && !presentInSignals;
  });

  if (hallucinated.length === 0) return result;

  console.log(`  [CompetitorGrounding] Fabricated competitor mention(s) detected: ${hallucinated.join(', ')} — not present in actual signals`);

  // Strip business_impact bullets that reference a hallucinated competitor
  const cleanedBusinessImpact = (result.business_impact || []).filter(bullet => {
    const bulletLower = (bullet || '').toLowerCase();
    return !hallucinated.some(comp => bulletLower.includes(comp.toLowerCase()));
  });

  // If dropping fabricated bullets left too few (or zero), fall back to a
  // generic bullet so the trend card never ships with an empty array.
  const involvedOrgs = [...new Set((signals || []).map(s => s.organization).filter(Boolean))];
  const orgList = involvedOrgs.length > 0 ? involvedOrgs.slice(0, 3).join(', ') : 'emerging players';
  const finalBusinessImpact = cleanedBusinessImpact.length > 0
    ? cleanedBusinessImpact
    : [`This trend is currently being driven by ${orgList} rather than any of the client's named competitors, making it worth monitoring as an emerging opportunity rather than a defensive priority.`];

  // summary is free-form prose, so we can't cleanly delete just the
  // company name mid-sentence without garbling the sentence. Instead, split
  // on sentence boundaries and drop any WHOLE sentence that names a
  // hallucinated competitor — safer than partial edits, and still leaves a
  // coherent (if shorter) summary behind.
  let cleanedSummary = result.summary || '';
  if (cleanedSummary) {
    const sentences = cleanedSummary.match(/[^.!?]+[.!?]+/g) || [cleanedSummary];
    const keptSentences = sentences.filter(sentence => {
      const sentenceLower = sentence.toLowerCase();
      return !hallucinated.some(comp => sentenceLower.includes(comp.toLowerCase()));
    });
    cleanedSummary = keptSentences.join(' ').trim();
    // If every sentence got dropped (all of them named a fabricated
    // competitor), fall back to a short generic line rather than an
    // empty summary field.
    if (!cleanedSummary) {
      cleanedSummary = 'This trend is within the clients broader industry but does not directly involve a named competitor based on available signals.';
    }
  }

  // A hallucinated competitor was the only evidence for a High rating —
  // that rating is not actually earned. Downgrade to Medium, matching the
  // same logic as applyCriticalRequiresCompetitorOverride in
  // llmRelevanceProcessor.js.
  const wasHighOnFabricatedEvidence = result.impact === 'High';

  return {
    ...result,
    summary: cleanedSummary,
    business_impact: finalBusinessImpact,
    impact: wasHighOnFabricatedEvidence ? 'Medium' : result.impact,
  };
};

// Deterministic safety net — the model consistently under-rates
// trends to Medium even when a named competitor has multiple real signals
// backing the trend (a textbook HIGH case per the prompt's own rules).
// Prompt wording alone did not fix this reliably, so this forces the
// upgrade in code: if any client competitor's name appears in 2+ distinct
// signals within this trend, the impact is forced to High regardless of
// what the model returned — mirroring applyCriticalRequiresCompetitorOverride
// in llmRelevanceProcessor.js, which handles the equivalent downgrade case.
const applyNamedCompetitorMultiSignalOverride = (result, signals, competitors) => {
  if (!Array.isArray(competitors) || competitors.length === 0) return result;
  if (result.impact === 'High') return result; // already High, nothing to do

  for (const comp of competitors) {
    const compLower = comp.toLowerCase();
    const matchingSignalCount = signals.filter(s => {
      const text = `${s.organization || ''} ${s.signal_title || ''} ${s.summary || ''}`.toLowerCase();
      return text.includes(compLower);
    }).length;

    if (matchingSignalCount >= 2) {
      console.log(`  [NamedCompetitorOverride] Forcing impact to High — competitor "${comp}" has ${matchingSignalCount} distinct signals in this trend`);
      return { ...result, impact: 'High' };
    }
  }

  return result;
};

const setupTrendCollection = async () => {
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some(c => c.name === TREND_COLLECTION);
  if (!exists) {
    await qdrant.createCollection(TREND_COLLECTION, {
      vectors: { size: 384, distance: 'Cosine' },
    });
    console.log(`[TrendClustering] Created Qdrant collection '${TREND_COLLECTION}'`);
  }

  const indexFields = ['type', 'module_id', 'client_id', 'industry', 'article_id'];
  for (const field of indexFields) {
    try {
      await qdrant.createPayloadIndex(TREND_COLLECTION, {
        field_name: field,
        field_schema: 'keyword',
      });
    } catch (err) {
      if (!err.message.includes('already exists')) {
        console.log(`[TrendClustering] Index note for '${field}': ${err.message}`);
      }
    }
  }
};

const AUTO_JOIN_THRESHOLD = 0.65; // how close a match needs to be to auto-join a trend
const MERGE_SEARCH_THRESHOLD = 0.60; // used only at promotion time, comparing a candidate's
// pooled centroid against other ACTIVE trends' centroids -- lower than AUTO_JOIN_THRESHOLD
// because comparing two averaged centroids is a much more stable signal than one raw
// article vs a centroid, so it can afford to be a bit more permissive.

/**
 * Checks if a new signal matches an EXISTING trend (one that already
 * has a centroid, meaning it already has 2+ signals grouped into it).
 */
const checkExistingTrends = async (signalEmbedding, moduleId, clientId, industry) => {
  const searchResult = await qdrant.search(TREND_COLLECTION, {
    vector: signalEmbedding,
    filter: {
      must: [
        { key: 'type', match: { value: 'centroid' } },
        { key: 'module_id', match: { value: moduleId } },
        { key: 'client_id', match: { value: clientId } },
        { key: 'industry', match: { value: industry } },
      ],
    },
    limit: 1,
    with_payload: true,
  });

  const bestMatch = searchResult[0];

  if (bestMatch && bestMatch.score >= AUTO_JOIN_THRESHOLD) {
    console.log(`  [TrendMatch] Found existing trend match, score: ${bestMatch.score}`);
    return { trendId: bestMatch.payload.trend_id, score: bestMatch.score };
  }

  if (bestMatch) {
    console.log(`  [TrendMatch] No existing trend match (best score=${bestMatch.score.toFixed(3)}, below ${AUTO_JOIN_THRESHOLD})`);
  } else {
    console.log(`  [TrendMatch] No existing trends to compare against yet`);
  }

  return null; // no strong match found
};

/**
 * Checks if a new signal matches an existing CANDIDATE trend — one that
 * doesn't have a centroid yet because it only has 1 signal so far.
 * Compares directly against that lone signal, not a centroid.
 */
const checkCandidateTrends = async (signalEmbedding, moduleId, clientId, industry) => {
  const searchResult = await qdrant.search(TREND_COLLECTION, {
    vector: signalEmbedding,
    filter: {
      must: [
        { key: 'type', match: { value: 'signal' } },
        { key: 'module_id', match: { value: moduleId } },
        { key: 'client_id', match: { value: clientId } },
        { key: 'industry', match: { value: industry } },
      ],
    },
    limit: 5,
    with_payload: true,
  });

  let bestBelowThreshold = null;

  for (const match of searchResult) {
    if (match.score < AUTO_JOIN_THRESHOLD) {
      if (!bestBelowThreshold || match.score > bestBelowThreshold) {
        bestBelowThreshold = match.score;
      }
      continue;
    }

    const { data: membership } = await supabase
      .from('trend_membership')
      .select('trend_id, trend_clusters!inner(status)')
      .eq('signal_id', match.payload.article_id)
      .single();

    if (membership && membership.trend_clusters.status === 'candidate') {
      console.log(`  [TrendMatch] Found candidate trend match, score: ${match.score}`);
      return { trendId: membership.trend_id };
    }
  }

  if (bestBelowThreshold !== null) {
    console.log(`  [TrendMatch] No candidate match (best score=${bestBelowThreshold.toFixed(3)}, below ${AUTO_JOIN_THRESHOLD})`);
  } else {
    console.log(`  [TrendMatch] No candidate signals to compare against yet`);
  }

  return null; // no candidate match either — this signal will start a brand new one
};

/**
 * The main entry point — called once per stored signal.
 * Decides: auto-join an existing trend, join a pending candidate,
 * or start a brand new candidate trend.
 */
const matchSignalToTrend = async (signalId, signalEmbedding, moduleId, clientId, industry, publishedDate = null) => {
    await setupTrendCollection();

  const existingMatch = await checkExistingTrends(signalEmbedding, moduleId, clientId, industry);

  const storeOwnVector = async () => {
    await qdrant.upsert(TREND_COLLECTION, {
      points: [{
        id: uuidv4(),
        vector: signalEmbedding,
        payload: {
          article_id: signalId,
          client_id: clientId,
          industry,
          module_id: moduleId,
          type: 'signal',
        },
      }],
    });
  };

  if (existingMatch) {
    await supabase.from('trend_membership').insert({
      trend_id: existingMatch.trendId,
      signal_id: signalId,
      module_id: moduleId,
      match_type: 'auto_join',
      joined_at: publishedDate || new Date().toISOString(),
    });
    await storeOwnVector();
    await updateTrendCentroid(existingMatch.trendId);
    console.log(`  [TrendMatch] Signal ${signalId} auto-joined trend ${existingMatch.trendId}`);

    // Always regenerate summary/business_impact/impact/sector so the
    // writeup reflects the full current signal set. Only regenerate the
    // NAME once 5+ new signals have joined since it was last set --
    // names shouldn't flip-flop on every single addition.
    const { data: trendRow } = await supabase
      .from('trend_clusters')
      .select('client_id, name, last_named_signal_count')
      .eq('id', existingMatch.trendId)
      .single();

    const refreshed = await generateTrendNameAndWriteup(existingMatch.trendId, industry, trendRow?.client_id);

    if (refreshed) {
      const currentSignalCount = (await getMemberArticleIds(existingMatch.trendId)).length;
      const signalsSinceLastNaming = currentSignalCount - (trendRow?.last_named_signal_count || 0);
      const shouldRenameToo = signalsSinceLastNaming >= 5;

      const updatePayload = {
        summary: refreshed.summary,
        business_impact: refreshed.business_impact,
        impact: refreshed.impact,
        sector: refreshed.sector,
        last_updated_at: new Date().toISOString(),
      };

      if (shouldRenameToo) {
        updatePayload.name = refreshed.name;
        updatePayload.last_named_signal_count = currentSignalCount;
        console.log(`  [TrendMatch] Renamed trend ${existingMatch.trendId} to "${refreshed.name}" (${signalsSinceLastNaming} new signals since last naming)`);
      } else {
        console.log(`  [TrendMatch] Summary/impact refreshed for trend ${existingMatch.trendId}, name kept ("${trendRow?.name}") — ${signalsSinceLastNaming}/5 signals since last naming`);
      }

      await supabase.from('trend_clusters').update(updatePayload).eq('id', existingMatch.trendId);
    } else {
      console.log(`  [TrendMatch] Writeup refresh failed for trend ${existingMatch.trendId}, keeping previous writeup`);
    }

    return { status: 'auto_joined', trendId: existingMatch.trendId };
  }

  const candidateMatch = await checkCandidateTrends(signalEmbedding, moduleId, clientId, industry);

  if (candidateMatch) {
    await supabase.from('trend_membership').insert({
      trend_id: candidateMatch.trendId,
      signal_id: signalId,
      module_id: moduleId,
      match_type: 'pending',
      joined_at: publishedDate || new Date().toISOString(),
    });
    await storeOwnVector();
    console.log(`  [TrendMatch] Signal ${signalId} joined candidate trend ${candidateMatch.trendId}`);
    return { status: 'joined_candidate', trendId: candidateMatch.trendId };
  }

  const { data: newTrend, error } = await supabase
    .from('trend_clusters')
    .insert({
      module_id: moduleId,
      client_id: clientId,
      industry,
      status: 'candidate',
    })
    .select()
    .single();

  if (error) {
    console.error('  [TrendMatch] Failed to create new candidate trend:', error.message);
    return { status: 'error', error: error.message };
  }

  await supabase.from('trend_membership').insert({
    trend_id: newTrend.id,
    signal_id: signalId,
    module_id: moduleId,
    match_type: 'pending',
    joined_at: publishedDate || new Date().toISOString(),
  });
  await storeOwnVector();

  console.log(`  [TrendMatch] Signal ${signalId} started new candidate trend ${newTrend.id}`);
  return { status: 'new_candidate', trendId: newTrend.id };
};

const MIN_SIGNALS_FOR_PROMOTION = 3;
const MIN_DAYS_FOR_PROMOTION = 7;

/**
 * Checks ONE candidate trend and decides if it's earned promotion to
 * a real, active, named trend — based on signal count + how long it's
 * existed since its first signal.
 */
const checkPromotionEligibility = async (trendId) => {
  const { data: members, error: membersError } = await supabase
    .from('trend_membership')
    .select('signal_id, joined_at')
    .eq('trend_id', trendId)
    .order('joined_at', { ascending: true });

  if (membersError || !members || members.length === 0) {
    return { eligible: false, reason: 'no members found' };
  }

  const signalCount = members.length;
  const firstSignalDate = new Date(members[0].joined_at);
  const daysSinceFirst = (Date.now() - firstSignalDate.getTime()) / (1000 * 60 * 60 * 24);

  const eligible = signalCount >= MIN_SIGNALS_FOR_PROMOTION && daysSinceFirst >= MIN_DAYS_FOR_PROMOTION;

  return {
    eligible,
    signalCount,
    daysSinceFirst: Math.round(daysSinceFirst * 10) / 10,
  };
};

/**
 * Promotes a candidate trend to active: creates its centroid for the
 * first time, generates name + writeup (single combined LLM call), and
 * flips its status. BEFORE creating a brand new active trend, checks
 * whether this candidate's pooled centroid already matches an existing
 * active trend closely enough that it should be MERGED instead of
 * duplicated -- this is what stops near-identical trends like
 * "Sustainable Refill" / "Sustainability Refill" from both existing.
 */
const promoteCandidate = async (trendId, industry) => {
  const { data: trendRow } = await supabase
    .from('trend_clusters')
    .select('module_id, client_id')
    .eq('id', trendId)
    .single();

  const points = await qdrant.scroll(TREND_COLLECTION, {
    filter: {
      must: [
        { key: 'article_id', match: { any: await getMemberArticleIds(trendId) } },
        { key: 'type', match: { value: 'signal' } },
      ],
    },
    with_vector: true,
    with_payload: false,
    limit: 100,
  });

  if (!points.points || points.points.length === 0) {
    console.log(`  [Promotion] No signal vectors found for trend ${trendId}, skipping`);
    return { status: 'skipped', reason: 'no vectors found' };
  }

  const vectors = points.points.map(p => p.vector);
  const dim = vectors[0].length;
  const centroid = new Array(dim).fill(0);

  for (const vec of vectors) {
    for (let i = 0; i < dim; i++) centroid[i] += vec[i];
  }
  for (let i = 0; i < dim; i++) centroid[i] /= vectors.length;

  // NEW: before creating a brand new active trend, check if this
  // candidate's pooled centroid is close to an EXISTING active trend's
  // centroid. Pure article-vs-centroid matching (AUTO_JOIN_THRESHOLD)
  // only ever runs per-signal, using one article's wording at a time --
  // this pooled-centroid-vs-centroid check is a cleaner, more stable
  // comparison, run once at promotion time.
  const mergeSearch = await qdrant.search(TREND_COLLECTION, {
    vector: centroid,
    filter: {
      must: [
        { key: 'type', match: { value: 'centroid' } },
        { key: 'module_id', match: { value: trendRow?.module_id } },
        { key: 'client_id', match: { value: trendRow?.client_id } },
        { key: 'industry', match: { value: industry } },
      ],
    },
    limit: 1,
    with_payload: true,
  });

  const mergeMatch = mergeSearch[0];

  if (mergeMatch && mergeMatch.score >= MERGE_SEARCH_THRESHOLD) {
    const existingTrendId = mergeMatch.payload.trend_id;
    console.log(`  [Promotion] Candidate ${trendId}'s pooled centroid matches existing active trend ${existingTrendId} (score: ${mergeMatch.score.toFixed(3)}) — merging instead of creating a duplicate.`);

    const { data: candidateMembers } = await supabase
      .from('trend_membership')
      .select('id, signal_id')
      .eq('trend_id', trendId);

    const { data: existingMembers } = await supabase
      .from('trend_membership')
      .select('signal_id')
      .eq('trend_id', existingTrendId);
    const existingSignalIds = new Set((existingMembers || []).map(m => m.signal_id));

    for (const member of candidateMembers || []) {
      if (existingSignalIds.has(member.signal_id)) {
        await supabase.from('trend_membership').delete().eq('id', member.id);
      } else {
        await supabase.from('trend_membership').update({ trend_id: existingTrendId }).eq('id', member.id);
      }
    }

    // This candidate never had its own centroid (it wasn't promoted yet),
    // so nothing to clean up in Qdrant for it -- just delete its row.
    await supabase.from('trend_clusters').delete().eq('id', trendId);

    await updateTrendCentroid(existingTrendId);
    const mergedResult = await generateTrendNameAndWriteup(existingTrendId, industry, trendRow?.client_id);
    if (mergedResult) {
      const memberCount = (await getMemberArticleIds(existingTrendId)).length;
      await supabase.from('trend_clusters').update({
        name: mergedResult.name,
        summary: mergedResult.summary,
        business_impact: mergedResult.business_impact,
        impact: mergedResult.impact,
        sector: mergedResult.sector,
        last_named_signal_count: memberCount,
      }).eq('id', existingTrendId);
    }

    console.log(`  [Promotion] Merged into existing trend ${existingTrendId}: "${mergedResult?.name}"`);
    return { status: 'merged', mergedIntoTrendId: existingTrendId, name: mergedResult?.name };
  }

  // No merge match -- proceed with normal promotion as before
  const centroidPointId = uuidv4();
  await qdrant.upsert(TREND_COLLECTION, {
    points: [{
      id: centroidPointId,
      vector: centroid,
      payload: {
        trend_id: trendId,
        type: 'centroid',
        module_id: trendRow?.module_id,
        client_id: trendRow?.client_id,
        industry,
      },
    }],
  });

  const { error } = await supabase
    .from('trend_clusters')
    .update({
      status: 'active',
      centroid_point_id: centroidPointId,
      promoted_at: new Date().toISOString(),
    })
    .eq('id', trendId);

  if (error) {
    console.error(`  [Promotion] Failed to update trend_clusters for ${trendId}:`, error.message);
    return { status: 'error', error: error.message };
  }

  const result = await generateTrendNameAndWriteup(trendId, industry, trendRow?.client_id);
  if (result) {
    const memberCountAtNaming = (await getMemberArticleIds(trendId)).length;
    await supabase.from('trend_clusters').update({
      name: result.name,
      summary: result.summary,
      business_impact: result.business_impact,
      impact: result.impact,
      sector: result.sector,
      last_named_signal_count: memberCountAtNaming,
    }).eq('id', trendId);
  }

  console.log(`  [Promotion] Trend ${trendId} promoted to active with centroid ${centroidPointId}`);
  return { status: 'promoted', centroidPointId, name: result?.name };
};

// Helper — gets the list of article_ids currently in a trend
const getMemberArticleIds = async (trendId) => {
  const { data } = await supabase
    .from('trend_membership')
    .select('signal_id')
    .eq('trend_id', trendId);
  return (data || []).map(m => m.signal_id);
};

// Recomputes the centroid whenever a new signal joins an ACTIVE trend.
const updateTrendCentroid = async (trendId) => {
  // Get the current centroid id + module/client/industry
  const { data: trend, error } = await supabase
    .from('trend_clusters')
    .select('centroid_point_id, module_id, client_id, industry')
    .eq('id', trendId)
    .single();

  if (error || !trend || !trend.centroid_point_id) {
    console.log(`[Centroid] Trend ${trendId} has no centroid yet.`);
    return;
  }

  // Get all article ids in this trend
  const articleIds = await getMemberArticleIds(trendId);

  const points = await qdrant.scroll(TREND_COLLECTION, {
    filter: {
      must: [
        {
          key: 'article_id',
          match: { any: articleIds }
        },
        {
          key: 'type',
          match: { value: 'signal' }
        }
      ]
    },
    with_vector: true,
    with_payload: false,
    limit: 500
  });

  if (!points.points || points.points.length === 0) {
    return;
  }

  const vectors = points.points.map(p => p.vector);

  const dimension = vectors[0].length;
  const centroid = new Array(dimension).fill(0);

  for (const vec of vectors) {
    for (let i = 0; i < dimension; i++) {
      centroid[i] += vec[i];
    }
  }

  for (let i = 0; i < dimension; i++) {
    centroid[i] /= vectors.length;
  }

  await qdrant.upsert(TREND_COLLECTION, {
    points: [{
      id: trend.centroid_point_id,
      vector: centroid,
      payload: {
        trend_id: trendId,
        type: 'centroid',
        module_id: trend.module_id,
        client_id: trend.client_id,
        industry: trend.industry
      }
    }]
  });

  console.log(`[Centroid] Updated centroid for trend ${trendId}`);
};
/**
 * Checks ALL candidate trends for a given module/client/industry,
 * and promotes any that are eligible. Meant to be called periodically
 * (e.g. once a day), not on every single signal insert.
 */
const runPromotionCheck = async (moduleId, clientId, industry) => {
  await setupTrendCollection();

  const { data: candidates, error } = await supabase
    .from('trend_clusters')
    .select('id')
    .eq('module_id', moduleId)
    .eq('client_id', clientId)
    .eq('industry', industry)
    .eq('status', 'candidate');

  if (error) {
    console.error('  [Promotion] Failed to fetch candidates:', error.message);
    return;
  }

  if (!candidates || candidates.length === 0) {
    console.log('  [Promotion] No candidates to check.');
    return;
  }

  console.log(`  [Promotion] Checking ${candidates.length} candidate(s)...`);

  for (const candidate of candidates) {
    const eligibility = await checkPromotionEligibility(candidate.id);

    if (eligibility.eligible) {
      console.log(`  [Promotion] Trend ${candidate.id} is eligible (signals: ${eligibility.signalCount}, days: ${eligibility.daysSinceFirst}) — promoting...`);
      await promoteCandidate(candidate.id, industry);
    } else {
      console.log(`  [Promotion] Trend ${candidate.id} not yet eligible (signals: ${eligibility.signalCount}, days: ${eligibility.daysSinceFirst})`);
    }
  }
};

// Single prompt lookup replaces the old separate naming +
// writeup template fetches — both used the same 'prompts' table pattern.
const getTrendNamingWriteupPromptTemplate = async () => {
  const { data, error } = await supabase
    .from('prompts')
    .select('prompt_template')
    .eq('id', 'trend_naming_writeup_v1')
    .eq('is_active', true)
    .single();

  if (error || !data) {
    throw new Error(`Could not load trend naming+writeup prompt: ${error?.message}`);
  }
  return data.prompt_template;
};

// Repairs common LLM JSON formatting issues before parsing.
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
        if (depth === 0) {
          endIndex = i;
          break;
        }
      }
    }
    if (endIndex !== -1) {
      cleaned = cleaned.slice(firstBrace, endIndex + 1);
    }
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
      const unescaped = cleaned.replace(/\\"/g, '"');
      return JSON.parse(unescaped);
    } catch (unescapeErr) {
      try {
        const repaired = cleaned.replace(
          /"(name|summary|impact)"\s*:\s*"((?:[^"\\]|\\.)*)"/g,
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

// Generates the trend name, summary, business impact bullets, and impact
// rating — ALL in ONE combined LLM call, using every signal in the cluster
// PLUS the client's ICP context. This cuts a full LLM round-trip out of
// every promotion versus the old two-call approach.
const generateTrendNameAndWriteup = async (trendId, industry, clientId) => {
  let rawContent; // declared here (not inside try) so it's visible in the catch block below
  try {
    const articleIds = await getMemberArticleIds(trendId);
    if (articleIds.length === 0) return null;

    const { data: signals, error } = await supabase
      .from('trend_signals')
      .select('signal_title, summary, signal_type, organization')
      .in('id', articleIds);

    if (error || !signals || signals.length === 0) {
      console.log(`  [NamingWriteup] No signals found for trend ${trendId}, skipping`);
      return null;
    }

    // Cap how many signals go into the prompt. Sending all of them (e.g.
    // 24) both times out the local model AND produces a more diluted,
    // generic summary -- more raw text doesn't improve synthesis with a
    // small model, it just drowns the real signal. Take the most RECENT
    // N signals, since those best reflect the trend's current state.
    const MAX_SIGNALS_FOR_WRITEUP = 12;
    const signalsForWriteup = signals.length > MAX_SIGNALS_FOR_WRITEUP
      ? signals.slice(-MAX_SIGNALS_FOR_WRITEUP)
      : signals;

    if (signals.length > MAX_SIGNALS_FOR_WRITEUP) {
      console.log(`  [NamingWriteup] Trend ${trendId} has ${signals.length} signals — using most recent ${MAX_SIGNALS_FOR_WRITEUP} for writeup generation`);
    }

    const signalsText = signalsForWriteup
      .map((s, i) => `${i + 1}. [${s.signal_type}] ${s.organization} — ${s.signal_title}: ${s.summary}`)
      .join('\n');

    const clientContext = await getClientContext(clientId);
    const contextText = clientContext || 'No specific client context available. Use industry-level reasoning only.';

    const promptTemplate = await getTrendNamingWriteupPromptTemplate();
    const finalPrompt = promptTemplate
      .replace('{industry}', industry)
      .replace('{client_context}', contextText)
      .replace('{signals_text}', signalsText);

    rawContent = await callLLM([
      { role: 'system', content: 'You only respond with valid JSON, nothing else.' },
      { role: 'user', content: finalPrompt },
    ], { temperature: 0.4, max_tokens: 600, timeout: 150000 });
    const parsed = repairAndParseJson(rawContent);

    let result = {
      name: parsed.name || 'Unnamed Trend',
      summary: parsed.summary || null,
      business_impact: Array.isArray(parsed.business_impact) ? parsed.business_impact : [],
      impact: parsed.impact || 'Medium',
      sector: parsed.sector || 'Unknown',
    };

    // Catch competitor names the model fabricated (pulled from client
    // context but not actually present in the signals it was given) and
    // strip/downgrade before this ever reaches the database.
    const competitors = await getCompetitorsList(clientId);
    result = applyCompetitorGroundingCheck(result, signalsText, competitors, signals);

    // The model consistently under-rates trends to Medium even when a
    // named competitor genuinely has 2+ real signals backing the trend —
    // a textbook HIGH case per the prompt's own rules. Force the upgrade
    // in code since prompt wording alone didn't fix it reliably.
    result = applyNamedCompetitorMultiSignalOverride(result, signals, competitors);

    console.log(`  [NamingWriteup] Trend ${trendId} named: "${result.name}" — Impact: ${result.impact}, ${result.business_impact?.length || 0} bullet points`);

    return result;

  } catch (err) {
    console.error(`  [NamingWriteup] Failed to generate name/writeup for trend ${trendId}:`, err.message);
    if (typeof rawContent !== 'undefined') {
      console.error(`  [NamingWriteup] Raw LLM response was:`, rawContent);
    }
    return null;
  }
};

// Maps horizon labels to numbers (for averaging) and back.
const HORIZON_TO_NUMBER = { near_term: 1, mid_term: 2, long_term: 3 };
const NUMBER_TO_HORIZON = { 1: 'near_term', 2: 'mid_term', 3: 'long_term' };

// Converts a raw average (e.g. 1.7) to the nearest valid horizon label.
const numberToNearestHorizon = (num) => {
  const rounded = Math.round(num);
  const clamped = Math.min(3, Math.max(1, rounded));
  return NUMBER_TO_HORIZON[clamped];
};

/**
 * Computes a trend's current ring (near/mid/long-term) based on the
 * horizon_estimate of all its signals, weighted so recent signals
 * count more than old ones — so one new signal can't flip the ring
 * by itself.
 */
const calculateTrendRing = async (trendId) => {
  const { data: members, error } = await supabase
    .from('trend_membership')
    .select('signal_id, joined_at')
    .eq('trend_id', trendId)
    .order('joined_at', { ascending: true });

  if (error || !members || members.length === 0) {
    console.log(`  [Scoring] No members found for trend ${trendId}, skipping ring calculation`);
    return null;
  }

  const signalIds = members.map(m => m.signal_id);
  const { data: signals, error: signalsError } = await supabase
    .from('trend_signals')
    .select('id, horizon_estimate')
    .in('id', signalIds);

  if (signalsError || !signals || signals.length === 0) {
    console.log(`  [Scoring] No signal data found for trend ${trendId}, skipping ring calculation`);
    return null;
  }

  // Build a lookup so we can match each signal back to its joined_at date
  const joinedAtMap = {};
  members.forEach(m => { joinedAtMap[m.signal_id] = m.joined_at; });

  const now = Date.now();
  let weightedSum = 0;
  let totalWeight = 0;

  for (const signal of signals) {
    if (!signal.horizon_estimate || !HORIZON_TO_NUMBER[signal.horizon_estimate]) continue;

    const joinedAt = new Date(joinedAtMap[signal.id]).getTime();
    const daysAgo = Math.max(0, (now - joinedAt) / (1000 * 60 * 60 * 24));

    // Recency weight: more recent signals count more. A signal from
    // today gets weight 1.0; a signal from 30 days ago gets weight 0.5;
    // this halves roughly every 30 days.
    const weight = 1 / (1 + daysAgo / 30);

    weightedSum += HORIZON_TO_NUMBER[signal.horizon_estimate] * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return null;

  const weightedAverage = weightedSum / totalWeight;
  const ring = numberToNearestHorizon(weightedAverage);

  console.log(`  [Scoring] Trend ${trendId} ring: ${ring} (weighted avg: ${weightedAverage.toFixed(2)})`);
  return ring;
};

const MAX_DOT_SIZE = 10; // caps evidence volume so a huge burst of signals can't make a dot balloon instantly

/**
 * Computes a trend's current dot size — a simple evidence-volume score
 * based on signal count, capped at MAX_DOT_SIZE. Growth-rate limiting
 * (comparing against the previous dot size) can be added later once
 * weekly scoring is actually running on a schedule.
 */
const calculateTrendDotSize = async (trendId) => {
  const { data: members, error } = await supabase
    .from('trend_membership')
    .select('signal_id')
    .eq('trend_id', trendId);

  if (error || !members) {
    console.log(`  [Scoring] Could not fetch members for trend ${trendId}, skipping dot size`);
    return null;
  }

  const dotSize = Math.min(members.length, MAX_DOT_SIZE);

  console.log(`  [Scoring] Trend ${trendId} dot size: ${dotSize} (from ${members.length} signals)`);
  return dotSize;
};

/**
 * Computes a trend's confidence score — a recency-weighted evidence
 * score, separate from dot_size. Each signal's weight decays with age
 * (same decay curve as calculateTrendRing: full weight today, half
 * weight at 30 days old), so trends with more RECENT signals score
 * higher than trends with the same signal count but older signals.
 * This does NOT affect dot_size or radar node sizing — confidence_score
 * is its own independent field.
 */
const calculateTrendConfidenceScore = async (trendId) => {
  const { data: members, error } = await supabase
    .from('trend_membership')
    .select('signal_id, joined_at')
    .eq('trend_id', trendId);

  if (error || !members || members.length === 0) {
    console.log(`  [Scoring] Could not fetch members for trend ${trendId}, skipping confidence score`);
    return null;
  }

  const now = Date.now();
  let weightedScore = 0;

  for (const member of members) {
    if (!member.joined_at) continue;
    const daysAgo = Math.max(0, (now - new Date(member.joined_at).getTime()) / (1000 * 60 * 60 * 24));
    weightedScore += 1 / (1 + daysAgo / 30);
  }

  const rounded = Math.round(weightedScore * 10) / 10;
  console.log(`  [Scoring] Trend ${trendId} confidence score: ${rounded}`);
  return rounded;
};
// Posture vocabulary is fixed by design (per Forward_Outlook_Trend_Logic doc) —
// never generated freeform, always one of these four.
const POSTURE_BANDS = [
  { min: 0.70, posture: 'Act Now' },
  { min: 0.45, posture: 'Prepare' },
  { min: 0.20, posture: 'Monitor' },
  { min: -Infinity, posture: 'Dismiss' },
];

// Margin required to cross a band boundary before a posture change is even
// considered — prevents flicker from a score sitting right on a threshold.
const POSTURE_CHANGE_MARGIN = 0.05;

// Minimum number of weekly scoring cycles a trend must hold its current
// posture before it's allowed to move again (in either direction).
const MIN_PERIODS_BEFORE_POSTURE_CHANGE = 2;

const RING_URGENCY = { near_term: 1.0, mid_term: 0.5, long_term: 0.0 };
const IMPACT_URGENCY = { High: 1.0, Medium: 0.5, Low: 0.0 };

const scoreToPostureBand = (score) => {
  for (const band of POSTURE_BANDS) {
    if (score >= band.min) return band.posture;
  }
  return 'Dismiss';
};

// Returns the numeric urgency score a candidate posture would need to
// clear the CURRENT posture's band boundary by POSTURE_CHANGE_MARGIN,
// in whichever direction the candidate lies. Used to decide if a raw
// score change is a real, decisive move or just noise near a boundary.
const clearsBoundaryWithMargin = (score, currentPosture) => {
  const currentBandIndex = POSTURE_BANDS.findIndex(b => b.posture === currentPosture);
  if (currentBandIndex === -1) return true; // no prior posture (first time) — no margin check needed

  const currentBand = POSTURE_BANDS[currentBandIndex];
  const bandAbove = POSTURE_BANDS[currentBandIndex - 1]; // stricter/higher urgency band, if any
  const bandBelow = POSTURE_BANDS[currentBandIndex + 1]; // looser/lower urgency band, if any

  // Moving up into a higher-urgency band: score must clear the CURRENT
  // band's own lower boundary by the margin, from above.
  if (bandAbove && score >= currentBand.min + POSTURE_CHANGE_MARGIN) return true;
  // Moving down into a lower-urgency band: score must fall below the
  // current band's lower boundary by the margin.
  if (bandBelow && score < currentBand.min - POSTURE_CHANGE_MARGIN) return true;

  return false; // still within margin of the current band's boundary — treat as no real change
};

/**
 * Computes a trend's posture (Act Now / Prepare / Monitor / Dismiss) from
 * its current ring, impact, and dot size — then applies hysteresis so the
 * posture can only actually change if the new score clears a band boundary
 * by a real margin AND the trend has held its current posture for at least
 * MIN_PERIODS_BEFORE_POSTURE_CHANGE weekly cycles. Otherwise the previous
 * posture is kept and periods_in_posture just increments.
 *
 * Mirrors calculateTrendRing/calculateTrendDotSize in shape, but unlike
 * those, posture needs to read+write trend_clusters' own stored state
 * (posture, posture_score, periods_in_posture) to enforce stability —
 * so this one has to load the trend row itself, not just its signals.
 */
const calculateTrendPosture = async (trendId, ring, dotSize) => {
  const { data: trend, error } = await supabase
    .from('trend_clusters')
    .select('impact, posture, posture_score, periods_in_posture')
    .eq('id', trendId)
    .single();

  if (error || !trend) {
    console.log(`  [Posture] Could not load trend ${trendId} for posture calculation`);
    return null;
  }

  const ringUrgency = RING_URGENCY[ring] ?? 0.5;
  const impactUrgency = IMPACT_URGENCY[trend.impact] ?? 0.5;
  const dotSizeUrgency = Math.min(dotSize, MAX_DOT_SIZE) / MAX_DOT_SIZE;

  const rawScore = (0.4 * ringUrgency) + (0.4 * impactUrgency) + (0.2 * dotSizeUrgency);
  const candidatePosture = scoreToPostureBand(rawScore);

  const currentPosture = trend.posture;
  const periodsInPosture = trend.periods_in_posture || 0;

  // First time this trend gets a posture — just set it, no hysteresis
  // needed since there's nothing to be stable relative to yet.
  if (!currentPosture) {
    console.log(`  [Posture] Trend ${trendId} — first posture assigned: ${candidatePosture} (score: ${rawScore.toFixed(3)})`);
    return { posture: candidatePosture, postureScore: rawScore, periodsInPosture: 1 };
  }

  // No change candidate — just keep incrementing the dwell counter.
  if (candidatePosture === currentPosture) {
    return { posture: currentPosture, postureScore: rawScore, periodsInPosture: periodsInPosture + 1 };
  }

  // Candidate differs from current — only allow the change if BOTH the
  // minimum dwell time has passed AND the score clears the boundary by
  // a real margin, not just barely.
  const dwellSatisfied = periodsInPosture >= MIN_PERIODS_BEFORE_POSTURE_CHANGE;
  const marginSatisfied = clearsBoundaryWithMargin(rawScore, currentPosture);

  if (dwellSatisfied && marginSatisfied) {
    console.log(`  [Posture] Trend ${trendId} — posture changed: ${currentPosture} -> ${candidatePosture} (score: ${rawScore.toFixed(3)}, held previous posture for ${periodsInPosture} period(s))`);
    return { posture: candidatePosture, postureScore: rawScore, periodsInPosture: 1 };
  }

  console.log(`  [Posture] Trend ${trendId} — change blocked (candidate: ${candidatePosture}, current: ${currentPosture}, dwell: ${periodsInPosture}/${MIN_PERIODS_BEFORE_POSTURE_CHANGE}, margin ok: ${marginSatisfied}) — keeping ${currentPosture}`);
  return { posture: currentPosture, postureScore: rawScore, periodsInPosture: periodsInPosture + 1 };
};

const SIMILAR_TRENDS_LIMIT = 3; // how many related trends to surface per card

/**
 * Finds the most similar OTHER active trends to a given trend, by
 * comparing centroid vectors. Used for the "Similar Future Prospects"
 * section shown on a trend's card in the frontend.
 */
const findSimilarTrends = async (trendId, moduleId, clientId, industry) => {
  // Step 1 — get this trend's own centroid point ID
  const { data: trend, error } = await supabase
    .from('trend_clusters')
    .select('centroid_point_id')
    .eq('id', trendId)
    .single();

  if (error || !trend || !trend.centroid_point_id) {
    console.log(`  [SimilarTrends] No centroid found for trend ${trendId}, skipping`);
    return [];
  }

  // Step 2 — fetch that centroid's actual vector from Qdrant
  const points = await qdrant.retrieve(TREND_COLLECTION, {
    ids: [trend.centroid_point_id],
    with_vector: true,
  });

  if (!points || points.length === 0) {
    console.log(`  [SimilarTrends] Centroid vector not found in Qdrant for trend ${trendId}`);
    return [];
  }

  const ownVector = points[0].vector;

  // Step 3 — search for other centroids close to this one, excluding itself
  const searchResult = await qdrant.search(TREND_COLLECTION, {
    vector: ownVector,
    filter: {
      must: [
        { key: 'type', match: { value: 'centroid' } },
        { key: 'module_id', match: { value: moduleId } },
        { key: 'client_id', match: { value: clientId } },
        { key: 'industry', match: { value: industry } },
      ],
    },
    limit: SIMILAR_TRENDS_LIMIT + 1, // +1 since it'll match itself first
    with_payload: true,
  });

  const otherTrendIds = searchResult
    .filter(r => r.payload.trend_id !== trendId)
    .slice(0, SIMILAR_TRENDS_LIMIT)
    .map(r => ({ trend_id: r.payload.trend_id, score: r.score }));

  if (otherTrendIds.length === 0) {
    console.log(`  [SimilarTrends] No similar trends found for ${trendId}`);
    return [];
  }

  // Step 4 — get the actual names for those trend IDs
  const { data: relatedTrends } = await supabase
    .from('trend_clusters')
    .select('id, name')
    .in('id', otherTrendIds.map(t => t.trend_id));

  const nameById = {};
  (relatedTrends || []).forEach(t => { nameById[t.id] = t.name; });

  const results = otherTrendIds.map(t => ({
    trend_id: t.trend_id,
    name: nameById[t.trend_id] || 'Unnamed Trend',
    score: t.score,
  }));

  console.log(`  [SimilarTrends] Trend ${trendId} — found ${results.length} similar trend(s)`);
  return results;
};

/**
 * Runs weekly scoring for every ACTIVE trend in a given module/client/
 * industry: recomputes ring + dot size, updates trend_clusters, and
 * writes a frozen row into trend_snapshots — the only thing the
 * frontend should ever read from.
 */
const runWeeklyScoring = async (moduleId, clientId, industry) => {
  const { data: trends, error } = await supabase
    .from('trend_clusters')
    .select('*')
    .eq('module_id', moduleId)
    .eq('client_id', clientId)
    .eq('industry', industry)
    .eq('status', 'active');

  if (error) {
    console.error('  [WeeklyScoring] Failed to fetch active trends:', error.message);
    return;
  }

  if (!trends || trends.length === 0) {
    console.log('  [WeeklyScoring] No active trends to score.');
    return;
  }

  console.log(`  [WeeklyScoring] Scoring ${trends.length} active trend(s)...`);

  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

  for (const trend of trends) {
    const ring = await calculateTrendRing(trend.id);
    const dotSize = await calculateTrendDotSize(trend.id);
    const similarTrends = await findSimilarTrends(trend.id, moduleId, clientId, industry);
    const confidenceScore = await calculateTrendConfidenceScore(trend.id);

    if (!ring || dotSize === null) {
      console.log(`  [WeeklyScoring] Skipping trend ${trend.id} — missing ring or dot size`);
      continue;
    }

    const postureResult = await calculateTrendPosture(trend.id, ring, dotSize);
    const posture = postureResult?.posture || 'Monitor';

    // Update the live trend record with fresh values
    await supabase
      .from('trend_clusters')
      .update({
        ring,
        dot_size: dotSize,
        confidence_score: confidenceScore,
        posture,
        posture_score: postureResult?.postureScore ?? null,
        periods_in_posture: postureResult?.periodsInPosture ?? 1,
        similar_trends: similarTrends,
      })
      .eq('id', trend.id);

    // Freeze this week's state into trend_snapshots — write_up (jsonb)
    // holds summary/business_impact/impact together; posture now comes
    // from calculateTrendPosture instead of the old 'N/A' placeholder.
    const { error: snapshotError } = await supabase.from('trend_snapshots').insert({
      trend_id: trend.id,
      module_id: moduleId,
      client_id: clientId,
      period_start: periodStart.toISOString().slice(0, 10),
      period_end: periodEnd.toISOString().slice(0, 10),
      name: trend.name || 'Unnamed Trend',
      sector: trend.sector || 'Unknown',
      ring,
      dot_size: dotSize,
      confidence_score: confidenceScore,
      posture,
      similar_trends: similarTrends,
      write_up: {
        summary: trend.summary,
        business_impact: trend.business_impact,
        impact: trend.impact,
      },
    });

    if (snapshotError) {
      console.error(`  [WeeklyScoring] Failed to write snapshot for trend ${trend.id}:`, snapshotError.message);
    } else {
      console.log(`  [WeeklyScoring] Snapshot frozen for trend ${trend.id} — ring: ${ring}, dot_size: ${dotSize}`);
    }
  }
};


  module.exports = { matchSignalToTrend, runPromotionCheck, setupTrendCollection, generateTrendNameAndWriteup, calculateTrendRing, calculateTrendDotSize, calculateTrendPosture, runWeeklyScoring, findSimilarTrends, updateTrendCentroid, calculateTrendConfidenceScore };