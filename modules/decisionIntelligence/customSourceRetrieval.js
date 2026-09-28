/**
 * modules/decisionIntelligence/customSourceRetrieval.js
 *
 * Retrieves relevant chunks from the client's UPLOADED custom data sources
 * (PDFs / websites / plain text), stored in Qdrant collection
 * `custom_source_content` by modules/customSourceProcessor.js.
 *
 * Enriches each hit with the source's clickable URL from
 * admin.custom_data_sources -- either the original url_or_path (for pasted
 * links) or a signed Supabase Storage URL (for uploaded files).
 */

const { QdrantClient } = require('@qdrant/js-client-rest');
const { createClient } = require('@supabase/supabase-js');
const { embedText } = require('./retrieveClientData');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  checkCompatibility: false,
});

const CUSTOM_SOURCE_COLLECTION =
  process.env.CUSTOM_SOURCE_QDRANT_COLLECTION || 'custom_source_content';
const STORAGE_BUCKET = 'custom-source-files';

const DEFAULT_MIN_SCORE = Number(process.env.CUSTOM_SOURCE_SCORE_FLOOR) || 0.28;
const DEFAULT_LIMIT = Number(process.env.CUSTOM_SOURCE_TOP_K) || 5;

async function retrieveCustomSourceData(
  question,
  clientId,
  limit = DEFAULT_LIMIT,
  minScore = DEFAULT_MIN_SCORE
) {
  if (!question || !clientId) return [];

  try {
    const vector = await embedText(question);

    const hits = await qdrant.search(CUSTOM_SOURCE_COLLECTION, {
      vector,
      limit: Math.max(limit * 3, 20),
      filter: {
        must: [{ key: 'client_id', match: { value: clientId } }],
      },
      with_payload: true,
    });

    const passing = hits.filter((h) => h.score >= minScore);

    // Dedupe by exact (content_id, chunk_index) only.
    const seenKeys = new Set();
    const deduped = [];
    for (const h of passing) {
      const cid = h.payload?.content_id;
      const ci = h.payload?.chunk_index;
      if (cid === undefined || ci === undefined) continue;
      const thisKey = `${cid}:${ci}`;
      if (seenKeys.has(thisKey)) continue;
      seenKeys.add(thisKey);
      deduped.push(h);
      if (deduped.length >= limit) break;
    }

    // ── Enrich with clickable URL from admin.custom_data_sources ────
    const sourceIds = [...new Set(deduped.map(h => h.payload?.source_id).filter(Boolean))];
    const metaById = {};

    if (sourceIds.length) {
      const { data: rows, error } = await supabase
        .schema('admin')
        .from('custom_data_sources')
        .select('id, url_or_path, storage_path, source_name, source_type')
        .in('id', sourceIds);

      if (error) {
        console.log(`[customSourceRetrieval] source lookup failed: ${error.message}`);
      } else {
        for (const row of rows || []) {
          let url = row.url_or_path || null;

          // Uploaded file (no url_or_path) -> generate a signed URL
          if (!url && row.storage_path) {
            try {
              const { data: signed, error: signedErr } = await supabase.storage
                .from(STORAGE_BUCKET)
                .createSignedUrl(row.storage_path, 60 * 60 * 24); // 24h
              if (signedErr) {
                console.log(`[customSourceRetrieval] signed URL failed for ${row.id}: ${signedErr.message}`);
              } else {
                url = signed?.signedUrl || null;
              }
            } catch (err) {
              console.log(`[customSourceRetrieval] signed URL threw for ${row.id}: ${err.message}`);
            }
          }

          metaById[row.id] = {
            url,
            source_name: row.source_name,
            source_type: row.source_type,
          };
        }
      }
    }

    // Attach metadata to each hit's payload.
    deduped.forEach(h => {
      const meta = metaById[h.payload?.source_id];
      if (!meta) return;
      h.payload.source_url = meta.url;
      h.payload.source_name = meta.source_name || h.payload.source_name;
      h.payload.source_type = meta.source_type || h.payload.source_type;
    });

    console.log(
      `[customSourceRetrieval] query="${String(question).slice(0, 60)}" | ` +
      `${hits.length} raw hits, ${passing.length} above ${minScore}, ` +
      `${deduped.length} after dedupe`
    );
    deduped.forEach((d, i) => {
      console.log(
        `  [${i + 1}] score=${d.score.toFixed(3)} | source="${d.payload.source_name}" ` +
        `| chunk ${d.payload.chunk_index} | url=${d.payload.source_url ? 'yes' : 'NO'}`
      );
    });

    return deduped;
  } catch (err) {
    console.log(`[customSourceRetrieval] Search failed: ${err.message}`);
    return [];
  }
}

module.exports = { retrieveCustomSourceData, CUSTOM_SOURCE_COLLECTION };