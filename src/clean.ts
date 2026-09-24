/** A price this far (as a fraction) from its neighborhood's median is a bad tick. */
const MAX_DEVIATION = 0.05;
/** Points on each side that make up the neighborhood. */
const HALF_WINDOW = 3;

/**
 * Drop one-off spikes from an hourly price series. CoinGecko occasionally reports a single bad
 * hour — e.g. NFLX xStock at its pre-split ~$1,000 for one hour between ~$95 prints, or MSFT +37%
 * and straight back. A point is dropped when it's more than 5% from the median of itself and its 3
 * neighbors on each side. Real moves persist for hours, so the median follows them and they stay.
 */
export function dropSpikes<T extends { price: number }>(prices: T[]): T[] {
  return prices.filter((p, i) => {
    const window = prices.slice(Math.max(0, i - HALF_WINDOW), i + HALF_WINDOW + 1).map((q) => q.price);
    window.sort((a, b) => a - b);
    const median = window[window.length >> 1]!;
    return Math.abs(p.price / median - 1) <= MAX_DEVIATION;
  });
}

/** How close a token/stock price ratio must be to a whole number to count as an unadjusted split. */
const SPLIT_TOLERANCE = 0.15;

/**
 * Put token prices on the stock's split-adjusted basis. Yahoo adjusts a stock's history for
 * splits; CoinGecko doesn't adjust the token's (NFLX xStock shows ~$1,150 before NFLX's 10-for-1
 * split, and sometimes afterwards). Where a token price is ~k× the stock's latest price for a whole
 * k ≥ 2, divide it by k.
 */
export function alignSplits<T extends { time: string; price: number }>(
  prices: T[],
  stock: { time: string; close: number }[],
): T[] {
  if (!stock.length) return prices;
  const stockTimes = stock.map((c) => Date.parse(c.time));
  let j = 0;
  return prices.map((p) => {
    const t = Date.parse(p.time);
    while (j + 1 < stockTimes.length && stockTimes[j + 1]! <= t) j++;
    const ratio = p.price / stock[j]!.close;
    const k = Math.round(ratio);
    return k >= 2 && Math.abs(ratio / k - 1) <= SPLIT_TOLERANCE ? { ...p, price: p.price / k } : p;
  });
}
