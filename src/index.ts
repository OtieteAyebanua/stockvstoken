// Fetch every 5-minute candle Alpaca has (since 2016) for the largest S&P 500 stocks that have listed
// options, one JSON file per stock in data/. Stocks already fetched are skipped, so an interrupted
// run picks up where it stopped.
//
//   npm run fetch                 the 100 largest (by market cap, from sp500.json)
//   npm run fetch -- --top 200    the 200 largest
//   npm run fetch -- AAPL TSLA    only these
//   npm run fetch -- --force      fetch again even if the file exists

import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fetchBars, optionableStocks } from "./alpaca.js";
import { dailyCloses } from "./sessions.js";

const OUT_DIR = "data";
const TIMEFRAME = "5Min";
/** Alpaca's stock history starts here. */
const START = new Date("2016-01-01T00:00:00Z");
/** The free plan can't query the latest 15 minutes of the full-market (SIP) feed. */
const FREE_PLAN_DELAY_MS = 16 * 60_000;
/** Stocks fetched at the same time. One stock alone can't use the whole rate limit, two nearly can. */
const WORKERS = 2;
/** How many of the largest stocks to fetch, unless --top or symbols are given. */
const DEFAULT_TOP = 100;

try {
  process.loadEnvFile();
} catch {
  // .env is optional if the keys are set in the environment
}
if (!process.env.ALPACA_API_KEY_ID || !process.env.ALPACA_API_SECRET_KEY) {
  console.error("Add your Alpaca keys to .env first:\n  ALPACA_API_KEY_ID=...\n  ALPACA_API_SECRET_KEY=...");
  process.exit(1);
}

interface Listing {
  symbol: string;
  name: string;
  sector: string;
  marketCap: number | null;
  /** By market cap; null for a company's second share class (e.g. GOOG next to GOOGL). */
  rank: number | null;
}

interface IndexEntry extends Listing {
  file: string;
  /** Latest and previous regular-session closes, for the watchlist's price and day change. */
  lastClose: number | null;
  prevClose: number | null;
  count: number;
  firstTime: string | null;
  lastTime: string | null;
  generatedAt: string;
}

const args = process.argv.slice(2);
const force = args.includes("--force");
const topAt = args.indexOf("--top");
const top = topAt >= 0 ? Number(args[topAt + 1]) : DEFAULT_TOP;
const only = args.filter((a, i) => !a.startsWith("--") && !(topAt >= 0 && i === topAt + 1)).map((a) => a.toUpperCase());

const sp500 = JSON.parse(await readFile("sp500.json", "utf8")) as Listing[];
const wanted = only.length
  ? sp500.filter((s) => only.includes(s.symbol))
  : sp500.filter((s) => s.rank != null && s.rank <= top).sort((a, b) => a.rank! - b.rank!);
const unknown = only.filter((s) => !sp500.some((l) => l.symbol === s));
if (unknown.length) console.warn(`Not in sp500.json, skipped: ${unknown.join(", ")}`);

console.log("Checking which stocks have options on Alpaca...");
const optionable = await optionableStocks();
const stocks = wanted.filter((s) => optionable.has(s.symbol));
const noOptions = wanted.filter((s) => !optionable.has(s.symbol));
if (noOptions.length) console.log(`No options (or not on Alpaca), skipped: ${noOptions.map((s) => s.symbol).join(", ")}`);

const end = new Date(Date.now() - FREE_PLAN_DELAY_MS);
const start = START;
console.log(`${stocks.length} stocks · ${TIMEFRAME} candles · ${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 16)}Z\n`);

await mkdir(OUT_DIR, { recursive: true });
const indexPath = join(OUT_DIR, "index.json");
const index = new Map<string, IndexEntry>(
  existsSync(indexPath)
    ? (JSON.parse(await readFile(indexPath, "utf8")) as { stocks: IndexEntry[] }).stocks.map((e) => [e.symbol, e])
    : [],
);
const saveIndex = () =>
  writeFile(
    indexPath,
    JSON.stringify({ timeframe: TIMEFRAME, generatedAt: new Date().toISOString(), stocks: [...index.values()].filter((e) => existsSync(join(OUT_DIR, e.file))).sort((a, b) => a.symbol.localeCompare(b.symbol)) }, null, 2),
  );

const fileFor = (symbol: string) => `${symbol.replace(/[^\w-]/g, "-")}.json`;
const failed: string[] = [];
const began = Date.now();
let done = 0;

async function fetchOne(i: number, stock: Listing) {
  const file = fileFor(stock.symbol);
  const path = join(OUT_DIR, file);
  const label = `[${String(i + 1).padStart(3)}/${stocks.length}] ${stock.symbol.padEnd(6)}`;
  if (!force && existsSync(path) && index.has(stock.symbol)) {
    // Keep the name, sector and size up to date even when the bars aren't fetched again.
    index.set(stock.symbol, { ...index.get(stock.symbol)!, ...stock });
    console.log(`${label} already fetched, skipping`);
    return;
  }

  try {
    const bars = await fetchBars(stock.symbol, TIMEFRAME, start, end);
    const generatedAt = new Date().toISOString();
    const entry: IndexEntry = {
      ...stock,
      file,
      ...dailyCloses(bars),
      count: bars.length,
      firstTime: bars[0]?.t ?? null,
      lastTime: bars.at(-1)?.t ?? null,
      generatedAt,
    };
    // Write to a temp file first so an interrupted run never leaves a half-written file behind.
    await writeFile(`${path}.tmp`, JSON.stringify({ ...entry, timeframe: TIMEFRAME, feed: "sip", adjustment: "all", bars }));
    await rename(`${path}.tmp`, path);
    index.set(stock.symbol, entry);
    await saveIndex();
    done++;

    const perStock = (Date.now() - began) / done;
    const left = stocks.length - next;
    console.log(`${label} ${bars.length.toLocaleString()} candles saved · ~${Math.ceil((perStock * left) / 60_000)} min left`);
  } catch (err) {
    failed.push(stock.symbol);
    console.error(`${label} failed: ${(err as Error).message}`);
  }
}

let next = 0;
await Promise.all(
  Array.from({ length: WORKERS }, async () => {
    while (next < stocks.length) {
      const i = next++;
      await fetchOne(i, stocks[i]!);
    }
  }),
);

await saveIndex();
console.log(`\nDone: ${done} fetched, ${stocks.length - done - failed.length} already had, ${failed.length} failed${failed.length ? ` (${failed.join(", ")})` : ""}.`);
if (failed.length) console.log("Run it again to retry the failed ones.");
