/**
 * modules/decisionIntelligence/secUrlResolver.js
 *
 * Given Qdrant point IDs from the sec10k_chunks collection, look up each
 * point's chunks_meta row and join to filings for the original EDGAR URL.
 * The Qdrant payload itself does NOT carry filing_id or source_url, so
 * this join is required to make SEC chunks clickable as sources.
 */

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * @param {string[]} pointIds - qdrant_point_id values (as strings)
 * @returns {Promise<Map<string, { url: string|null, ticker: string, fiscal_year: number, item_code: string, item_title: string|null }>>}
 */
async function resolveSecUrls(pointIds) {
  if (!pointIds || !pointIds.length) return new Map();

  const { data, error } = await supabase
    .from('chunks_meta')
    .select('qdrant_point_id, ticker, fiscal_year, item_code, filing_id, filings(source_url)')
    .in('qdrant_point_id', pointIds);

  if (error) {
    console.log(`[secUrlResolver] Join failed: ${error.message}`);
    return new Map();
  }

  const byPointId = new Map();
  for (const row of data || []) {
    byPointId.set(row.qdrant_point_id, {
      url: row.filings?.source_url || null,
      ticker: row.ticker,
      fiscal_year: row.fiscal_year,
      item_code: row.item_code,
    });
  }
  return byPointId;
}

module.exports = { resolveSecUrls };