import type { StockCandle, TickerFile, TokenPrice } from "./types";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

export type SeriesKey = "stock" | "xstock" | "ondo";

export const SERIES_LABEL: Record<SeriesKey, string> = {
  stock: "Stock",
  xstock: "xStock",
  ondo: "Ondo",
};

/** One OHLC candle covering [start, end] (Unix ms). */
export interface Candle {
  start: number;
  end: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** A price at a moment (Unix ms). */
export interface Point {
  t: number;
  v: number;
}

export interface TickerSeries {
  stock: { symbol: string; bars: Candle[] } | null;
  tokens: { key: "xstock" | "ondo"; symbol: string; points: Point[] }[];
}

/**
 * Yahoo stamps hourly bars with their start time; `close` is the price at the bar's end.
 * Bars last an hour, except the day's last bar (starting :30), which ends at the 4:00 PM ET
 * close half an hour later, and the in-progress bar, which ends no later than the fetch.
 */
function stockBars(candles: StockCandle[], fetchedAt: number): Candle[] {
  const starts = candles.map((c) => Date.parse(c.time));
  return candles.map((c, i) => {
    const start = starts[i]!;
    const next = starts[i + 1];
    const lastOfDay = next === undefined || next - start > 2 * HOUR;
    const end = lastOfDay && new Date(start).getUTCMinutes() === 30 ? start + HOUR / 2 : start + HOUR;
    return { start, end: Math.min(end, fetchedAt), open: c.open, high: c.high, low: c.low, close: c.close };
  });
}

const tokenPoints = (prices: TokenPrice[]): Point[] => prices.map((p) => ({ t: Date.parse(p.time), v: p.price }));

export function toSeries(file: TickerFile): TickerSeries {
  return {
    stock: file.stock && { symbol: file.stock.symbol, bars: stockBars(file.stock.candles, Date.parse(file.generatedAt)) },
    tokens: (["xstock", "ondo"] as const).flatMap((key) => {
      const token = file.tokens.find((k) => k.issuer === key);
      return token ? [{ key, symbol: token.symbol, points: tokenPoints(token.prices) }] : [];
    }),
  };
}

export function lastTime(s: TickerSeries): number {
  return Math.max(s.stock?.bars.at(-1)?.end ?? 0, ...s.tokens.map((t) => t.points.at(-1)?.t ?? 0));
}

/** Start of the bucket containing t. Weeks start on Monday (the epoch was a Thursday). */
const bucketStart = (t: number, interval: number) => {
  const offset = interval === WEEK ? 4 * DAY : 0;
  return Math.floor((t - offset) / interval) * interval + offset;
};

/** Stock candles for [from, to]: the native hourly bars, or those bars merged into bigger buckets. */
export function stockCandles(bars: Candle[], interval: number, from: number, to: number): Candle[] {
  const visible = bars.filter((b) => b.end > from && b.start < to);
  if (interval === HOUR) return visible;

  const out: Candle[] = [];
  for (const b of visible) {
    // Bucket by the bar's start so a day's bars stay together.
    const start = bucketStart(b.start, interval);
    const cur = out.at(-1);
    if (cur && cur.start === start) {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
    } else {
      out.push({ start, end: start + interval, open: b.open, high: b.high, low: b.low, close: b.close });
    }
  }
  return out;
}

/**
 * Token candles built from hourly price samples. A bucket (a, a + interval] opens at the last
 * sample at or before a, closes at its last sample, and its high/low are the extremes of the
 * samples in between — so wicks understate true intraperiod highs and lows.
 */
export function tokenCandles(points: Point[], interval: number, from: number, to: number): Candle[] {
  const out: Candle[] = [];
  let prev: number | undefined;
  let cur: Candle | undefined;

  for (const p of points) {
    if (p.t > to + interval) break;
    const start = bucketStart(p.t - 1, interval); // p.t on a boundary closes the bucket before it
    if (!cur || cur.start !== start) {
      if (cur && cur.end > from) out.push(cur);
      const open = prev ?? p.v;
      cur = { start, end: start + interval, open, high: Math.max(open, p.v), low: Math.min(open, p.v), close: p.v };
    } else {
      cur.high = Math.max(cur.high, p.v);
      cur.low = Math.min(cur.low, p.v);
      cur.close = p.v;
    }
    prev = p.v;
  }
  if (cur && cur.end > from && cur.start < to) out.push(cur);
  return out.filter((c) => c.start < to);
}

/** The candle whose span contains t, else the last one before it (flagged stale). */
export function candleAt(candles: Candle[], t: number): { candle: Candle; stale: boolean } | null {
  let lo = 0;
  let hi = candles.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]!.start <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const candle = candles[found];
  return candle ? { candle, stale: t > candle.end } : null;
}

/** ~count round-number ticks spanning [min, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  const span = max - min || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

/** A gap longer than this between stock bars means the market was closed. */
const CLOSED_MIN_GAP = 30 * 60_000;

export type Gap = [start: number, end: number];

/**
 * When the stock market was closed (nights, weekends, holidays), from gaps between hourly bars.
 * If the market is closed now, the last gap is open-ended.
 */
export function marketClosedGaps(bars: Candle[], dataEnd: number): Gap[] {
  const gaps: Gap[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1]!.end;
    const next = bars[i]!.start;
    if (next - prev > CLOSED_MIN_GAP) gaps.push([prev, next]);
  }
  const last = bars.at(-1);
  if (last && dataEnd - last.end > CLOSED_MIN_GAP) gaps.push([last.end, Infinity]);
  return gaps;
}

/**
 * Closed gaps overlapping [from, to] that are at least one candle long — shorter closures
 * (e.g. nights, at daily candles) happen inside a candle and aren't worth shading.
 */
export function visibleGaps(gaps: Gap[], interval: number, from: number, to: number): Gap[] {
  return gaps.filter(([start, end]) => end > from && start < to && end - start >= interval);
}

/** Whether t falls inside a closed gap. */
export const inGap = (gaps: Gap[], t: number) => gaps.some(([start, end]) => start <= t && t < end);

/** The candles overlapping [from, to] (candles sorted by start). */
export function sliceWindow(candles: Candle[], from: number, to: number): Candle[] {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]!.end <= from) lo = mid + 1;
    else hi = mid;
  }
  let end = lo;
  while (end < candles.length && candles[end]!.start < to) end++;
  return candles.slice(lo, end);
}

interface TickLevel {
  key: (d: Date) => string;
  label: (d: Date, dayStart: boolean) => string;
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const dayLabel = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
const hours = (n: number): TickLevel => ({
  key: (d) => `${dayKey(d)}-${Math.floor(d.getHours() / n)}`,
  label: (d, dayStart) => (dayStart ? dayLabel(d) : d.toLocaleTimeString("en-US", { hour: "numeric" })),
});

/** Finest first; an axis uses the finest level whose ticks fit. */
const TICK_LEVELS: TickLevel[] = [
  hours(1),
  hours(3),
  hours(6),
  hours(12),
  { key: dayKey, label: dayLabel },
  {
    // Every other day (by local day number), between daily and weekly.
    key: (d) => String(Math.floor((d.getTime() - d.getTimezoneOffset() * 60_000) / DAY / 2)),
    label: dayLabel,
  },
  {
    key: (d) => {
      const monday = new Date(d);
      monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      return dayKey(monday);
    },
    label: dayLabel,
  },
  {
    key: (d) => `${d.getFullYear()}-${d.getMonth()}`,
    label: (d) => (d.getMonth() === 0 ? String(d.getFullYear()) : d.toLocaleDateString("en-US", { month: "short" })),
  },
  {
    key: (d) => `${d.getFullYear()}-${Math.floor(d.getMonth() / 3)}`,
    label: (d) => (d.getMonth() === 0 ? String(d.getFullYear()) : d.toLocaleDateString("en-US", { month: "short" })),
  },
  { key: (d) => String(d.getFullYear()), label: (d) => String(d.getFullYear()) },
];

/**
 * Ticks for a time axis: a tick wherever a new hour block, day, week, month… starts inside
 * [from, to] — whichever is the finest level that fits maxTicks.
 */
export function timeAxisTicks(from: number, to: number, maxTicks: number): { t: number; label: string }[] {
  // Walk the window at a step fine enough for every level that could fit.
  const step = to - from <= 60 * DAY ? HOUR : DAY;
  const first = Math.ceil(from / step) * step;
  for (const level of TICK_LEVELS) {
    const ticks: { t: number; label: string }[] = [];
    let prev = new Date(from);
    for (let t = first; t <= to; t += step) {
      const d = new Date(t);
      if (level.key(d) !== level.key(prev)) {
        ticks.push({ t, label: level.label(d, dayKey(d) !== dayKey(prev)) });
        if (ticks.length > maxTicks) break;
      }
      prev = d;
    }
    if (ticks.length <= maxTicks) return ticks;
  }
  return [];
}

export const fmtPrice = (v: number) =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtAxisPrice = (v: number, step: number) =>
  `$${v.toLocaleString("en-US", { minimumFractionDigits: step < 1 ? 2 : 0, maximumFractionDigits: step < 1 ? 2 : 0 })}`;

export const fmtSpan = (c: Candle, interval: number) => {
  if (interval >= DAY) {
    const opts = { month: "short", day: "numeric", year: "numeric" } as const;
    return interval === DAY
      ? new Date(c.start).toLocaleDateString("en-US", opts)
      : `${new Date(c.start).toLocaleDateString("en-US", opts)} – ${new Date(c.end - 1).toLocaleDateString("en-US", opts)}`;
  }
  const time = (t: number) => new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${new Date(c.start).toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time(c.start)} – ${time(c.end)}`;
};
