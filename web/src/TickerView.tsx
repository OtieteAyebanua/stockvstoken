import { useRef, useState } from "react";
import { CandleChart } from "./CandleChart";
import { GapStats } from "./GapStats";
import {
  aggregate,
  clampView,
  DAY,
  fmtChange,
  fmtPrice,
  HOUR,
  indexAtTime,
  latestView,
  MINUTE,
  RIGHT_PAD,
  toCandles,
  WEEK,
  type Candle,
  type View,
} from "./series";
import type { TickerFile } from "./types";

const TIMEFRAMES = [
  { label: "5m", name: "5 minutes", ms: 5 * MINUTE },
  { label: "15m", name: "15 minutes", ms: 15 * MINUTE },
  { label: "30m", name: "30 minutes", ms: 30 * MINUTE },
  { label: "1h", name: "1 hour", ms: HOUR },
  { label: "4h", name: "4 hours", ms: 4 * HOUR },
  { label: "D", name: "1 day", ms: DAY },
  { label: "W", name: "1 week", ms: WEEK },
] as const;
type Timeframe = (typeof TIMEFRAMES)[number]["label"];

/** Like TradingView's bottom bar: each range picks a candle size that suits it. */
const RANGES: { label: string; name: string; timeframe: Timeframe; start: (c: Candle[]) => number }[] = [
  { label: "1D", name: "Last trading day", timeframe: "5m", start: (c) => tradingDaysBack(c, 1) },
  { label: "5D", name: "Last 5 trading days", timeframe: "15m", start: (c) => tradingDaysBack(c, 5) },
  { label: "1M", name: "Last month", timeframe: "30m", start: (c) => since(c, 30 * DAY) },
  { label: "3M", name: "Last 3 months", timeframe: "1h", start: (c) => since(c, 91 * DAY) },
  { label: "6M", name: "Last 6 months", timeframe: "4h", start: (c) => since(c, 182 * DAY) },
  { label: "YTD", name: "Year to date", timeframe: "D", start: (c) => c.findIndex((x) => x.ny.year === c.at(-1)?.ny.year) },
  { label: "1Y", name: "Last year", timeframe: "D", start: (c) => since(c, 365 * DAY) },
  { label: "5Y", name: "Last 5 years", timeframe: "W", start: (c) => since(c, 1826 * DAY) },
  { label: "All", name: "All data", timeframe: "W", start: () => 0 },
];

/** Index of the first candle of the last `n` trading days. */
function tradingDaysBack(candles: Candle[], n: number): number {
  let days = 0;
  for (let i = candles.length - 1; i > 0; i--) {
    if (candles[i]!.day !== candles[i - 1]!.day && ++days === n) return i;
  }
  return 0;
}
const since = (candles: Candle[], ms: number) => indexAtTime(candles, (candles.at(-1)?.end ?? 0) - ms);

/** Candles shown when opening a stock or changing the timeframe. */
const DEFAULT_VISIBLE = 160;

export function TickerView({ file }: { file: TickerFile }) {
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const [extended, setExtended] = useState(false);
  const [range, setRange] = useState<string | null>(null);

  // Candles per (hours, timeframe), built on first use and kept for this stock.
  const cache = useRef({ file, map: new Map<string, Candle[]>() });
  if (cache.current.file !== file) cache.current = { file, map: new Map() };
  const candlesFor = (tf: Timeframe, ext: boolean): Candle[] => {
    const { map } = cache.current;
    const base = `${ext}`;
    if (!map.has(base)) map.set(base, toCandles(file, ext));
    const key = `${ext}|${tf}`;
    if (!map.has(key)) map.set(key, aggregate(map.get(base)!, TIMEFRAMES.find((t) => t.label === tf)!.ms));
    return map.get(key)!;
  };

  const candles = candlesFor(timeframe, extended);
  const tfMs = TIMEFRAMES.find((t) => t.label === timeframe)!.ms;

  const [view, setView] = useState<View>(() => latestView(candles.length, DEFAULT_VISIBLE));
  // A new stock opens on its latest candles.
  const [viewFile, setViewFile] = useState(file);
  if (viewFile !== file) {
    setViewFile(file);
    setRange(null);
    setView(latestView(candles.length, DEFAULT_VISIBLE));
  }

  /** Switch candles, keeping the same moment at the right edge (or staying on the latest candles). */
  const switchTo = (tf: Timeframe, ext: boolean) => {
    const next = candlesFor(tf, ext);
    const atLatest = view[1] >= candles.length;
    const rightTime = candles[Math.min(Math.max(Math.floor(view[1]) - 1, 0), candles.length - 1)]?.end ?? 0;
    const right = indexAtTime(next, rightTime);
    setTimeframe(tf);
    setExtended(ext);
    setRange(null);
    setView(atLatest ? latestView(next.length, DEFAULT_VISIBLE) : clampView([right - DEFAULT_VISIBLE, right], next.length));
  };

  const pickRange = (r: (typeof RANGES)[number]) => {
    const next = candlesFor(r.timeframe, extended);
    setTimeframe(r.timeframe);
    setRange(r.label);
    setView(clampView([Math.max(0, r.start(next)), next.length + RIGHT_PAD], next.length));
  };

  // Price now and the day's change, from 5-minute candles: last close vs the previous trading day's close.
  const bars = candlesFor("5m", extended);
  const last = bars.at(-1);
  const prevDayClose = last && bars.findLast((b) => b.day !== last.day)?.close;
  const dayUp = last != null && prevDayClose != null && last.close >= prevDayClose;

  return (
    <section className="ticker-view">
      <header className="ticker-header">
        <div className="ticker-id">
          <h2>{file.symbol}</h2>
          <span className="muted">{file.name}</span>
          <span className="sector">{file.sector}</span>
        </div>
        {last && (
          <div className="quote">
            <span className="quote-price">{fmtPrice(last.close)}</span>
            {prevDayClose != null && <span className={`quote-change ${dayUp ? "up" : "down"}`}>{fmtChange(prevDayClose, last.close)}</span>}
            <span className="muted small">USD · last day in the data</span>
          </div>
        )}
      </header>

      <div className="toolbar" role="toolbar" aria-label="Chart settings">
        <div className="tf-group" role="group" aria-label="Candle size">
          {TIMEFRAMES.map((t) => (
            <button key={t.label} aria-pressed={t.label === timeframe} title={`Each candle = ${t.name}`} onClick={() => switchTo(t.label, extended)}>
              {t.label}
            </button>
          ))}
        </div>
        <span className="toolbar-sep" />
        <label className="switch" title="Show pre-market (from 4 AM) and after-hours (to 8 PM) trading">
          <input type="checkbox" checked={extended} onChange={(e) => switchTo(timeframe, e.target.checked)} />
          <span className="switch-track" aria-hidden />
          Extended hours
        </label>
      </div>

      <CandleChart
        symbol={file.symbol}
        intervalLabel={timeframe}
        candles={candles}
        interval={tfMs}
        view={view}
        onView={(v) => {
          setView(v);
          setRange(null);
        }}
        onReset={() => {
          setRange(null);
          setView(latestView(candles.length, DEFAULT_VISIBLE));
        }}
      />

      <footer className="range-bar">
        <div className="range-group" role="group" aria-label="Date range">
          {RANGES.map((r) => (
            <button key={r.label} aria-pressed={r.label === range} title={`${r.name} (${r.timeframe} candles)`} onClick={() => pickRange(r)}>
              {r.label}
            </button>
          ))}
        </div>
        <span className="muted small gap-key">
          <span className="gap-swatch" aria-hidden /> Gap from market close
        </span>
        <span className="muted small range-hint">Scroll to zoom · drag to move · double-click for latest · New York time</span>
      </footer>

      <GapStats daily={candlesFor("D", extended)} extended={extended} />
    </section>
  );
}
