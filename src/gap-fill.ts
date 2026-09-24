// Gap-fill study: while the US market is closed, tokenized stocks keep trading and move. When the
// market reopens, how often does the stock trade back to its prior close?
//
// The gap is the token's own move during the closure (its price just before the reopen vs. at the
// close). Measuring it against the stock's close instead would count the token's steady premium or
// discount to the stock (e.g. MCD xStock trades ~1% above MCD) as a gap.
//
//   npm run gaps              all tickers in data/
//   npm run gaps -- AAPL TSLA only these

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { alignSplits, dropSpikes } from "./clean.js";
import { HORIZONS, SIZE_BUCKETS, hedgeStats, summarize, type GapRow, type Night } from "./gap-stats.js";

const DATA_DIR = "data";
/** Per-ticker results + all.json, served to the UI as /analysis/gaps/*.json. */
const OUT_DIR = join(DATA_DIR, "analysis", "gaps");

const HOUR = 3_600_000;
/** Token moves smaller than this aren't a gap. */
const MIN_GAP = 0.001;
/** The token price used for "just before the open" must be at most this old. */
const MAX_TOKEN_STALENESS = 2 * HOUR;
/** A closure where the token moved, with the detail behind the stats' fields. */
interface Closure extends GapRow {
  closedAt: string;
  /** Stock close before the closure. */
  close: number;
  /** Token price at the close and just before the reopen. */
  tokenAtClose: number;
  tokenBeforeOpen: number;
  /** Stock's first trade after reopening. */
  stockOpen: number;
  stockGap: number;
  /** Stock already at or through the close on the opening print. */
  filledAtOpen: boolean;
  /** Filled within N sessions after reopening (index-aligned with HORIZONS). */
  filledWithin: boolean[];
}

interface Bar {
  start: number;
  end: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface TickerFile {
  ticker: string;
  stock: { candles: { time: string; open: number; high: number; low: number; close: number }[] } | null;
  tokens: { issuer: "xstock" | "ondo"; symbol: string; prices: { time: string; price: number }[] }[];
}

/** Yahoo bars start at :30; a session's last bar ends at the 4:00 PM close, half an hour in. */
function toBars(candles: NonNullable<TickerFile["stock"]>["candles"]): Bar[][] {
  const bars = candles.map((c) => ({ ...c, start: Date.parse(c.time), end: 0 }));
  const sessions: Bar[][] = [];
  bars.forEach((b, i) => {
    const next = bars[i + 1];
    const lastOfSession = !next || next.start - b.start > 2 * HOUR;
    b.end = b.start + (lastOfSession && new Date(b.start).getUTCMinutes() === 30 ? HOUR / 2 : HOUR);
    if (i === 0 || b.start - bars[i - 1]!.start > 2 * HOUR) sessions.push([]);
    sessions.at(-1)!.push(b);
  });
  return sessions;
}

/** Index of the last point at or before t, or -1. */
function lastAtOrBefore(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

function analyzeTicker(file: TickerFile): { closures: Closure[]; nights: Night[] } {
  if (!file.stock) return { closures: [], nights: [] };
  const sessions = toBars(file.stock.candles);
  const out: Closure[] = [];
  const nights: Night[] = [];

  for (const token of file.tokens) {
    // Files fetched before cleaning may still hold unadjusted splits and bad ticks.
    const clean = dropSpikes(alignSplits(token.prices, file.stock.candles));
    const times = clean.map((p) => Date.parse(p.time));
    const prices = clean.map((p) => p.price);

    for (let k = 0; k + 1 < sessions.length; k++) {
      const before = sessions[k]!.at(-1)!;
      const after = sessions[k + 1]!;
      const reopen = after[0]!;
      const closedAt = before.end;

      // Need fresh token prices at the close and just before the reopen.
      const i = lastAtOrBefore(times, closedAt);
      const j = lastAtOrBefore(times, reopen.start);
      if (i < 0 || closedAt - times[i]! > MAX_TOKEN_STALENESS) continue;
      if (j <= i || reopen.start - times[j]! > MAX_TOKEN_STALENESS) continue;

      const close = before.close;
      const tokenAtClose = prices[i]!;
      const tokenBeforeOpen = prices[j]!;
      const tokenGap = (tokenBeforeOpen - tokenAtClose) / tokenAtClose;
      const kind = reopen.start - closedAt > 24 * HOUR ? "weekend/holiday" : "overnight";
      nights.push({
        ticker: file.ticker,
        issuer: token.issuer,
        kind,
        closedAt: new Date(closedAt).toISOString(),
        tokenMove: tokenGap,
        stockGap: (reopen.open - close) / close,
      });
      if (Math.abs(tokenGap) < MIN_GAP) continue;
      const up = tokenGap > 0;

      const stockGapped = up ? reopen.open > close : reopen.open < close;

      // Fill = the stock trades back to the close: its low reaches it after a gap up, its high after a gap down.
      const touches = (b: Bar) => (up ? b.low <= close : b.high >= close);
      const following = sessions.slice(k + 1, k + 1 + HORIZONS.at(-1)!);
      const fillIndex = following.findIndex((s) => s.some(touches));
      const fillDay = fillIndex < 0 ? null : fillIndex + 1;
      const filledWithin = HORIZONS.map((n) => fillDay != null && fillDay <= n);
      const fillBar = following.flat().find(touches);

      out.push({
        ticker: file.ticker,
        issuer: token.issuer,
        kind,
        closedAt: new Date(closedAt).toISOString(),
        reopenedAt: new Date(reopen.start).toISOString(),
        close,
        tokenAtClose,
        tokenBeforeOpen,
        tokenGap,
        stockOpen: reopen.open,
        stockGap: (reopen.open - close) / close,
        openAgreed: Math.sign(reopen.open - close) === Math.sign(tokenGap),
        filledAtOpen: up ? reopen.open <= close : reopen.open >= close,
        stockGapped,
        filledWithin,
        fillDay,
        sessionsAfter: sessions.length - (k + 1),
        // Hourly bars: the fill happened somewhere inside this bar, so round up to its end.
        hoursToFill: fillBar ? Math.max(0, (fillBar.end - reopen.start) / HOUR) : null,
      });
    }
  }
  return { closures: out, nights };
}

const fmt = (x: number | null, digits = 1) => (x == null ? "—" : `${(x * 100).toFixed(digits)}%`);

function table(title: string, groups: [string, Closure[]][]) {
  console.log(`\n${title}`);
  console.table(
    Object.fromEntries(
      groups
        .filter(([, rows]) => rows.length)
        .map(([k, rows]) => {
          const s = summarize(rows);
          return [
            k,
            {
              gaps: s.gaps,
              medianGap: fmt(s.medianGap, 2),
              openedSameWay: fmt(s.openedSameWay),
              realGaps: s.realGaps,
              ...Object.fromEntries(s.filledWithin.map((w) => [w.days === 1 ? "sameDay" : `${w.days}d`, fmt(w.share)])),
              medianHoursToFill: s.medianHoursToFill,
            },
          ];
        }),
    ),
  );
}

// --- main ---

const args = process.argv.slice(2).map((t) => t.toUpperCase());
const files = (await readdir(DATA_DIR)).filter((f) => f.endsWith(".json") && f !== "index.json");
const tickers = files.map((f) => f.replace(/\.json$/, "")).filter((t) => !args.length || args.includes(t));

const byTicker = new Map<string, Closure[]>();
const nightsByTicker = new Map<string, Night[]>();
for (const t of tickers) {
  const file = JSON.parse(await readFile(join(DATA_DIR, `${t}.json`), "utf8")) as TickerFile;
  const { closures, nights } = analyzeTicker(file);
  byTicker.set(t, closures);
  nightsByTicker.set(t, nights);
}
const all = [...byTicker.values()].flat();
const allNights = [...nightsByTicker.values()].flat();
const xstock = all.filter((r) => r.issuer === "xstock");
const ondo = all.filter((r) => r.issuer === "ondo");

console.log(
  `Gap fill: the token's move while the market was closed. A gap is "filled" when the stock trades back\n` +
    `to its prior close after reopening. Fill rates are of "real" gaps: the stock opened past its close in the token's direction.\n` +
    `Tickers: ${tickers.join(", ")}. Token moves under ${MIN_GAP * 100}% ignored.`,
);
table("By token", [
  ["xStock", xstock],
  ["Ondo", ondo],
]);
table("xStock · by closure type", [
  ["overnight", xstock.filter((r) => r.kind === "overnight")],
  ["weekend/holiday", xstock.filter((r) => r.kind === "weekend/holiday")],
]);
table(
  "xStock · by gap size",
  SIZE_BUCKETS.map(({ label, min, max }) => [label, xstock.filter((r) => Math.abs(r.tokenGap) >= min && Math.abs(r.tokenGap) < max)]),
);
table(
  "xStock · by ticker",
  tickers.map((t) => [t, xstock.filter((r) => r.ticker === t)]),
);

console.log("\nHedge: hold the stock, offset it 1:1 with the xStock while the market is closed (all closures)");
console.table(
  Object.fromEntries(
    [["All stocks", allNights] as const, ...tickers.map((t) => [t, nightsByTicker.get(t)!] as const)].map(([k, ns]) => {
      const h = hedgeStats(ns.filter((r) => r.issuer === "xstock"));
      return [
        k,
        h && {
          nights: h.nights,
          correlation: h.correlation.toFixed(2),
          bestRatio: h.beta.toFixed(2),
          riskRemoved: fmt(h.riskRemoved, 0),
          typicalJump: fmt(h.typicalJump, 2),
          leftAfterHedge: fmt(h.typicalLeftOver, 2),
        },
      ];
    }),
  ),
);

// Raw rows for the UI, which computes the stats for whatever time range the charts show: one file
// per ticker, plus every ticker's rows in all.json for the average-stock comparison.
const method = {
  gap: "the token's move while the market was closed: its price just before the reopen vs. at the close",
  realGap: "the stock opened past its prior close in the token's direction",
  fill: "the stock's hourly low (gap up) or high (gap down) reaches its prior close after reopening",
  minGap: MIN_GAP,
  horizonsInSessions: HORIZONS,
};
const generatedAt = new Date().toISOString();
/** Just the fields the stats use, rounded, to keep all.json small. */
const round = (x: number) => Math.round(x * 1e6) / 1e6;
const gapRow = (r: Closure): GapRow => ({
  ticker: r.ticker,
  issuer: r.issuer,
  kind: r.kind,
  reopenedAt: r.reopenedAt,
  tokenGap: round(r.tokenGap),
  openAgreed: r.openAgreed,
  stockGapped: r.stockGapped,
  fillDay: r.fillDay,
  sessionsAfter: r.sessionsAfter,
  hoursToFill: r.hoursToFill,
});
const nightRow = (n: Night): Night => ({ ...n, tokenMove: round(n.tokenMove), stockGap: round(n.stockGap) });

await mkdir(OUT_DIR, { recursive: true });
for (const [ticker, rows] of byTicker) {
  const nights = nightsByTicker.get(ticker)!.map(nightRow);
  await writeFile(join(OUT_DIR, `${ticker}.json`), JSON.stringify({ ticker, generatedAt, method, closures: rows, nights }));
}
// Only overwrite the all-stocks file on a full run.
if (!args.length) {
  await writeFile(join(OUT_DIR, "all.json"), JSON.stringify({ generatedAt, method, tickers, closures: all.map(gapRow), nights: allNights.map(nightRow) }));
}
console.log(`\nWrote ${byTicker.size} ticker files${args.length ? "" : " + all.json"} to ${OUT_DIR}/`);
