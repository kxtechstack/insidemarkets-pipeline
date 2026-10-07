/**
 * modules/decisionIntelligenceV2/sec/secUrlResolver.js
 *
 * COPIED VERBATIM from modules/decisionIntelligence/secUrlResolver.js.
 * No logic changed.
 */

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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