/**
 * modules/decisionIntelligenceV2/sec/subsectorResolver.js
 *
 * Extracted from the old modules/decisionIntelligence/route.js.
 * Contains ONLY the SEC-related helpers, moved as-is:
 *   - SUBSECTOR_ALLOWLISTS
 *   - SECTOR_ALIASES + expandSectorAliases
 *   - findAllowlistTickers
 *   - selectCompaniesForSubsector
 *   - resolveCompanySetFacts
 *
 * No logic changed. Just relocated so V2 owns its own SEC code and the
 * old route.js stays as reference.
 */

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── Subsector allow-lists ────────────────────────────────────────────────
const SUBSECTOR_ALLOWLISTS = {
  // ── Pharma / Biotech ────────────────────────────────────────────────
  pharma: ['JNJ','LLY','PFE','MRK','ABBV','BMY','AMGN','GILD','VRTX','REGN','BIIB','MRNA'],
  pharmaceutical: ['JNJ','LLY','PFE','MRK','ABBV','BMY','AMGN','GILD','VRTX','REGN','BIIB','MRNA'],
  biotech: ['AMGN','GILD','VRTX','REGN','BIIB','MRNA','INCY','BMRN','ALNY','SGEN'],
  biotechnology: ['AMGN','GILD','VRTX','REGN','BIIB','MRNA','INCY','BMRN','ALNY','SGEN'],

  // ── Retail ──────────────────────────────────────────────────────────
  retail: ['WMT','AMZN','COST','HD','LOW','TGT','KR','BBY','ROST','TJX','DG','DLTR','ORLY','AZO','TSCO','ULTA','LULU','NKE'],
  retailer: ['WMT','AMZN','COST','HD','LOW','TGT','KR','BBY','ROST','TJX','DG','DLTR','ORLY','AZO','TSCO','ULTA','LULU','NKE'],
  retailers: ['WMT','AMZN','COST','HD','LOW','TGT','KR','BBY','ROST','TJX','DG','DLTR','ORLY','AZO','TSCO','ULTA','LULU','NKE'],

  // ── Banks / Financials ──────────────────────────────────────────────
  bank: ['JPM','BAC','WFC','C','USB','PNC','TFC','GS','MS','SCHW','COF','BK','STT','FITB','HBAN','RF','CFG','MTB','KEY'],
  banks: ['JPM','BAC','WFC','C','USB','PNC','TFC','GS','MS','SCHW','COF','BK','STT','FITB','HBAN','RF','CFG','MTB','KEY'],
  banking: ['JPM','BAC','WFC','C','USB','PNC','TFC','GS','MS','SCHW','COF','BK','STT','FITB','HBAN','RF','CFG','MTB','KEY'],
  insurance: ['BRK.B','PGR','AIG','MET','PRU','AFL','ALL','TRV','CB','HIG','AON','MMC','AJG','WTW','GL','AIZ','CINF','WRB'],
  insurers: ['BRK.B','PGR','AIG','MET','PRU','AFL','ALL','TRV','CB','HIG','AON','MMC','AJG','WTW','GL','AIZ','CINF','WRB'],

  // ── Energy / Oil & Gas ──────────────────────────────────────────────
  oil: ['XOM','CVX','COP','EOG','OXY','PSX','VLO','MPC','SLB','HAL','BKR','DVN','FANG','HES','APA','MRO','PXD','KMI','WMB','OKE','TRGP'],
  'oil and gas': ['XOM','CVX','COP','EOG','OXY','PSX','VLO','MPC','SLB','HAL','BKR','DVN','FANG','HES','APA','MRO','PXD','KMI','WMB','OKE','TRGP'],
  energy: ['XOM','CVX','COP','EOG','OXY','PSX','VLO','MPC','SLB','HAL','BKR','NEE','DUK','SO','D','AEP','EXC','SRE','PEG','XEL'],
  'oilfield services': ['SLB','HAL','BKR','NOV','FTI','WHD','OIS','RES'],

  // ── Tech / Semiconductors ───────────────────────────────────────────
  tech: ['AAPL','MSFT','NVDA','GOOGL','AMZN','META','AVGO','ORCL','CRM','ADBE','AMD','INTC','CSCO','QCOM','TXN','INTU','NOW','AMAT','MU','ADI','LRCX','KLAC','PANW','SNPS','CDNS'],
  technology: ['AAPL','MSFT','NVDA','GOOGL','AMZN','META','AVGO','ORCL','CRM','ADBE','AMD','INTC','CSCO','QCOM','TXN','INTU','NOW','AMAT','MU','ADI','LRCX','KLAC','PANW','SNPS','CDNS'],
  semiconductor: ['NVDA','AVGO','AMD','INTC','QCOM','TXN','MU','AMAT','LRCX','KLAC','ADI','MCHP','NXPI','ON','SWKS','MRVL','TER','MPWR'],
  semiconductors: ['NVDA','AVGO','AMD','INTC','QCOM','TXN','MU','AMAT','LRCX','KLAC','ADI','MCHP','NXPI','ON','SWKS','MRVL','TER','MPWR'],
  software: ['MSFT','ORCL','CRM','ADBE','INTU','NOW','SNPS','CDNS','PANW','WDAY','TEAM','MDB','DDOG','SNOW','CRWD','FTNT','ADSK','ANSS','PTC','TYL'],
  cloud: ['AMZN','MSFT','GOOGL','ORCL','CRM','NOW','SNOW','DDOG','MDB','TEAM'],

  // ── Airlines / Industrials ──────────────────────────────────────────
  airline: ['DAL','UAL','AAL','LUV','ALK','JBLU','SAVE','HA'],
  airlines: ['DAL','UAL','AAL','LUV','ALK','JBLU','SAVE','HA'],

  // ── Autos ───────────────────────────────────────────────────────────
  auto: ['TSLA','F','GM','RIVN','LCID','TM','HMC','STLA'],
  autos: ['TSLA','F','GM','RIVN','LCID','TM','HMC','STLA'],
  automaker: ['TSLA','F','GM','RIVN','LCID','TM','HMC','STLA'],
  automakers: ['TSLA','F','GM','RIVN','LCID','TM','HMC','STLA'],
  'electric vehicle': ['TSLA','RIVN','LCID','NIO','XPEV','LI','FSR'],
  'electric vehicles': ['TSLA','RIVN','LCID','NIO','XPEV','LI','FSR'],
  ev: ['TSLA','RIVN','LCID','NIO','XPEV','LI','FSR'],

  // ── Cosmetics / Beauty ──────────────────────────────────────────────
  cosmetic: ['EL','ULTA','COTY','ELF','BBWI','IPAR'],
  cosmetics: ['EL','ULTA','COTY','ELF','BBWI','IPAR'],
  beauty: ['EL','ULTA','COTY','ELF','BBWI','IPAR'],

  // ── Utilities / Telecom / Media ─────────────────────────────────────
  utility: ['NEE','DUK','SO','D','AEP','EXC','SRE','PEG','XEL','ED','WEC','ES','DTE','PPL','FE','ETR','AEE','CMS','CNP','NI','ATO','LNT','EVRG','PNW','NRG','VST','AES','CEG'],
  utilities: ['NEE','DUK','SO','D','AEP','EXC','SRE','PEG','XEL','ED','WEC','ES','DTE','PPL','FE','ETR','AEE','CMS','CNP','NI','ATO','LNT','EVRG','PNW','NRG','VST','AES','CEG'],
  telecom: ['T','VZ','TMUS','LUMN','USM','SHEN'],
  telecommunications: ['T','VZ','TMUS','LUMN','USM','SHEN'],
  media: ['DIS','CMCSA','NFLX','WBD','PARA','FOXA','NWSA','LYV','OMC','TTWO','EA','PSKY'],
  streaming: ['NFLX','DIS','WBD','PARA','CMCSA','FOXA'],

  // ── Food / Beverage / Consumer ──────────────────────────────────────
  food: ['PEP','KO','MDLZ','GIS','KHC','HSY','SYY','KR','ADM','TSN','CAG','CPB','MKC','HRL','SJM'],
  beverage: ['KO','PEP','MNST','STZ','KDP','TAP','BF.B','SAM'],
  beverages: ['KO','PEP','MNST','STZ','KDP','TAP','BF.B','SAM'],

  // ── Misc high-frequency ─────────────────────────────────────────────
  aerospace: ['BA','RTX','LMT','NOC','GD','LHX','HII','TDG','HEI','TXT','AXON','HWM','GE'],
  defense: ['LMT','RTX','NOC','GD','BA','LHX','HII','TDG','LDOS','SAIC','KTOS'],
  healthcare: ['UNH','CVS','CI','ELV','HUM','CNC','HCA','UHS','MCK','COR','CAH','JNJ','PFE','ABT','TMO','DHR'],
  'health care': ['UNH','CVS','CI','ELV','HUM','CNC','HCA','UHS','MCK','COR','CAH','JNJ','PFE','ABT','TMO','DHR'],
  reit: ['PLD','AMT','EQIX','CCI','SPG','PSA','O','WELL','DLR','VICI','SBAC','IRM','EXR','AVB','EQR','ESS','MAA','UDR','INVH','CPT'],
  reits: ['PLD','AMT','EQIX','CCI','SPG','PSA','O','WELL','DLR','VICI','SBAC','IRM','EXR','AVB','EQR','ESS','MAA','UDR','INVH','CPT'],
  restaurant: ['MCD','SBUX','CMG','YUM','DRI','DPZ','QSR','WEN'],
  restaurants: ['MCD','SBUX','CMG','YUM','DRI','DPZ','QSR','WEN'],
  travel: ['BKNG','ABNB','EXPE','MAR','HLT','RCL','CCL','NCLH','LVS','MGM','WYNN'],
  hotel: ['MAR','HLT','H','IHG','LVS','MGM','WYNN'],
  hotels: ['MAR','HLT','H','IHG','LVS','MGM','WYNN'],
  steel: ['NUE','STLD','CLF','X','RS','CMC'],
  mining: ['FCX','NEM','AA','X','CLF','NUE','STLD'],
  chemicals: ['LIN','APD','SHW','ECL','DD','DOW','PPG','LYB','IFF','ALB','CF','MOS'],
  packaging: ['IP','PKG','AMCR','BALL','AVY','SEE','CCK'],
  railway: ['UNP','CSX','NSC','CP','CNI'],
  railroads: ['UNP','CSX','NSC','CP','CNI'],
  shipping: ['UPS','FDX','CHRW','EXPD','XPO','ODFL','JBHT'],
  logistics: ['UPS','FDX','CHRW','EXPD','XPO','ODFL','JBHT'],
  'home improvement': ['HD','LOW','TSCO','FND','BLDR'],
  ecommerce: ['AMZN','EBAY','ETSY','W','CHWY','SHOP','PDD','BABA'],
  'e-commerce': ['AMZN','EBAY','ETSY','W','CHWY','SHOP','PDD','BABA'],
  ev_charging: ['TSLA','CHPT','EVGO','BLNK'],
};

function findAllowlistTickers(subsectorTerm) {
  if (!subsectorTerm) return null;
  const key = String(subsectorTerm).toLowerCase().trim();
  if (SUBSECTOR_ALLOWLISTS[key]) return SUBSECTOR_ALLOWLISTS[key];
  if (key.endsWith('s') && SUBSECTOR_ALLOWLISTS[key.slice(0, -1)]) {
    return SUBSECTOR_ALLOWLISTS[key.slice(0, -1)];
  }
  return null;
}

// ── Sector alias map ────────────────────────────────────────────────────────
const SECTOR_ALIASES = {
  'Information Technology': ['Information Technology', 'Technology'],
};

function expandSectorAliases(sector) {
  if (!sector) return null;
  return SECTOR_ALIASES[sector] || [sector];
}

// ── Subsector company picker ────────────────────────────────────────────────
async function selectCompaniesForSubsector(subsectorTerm, sectorHint = null, metric = null) {
  const candidates0 = [];

  let candidates = null;
  let source = null;
  let reasoning = '';

  const allowlist = findAllowlistTickers(subsectorTerm);
  if (allowlist && allowlist.length > 0) {
    candidates = allowlist;
    source = 'allowlist';
    reasoning = 'curated allowlist';
  } else {
    const { callLLM } = require('../../llmClient');

    let query = supabase.from('companies').select('ticker, company_name, sector').order('ticker');
    if (sectorHint) {
      const dbSectors = expandSectorAliases(sectorHint);
      query = query.in('sector', dbSectors);
    }
    const { data: companies, error } = await query;

    if (error || !companies || companies.length === 0) {
      console.log(`[selectCompaniesForSubsector] companies query failed: ${error?.message}`);
      return null;
    }

    const companyList = companies
      .map(c => `${c.ticker} | ${c.company_name} | ${c.sector}`)
      .join('\n');

    const prompt = `You are given a list of US-listed companies and a subsector term. Identify which companies in the list are PRIMARILY in that subsector.

Subsector term: "${subsectorTerm}"

Company list (format: TICKER | Name | Sector):
${companyList}

STRICT RULES:
1. A company qualifies ONLY if the subsector is its PRIMARY business.
2. Do NOT include a company just because it owns a small subsidiary or brand
   in that subsector.
3. Do NOT include a company just because the word appears in its name.
4. Do NOT include companies from an unrelated sector.
5. Return AT MOST 20 tickers. Prefer the largest / most well-known ones.
6. Return tickers SEPARATED, no duplicates.

Respond with ONLY this JSON, no other text:
{
  "tickers": ["TICKER1", "TICKER2", ...],
  "reasoning": "one short sentence"
}

If no companies qualify, return: { "tickers": [], "reasoning": "no matches" }`;

    try {
      const raw = await callLLM(
        [{ role: 'user', content: prompt }],
        { temperature: 0, max_tokens: 500, timeout: 45000 }
      );

      const cleaned = (raw || '').trim()
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/, '')
        .replace(/```\s*$/, '')
        .trim();

      let picked = [];
      try {
        const parsed = JSON.parse(cleaned);
        picked = Array.isArray(parsed.tickers) ? parsed.tickers : [];
        reasoning = parsed.reasoning || '';
      } catch (parseErr) {
        console.log(`  [selectCompaniesForSubsector] JSON parse failed (${parseErr.message}) — salvaging`);
        const block = cleaned.match(/"tickers"\s*:\s*\[([^\]]*)/);
        if (block) {
          picked = block[1]
            .split(',')
            .map(s => s.replace(/["'\s]/g, '').toUpperCase())
            .filter(t => /^[A-Z][A-Z.]{0,5}$/.test(t));
        }
        const rMatch = cleaned.match(/"reasoning"\s*:\s*"([^"]*)/);
        if (rMatch) reasoning = rMatch[1];
      }

      const seen = new Set();
      candidates = picked
        .map(t => String(t).toUpperCase().trim())
        .filter(t => /^[A-Z][A-Z.]{0,5}$/.test(t))
        .filter(t => {
          if (seen.has(t)) return false;
          seen.add(t);
          return true;
        })
        .slice(0, 20);
      source = 'llm';
    } catch (err) {
      console.log(`[selectCompaniesForSubsector] failed for "${subsectorTerm}": ${err.message}`);
      return null;
    }
  }

  const totalConsidered = candidates.length;

  if (totalConsidered === 0) {
    console.log(`[selectCompaniesForSubsector] "${subsectorTerm}" -> 0 candidates from ${source}`);
    return { tickers: [], reasoning, source, dropped: [], totalConsidered: 0 };
  }

  const { data: existingCompanies, error: compErr } = await supabase
    .from('companies')
    .select('ticker')
    .in('ticker', candidates);

  if (compErr) {
    console.log(`[selectCompaniesForSubsector] companies coverage check failed: ${compErr.message}`);
    return { tickers: candidates, reasoning, source, dropped: [], totalConsidered };
  }

  const inCompanies = new Set((existingCompanies || []).map(r => r.ticker));
  let surviving = candidates.filter(t => inCompanies.has(t));
  const droppedNotInDb = candidates.filter(t => !inCompanies.has(t));

  let droppedNoFacts = [];
  if (metric && surviving.length > 0) {
    const { data: factRows, error: factErr } = await supabase
      .from('financial_facts')
      .select('ticker')
      .in('ticker', surviving)
      .eq('metric_name', metric);

    if (factErr) {
      console.log(`[selectCompaniesForSubsector] financial_facts coverage check failed: ${factErr.message}`);
    } else {
      const hasFacts = new Set((factRows || []).map(r => r.ticker));
      droppedNoFacts = surviving.filter(t => !hasFacts.has(t));
      surviving = surviving.filter(t => hasFacts.has(t));
    }
  }

  const dropped = [...droppedNotInDb, ...droppedNoFacts];

  console.log(
    `[selectCompaniesForSubsector] "${subsectorTerm}" -> ${surviving.length} of ${totalConsidered} ` +
    `usable ticker(s) [${surviving.join(', ')}] via ${source}` +
    (dropped.length > 0 ? ` | dropped (not in DB or no ${metric || 'facts'} data): ${dropped.join(', ')}` : '')
  );

  return { tickers: surviving, reasoning, source, dropped, totalConsidered };
}

// ── Company-set facts resolver ──────────────────────────────────────────────
async function resolveCompanySetFacts(filter) {
  let coverageInfo = null;

  if (filter.sector === null && filter.unresolvedTerm) {
    console.log(`[resolveCompanySetFacts] refusing unresolvedTerm="${filter.unresolvedTerm}" with sector=null`);
    return { chunks: [], facts: [], sources: [], _unresolved: filter.unresolvedTerm };
  }

  let candidateTickers = null;

  if (filter.subsectorTerm) {
    const picked = await selectCompaniesForSubsector(filter.subsectorTerm, filter.sector, filter.metric);
    if (!picked || picked.tickers.length === 0) {
      console.log(
        `[resolveCompanySetFacts] no companies matched subsector "${filter.subsectorTerm}" — returning empty`
      );
      return { chunks: [], facts: [], sources: [], _unresolved: filter.subsectorTerm };
    }
    candidateTickers = picked.tickers;
    coverageInfo = {
      returned: null,
      considered: picked.totalConsidered,
      dropped: picked.dropped,
      subsector: filter.subsectorTerm,
    };
    console.log(
      `[resolveCompanySetFacts] subsector "${filter.subsectorTerm}" -> ${candidateTickers.length} ticker(s): ${candidateTickers.join(', ')}`
    );
  }

  let companyQuery = supabase.from('companies').select('ticker, company_name, cik');

  if (candidateTickers) {
    companyQuery = companyQuery.in('ticker', candidateTickers);
  } else if (filter.sector) {
    const dbSectors = expandSectorAliases(filter.sector);
    companyQuery = companyQuery.in('sector', dbSectors);
    console.log(
      `[resolveCompanySetFacts] sector "${filter.sector}" expanded to DB tags: [${dbSectors.join(', ')}]`
    );
  }
  companyQuery = companyQuery.limit(200);

  const { data: candidates, error: candErr } = await companyQuery;
  if (candErr || !candidates || candidates.length === 0) {
    console.log(`[resolveCompanySetFacts] no candidates: ${candErr?.message || 'empty'}`);
    return { chunks: [], facts: [], sources: [] };
  }

  const tickers = candidates.map(c => c.ticker);
  const nameByTicker = {};
  const cikByTicker = {};
  candidates.forEach(c => {
    nameByTicker[c.ticker] = c.company_name;
    cikByTicker[c.ticker] = c.cik;
  });
  console.log(
    `[resolveCompanySetFacts] ${tickers.length} candidate tickers ` +
    `(subsector=${filter.subsectorTerm || 'none'}, sector=${filter.sector || 'any'})`
  );

  const { data: allFacts, error: factsErr } = await supabase
    .from('financial_facts')
    .select('*')
    .in('ticker', tickers)
    .eq('metric_name', filter.metric);

  if (factsErr || !allFacts || allFacts.length === 0) {
    console.log(`[resolveCompanySetFacts] no facts: ${factsErr?.message || 'empty'}`);
    return { chunks: [], facts: [], sources: [] };
  }

  const latestByTicker = {};
  for (const f of allFacts) {
    const existing = latestByTicker[f.ticker];
    if (!existing || (f.fiscal_year || 0) > (existing.fiscal_year || 0)) {
      latestByTicker[f.ticker] = f;
    }
  }

  const top = Object.values(latestByTicker)
    .filter(f => f.metric_value !== null && f.metric_value !== undefined)
    .sort((a, b) => {
      const av = Number(a.metric_value);
      const bv = Number(b.metric_value);
      return filter.orderBy === 'asc' ? av - bv : bv - av;
    })
    .slice(0, filter.limit);

  const filingIds = [...new Set(top.map(f => f.filing_id).filter(Boolean))];
  const filingById = {};
  if (filingIds.length > 0) {
    const { data: filings, error: filingsErr } = await supabase
      .from('filings')
      .select('*')
      .in('id', filingIds);
    if (filingsErr) {
      console.log(`[resolveCompanySetFacts] filings lookup failed: ${filingsErr.message}`);
    } else {
      (filings || []).forEach(row => { filingById[row.id] = row; });
    }
  }

  const facts = top.map(f => ({
    ...f,
    company_name: nameByTicker[f.ticker] || f.ticker,
  }));

  const sources = top.map((f, idx) => {
    const filing = f.filing_id ? filingById[f.filing_id] : null;
    const cik = cikByTicker[f.ticker];
    const directUrl =
      filing?.source_url ||
      filing?.url ||
      filing?.filing_url ||
      filing?.sec_url ||
      null;
    const fallbackUrl = cik
      ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=10-K&dateb=&owner=include&count=10`
      : null;

    return {
      index: idx + 1,
      type: 'sec',
      title: `${nameByTicker[f.ticker] || f.ticker} (${f.ticker}) — FY${f.fiscal_year} ${filter.metric}`,
      url: directUrl || fallbackUrl,
      ticker: f.ticker,
      fiscal_year: f.fiscal_year,
      item_code: filter.metric,
    };
  });

  if (coverageInfo) coverageInfo.returned = facts.length;

  return { chunks: [], facts, sources, coverageInfo };
}

module.exports = {
  SUBSECTOR_ALLOWLISTS,
  SECTOR_ALIASES,
  findAllowlistTickers,
  expandSectorAliases,
  selectCompaniesForSubsector,
  resolveCompanySetFacts,
};