import { getJson } from "./http.js";

export interface StockCandle {
  /** Bar start time, ISO 8601 UTC. */
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface StockHistory {
  source: "yahoo";
  symbol: string;
  name: string | null;
  currency: string;
  exchange: string;
  firstTime: string | null;
  lastTime: string | null;
  count: number;
  candles: StockCandle[];
}

interface ChartResponse {
  chart: {
    result: Array<{
      meta: {
        symbol: string;
        currency: string;
        fullExchangeName?: string;
        exchangeName: string;
        longName?: string;
        shortName?: string;
      };
      timestamp?: number[];
      indicators: {
        quote: Array<Record<"open" | "high" | "low" | "close" | "volume", (number | null)[]>>;
      };
    }> | null;
    error: { code: string; description: string } | null;
  };
}

/** Yahoo serves hourly bars for the last 730 days only. */
const HOURLY_DAYS = 729;

/** Hourly bars for the last two years (market hours only). */
export async function fetchStockHistory(ticker: string): Promise<StockHistory> {
  // Yahoo writes share classes with a dash (BRK.B → BRK-B).
  const symbol = ticker.replace(/\./g, "-");
  const now = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${now - HOURLY_DAYS * 86400}&period2=${now}&interval=60m`;

  const { chart } = await getJson<ChartResponse>(url);
  const result = chart.result?.[0];
  if (!result) throw new Error(`Yahoo: ${chart.error?.description ?? `no data for ${symbol}`}`);

  const { meta, timestamp = [], indicators } = result;
  const quote = indicators.quote[0];

  const candles: StockCandle[] = [];
  timestamp.forEach((t, i) => {
    const close = quote?.close[i];
    // Skip Yahoo's null gaps, and the live quote it appends while the market is open
    // (stamped with the current second; real bars start on a whole minute).
    if (close == null || t % 60 !== 0) return;
    candles.push({
      time: new Date(t * 1000).toISOString(),
      open: quote?.open[i] ?? close,
      high: quote?.high[i] ?? close,
      low: quote?.low[i] ?? close,
      close,
      volume: quote?.volume[i] ?? 0,
    });
  });

  return {
    source: "yahoo",
    symbol: meta.symbol,
    name: meta.longName ?? meta.shortName ?? null,
    currency: meta.currency,
    exchange: meta.fullExchangeName ?? meta.exchangeName,
    firstTime: candles[0]?.time ?? null,
    lastTime: candles.at(-1)?.time ?? null,
    count: candles.length,
    candles,
  };
}
