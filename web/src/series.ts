import type { TickerFile } from "./types";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

/** Length of one candle in the data files. */
const BAR = 5 * MINUTE;
/** Regular session, in minutes after midnight New York time. */
const REGULAR_OPEN = 9 * 60 + 30;
const REGULAR_CLOSE = 16 * 60;

/** New York wall-clock time of a candle's start. All times on the chart are New York (exchange) time. */
export interface NyTime {
  year: number;
  /** 0 = January. */
  month: number;
  date: number;
  /** 0 = Sunday. */
  weekday: number;
  /** Minutes after midnight. */
  minutes: number;
}

/** One OHLCV candle covering [start, end) (Unix ms). */
export interface Candle {
  start: number;
  end: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ny: NyTime;
  /** The trading day, as YYYYMMDD. */
  day: number;
}

const nyParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
});
/** How far New York is behind UTC (ms) on each UTC date. Trading never spans a DST switch, which happens early on a Sunday. */
const offsetByDate = new Map<string, number>();
function nyOffset(t: number): number {
  const date = new Date(t).toISOString().slice(0, 10);
  let offset = offsetByDate.get(date);
  if (offset === undefined) {
    const noon = Date.parse(`${date}T12:00:00Z`);
    const p = Object.fromEntries(nyParts.formatToParts(noon).map((x) => [x.type, Number(x.value)]));
    offset = noon - Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!);
    offsetByDate.set(date, offset);
  }
  return offset;
}

/** The file's 5-minute candles; pre-market and after-hours ones only if `extended`. */
export function toCandles(file: TickerFile, extended: boolean): Candle[] {
  const out: Candle[] = [];
  for (const b of file.bars) {
    const start = Date.parse(b.t);
    const ny = new Date(start - nyOffset(start)); // New York wall-clock time, read with UTC getters
    const minutes = ny.getUTCHours() * 60 + ny.getUTCMinutes();
    if (!extended && (minutes < REGULAR_OPEN || minutes >= REGULAR_CLOSE)) continue;
    const year = ny.getUTCFullYear();
    const month = ny.getUTCMonth();
    const date = ny.getUTCDate();
    out.push({
      start,
      end: start + BAR,
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: b.v,
      ny: { year, month, date, weekday: ny.getUTCDay(), minutes },
      day: year * 10000 + (month + 1) * 100 + date,
    });
  }
  return out;
}

/** Days since the epoch for a New York date, for week arithmetic. */
const dayNumber = (ny: NyTime) => Math.round(Date.UTC(ny.year, ny.month, ny.date) / DAY);

/**
 * Candles of `interval` built from 5-minute ones. Intraday candles count from the 9:30 open, like
 * TradingView (9:30, 10:30, … for 1H; 9:30 and 1:30 for 4H); a daily candle is one trading day and
 * a weekly one starts on Monday.
 */
export function aggregate(bars: Candle[], interval: number): Candle[] {
  if (interval <= BAR) return bars;
  const out: Candle[] = [];
  let key = NaN;
  for (const b of bars) {
    let k: number;
    let bucketStart = b.start;
    if (interval >= WEEK) k = dayNumber(b.ny) - ((b.ny.weekday + 6) % 7);
    else if (interval >= DAY) k = b.day;
    else {
      const open = b.start - (b.ny.minutes - REGULAR_OPEN) * MINUTE;
      bucketStart = open + Math.floor((b.start - open) / interval) * interval;
      k = bucketStart;
    }
    const cur = out.at(-1);
    if (cur && k === key) {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
      cur.end = b.end;
    } else {
      const ny = { ...b.ny, minutes: b.ny.minutes - (b.start - bucketStart) / MINUTE };
      out.push({ ...b, start: bucketStart, ny });
      key = k;
    }
  }
  return out;
}

// --- view: a window over candle indices ---

/** Visible candle range [from, to) in fractional candle indices; candle i spans [i, i + 1). */
export type View = [number, number];

export const MIN_VISIBLE = 12;
/** Drawing more than this many candles gets slow and unreadable; long ranges use bigger candles instead. */
export const MAX_VISIBLE = 2500;
/** Empty candle slots kept right of the last candle, like TradingView. */
export const RIGHT_PAD = 6;

/** Keep a view a sensible size, with candles always on screen. */
export function clampView([from, to]: View, count: number): View {
  const span = Math.min(Math.max(to - from, MIN_VISIBLE), MAX_VISIBLE);
  const start = Math.min(Math.max(from, -span * 0.5), count + RIGHT_PAD - span * 0.5);
  return [start, start + span];
}

/** The last `visible` candles, with the usual empty space on the right. */
export const latestView = (count: number, visible: number): View => clampView([count - visible, count + RIGHT_PAD], count);

/** Index of the first candle starting at or after t (count if none). */
export function indexAtTime(candles: Candle[], t: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]!.start < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// --- axes ---

/** ~count round-number ticks spanning [min, max]. */
export function niceTicks(min: number, max: number, count = 6): number[] {
  const span = max - min || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

interface TickLevel {
  key: (c: Candle) => number;
  label: (c: Candle, prev: Candle) => string;
}

/** Day-of-month, or the month/year when that changes too. */
const calendarLabel = (c: Candle, prev: Candle) =>
  c.ny.year !== prev.ny.year ? String(c.ny.year) : c.ny.month !== prev.ny.month ? MONTHS[c.ny.month]! : String(c.ny.date);

const everyMinutes = (n: number): TickLevel => ({
  key: (c) => c.day * 10_000 + Math.floor(c.ny.minutes / n),
  label: (c, prev) => (c.day !== prev.day ? `${MONTHS[c.ny.month]} ${c.ny.date}` : hhmm(c.ny.minutes)),
});

const INTRADAY_LEVELS = [15, 30, 60, 120, 240].map(everyMinutes);
const CALENDAR_LEVELS: TickLevel[] = [
  { key: (c) => c.day, label: calendarLabel },
  { key: (c) => dayNumber(c.ny) - ((c.ny.weekday + 6) % 7), label: calendarLabel },
  { key: (c) => c.ny.year * 12 + c.ny.month, label: (c, prev) => (c.ny.year !== prev.ny.year ? String(c.ny.year) : MONTHS[c.ny.month]!) },
  { key: (c) => c.ny.year * 4 + Math.floor(c.ny.month / 3), label: (c, prev) => (c.ny.year !== prev.ny.year ? String(c.ny.year) : MONTHS[c.ny.month]!) },
  { key: (c) => c.ny.year, label: (c) => String(c.ny.year) },
];

/**
 * Time-axis ticks for candles [from, to): a tick wherever a new time block (15 min, hour, day,
 * week, month…) starts, at the finest level that fits `maxTicks`. Day/month/year changes are major.
 */
export function timeTicks(candles: Candle[], from: number, to: number, maxTicks: number, intraday: boolean) {
  const first = Math.max(1, Math.ceil(from));
  const last = Math.min(candles.length - 1, Math.floor(to));
  for (const level of intraday ? [...INTRADAY_LEVELS, ...CALENDAR_LEVELS] : CALENDAR_LEVELS) {
    const ticks: { i: number; label: string; major: boolean }[] = [];
    for (let i = first; i <= last && ticks.length <= maxTicks; i++) {
      const c = candles[i]!;
      const prev = candles[i - 1]!;
      if (level.key(c) !== level.key(prev)) {
        ticks.push({ i, label: level.label(c, prev), major: intraday ? c.day !== prev.day : c.ny.month !== prev.ny.month });
      }
    }
    if (ticks.length <= maxTicks) return ticks;
  }
  return [];
}

// --- formatting ---

export const fmtPrice = (v: number) =>
  v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtVolume = (v: number) =>
  v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(v);

export const fmtChange = (from: number, to: number) => {
  const d = to - from;
  const pct = (d / from) * 100;
  return `${d >= 0 ? "+" : "−"}${fmtPrice(Math.abs(d))} (${d >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(2)}%)`;
};

/** E.g. "Fri Oct 2 '26 10:30" for intraday candles, "Fri Oct 2 '26" for daily, "Week of Sep 28 '26" for weekly. */
export function fmtCandleTime(c: Candle, interval: number): string {
  const date = `${MONTHS[c.ny.month]} ${c.ny.date} '${String(c.ny.year).slice(2)}`;
  if (interval >= WEEK) return `Week of ${date}`;
  if (interval >= DAY) return `${WEEKDAYS[c.ny.weekday]} ${date}`;
  return `${WEEKDAYS[c.ny.weekday]} ${date} ${hhmm(c.ny.minutes)}`;
}
