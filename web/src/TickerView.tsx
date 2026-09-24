import { useMemo, useState } from "react";
import { CandleChart } from "./CandleChart";
import { GapAnalysis } from "./GapAnalysis";
import {
  DAY,
  fmtPrice,
  fmtSpan,
  HOUR,
  lastTime,
  marketClosedGaps,
  SERIES_LABEL,
  sliceWindow,
  stockCandles,
  tokenCandles,
  toSeries,
  WEEK,
  type Candle,
} from "./series";
import type { TickerFile } from "./types";

const RANGES = [
  { label: "1D", ms: DAY },
  { label: "1W", ms: WEEK },
  { label: "1M", ms: 30 * DAY },
  { label: "3M", ms: 91 * DAY },
  { label: "6M", ms: 182 * DAY },
  { label: "1Y", ms: 365 * DAY },
  { label: "2Y", ms: 730 * DAY },
] as const;

const INTERVALS = [
  { label: "1H", ms: HOUR },
  { label: "4H", ms: 4 * HOUR },
  { label: "1D", ms: DAY },
  { label: "1W", ms: WEEK },
] as const;

type RangeLabel = (typeof RANGES)[number]["label"];
type IntervalLabel = (typeof INTERVALS)[number]["label"];

/** Zoom limits, in candles. */
const MIN_CANDLES = 8;

export function TickerView({ file }: { file: TickerFile }) {
  const [interval, setIntervalLabel] = useState<IntervalLabel>("1H");
  const [hoverT, setHoverT] = useState<number | null>(null);

  const series = useMemo(() => toSeries(file), [file]);
  const [tokenKey, setTokenKey] = useState(series.tokens[0]?.key);
  const token = series.tokens.find((t) => t.key === tokenKey) ?? series.tokens[0];
  const intervalMs = INTERVALS.find((i) => i.label === interval)!.ms;

  // Every candle at the chosen interval; the charts window into these.
  const stock = useMemo(
    () => (series.stock ? stockCandles(series.stock.bars, intervalMs, -Infinity, Infinity) : []),
    [series, intervalMs],
  );
  const tokenC = useMemo(
    () => (token ? tokenCandles(token.points, intervalMs, -Infinity, Infinity) : []),
    [token, intervalMs],
  );

  const dataEnd = lastTime(series);

  // When the stock market was closed, from gaps in the stock's own hourly bars.
  const closedGaps = useMemo(() => (series.stock ? marketClosedGaps(series.stock.bars, lastTime(series)) : []), [series]);
  const dataStart = Math.min(stock[0]?.start ?? Infinity, tokenC[0]?.start ?? Infinity);

  // Visible time window, shared by both charts. Starts on the last week.
  const [view, setView] = useState<[number, number]>(() => [dataEnd - WEEK, dataEnd]);

  const clampView = (from: number, to: number, candleMs = intervalMs): [number, number] => {
    const span = Math.min(Math.max(to - from, MIN_CANDLES * candleMs), dataEnd - dataStart);
    const start = Math.max(dataStart, Math.min(from, dataEnd - span));
    return [start, start + span];
  };

  const zoom = (anchor: number, factor: number) =>
    setView(([from, to]) => {
      const span = to - from;
      const next = Math.min(Math.max(span * factor, MIN_CANDLES * intervalMs), dataEnd - dataStart);
      const ratio = next / span;
      return clampView(anchor - (anchor - from) * ratio, anchor + (to - anchor) * ratio);
    });

  const pan = (fraction: number) =>
    setView(([from, to]) => {
      const shift = fraction * (to - from);
      return clampView(from + shift, to + shift);
    });

  const showLast = (ms: number) => setView(clampView(dataEnd - ms, dataEnd));
  const activeRange = RANGES.find((r) => Math.abs(view[1] - dataEnd) < intervalMs && Math.abs(view[1] - view[0] - r.ms) < intervalMs)?.label;

  // Keep the window valid when the ticker or interval changes.
  const [clampedFor, setClampedFor] = useState({ file, intervalMs });
  if (clampedFor.file !== file || clampedFor.intervalMs !== intervalMs) {
    setClampedFor({ file, intervalMs });
    setView(clampView(view[0], view[1]));
  }

  const visibleStock = sliceWindow(stock, view[0], view[1]);
  const visibleToken = sliceWindow(tokenC, view[0], view[1]);
  const all = [...visibleStock, ...visibleToken];
  const lo = Math.min(...all.map((c) => c.low));
  const hi = Math.max(...all.map((c) => c.high));
  const pad = (hi - lo) * 0.06 || hi * 0.01 || 1;
  const yDomain: [number, number] = all.length ? [lo - pad, hi + pad] : [0, 1];

  const stockLast = series.stock?.bars.at(-1);
  const chartProps = { interval: intervalMs, view, yDomain, hoverT, onHover: setHoverT, onZoom: zoom, onPan: pan, closedGaps };

  return (
    <section className="ticker-view">
      <header className="ticker-header">
        <div>
          <h2>{file.ticker}</h2>
          <p className="muted">{file.stock?.name ?? file.ticker}</p>
        </div>
        <div className="toolbar">
          <div className="control">
            <span className="control-label">Show last</span>
            <Segmented
              label="Zoom to"
              options={RANGES.map((r) => ({ value: r.label, label: r.label, title: `Zoom to the last ${RANGE_WORDS[r.label]}` }))}
              value={activeRange}
              onChange={(label) => showLast(RANGES.find((r) => r.label === label)!.ms)}
            />
          </div>
          <div className="control">
            <span className="control-label">Each candle =</span>
            <Segmented
              label="Candle interval"
              options={INTERVALS.map((i) => ({ value: i.label, label: i.label, title: `Each candle covers ${INTERVAL_WORDS[i.label]}` }))}
              value={interval}
              onChange={setIntervalLabel}
            />
          </div>
        </div>
      </header>

      <Guide stockSymbol={series.stock?.symbol ?? file.ticker} tokenSymbol={token?.symbol ?? "the token"} />

      <div className="stats">
        {series.stock && stockLast && (
          <Stat
            seriesKey="stock"
            label={`${series.stock.symbol} stock`}
            value={stockLast.close}
            note={`Last trade ${fmtShort(stockLast.end)}`}
          />
        )}
        {series.tokens.map((t) => {
          const last = t.points.at(-1)!;
          // Compare with the stock at its last trade, not the token's latest tick.
          const atStock = stockLast && [...t.points].reverse().find((p) => p.t <= stockLast.end);
          return (
            <Stat
              key={t.key}
              seriesKey={t.key}
              label={`${t.symbol} token (${SERIES_LABEL[t.key]})`}
              value={last.v}
              note={atStock && stockLast ? premiumWords(atStock.v, stockLast.close) : `Updated ${fmtShort(last.t)}`}
            />
          );
        })}
      </div>

      <div className="hint muted">
        <span>Scroll on a chart to zoom · drag to move through time · both charts move together</span>
        <span className="chart-key">
          <span><span className="candle-icon up" /> Price rose</span>
          <span><span className="candle-icon down" /> Price fell</span>
          <span><span className="swatch-band" /> US market closed (the stock can't trade)</span>
        </span>
      </div>

      <div className="charts">
        {series.stock ? (
          <CandleChart
            title={`Real stock · ${series.stock.symbol}`}
            subtitle="Trades weekdays 9:30 AM – 4 PM New York time"
            series="stock"
            symbol={series.stock.symbol}
            candles={stock}
            {...chartProps}
          />
        ) : (
          <div className="chart chart-missing">No stock data</div>
        )}
        {token ? (
          <CandleChart
            title={`Token · ${token.symbol}`}
            subtitle="Trades 24/7 on crypto markets"
            controls={
              series.tokens.length > 1 && (
                <Segmented
                  label="Token"
                  options={series.tokens.map((t) => ({ value: t.key, label: SERIES_LABEL[t.key], keyClass: `key-${t.key}` }))}
                  value={token.key}
                  onChange={setTokenKey}
                />
              )
            }
            series={token.key}
            symbol={token.symbol}
            candles={tokenC}
            {...chartProps}
          />
        ) : (
          <div className="chart chart-missing">No tokenized versions on CoinGecko</div>
        )}
      </div>

      {token && (
        <GapAnalysis
          ticker={file.ticker}
          issuer={token.key}
          stockSymbol={series.stock?.symbol ?? file.ticker}
          tokenSymbol={token.symbol}
          view={view}
          rangeText={activeRange ? `the last ${RANGE_WORDS[activeRange]}` : fmtRange(view[0], view[1])}
        />
      )}

      <CandleTable
        interval={intervalMs}
        intervalLabel={interval}
        columns={[
          ...(series.stock ? [{ label: series.stock.symbol, candles: visibleStock }] : []),
          ...(token ? [{ label: token.symbol, candles: visibleToken }] : []),
        ]}
      />
    </section>
  );
}

const fmtShort = (t: number) =>
  new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const fmtDay = (t: number, year: boolean) =>
  new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}) });
const fmtRange = (from: number, to: number) =>
  `${fmtDay(from, new Date(from).getFullYear() !== new Date(to).getFullYear())} – ${fmtDay(to, true)}`;

const RANGE_WORDS: Record<string, string> = { "1D": "day", "1W": "week", "1M": "month", "3M": "3 months", "6M": "6 months", "1Y": "year", "2Y": "2 years" };
const INTERVAL_WORDS: Record<string, string> = { "1H": "1 hour", "4H": "4 hours", "1D": "1 day", "1W": "1 week" };

const premiumWords = (token: number, stock: number) => {
  const d = ((token - stock) / stock) * 100;
  if (Math.abs(d) < 0.05) return "Same price as the stock";
  return `${Math.abs(d).toFixed(2)}% ${d > 0 ? "above" : "below"} the stock's last trade`;
};

const GUIDE_KEY = "guide-dismissed";

/** A short "how to read this page", dismissible (remembered in this browser only). */
function Guide({ stockSymbol, tokenSymbol }: { stockSymbol: string; tokenSymbol: string }) {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(GUIDE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggle = (next: boolean) => {
    setHidden(next);
    try {
      localStorage.setItem(GUIDE_KEY, next ? "1" : "0");
    } catch {
      // storage blocked: just don't remember it
    }
  };
  if (hidden) {
    return (
      <button className="guide-reopen" onClick={() => toggle(false)}>
        ? How to read this page
      </button>
    );
  }
  return (
    <aside className="guide">
      <div className="guide-head">
        <strong>How to read this page</strong>
        <button onClick={() => toggle(true)} aria-label="Hide guide">
          Hide
        </button>
      </div>
      <ol>
        <li>
          <b>Left chart:</b> the real {stockSymbol} stock. It only trades when the US market is open (weekdays 9:30 AM – 4 PM New
          York time).
        </li>
        <li>
          <b>Right chart:</b> {tokenSymbol}, a token that tracks {stockSymbol} but trades <b>24/7</b>, including nights and
          weekends.
        </li>
        <li>
          <b>Green zones</b> mark when the US market is closed. The stock is frozen there, but the token keeps moving, so you can
          see where the stock "should" open.
        </li>
        <li>
          <b>Below the charts:</b> how often the stock actually follows the token's overnight move, and whether it later comes
          back to where it closed.
        </li>
      </ol>
    </aside>
  );
}

function Stat({ seriesKey, label, value, note }: { seriesKey: string; label: string; value: number; note: string }) {
  return (
    <div className="stat">
      <div className="stat-label">
        <span className={`key key-${seriesKey}`} />
        {label}
      </div>
      <div className="stat-value">{fmtPrice(value)}</div>
      <div className="stat-note muted">{note}</div>
    </div>
  );
}

interface Option<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  title?: string;
  keyClass?: string;
}

function Segmented<T extends string>({ label, options, value, onChange }: { label: string; options: Option<T>[]; value: T | undefined; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          aria-pressed={o.value === value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.keyClass && <span className={`key ${o.keyClass}`} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

const MAX_ROWS = 1000;

/** The candles on screen as a table: one row per period, OHLC per series. */
function CandleTable({ columns, interval, intervalLabel }: { columns: { label: string; candles: Candle[] }[]; interval: number; intervalLabel: string }) {
  const [open, setOpen] = useState(false);

  const rows = useMemo(() => {
    if (!open) return [];
    const byStart = new Map<number, (Candle | undefined)[]>();
    columns.forEach((col, i) => {
      for (const c of col.candles) {
        const row = byStart.get(c.start) ?? Array<Candle | undefined>(columns.length).fill(undefined);
        row[i] = c;
        byStart.set(c.start, row);
      }
    });
    return [...byStart.entries()].sort(([a], [b]) => b - a);
  }, [open, columns]);
  const shown = rows.slice(0, MAX_ROWS);

  return (
    <details className="table-view" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Data table ({intervalLabel} candles in view)</summary>
      {open && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th rowSpan={2}>Period</th>
                {columns.map((c) => (
                  <th key={c.label} colSpan={4} className="group">
                    {c.label}
                  </th>
                ))}
              </tr>
              <tr>
                {columns.flatMap((c) => ["Open", "High", "Low", "Close"].map((h) => <th key={c.label + h} className="num">{h}</th>))}
              </tr>
            </thead>
            <tbody>
              {shown.map(([start, cells]) => {
                const any = cells.find(Boolean)!;
                return (
                  <tr key={start}>
                    <td>{fmtSpan(any, interval)}</td>
                    {cells.flatMap((c, i) =>
                      (["open", "high", "low", "close"] as const).map((k) => (
                        <td key={`${i}${k}`} className="num">
                          {c ? fmtPrice(c[k]) : "—"}
                        </td>
                      )),
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length > MAX_ROWS && (
            <p className="muted table-note">
              Showing the latest {MAX_ROWS.toLocaleString()} of {rows.length.toLocaleString()} candles in view. Zoom in to see earlier ones.
            </p>
          )}
        </div>
      )}
    </details>
  );
}
