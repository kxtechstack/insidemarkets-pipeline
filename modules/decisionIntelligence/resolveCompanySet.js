// modules/decisionIntelligence/resolveCompanySet.js
const { callLLM } = require('../llmClient');

/**
 * Given a natural-language question that references a set of companies
 * ("top 5 US tech companies", "largest European banks", "big pharma firms"),
 * return a structured filter { sector, orderBy, limit } that we can use to
 * query the companies/financial_facts tables.
 *
 * Returns null if the question doesn't reference a company set (e.g. it's
 * a specific named company, or a general trend question).
 */
async function resolveCompanySet(question) {
  const prompt = `Analyze this question and determine if it references a SET of companies by category or sector (as opposed to a specific named company).

Question: "${question}"

If it does, respond with JSON:
{
  "isCompanySet": true,
  "sector": "Information Technology" | "Financials" | "Health Care" | "Energy" | "Industrials" | "Consumer Discretionary" | "Consumer Staples" | "Utilities" | "Real Estate" | "Materials" | "Communication Services" | null,
  "metric": "Revenue" | "NetIncome" | "TotalAssets" | "TotalLiabilities" | "CashFlow" | null,
  "orderBy": "desc" | "asc",
  "limit": 5
}

If the question is about a specific named company (Apple, Microsoft), or does not reference a sector/company set, respond:
{ "isCompanySet": false }

Sectors available: Information Technology, Financials, Health Care, Energy, Industrials, Consumer Discretionary, Consumer Staples, Utilities, Real Estate, Materials, Communication Services.

If the user mentions "tech" or "technology", use "Information Technology".
If unclear, set sector to null (means "all sectors").

Respond with ONLY the JSON, no other text.`;

  try {
    const raw = await callLLM(
      [{ role: 'user', content: prompt }],
      { temperature: 0, max_tokens: 200, timeout: 30000 }
    );
    const cleaned = (raw || '').trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/, '')
      .replace(/```\s*$/, '')
      .trim();
    const parsed = JSON.parse(cleaned);
    if (!parsed.isCompanySet) return null;

    // Validate the sector against our DB's actual sector names.
    // If the LLM returned something that isn't one of ours (e.g. "Tech"
    // instead of "Information Technology"), null it out -- the query
    // will fall back to all sectors.
    const VALID_SECTORS = new Set([
      'Information Technology', 'Financials', 'Health Care', 'Energy',
      'Industrials', 'Consumer Discretionary', 'Consumer Staples',
      'Utilities', 'Real Estate', 'Materials', 'Communication Services',
    ]);
    const VALID_METRICS = new Set([
      'Revenue', 'NetIncome', 'TotalAssets', 'TotalLiabilities', 'CashFlow', 'CapEx',
    ]);

    const sector = VALID_SECTORS.has(parsed.sector) ? parsed.sector : null;
    const metric = VALID_METRICS.has(parsed.metric) ? parsed.metric : 'Revenue';
    const orderBy = parsed.orderBy === 'asc' ? 'asc' : 'desc';
    const limit = Math.min(Math.max(Number(parsed.limit) || 5, 1), 20);

    console.log(`[resolveCompanySet] parsed: sector=${sector || 'any'} metric=${metric} orderBy=${orderBy} limit=${limit}`);

    return { sector, metric, orderBy, limit };
  } catch (err) {
    console.log(`[resolveCompanySet] failed: ${err.message}`);
    return null;
  }
}

module.exports = { resolveCompanySet };