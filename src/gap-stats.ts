// Gap-fill and hedge statistics over a set of closures. Pure functions shared by `npm run gaps` and
// the UI, which recomputes them for whatever time range the charts show.

export type Issuer = "xstock" | "ondo";
export type ClosureKind = "overnight" | "weekend/holiday";

/** "Came back within N trading days" is measured for each of these. */
export const HORIZONS = [1, 3, 5, 10, 15, 20, 25, 30] as const;
/** Bands for the fill-timing bar, in trading days (inclusive). */
export const TIMING_BANDS = [
  { label: "Same day", from: 1, to: 1 },
  { label: "2–5 days later", from: 2, to: 5 },
  { label: "6–10 days later", from: 6, to: 10 },
  { label: "11–20 days later", from: 11, to: 20 },
  { label: "21–30 days later", from: 21, to: 30 },
];
export const SIZE_BUCKETS = [
  { label: "0.1–0.5%", min: 0.001, max: 0.005 },
  { label: "0.5–1%", min: 0.005, max: 0.01 },
  { label: "1–2%", min: 0.01, max: 0.02 },
  { label: "2%+", min: 0.02, max: Infinity },
];

/** One market closure where the token moved: the fields the stats need. */
export interface GapRow {
  ticker: string;
  issuer: Issuer;
  kind: ClosureKind;
  reopenedAt: string;
  /** Token's move while the market was closed, as a fraction. */
  tokenGap: number;
  /** Did the stock open on the same side of the close as the token said it would? */
  openAgreed: boolean;
  /** Stock opened past its close in the token's direction: a real gap on the stock. */
  stockGapped: boolean;
  /** Trading day the fill happened on (1 = the reopening session), or null if not within the last horizon. */
  fillDay: number | null;
  /** Sessions of data after the reopen (including it) — gaps too recent for a horizon are left out of it. */
  sessionsAfter: number;
  /** Hours from the reopen until the fill, if filled within the last horizon. */
  hoursToFill: number | null;
}

/** Every closure, gap or not: the token's move while closed vs. the stock's opening jump. For the hedge study. */
export interface Night {
  ticker: string;
  issuer: Issuer;
  kind: ClosureKind;
  closedAt: string;
  /** Token's move while the market was closed. */
  tokenMove: number;
  /** Stock's opening jump vs. its prior close. */
  stockGap: number;
}

export const median = (xs: number[]) => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2;
};
const share = (n: number, d: number) => (d ? n / d : null);

/** Fractions are 0–1, or null when there's nothing to divide by. */
export interface GapStats {
  gaps: number;
  medianGap: number | null;
  /** Stock opened on the side of its close the token moved to. */
  openedSameWay: number | null;
  /** Gaps the stock actually opened with; the fill rates below are of these. */
  realGaps: number;
  /**
   * Share of real gaps filled within N trading days. Each uses only gaps with at least N days of
   * data after them, so recent gaps don't count as "not filled" before they've had the chance.
   */
  filledWithin: { days: number; share: number | null; gaps: number }[];
  /** When real gaps filled, by band, for gaps with a full 30 days of data after them — sums to 1. */
  fillTiming: { bands: { label: string; share: number }[]; notFilled: number; gaps: number } | null;
  medianHoursToFill: number | null;
}

export function summarize(rows: GapRow[]): GapStats {
  const real = rows.filter((r) => r.stockGapped);
  const maxDays = HORIZONS.at(-1)!;
  const complete = real.filter((r) => r.sessionsAfter >= maxDays);
  return {
    gaps: rows.length,
    medianGap: median(rows.map((r) => Math.abs(r.tokenGap))),
    openedSameWay: share(rows.filter((r) => r.openAgreed).length, rows.length),
    realGaps: real.length,
    filledWithin: HORIZONS.map((days) => {
      const eligible = real.filter((r) => r.sessionsAfter >= days);
      return { days, share: share(eligible.filter((r) => r.fillDay != null && r.fillDay <= days).length, eligible.length), gaps: eligible.length };
    }),
    fillTiming: complete.length
      ? {
          bands: TIMING_BANDS.map(({ label, from, to }) => ({
            label,
            share: complete.filter((r) => r.fillDay != null && r.fillDay >= from && r.fillDay <= to).length / complete.length,
          })),
          notFilled: complete.filter((r) => r.fillDay == null).length / complete.length,
          gaps: complete.length,
        }
      : null,
    medianHoursToFill: median(real.flatMap((r) => (r.hoursToFill == null ? [] : [r.hoursToFill]))),
  };
}

export interface HedgeStats {
  nights: number;
  /** 1 = the token's overnight move and the stock's opening jump line up perfectly. */
  correlation: number;
  /** Best hedge ratio: how much stock moves per 1 of token move. */
  beta: number;
  /** Share of overnight variance removed by a 1:1 hedge (1 − var(left over) / var(unhedged)). */
  riskRemoved: number;
  typicalJump: number | null;
  typicalLeftOver: number | null;
  worstNight: { ticker: string; closedAt: string; stockGap: number; leftOver: number };
}

/**
 * How well the token hedges the stock over a closure: hold the stock, take the opposite position in
 * the token (1:1) while the market is closed. What's left is the stock's opening jump minus the
 * token's move.
 */
export function hedgeStats(nights: Night[]): HedgeStats | null {
  const n = nights.length;
  if (n < 5) return null;
  const x = nights.map((r) => r.tokenMove);
  const y = nights.map((r) => r.stockGap);
  const res = nights.map((r) => r.stockGap - r.tokenMove);
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const variance = (a: number[]) => {
    const m = mean(a);
    return a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length;
  };
  const mx = mean(x);
  const my = mean(y);
  const cov = x.reduce((s, v, i) => s + (v - mx) * (y[i]! - my), 0) / n;
  const worst = nights.reduce((a, b) => (Math.abs(b.stockGap) > Math.abs(a.stockGap) ? b : a));
  return {
    nights: n,
    correlation: cov / Math.sqrt(variance(x) * variance(y)),
    beta: cov / variance(x),
    riskRemoved: 1 - variance(res) / variance(y),
    typicalJump: median(y.map(Math.abs)),
    typicalLeftOver: median(res.map(Math.abs)),
    worstNight: { ticker: worst.ticker, closedAt: worst.closedAt, stockGap: worst.stockGap, leftOver: worst.stockGap - worst.tokenMove },
  };
}

const KINDS: ClosureKind[] = ["overnight", "weekend/holiday"];

export interface GapBreakdown {
  all: GapStats;
  bySize: { label: string; stats: GapStats }[];
  byKind: { label: ClosureKind; stats: GapStats }[];
  hedge: { all: HedgeStats | null; byKind: { label: ClosureKind; stats: HedgeStats | null }[] };
}

/** Overall stats plus the same split by gap size and by closure type, and the hedge study. */
export function breakdown(rows: GapRow[], nights: Night[]): GapBreakdown {
  return {
    all: summarize(rows),
    bySize: SIZE_BUCKETS.map(({ label, min, max }) => ({
      label,
      stats: summarize(rows.filter((r) => Math.abs(r.tokenGap) >= min && Math.abs(r.tokenGap) < max)),
    })),
    byKind: KINDS.map((kind) => ({ label: kind, stats: summarize(rows.filter((r) => r.kind === kind)) })),
    hedge: {
      all: hedgeStats(nights),
      byKind: KINDS.map((kind) => ({ label: kind, stats: hedgeStats(nights.filter((r) => r.kind === kind)) })),
    },
  };
}
