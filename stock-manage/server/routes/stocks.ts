import { Router } from 'express';

const router = Router();

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || 'd7sa5a1r01qorsvhvrlgd7sa5a1r01qorsvhvrm0';

const POLYGON_API_KEY = process.env.POLYGON_API_KEY || 'ksTLCk4yRwmpfGycHMVKdvYIWyoAuCsb';

// 股票数据接口
interface StockData {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
}

// 期权数据接口
interface OptionData {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  type: 'call' | 'put';
  strikePrice: number;
  expirationDate: string;
  underlying: string;
}

// 解析期权代码
function parseOptionSymbol(symbol: string): { underlying: string; expiration: string; type: string; strike: string } | null {
  // 格式: AAPL250530C150 或 AAPL260620P200
  const match = symbol.match(/^([A-Z]+)(\d{6})([CP])(\d+(?:\.\d+)?)$/i);
  if (!match) return null;
  
  const [, underlying, date, type, strike] = match;
  return {
    underlying: underlying.toUpperCase(),
    expiration: date,
    type: type.toUpperCase(),
    strike: strike
  };
}

// 格式化为 Polygon.io 期权代码
function toPolygonOptionSymbol(symbol: string): string {
  const parsed = parseOptionSymbol(symbol);
  if (!parsed) return '';
  
  // Polygon.io 格式: O:AAPL250530C00150000
  // 执行价格式：strike * 1000 (3位小数)，左补零到8位
  // 例如: $150 = 150000 -> 00150000
  const strikeFloat = parseFloat(parsed.strike);
  const strikeInt = Math.round(strikeFloat * 1000); // 3位小数精度
  const strikePadded = strikeInt.toString().padStart(8, '0');
  return `O:${parsed.underlying}${parsed.expiration}${parsed.type}${strikePadded}`;
}

// 获取股票数据 (Finnhub)
router.get('/stock/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    
    // 使用原生 fetch 调用 Finnhub API
    const quoteUrl = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_API_KEY}`;
    const response = await fetch(quoteUrl);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const quoteData = await response.json();
    
    // Finnhub 返回: { c: current price, d: change, dp: change percent, h: high, l: low, o: open, pc: previous close, t: timestamp }
    if (!quoteData.c && quoteData.c !== 0) {
      return res.status(404).json({
        error: '无法获取股票数据，请检查股票代码是否正确',
        symbol: symbol.toUpperCase()
      });
    }
    
    // 如果价格为空或为0，说明股票代码无效
    if (quoteData.c === 0 && quoteData.pc === 0) {
      return res.status(404).json({
        error: '无法获取股票数据，请检查股票代码是否正确',
        symbol: symbol.toUpperCase()
      });
    }
    
    let stockData: StockData = {
      symbol: symbol.toUpperCase(),
      name: symbol.toUpperCase(),
      price: quoteData.c,
      change: quoteData.d,
      changePercent: quoteData.dp
    };
    
    res.json(stockData);
  } catch (error) {
    console.error('获取股票数据失败:', error);
    return res.status(500).json({
      error: '服务器错误，无法获取股票数据',
      message: error instanceof Error ? error.message : '未知错误'
    });
  }
});

// 获取期权数据 (Polygon.io v3 API)
router.get('/option/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const upperSymbol = symbol.toUpperCase();
    
    const parsed = parseOptionSymbol(upperSymbol);
    if (!parsed) {
      return res.status(400).json({
        error: '期权代码格式错误，格式应为: AAPL250530C150',
        example: 'AAPL250530C150 = Apple 2025-05-30 看涨期权 $150'
      });
    }
    
    const polygonSymbol = toPolygonOptionSymbol(upperSymbol);
    
    // 首先使用 v3/reference/options/contracts 获取期权合约详情
    const contractUrl = `https://api.polygon.io/v3/reference/options/contracts/${polygonSymbol}?apiKey=${POLYGON_API_KEY}`;
    const contractResponse = await fetch(contractUrl);
    const contractData = await contractResponse.json();
    
    // 如果合约不存在，返回错误
    if (contractData.status !== 'OK' || !contractData.results) {
      return res.status(404).json({
        error: '期权代码不存在或已过期',
        symbol: upperSymbol,
        polygonSymbol: polygonSymbol,
        hint: '请检查期权代码是否正确，或尝试更新的到期日'
      });
    }
    
    // 使用 v2/aggs 获取上一个交易日的价格数据
    const priceUrl = `https://api.polygon.io/v2/aggs/ticker/${polygonSymbol}/prev?adjusted=true&apiKey=${POLYGON_API_KEY}`;
    const priceResponse = await fetch(priceUrl);
    const priceData = await priceResponse.json();
    
    let price = 0;
    let change = 0;
    let changePercent = 0;
    
    if (priceData.status === 'OK' && priceData.results && priceData.results.length > 0) {
      const result = priceData.results[0];
      price = result.c || result.vw || 0;
      change = result.c && result.o ? result.c - result.o : 0;
      changePercent = result.c && result.o ? ((result.c - result.o) / result.o) * 100 : 0;
    }
    
    const optionData: OptionData = {
      symbol: upperSymbol,
      name: `${parsed.underlying} ${contractData.results.expiration_date} ${contractData.results.contract_type === 'call' ? 'Call' : 'Put'} $${contractData.results.strike_price}`,
      price: price,
      change: change,
      changePercent: changePercent,
      type: contractData.results.contract_type as 'call' | 'put',
      strikePrice: contractData.results.strike_price,
      expirationDate: contractData.results.expiration_date,
      underlying: parsed.underlying
    };
    
    res.json(optionData);
  } catch (error) {
    console.error('获取期权数据失败:', error);
    return res.status(500).json({
      error: '服务器错误，无法获取期权数据',
      message: error instanceof Error ? error.message : '未知错误'
    });
  }
});

// 获取期权链 (Polygon.io) - 获取某个标的的所有期权
router.get('/options/chain/:underlying', async (req, res) => {
  try {
    const { underlying } = req.params;
    const upperUnderlying = underlying.toUpperCase();
    
    // 使用 Polygon.io v3 获取期权链
    const url = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${upperUnderlying}&apiKey=${POLYGON_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.status !== 'OK') {
      return res.status(404).json({
        error: '无法获取期权链数据',
        symbol: upperUnderlying
      });
    }
    
    // 返回期权列表
    const results = Array.isArray(data.results) ? data.results : [];
    const options = results.map((contract: Record<string, unknown>) => ({
      ticker: String(contract.ticker ?? '').replace(/^O:/, ''),
      type: contract.contract_type,
      strikePrice: contract.strike_price,
      expirationDate: contract.expiration_date,
      sharesPerContract: contract.shares_per_contract
    }));
    
    res.json({
      underlying: upperUnderlying,
      count: options.length,
      options: options.slice(0, 50) // 限制返回数量
    });
  } catch (error) {
    console.error('获取期权链失败:', error);
    return res.status(500).json({
      error: '服务器错误，无法获取期权链'
    });
  }
});

function etfHoldingWeight(h: Record<string, unknown>): number {
  const v = h.percent ?? h.percentage ?? h.weight;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * 用 Finnhub ETF 持仓推断「主成分股」：对单股杠杆 ETF 等，最大权重往往为对应正股。
 * 注意：部分账户/免费层无 holdings 或成分以互换为主，需与前端手写 UNDERLYING_EQUIVALENTS 互补。
 * GET /api/symbol/canonical-underlying/:symbol
 */
router.get('/symbol/canonical-underlying/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '')
      .trim()
      .toUpperCase();
    if (!symbol) {
      return res.status(400).json({ error: '缺少 symbol' });
    }

    const url = `https://finnhub.io/api/v1/etf/holdings?symbol=${encodeURIComponent(
      symbol
    )}&token=${FINNHUB_API_KEY}`;
    const response = await fetch(url);
    const data = (await response.json()) as {
      holdings?: Array<Record<string, unknown>>;
      error?: string;
    };

    if (data.error || !Array.isArray(data.holdings) || data.holdings.length === 0) {
      return res.json({
        canonical: symbol,
        source: 'no_holdings' as const
      });
    }

    let bestSym = '';
    let bestW = -1;
    for (const h of data.holdings) {
      const rawSym = h.symbol ?? h.asset ?? h.ticker;
      const sym = String(rawSym ?? '')
        .trim()
        .toUpperCase();
      if (!sym || sym === symbol) continue;
      const w = etfHoldingWeight(h);
      if (w > bestW) {
        bestW = w;
        bestSym = sym;
      }
    }

    if (!bestSym) {
      return res.json({
        canonical: symbol,
        source: 'no_primary' as const
      });
    }

    return res.json({
      canonical: bestSym,
      source: 'finnhub_etf_holdings' as const,
      weight: bestW >= 0 ? bestW : undefined
    });
  } catch (error) {
    console.error('canonical-underlying:', error);
    return res.json({
      canonical: String(req.params.symbol || '')
        .trim()
        .toUpperCase(),
      source: 'error' as const
    });
  }
});

// Finnhub Symbol Search（Symbol Lookup），供前端补全未在本地表中的代码/公司名
router.get('/search', async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) {
      return res.json({ count: 0, result: [] });
    }
    const exchange = typeof req.query.exchange === 'string' ? req.query.exchange.trim() : '';
    let url = `https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${FINNHUB_API_KEY}`;
    if (exchange) {
      url += `&exchange=${encodeURIComponent(exchange)}`;
    }
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(response.status).json({
        error: 'Symbol search 请求失败',
        status: response.status
      });
    }
    const data = (await response.json()) as unknown;
    res.json(data);
  } catch (error) {
    console.error('Finnhub /search:', error);
    res.status(500).json({
      error: '服务器错误',
      message: error instanceof Error ? error.message : '未知错误'
    });
  }
});

export default router;
