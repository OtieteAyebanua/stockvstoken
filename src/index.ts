import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { alignSplits, dropSpikes } from "./clean.js";
import { fetchTokenHistory, findTokens, type TokenHistory } from "./coingecko.js";
import { fetchStockHistory, type StockHistory } from "./yahoo.js";

// Stocks with live xStock and/or Ondo tokens. Override on the command line:
//   npm run fetch -- AAPL TSLA NVDA
const DEFAULT_TICKERS = [
  "AAPL", "TSLA", "NVDA", "MSFT", "GOOGL", "AMZN", "META", "NFLX", "MCD", "MU",
  "COIN", "HOOD", "MSTR", "CRCL", "SPY", "QQQ", "GLD",
];

const OUT_DIR = "data";

try {
  process.loadEnvFile();
} catch {
  // .env is optional
}

console.log(
  process.env.COINGECKO_API_KEY
    ? "CoinGecko: using Demo API key from .env"
    : "CoinGecko: no API key (slow). Add COINGECKO_API_KEY=... to .env to speed up.",
);

const args = process.argv.slice(2).map((t) => t.toUpperCase());
const tickers = args.length ? args : DEFAULT_TICKERS;

console.log(`Looking up tokenized versions of ${tickers.length} tickers on CoinGecko...`);
const tokensByTicker = await findTokens(tickers);
await mkdir(OUT_DIR, { recursive: true });

const describe = ({ count, firstTime, lastTime }: StockHistory | TokenHistory) =>
  `${count} hourly (${firstTime?.slice(0, 13)}h → ${lastTime?.slice(0, 13)}h)`;

const summary = [];

for (const ticker of tickers) {
  console.log(`\n${ticker}`);
  const errors: string[] = [];

  let stock: StockHistory | null = null;
  try {
    stock = await fetchStockHistory(ticker);
    console.log(`  stock  ${describe(stock)}`);
  } catch (err) {
    errors.push(`stock: ${(err as Error).message}`);
    console.error(`  stock  failed: ${(err as Error).message}`);
  }

  const tokens: TokenHistory[] = [];
  const matches = tokensByTicker.get(ticker) ?? [];
  if (!matches.length) console.log("  tokens none listed on CoinGecko");
  for (const { issuer, coin } of matches) {
    try {
      const token = await fetchTokenHistory(issuer, coin);
      if (stock) {
        // CoinGecko doesn't adjust token history for stock splits; put it on the stock's basis.
        token.prices = dropSpikes(alignSplits(token.prices, stock.candles));
        Object.assign(token, { count: token.prices.length, firstTime: token.prices[0]?.time ?? null, lastTime: token.prices.at(-1)?.time ?? null });
      }
      tokens.push(token);
      console.log(`  ${issuer.padEnd(6)} ${describe(token)}  (${coin.id})`);
    } catch (err) {
      errors.push(`${issuer} (${coin.id}): ${(err as Error).message}`);
      console.error(`  ${issuer.padEnd(6)} failed: ${(err as Error).message}`);
    }
  }

  const file = `${ticker.replace(/\W/g, "-")}.json`;
  await writeFile(
    join(OUT_DIR, file),
    JSON.stringify({ ticker, generatedAt: new Date().toISOString(), stock, tokens, errors }, null, 2),
  );

  summary.push({
    ticker,
    file,
    stock: stock && { symbol: stock.symbol, firstTime: stock.firstTime, lastTime: stock.lastTime, count: stock.count },
    tokens: tokens.map(({ issuer, id, symbol, firstTime, lastTime, count }) => ({
      issuer, id, symbol, firstTime, lastTime, count,
    })),
    errors,
  });
}

await writeFile(
  join(OUT_DIR, "index.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), tickers: summary }, null, 2),
);

const failed = summary.filter((s) => s.errors.length).length;
console.log(`\nWrote ${summary.length} files + index.json to ${OUT_DIR}/${failed ? ` (${failed} with errors)` : ""}`);
