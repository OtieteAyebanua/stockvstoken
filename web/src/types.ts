// Shapes of the JSON written by `npm run fetch` (see src/yahoo.ts and src/coingecko.ts).

export interface Coverage {
  firstTime: string | null;
  lastTime: string | null;
  count: number;
}

export interface IndexFile {
  generatedAt: string;
  tickers: Array<{
    ticker: string;
    file: string;
    stock: ({ symbol: string } & Coverage) | null;
    tokens: Array<{ issuer: "xstock" | "ondo"; id: string; symbol: string } & Coverage>;
    errors: string[];
  }>;
}

export interface StockCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TokenPrice {
  time: string;
  price: number;
  marketCap: number | null;
  volume: number | null;
}

export interface TickerFile {
  ticker: string;
  generatedAt: string;
  stock: ({ source: "yahoo"; symbol: string; name: string | null; currency: string; exchange: string; candles: StockCandle[] } & Coverage) | null;
  tokens: Array<{ source: "coingecko"; issuer: "xstock" | "ondo"; id: string; symbol: string; name: string; prices: TokenPrice[] } & Coverage>;
  errors: string[];
}

// The gap-fill rows written by `npm run gaps` (see src/gap-fill.ts); stats come from src/gap-stats.ts.

import type { GapRow, Night } from "../../src/gap-stats.js";

export interface GapAllFile {
  generatedAt: string;
  tickers: string[];
  closures: GapRow[];
  nights: Night[];
}
