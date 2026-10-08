// Shapes of the JSON written by `npm run fetch` (see src/index.ts and src/alpaca.ts).

export interface StockEntry {
  symbol: string;
  name: string;
  sector: string;
  marketCap: number | null;
  /** By market cap; null for a company's second share class. */
  rank: number | null;
  file: string;
  /** Latest and previous regular-session (4 PM) closes. */
  lastClose: number | null;
  prevClose: number | null;
  count: number;
  firstTime: string | null;
  lastTime: string | null;
  generatedAt: string;
}

export interface IndexFile {
  timeframe: string;
  generatedAt: string;
  stocks: StockEntry[];
}

/** One 5-minute candle from Alpaca. `t` is the candle's start, ISO 8601 UTC. */
export interface Bar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface TickerFile extends StockEntry {
  timeframe: string;
  feed: string;
  adjustment: string;
  bars: Bar[];
}
