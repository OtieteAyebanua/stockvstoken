import { getJson, sleep } from "./http.js";

const DATA_URL = "https://data.alpaca.markets/v2";
/** Assets live on the trading API; paper and live keys each work on only one of these. */
const TRADING_URLS = ["https://paper-api.alpaca.markets/v2", "https://api.alpaca.markets/v2"];
/** The free plan allows 200 requests a minute; stay a little under. */
const MIN_GAP_MS = 320;
/** Most bars Alpaca returns per page. */
const PAGE_LIMIT = 10_000;

/** One candle. Times are the bar's start, ISO 8601 UTC. */
export interface Bar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface Asset {
  symbol: string;
  name: string;
  tradable: boolean;
  attributes?: string[];
}

function headers(): Record<string, string> {
  const id = process.env.ALPACA_API_KEY_ID;
  const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!id || !secret) throw new Error("Add ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY to .env");
  return { "APCA-API-KEY-ID": id, "APCA-API-SECRET-KEY": secret };
}

/** Requests are spaced MIN_GAP_MS apart, even when several stocks are fetched at once. */
let nextSlot = 0;
async function call<T>(url: string): Promise<T> {
  const slot = Math.max(Date.now(), nextSlot);
  nextSlot = slot + MIN_GAP_MS;
  await sleep(slot - Date.now());
  return getJson<T>(url, headers());
}

/** Active US stocks that have listed options, by symbol. */
export async function optionableStocks(): Promise<Map<string, Asset>> {
  let lastError: unknown;
  for (const base of TRADING_URLS) {
    try {
      const assets = await call<Asset[]>(`${base}/assets?status=active&asset_class=us_equity`);
      return new Map(assets.filter((a) => a.tradable && a.attributes?.includes("has_options")).map((a) => [a.symbol, a]));
    } catch (err) {
      lastError = err; // wrong environment for these keys: try the other one
    }
  }
  throw lastError;
}

interface BarsPage {
  bars: Record<string, { t: string; o: number; h: number; l: number; c: number; v: number }[]> | null;
  next_page_token: string | null;
}

/**
 * Every bar for one symbol between start and end, following pages. Prices are adjusted for splits
 * and dividends; the SIP feed covers all US exchanges (free plan: not the latest 15 minutes).
 */
export async function fetchBars(
  symbol: string,
  timeframe: string,
  start: Date,
  end: Date,
  onPage?: (count: number) => void,
): Promise<Bar[]> {
  const out: Bar[] = [];
  let token: string | null = null;
  do {
    const params = new URLSearchParams({
      symbols: symbol,
      timeframe,
      start: start.toISOString(),
      end: end.toISOString(),
      limit: String(PAGE_LIMIT),
      adjustment: "all",
      feed: "sip",
      sort: "asc",
    });
    if (token) params.set("page_token", token);
    const page: BarsPage = await call<BarsPage>(`${DATA_URL}/stocks/bars?${params}`);
    for (const b of page.bars?.[symbol] ?? []) out.push({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    onPage?.(out.length);
    token = page.next_page_token;
  } while (token);
  return out;
}
