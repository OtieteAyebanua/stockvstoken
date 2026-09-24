import { dropSpikes } from "./clean.js";
import { getJson, sleep } from "./http.js";

export type Issuer = "xstock" | "ondo";

export interface TokenPrice {
  /** Sample time, ISO 8601 UTC. */
  time: string;
  price: number;
  marketCap: number | null;
  /** Rolling 24h volume at this time. */
  volume: number | null;
}

export interface TokenHistory {
  source: "coingecko";
  issuer: Issuer;
  id: string;
  symbol: string;
  name: string;
  firstTime: string | null;
  lastTime: string | null;
  count: number;
  prices: TokenPrice[];
}

interface Coin {
  id: string;
  symbol: string;
  name: string;
}

type Series = [number, number][];
interface MarketChart {
  prices: Series;
  market_caps: Series;
  total_volumes: Series;
}

const BASE = "https://api.coingecko.com/api/v3";
const DAY = 86400;
/** The free public API allows 365 days of history; `max` is paid-only. */
const DAYS = 365;
/** Ranges of 2–90 days come back hourly; longer ranges are downsampled to daily. */
const HOURLY_WINDOW_DAYS = 89;

let lastCall = 0;
async function cg<T>(path: string): Promise<T> {
  // Optional free "Demo" key from coingecko.com raises the rate limit (30/min vs ~10/min).
  const key = process.env.COINGECKO_API_KEY;
  const gapMs = key ? 2100 : 6000;
  const wait = lastCall + gapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  return getJson<T>(`${BASE}${path}`, key ? { "x-cg-demo-api-key": key } : {});
}

const ISSUERS: Record<Issuer, { suffix: string; name: RegExp }> = {
  xstock: { suffix: "X", name: /xstock/i },
  ondo: { suffix: "ON", name: /ondo tokenized/i },
};

/** Map each ticker to its xStock and Ondo coins, using CoinGecko's full coin list. */
export async function findTokens(tickers: string[]): Promise<Map<string, { issuer: Issuer; coin: Coin }[]>> {
  const coins = (await cg<Coin[]>("/coins/list")).filter((c) => !/wrapped/i.test(c.name));
  const found = new Map<string, { issuer: Issuer; coin: Coin }[]>();

  for (const ticker of tickers) {
    const matches: { issuer: Issuer; coin: Coin }[] = [];
    for (const [issuer, { suffix, name }] of Object.entries(ISSUERS) as [Issuer, (typeof ISSUERS)[Issuer]][]) {
      const coin = coins.find((c) => c.symbol.toUpperCase() === ticker + suffix && name.test(c.name));
      if (coin) matches.push({ issuer, coin });
    }
    found.set(ticker, matches);
  }
  return found;
}

/** Hourly prices for the last 365 days, fetched in windows short enough to stay hourly. */
export async function fetchTokenHistory(issuer: Issuer, coin: Coin): Promise<TokenHistory> {
  const now = Math.floor(Date.now() / 1000);
  const byTime = new Map<number, TokenPrice>();

  // Start a day inside the 365-day limit so the first window isn't rejected.
  for (let from = now - (DAYS - 1) * DAY; from < now; from += HOURLY_WINDOW_DAYS * DAY) {
    const to = Math.min(from + HOURLY_WINDOW_DAYS * DAY, now);
    const data = await cg<MarketChart>(`/coins/${coin.id}/market_chart/range?vs_currency=usd&from=${from}&to=${to}`);
    data.prices.forEach(([ms, price], i) => {
      byTime.set(ms, {
        time: new Date(ms).toISOString(),
        price,
        marketCap: data.market_caps[i]?.[1] ?? null,
        volume: data.total_volumes[i]?.[1] ?? null,
      });
    });
  }
  const prices = dropSpikes([...byTime.entries()].sort(([a], [b]) => a - b).map(([, p]) => p));

  return {
    source: "coingecko",
    issuer,
    id: coin.id,
    symbol: coin.symbol.toUpperCase(),
    name: coin.name,
    firstTime: prices[0]?.time ?? null,
    lastTime: prices.at(-1)?.time ?? null,
    count: prices.length,
    prices,
  };
}
