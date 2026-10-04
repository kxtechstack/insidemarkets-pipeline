/**
 * modules/decisionIntelligence/route.js
 */

const { retrieveCustomSourceData } = require('./customSourceRetrieval');
const { extractIntent, retrieveForIntent, getAllCompanies } = require('./secRetrieval');
const { generateAnswer } = require('./generateAnswer');
const { retrieveClientData, detectTargetModules, detectTimeWindow } = require('./retrieveClientData');
const { detectTargetCategories, applyCategoryFilter, queryItemsByCategory } = require('./categoryFilter');
const { getVerifiedSuggestions } = require('./suggestionEngine');
const { buildListAnswer } = require('./buildListAnswer');
const { generateInferenceAnswer } = require('./generateInferenceAnswer');
const { classifyQuestion } = require('./classifyQuestion');
const { enrichSourcesWithSignalIds } = require('./enrichSources');
const { resolveCompanySet } = require('./resolveCompanySet');
// ── Subsector allow-lists ─────────────────────────────────────────────────
// For the subsectors clients actually ask about, we curate the exact tickers
// rather than trusting the LLM to guess. This eliminates the entire class of
// "retail question returned Verizon and AT&T" hallucinations. When a
// subsector is not in this map, we fall back to the LLM picker.
//
// Tickers must exist in `companies` AND have financial_facts rows in
// `financial_facts`. Missing ones are silently ignored by the DB query.
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
  restaurant: ['MCD','SBUX','CMG','YUM','DRI','DPZ','QSR','WEN','Chipotle'],
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
  // Try exact match first, then try matching the singular form.
  if (SUBSECTOR_ALLOWLISTS[key]) return SUBSECTOR_ALLOWLISTS[key];
  if (key.endsWith('s') && SUBSECTOR_ALLOWLISTS[key.slice(0, -1)]) {
    return SUBSECTOR_ALLOWLISTS[key.slice(0, -1)];
  }
  return null;
}
// ── Sector alias map ────────────────────────────────────────────────────────
// Some companies in our DB were historically tagged under a legacy sector
// name that differs from the canonical GICS name the LLM resolver uses.
// This maps the canonical name -> ALL DB sector tags that mean the same
// thing, so `.in('sector', [...])` picks up everything.
//
// DO NOT edit the companies table to normalize these — downstream tables
// (financial_facts, filings, chunks_meta, Qdrant payloads) reference these
// rows, and any DB write here risks breaking the SEC pipeline. Fix it here.
const SECTOR_ALIASES = {
  'Information Technology': ['Information Technology', 'Technology'],
  // Add more as you discover them, e.g.:
  // 'Health Care': ['Health Care', 'Healthcare'],
  // 'Real Estate': ['Real Estate', 'REITs'],
};

function expandSectorAliases(sector) {
  if (!sector) return null;
  return SECTOR_ALIASES[sector] || [sector];
}
const {
  createConversation, appendMessage,
  listConversations, loadConversation, deleteConversation,
  getSuggestedQuestions,
} = require('./chatHistory');


/**
 * Handles a 'list' question.
 *
 * Safety net: if the classifier routed a sector-set question to list,
 * delegate to handleDecision.
 *
 * Time-scoped questions ("last week"): progressively widen the window
 * (30d -> 90d -> all-time) ONLY when the exact window is empty, and tell
 * the user honestly that it widened.
 */
async function handleList(question, clientId, industry, forceList = false) {
  // Safety net -- company-set question that got routed to list.
  const setPeek = await resolveCompanySet(question);
  if (setPeek) {
    console.log(`[handleList] detected company-set question -- delegating to handleDecision`);
    return await handleDecision(question, clientId, industry);
  }

  const modules = detectTargetModules(question);
  const hasTimeWindow = Boolean(detectTimeWindow(question));
  const targetCategories = await detectTargetCategories(question, clientId);
  const LIST_FLOOR = Number(process.env.LIST_SCORE_FLOOR) || 0.35;

  const [searchResults, customSourceResults] = await Promise.all([
    retrieveClientData(question, clientId, industry, 10, modules, LIST_FLOOR, true),
    retrieveCustomSourceData(question, clientId),
  ]);

  let clientItems = [];
  if (searchResults.length > 0) {
    try {
      clientItems = await buildListAnswer(searchResults);
    } catch (err) {
      console.log(`[handleList] buildListAnswer failed: ${err.message}`);
      clientItems = [];
    }
  }
  clientItems = applyCategoryFilter(clientItems, targetCategories);

  
  if (targetCategories.length > 0 && clientItems.length === 0) {
    try {
      clientItems = await queryItemsByCategory(clientId, targetCategories, 10);
      console.log(`[handleList] semantic search found 0 matching-category items; direct category query found ${clientItems.length}`);
    } catch (err) {
      console.log(`[handleList] queryItemsByCategory failed: ${err.message}`);
    }
  }
  let widenedLabel = null;
  if (hasTimeWindow && clientItems.length === 0) {
    const widenSteps = [
      { days: 30, label: 'the last 30 days' },
      { days: 90, label: 'the last 90 days' },
      { days: null, label: 'all available data' },
    ];
    for (const step of widenSteps) {
      const widenedResults = await retrieveClientData(
        question, clientId, industry, 10, modules, LIST_FLOOR, true, step.days
      );
      if (widenedResults.length > 0) {
        let widenedItems = [];
        try {
          widenedItems = await buildListAnswer(widenedResults);
        } catch (err) {
          console.log(`[handleList] buildListAnswer failed on widen: ${err.message}`);
          widenedItems = [];
        }
        widenedItems = applyCategoryFilter(widenedItems, targetCategories);
        if (widenedItems.length > 0) {
          clientItems = widenedItems;
          widenedLabel = step.label;
          break;
        }
      }
    }
  }

  const MIN_RICH_LIST_SIZE = 3;
  const useCustomSources =
    !hasTimeWindow && targetCategories.length === 0 && clientItems.length < MIN_RICH_LIST_SIZE && customSourceResults.length > 0;

  console.log(
    `[handleList] client=${clientId} | signals=${searchResults.length} (${clientItems.length} items) | categories=${targetCategories.join(',') || 'none'} | widened=${widenedLabel || 'no'} | customSource=${customSourceResults.length} | route=${useCustomSources ? 'custom->inference' : 'list'}`
  );

  const widenMessage = widenedLabel
    ? `No results in the requested time frame — showing matches from ${widenedLabel} instead.`
    : null;

  if (forceList) {
    return { type: 'list', items: clientItems, ...(widenMessage ? { message: widenMessage } : {}) };
  }

  if (!useCustomSources) {
    return { type: 'list', items: clientItems, ...(widenMessage ? { message: widenMessage } : {}) };
  }

  const { report, sources, _empty } = await generateInferenceAnswer(
    question,
    [],
    customSourceResults
  );

  if (_empty) {
    return { type: 'list', items: clientItems };
  }

  return { type: 'inference', report, sources };
}

/**
 * Handles an 'inference' question: client data + LLM synthesis.
 */
async function handleInference(question, clientId, industry) {
  const [searchResults, customSourceResults] = await Promise.all([
    retrieveClientData(question, clientId, industry),
    retrieveCustomSourceData(question, clientId),
  ]);
  console.log(`[handleInference] client=${clientId} | signals=${searchResults.length} | customSource=${customSourceResults.length}`);
  const { report, sources, _empty, _reason } = await generateInferenceAnswer(
    question,
    searchResults,
    customSourceResults
  );
  if (_empty) {
    return {
      type: 'inference',
      report: null,
      sources: [],
      _empty: true,
      _reason: _reason || null,
    };
  }
  return { type: 'inference', report, sources };
}

/**
 * Handles a 'decision' question: SEC filings + client data.
 *
 * Company-set resolution runs FIRST -- if the question is a sector-set
 * query ("top 5 US tech companies by revenue"), we use the LLM-driven
 * filter + DB query, even if extractTickers incidentally matched a
 * generic word in the question.
 */
async function handleDecision(question, clientId, industry) {
  const intent = await extractIntent(question, getAllCompanies);

  let secRetrieval;
  const setFilter = await resolveCompanySet(question);

  // ── Guard: refuse when sector could not be resolved AND the user's term
  // was flagged as unmatched. Prevents the "top cosmetic companies" -> top-5-
  // by-revenue bug where an unresolved term silently became sector=null and
  // returned the biggest US companies across all sectors.
  if (setFilter && setFilter.sector === null && setFilter.unresolvedTerm) {
    console.log(
      `[handleDecision] refusing: unresolved sector term "${setFilter.unresolvedTerm}" ` +
      `-- no sector matched even after disambiguation`
    );
    return {
      type: 'decision',
      report: null,
      sources: [],
      chart: null,
      chartMeta: null,
      _empty: true,
      _reason: `I couldn't match "${setFilter.unresolvedTerm}" to a sector in our SEC data. Try naming a broader category (e.g. "consumer staples", "health care", "information technology").`,
    };
  }

  if (setFilter) {
    secRetrieval = await resolveCompanySetFacts(setFilter);
    if (secRetrieval.facts.length > 0) {
      intent.dataType = 'quantitative';
      intent.questionCategory = 'comparison';
      intent.metric = setFilter.metric;
      intent.tickers = secRetrieval.facts.map((f) => f.ticker);
      intent.isChartable = secRetrieval.facts.length >= 2;
      console.log(
        `[handleDecision] company-set resolved to ${secRetrieval.facts.length} facts ` +
        `(sector=${setFilter.sector || 'any'}, metric=${setFilter.metric}, orderBy=${setFilter.orderBy})`
      );
    } else {
      secRetrieval = intent.tickers.length > 0
        ? await retrieveForIntent(question, intent)
        : { chunks: [], facts: [] };
    }
  } else if (intent.tickers.length > 0) {
    secRetrieval = await retrieveForIntent(question, intent);
  } else {
    secRetrieval = { chunks: [], facts: [] };
  }

  const [customSourceResults] = await Promise.all([
    retrieveCustomSourceData(question, clientId),
  ]);
  const { chunks, facts, sources: secFactSources = [] } = secRetrieval;

  console.log(`[handleDecision] client=${clientId} | secChunks=${chunks.length} | facts=${facts.length} | customSource=${customSourceResults.length}`);

  const {
    report, sources,
    chart: autoChart, chartMeta: autoChartMeta,
    clientContextCount, _empty, _reason,
  } = await generateAnswer(
    question, intent, chunks, facts, clientId, industry, customSourceResults
  );

  if (_empty) {
    return {
      type: 'decision',
      report: null,
      sources: [],
      chart: null,
      chartMeta: null,
      _empty: true,
      _reason: _reason || null,
    };
  }

  let chart = autoChart || null;
  let chartMeta = autoChartMeta || null;

  // Generate a chart whenever the numeric answer has more than one value --
  // whether that's multiple companies (comparison) or multiple years for
  // one company (trend). We keep the intent-based `decideChartFormat`
  // logic for choosing chart type, but we no longer gate on
  // `intent.isChartable` alone, because the classifier sometimes misses
  // the trend shape for short questions like "Apple revenue".
  const shouldChart =
    !chart &&
    intent.dataType === 'quantitative' &&
    Array.isArray(facts) &&
    facts.length > 1;

  if (shouldChart) {
    try {
      const { decideChartFormat, renderChart } = require('./chartPipeline');
      const display = decideChartFormat(intent, facts);

      if (display.format === 'chart') {
        chart = await renderChart(display.chartData);
        chartMeta = { chartType: display.chartType };
      } else {
        // decideChartFormat returned 'text' but we have multiple values.
        // Force-generate the chart with a sensible default so the user
        // always gets a visual when there's more than one number.
        // Sort facts by ticker+year so the chart has a stable shape.
        const tickers = [...new Set(facts.map(f => f.ticker))];
        const years = [...new Set(facts.map(f => f.fiscal_year))].sort();

        // If one ticker, chart over years. If multiple tickers with one
        // year each, chart over companies.
        let chartData;
        if (tickers.length === 1 && years.length > 1) {
          const t = tickers[0];
          chartData = {
            type: 'line',
            xAxis: 'year',
            metricLabel: facts[0]?.metric_name || 'Value',
            series: [{
              name: t,
              labels: years,
              data: years.map(y => {
                const f = facts.find(x => x.ticker === t && x.fiscal_year === y);
                return f && f.metric_value !== null ? Number(f.metric_value) : null;
              }),
            }],
          };
        } else if (tickers.length > 1) {
          chartData = {
            type: 'bar',
            xAxis: 'company',
            metricLabel: facts[0]?.metric_name || 'Value',
            series: tickers.map(t => {
              const f = facts.find(x => x.ticker === t);
              return {
                name: t,
                labels: [t],
                data: [f && f.metric_value !== null ? Number(f.metric_value) : null],
              };
            }),
          };
        }

        if (chartData) {
          chart = await renderChart(chartData);
          chartMeta = { chartType: chartData.type };
        }
      }
    } catch (err) {
      console.log(`[handleDecision] Chart rendering unavailable: ${err.message}`);
    }
  }

  const hadNoContext =
    (!chunks || chunks.length === 0) &&
    (!facts || facts.length === 0) &&
    (!sources || sources.length === 0) &&
    (!clientContextCount || clientContextCount === 0) &&
    (!customSourceResults || customSourceResults.length === 0);

  if (hadNoContext) {
    console.log(
      `[handleDecision] Discarding report for "${question}" -- zero context retrieved (chunks=${chunks?.length || 0}, facts=${facts?.length || 0}, sources=${sources?.length || 0})`
    );
    return { type: 'decision', report: null, sources: [], chart: null, chartMeta: null, _empty: true };
  }

  // Merge SEC-fact sources (per-company filing URLs) with whatever sources
  // the LLM cited. Dedupe by ticker so we don't show the same company twice.
  const mergedSources = [...(sources || [])];
  const seenKeys = new Set(mergedSources.map((s) => `${s.type || ''}:${s.ticker || s.article_id || s.url || s.index}`));
  for (const s of secFactSources) {
    const key = `${s.type}:${s.ticker}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    mergedSources.push(s);
  }

  return { type: 'decision', report, sources: mergedSources, chart, chartMeta };
}



function registerDecisionIntelligenceRoute(app) {

  app.post('/decision-intelligence/chat', async (req, res) => {
    try {
      const {
        question, clientId, industry,
        type: providedType,
        conversationId: incomingConversationId,
        userId,
      } = req.body;

      if (!question || !clientId || !industry || !userId) {
        return res.status(400).json({
          error: 'question, clientId, industry, and userId are required',
        });
      }

      let conversationId = incomingConversationId;
      if (!conversationId) {
        conversationId = await createConversation({
          clientId, userId, firstQuestion: question,
        });
      }

      await appendMessage({
        conversationId,
        role: 'user',
        content: question,
      });

      const { classifyIntent } = require('./classifyIntent');
      const intentResult = await classifyIntent(question);

      if (intentResult.intent !== 'market_intelligence') {
        let suggestions = [];
        try {
          const homeQs = await getSuggestedQuestions({
            clientId, surface: 'home', industry, companyName: null,
          });
          suggestions = (homeQs || []).slice(0, 4).map((q) => q.question).filter(Boolean);
        } catch (err) {
          console.log(`[DI intent] Failed to load suggestions: ${err.message}`);
        }

        const reply = intentResult.message
          || 'Hey! Ask me a question about your market intelligence data to get started.';

        const payload = {
          type: 'list',
          items: [],
          greeting: intentResult.intent === 'greeting',
          no_data: intentResult.intent === 'off_topic' || intentResult.intent === 'clarification',
          message: reply,
          suggestions,
        };

        await appendMessage({
          conversationId, role: 'assistant', content: reply, type: 'list', payload,
        });

        return res.json({ ...payload, conversationId });
      }

      let type = providedType;
      let classifierReasoning = null;
      const typeWasExplicit = Boolean(providedType);
      if (!type) {
        const classification = await classifyQuestion(question);
        type = classification.type;
        classifierReasoning = classification.reasoning;
      } else if (!['list', 'inference', 'decision'].includes(type)) {
        return res.status(400).json({
          error: `Invalid type "${type}" -- must be list, inference, or decision`,
        });
      }

      let result;
      if (type === 'list') {
        result = await handleList(question, clientId, industry, typeWasExplicit);
      } else if (type === 'inference') {
        result = await handleInference(question, clientId, industry);
      } else {
        result = await handleDecision(question, clientId, industry);
      }

      if (classifierReasoning) result.classifierReasoning = classifierReasoning;
      if (result.sources && result.sources.length) {
        try {
          result.sources = await enrichSourcesWithSignalIds(result.sources, clientId);
        } catch (err) {
          console.log(`[DI] enrichSources failed: ${err.message}`);
        }
      }

      const NO_DATA_PATTERNS = [
        /no (specific|relevant|publicly[\s-]?available|reported) (developments?|information|data|coverage|insights?)/i,
        /context (lacks|does not contain|does not provide|provides no)/i,
        /not documented in the (provided|given|available) context/i,
        /no insights? (are|is) available/i,
        /cannot (identify|determine|find|locate) (any )?(drivers|signals|information|developments?)/i,
        /no relevant information/i,
        /not provided in the (given|provided|available) context/i,
        /does not contain information about/i,
        /no information (is )?(available|provided|present) (in|about)/i,
        /not provided in the given context/i,
        /information is not (available|provided|present)/i,
      ];
      const textSaysNoData = (text) =>
        typeof text === 'string' && NO_DATA_PATTERNS.some((p) => p.test(text));

      const isEmptyResult = (() => {
        if (!result) return true;
        if (result._empty) return true;

        if (result.type === 'list') {
          return !result.items || result.items.length === 0;
        }

        if (result.type === 'inference' || result.type === 'decision') {
          const r = result.report || {};
          const outlookText = Array.isArray(r.outlook) ? r.outlook.join(' ') : (r.outlook || '');
          if (textSaysNoData(outlookText) || textSaysNoData(r.bodyText) || textSaysNoData(r.bottom_line)) {
            return true;
          }

          const hasTitle = Boolean(r.title && r.title.trim());
          const hasOutlook = Array.isArray(r.outlook)
            ? r.outlook.length > 0
            : Boolean(r.outlook && String(r.outlook).trim());
          const hasBody = Boolean(r.bodyText && r.bodyText.trim());
          const hasTable = Boolean(
            r.key_movement_analysis &&
              r.key_movement_analysis.rows &&
              r.key_movement_analysis.rows.length > 0
          );
          const hasDrivers = Array.isArray(r.driving_factors) && r.driving_factors.length > 0;
          const hasSources = Array.isArray(result.sources) && result.sources.length > 0;
          return !(hasTitle || hasOutlook || hasBody || hasTable || hasDrivers || hasSources);
        }

        return false;
      })();

      if (isEmptyResult) {
        let suggestions = [];
        try {
          suggestions = await getVerifiedSuggestions(clientId, 4);
        } catch (err) {
          console.log(`[DI] getVerifiedSuggestions failed: ${err.message}`);
        }

        if (suggestions.length === 0) {
          try {
            const homeQs = await getSuggestedQuestions({
              clientId, surface: 'home', industry, companyName: null,
            });
            suggestions = (homeQs || []).slice(0, 4).map((q) => q.question).filter(Boolean);
          } catch (err) {
            console.log(`[DI] Failed to load suggestions for empty result: ${err.message}`);
          }
        }

        if (suggestions.length === 0) {
          suggestions = [
            'What are the major policy changes affecting my industry?',
            'What recent market activity is happening in my sector?',
          ];
        }

        const reply = result._reason
          ? `I don't have relevant data on that in your current dataset (${result._reason}). Would you like to explore one of these instead?`
          : "I don't have relevant data on that in your current dataset. Would you like to explore one of these instead?";

        const enriched = {
          type: 'list',
          items: [],
          no_data: true,
          message: reply,
          suggestions,
        };

        await appendMessage({
          conversationId, role: 'assistant', content: reply, type: 'list', payload: enriched,
        });

        return res.json({ ...enriched, conversationId });
      }

      const contentForSearch =
        result.type === 'list'
          ? `List: ${result.items?.length ?? 0} items`
          : (result.report?.title || result.report?.bodyText || '');

      await appendMessage({
        conversationId,
        role: 'assistant',
        content: contentForSearch,
        type: result.type,
        payload: result,
      });

      return res.json({ ...result, conversationId });

    } catch (err) {
      console.error('[DecisionIntelligence] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/decision-intelligence/conversations', async (req, res) => {
    try {
      const { userId } = req.query;
      if (!userId) return res.status(400).json({ error: 'userId is required' });
      const conversations = await listConversations({ userId });
      return res.json({ conversations });
    } catch (err) {
      console.error('[DI listConversations] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/decision-intelligence/conversations/:id', async (req, res) => {
    try {
      const { userId } = req.query;
      if (!userId) return res.status(400).json({ error: 'userId is required' });
      const data = await loadConversation({ conversationId: req.params.id, userId });
      return res.json(data);
    } catch (err) {
      console.error('[DI loadConversation] Error:', err.message);
      return res.status(404).json({ error: err.message });
    }
  });

  app.get('/decision-intelligence/suggested-questions', async (req, res) => {
    try {
      const { clientId, surface, category, industry, companyName } = req.query;
      if (!clientId || !surface) {
        return res.status(400).json({ error: 'clientId and surface are required' });
      }
      const questions = await getSuggestedQuestions({
        clientId, surface, category, industry, companyName,
      });
      return res.json({ questions });
    } catch (err) {
      console.error('[DI suggested-questions] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  app.delete('/decision-intelligence/conversations/:id', async (req, res) => {
    try {
      const { userId } = req.query;
      if (!userId) return res.status(400).json({ error: 'userId is required' });
      await deleteConversation({ conversationId: req.params.id, userId });
      return res.json({ success: true });
    } catch (err) {
      console.error('[DI deleteConversation] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerDecisionIntelligenceRoute };