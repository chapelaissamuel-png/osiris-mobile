
import { NextResponse } from 'next/server';

/**
 * OSIRIS — Financial Markets & Commodities API
 * Defense stocks, oil, gold, silver, natural gas, wheat, crypto
 *
 * Stock source priority:
 *   1. Yahoo Finance v8 (no key, rate-limited)
 *   2. Yahoo Finance v6 (no key, alternate endpoint)
 *   3. Alpha Vantage (set ALPHA_VANTAGE_KEY — free 25 req/day at alphavantage.co)
 *
 * Crypto source: CoinGecko (no key, open)
 */

const DEFENSE_STOCKS    = ['RTX', 'LMT', 'NOC', 'GD', 'BA', 'PLTR'];
const OIL_TICKERS       = ['CL=F', 'BZ=F'];
const COMMODITY_TICKERS = ['GC=F', 'SI=F', 'HG=F', 'NG=F', 'ZW=F', 'ZC=F'];
const CRYPTO_TICKERS    = ['BTC-USD', 'ETH-USD'];
const INDEX_TICKERS     = ['ES=F', 'NQ=F'];

const COMMODITY_NAMES: Record<string, string> = {
  'GC=F': 'Gold', 'SI=F': 'Silver', 'HG=F': 'Copper',
  'NG=F': 'Natural Gas', 'ZW=F': 'Wheat', 'ZC=F': 'Corn',
};
const OIL_NAMES:    Record<string, string> = { 'CL=F': 'WTI Crude', 'BZ=F': 'Brent Crude' };
const CRYPTO_NAMES: Record<string, string> = { 'BTC-USD': 'Bitcoin', 'ETH-USD': 'Ethereum' };
const INDEX_NAMES:  Record<string, string> = { 'ES=F': 'S&P 500', 'NQ=F': 'Nasdaq 100' };

// ─── Yahoo Finance v8 ─────────────────────────────────────────────────────────
async function fetchYahoo(symbol: string): Promise<any | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data.chart?.result?.[0];
    if (!result) return null;
    const meta = result.meta;
    const closes = result.indicators?.quote?.[0]?.close || [];
    const currentPrice = meta.regularMarketPrice || closes[closes.length - 1];
    const prevClose    = meta.chartPreviousClose  || closes[0];
    if (!currentPrice || !prevClose) return null;
    const changePercent = ((currentPrice - prevClose) / prevClose) * 100;
    return {
      price:          Math.round(currentPrice * 100) / 100,
      change_percent: Math.round(changePercent * 100) / 100,
      up:             changePercent >= 0,
      source:         'Yahoo v8',
    };
  } catch { return null; }
}

// ─── Yahoo Finance v6 ─────────────────────────────────────────────────────────
async function fetchYahooV6(symbol: string): Promise<any | null> {
  try {
    const url = `https://query2.finance.yahoo.com/v6/finance/quote?symbols=${encodeURIComponent(symbol)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const q = data.quoteResponse?.result?.[0];
    if (!q) return null;
    return {
      price:          Math.round((q.regularMarketPrice || 0) * 100) / 100,
      change_percent: Math.round((q.regularMarketChangePercent || 0) * 100) / 100,
      up:             (q.regularMarketChangePercent || 0) >= 0,
      source:         'Yahoo v6',
    };
  } catch { return null; }
}

// ─── Alpha Vantage (free key, 25 req/day) ─────────────────────────────────────
// Used as fallback for defense stocks only when Yahoo fails
async function fetchAlphaVantage(symbol: string, apiKey: string): Promise<any | null> {
  try {
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const q = data['Global Quote'];
    if (!q || !q['05. price']) return null;
    const price      = parseFloat(q['05. price']);
    const prevClose  = parseFloat(q['08. previous close'] || '0');
    const pctStr     = q['10. change percent'] || '0%';
    const pct        = parseFloat(pctStr.replace('%', ''));
    if (isNaN(price)) return null;
    return {
      price:          Math.round(price * 100) / 100,
      change_percent: isNaN(pct) ? 0 : Math.round(pct * 100) / 100,
      up:             pct >= 0,
      prev_close:     isNaN(prevClose) ? undefined : Math.round(prevClose * 100) / 100,
      source:         'AlphaVantage',
    };
  } catch { return null; }
}

// ─── CoinGecko (crypto, free, no key) ────────────────────────────────────────
async function fetchCoinGecko(): Promise<Record<string, any>> {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true',
      { signal: AbortSignal.timeout(8000), cache: 'no-store' }
    );
    if (!res.ok) return {};
    const data = await res.json();
    const result: Record<string, any> = {};
    if (data.bitcoin) {
      result['Bitcoin'] = {
        price:          Math.round(data.bitcoin.usd * 100) / 100,
        change_percent: Math.round((data.bitcoin.usd_24h_change || 0) * 100) / 100,
        up:             (data.bitcoin.usd_24h_change || 0) >= 0,
        source:         'CoinGecko',
      };
    }
    if (data.ethereum) {
      result['Ethereum'] = {
        price:          Math.round(data.ethereum.usd * 100) / 100,
        change_percent: Math.round((data.ethereum.usd_24h_change || 0) * 100) / 100,
        up:             (data.ethereum.usd_24h_change || 0) >= 0,
        source:         'CoinGecko',
      };
    }
    return result;
  } catch { return {}; }
}

// ─── Unified quote fetcher with Alpha Vantage fallback ────────────────────────
async function fetchQuote(symbol: string, avKey?: string): Promise<any | null> {
  let result = await fetchYahoo(symbol);
  if (!result) result = await fetchYahooV6(symbol);
  if (!result && avKey && DEFENSE_STOCKS.includes(symbol)) {
    result = await fetchAlphaVantage(symbol, avKey);
  }
  return result;
}

export async function GET() {
  try {
    const avKey = process.env.ALPHA_VANTAGE_KEY;

    const [stockResults, oilResults, commodityResults, yahooResults, indexResults, cgCrypto] =
      await Promise.all([
        Promise.all(DEFENSE_STOCKS.map(async t => ({ symbol: t, data: await fetchQuote(t, avKey) }))),
        Promise.all(OIL_TICKERS.map(async t => ({ symbol: t, data: await fetchQuote(t) }))),
        Promise.all(COMMODITY_TICKERS.map(async t => ({ symbol: t, data: await fetchQuote(t) }))),
        Promise.all(CRYPTO_TICKERS.map(async t => ({ symbol: t, data: await fetchQuote(t) }))),
        Promise.all(INDEX_TICKERS.map(async t => ({ symbol: t, data: await fetchQuote(t) }))),
        fetchCoinGecko(),
      ]);

    const stocks: Record<string, any> = {};
    for (const { symbol, data } of stockResults) { if (data) stocks[symbol] = data; }

    const oil: Record<string, any> = {};
    for (const { symbol, data } of oilResults) { if (data) oil[OIL_NAMES[symbol] || symbol] = data; }

    const commodities: Record<string, any> = {};
    for (const { symbol, data } of commodityResults) { if (data) commodities[COMMODITY_NAMES[symbol] || symbol] = data; }

    const crypto: Record<string, any> = {};
    for (const { symbol, data } of yahooResults) { if (data) crypto[CRYPTO_NAMES[symbol] || symbol] = data; }
    for (const [name, data] of Object.entries(cgCrypto)) {
      if (!crypto[name]) crypto[name] = data;
    }

    const indices: Record<string, any> = {};
    for (const { symbol, data } of indexResults) { if (data) indices[INDEX_NAMES[symbol] || symbol] = data; }

    // SCM: Chokepoint → Commodity correlation
    const scm_alerts: string[] = [];
    try {
      const port = process.env.PORT || 3000;
      const maritimeRes = await fetch(`http://127.0.0.1:${port}/api/maritime`, {
        signal: AbortSignal.timeout(3000),
        cache: 'no-store',
      });
      if (maritimeRes.ok) {
        const maritimeData = await maritimeRes.json();
        const chokepoints = maritimeData.chokepoints || [];

        const hormuz = chokepoints.find((c: any) => c.name === 'Strait of Hormuz');
        const suez   = chokepoints.find((c: any) => c.name === 'Suez Canal');
        const panama = chokepoints.find((c: any) => c.name === 'Panama Canal');

        if (hormuz && (hormuz.risk === 'CRITICAL' || hormuz.risk === 'HIGH'))
          scm_alerts.push(`HORMUZ ${hormuz.risk}: High risk of WTI/Brent Crude price spike.`);
        if (suez && (suez.risk === 'CRITICAL' || suez.risk === 'HIGH'))
          scm_alerts.push(`SUEZ ${suez.risk}: Supply chain delays impacting European markets.`);
        if (panama && (panama.risk === 'CRITICAL' || panama.risk === 'HIGH'))
          scm_alerts.push(`PANAMA ${panama.risk}: LNG and Agriculture shipment delays expected.`);
      }
    } catch { /* best-effort */ }

    const avStatus = avKey
      ? 'Alpha Vantage fallback active (25 req/day)'
      : 'Set ALPHA_VANTAGE_KEY for stock fallback (free at alphavantage.co)';

    return NextResponse.json({
      stocks, oil, commodities, crypto, indices, scm_alerts,
      meta: { av_status: avStatus },
      timestamp: new Date().toISOString(),
    }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[OSIRIS/Markets] Fatal error:', error);
    return NextResponse.json(
      { stocks: {}, oil: {}, commodities: {}, crypto: {}, indices: {}, scm_alerts: [], error: 'Failed' },
      { status: 500 }
    );
  }
}
