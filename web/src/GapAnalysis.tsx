import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { breakdown, TIMING_BANDS, type GapStats, type HedgeStats } from "../../src/gap-stats.js";
import type { GapAllFile } from "./types";

type Issuer = "xstock" | "ondo";

const cache = new Map<string, Promise<unknown>>();
function load<T>(path: string): Promise<T> {
  if (!cache.has(path)) {
    cache.set(
      path,
      fetch(path).then((res) => {
        if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
        return res.json();
      }),
    );
  }
  return cache.get(path) as Promise<T>;
}

const pct = (x: number | null | undefined, digits = 0) => (x == null ? "—" : `${(x * 100).toFixed(digits)}%`);

/** Share filled within `days` trading days, or null. */
const within = (s: GapStats | null | undefined, days: number) => s?.filledWithin.find((w) => w.days === days)?.share ?? null;

const SIZE_WORDS: Record<string, string> = {
  "0.1–0.5%": "Small move (0.1–0.5%)",
  "0.5–1%": "Medium move (0.5–1%)",
  "1–2%": "Large move (1–2%)",
  "2%+": "Very large move (over 2%)",
};

interface Props {
  ticker: string;
  issuer: Issuer;
  stockSymbol: string;
  tokenSymbol: string;
  /** The charts' visible time range: only closures inside it are counted. */
  view: [number, number];
  /** That range in words, e.g. "the last month" or "Mar 3 – Sep 24, 2026". */
  rangeText: string;
}

/** Fewer real gaps than this and the percentages are mostly noise. */
const FEW_GAPS = 20;

export function GapAnalysis({ ticker, issuer, stockSymbol, tokenSymbol, view, rangeText }: Props) {
  const [all, setAll] = useState<GapAllFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    load<GapAllFile>("/analysis/gaps/all.json")
      .then((a) => !cancelled && setAll(a))
      .catch(() => !cancelled && setError("No analysis yet. Run `npm run gaps` to create it."));
    return () => {
      cancelled = true;
    };
  }, []);

  // Recompute for the visible range; deferred so dragging the charts stays smooth.
  const [from, to] = useDeferredValue(view);
  const { mine, avg } = useMemo(() => {
    if (!all) return { mine: null, avg: null };
    const inRange = (iso: string) => {
      const t = Date.parse(iso);
      return t >= from && t <= to;
    };
    const closures = all.closures.filter((r) => r.issuer === issuer && inRange(r.reopenedAt));
    const nights = all.nights.filter((r) => r.issuer === issuer && inRange(r.closedAt));
    const own = closures.filter((r) => r.ticker === ticker);
    return {
      mine: own.length ? breakdown(own, nights.filter((r) => r.ticker === ticker)) : null,
      avg: closures.length ? breakdown(closures, nights) : null,
    };
  }, [all, ticker, issuer, from, to]);

  return (
    <section className="analysis">
      <header className="analysis-header">
        <h3>
          Does {stockSymbol} follow its token overnight, and then come back?
        </h3>
      </header>

      <div className="explainer">
        <GapDiagram issuer={issuer} />
        <ol className="steps">
          <li>
            <b>The market closes.</b> {stockSymbol} stops trading at its closing price (the dashed line).
          </li>
          <li>
            <b>The token keeps trading.</b> Overnight or over the weekend {tokenSymbol} moves up or down. That move is the{" "}
            <b>gap</b>.
          </li>
          <li>
            <b>The market opens.</b> {stockSymbol} usually jumps the same way the token moved.
          </li>
          <li>
            <b>Does it come back?</b> We check whether {stockSymbol} later trades back to its old closing price. Traders call this{" "}
            <b>filling the gap</b>.
          </li>
        </ol>
      </div>

      {error && <p className="muted">{error}</p>}
      {!error && all && !mine && (
        <p className="muted">
          No {tokenSymbol} moves while the market was closed in {rangeText}. Zoom out or pick a longer range above the charts.
        </p>
      )}

      {mine && (
        <>
          <p className="range-note muted small">
            Counting only what happened in the range the charts show: <b>{rangeText}</b>. Zoom or drag the charts to change it.
            {mine.all.realGaps < FEW_GAPS && (
              <span className="few"> Only {mine.all.realGaps} gaps here, so these numbers can swing a lot. Zoom out for a steadier picture.</span>
            )}
          </p>
          <p className="takeaway">{takeaway(stockSymbol, tokenSymbol, rangeText, mine.all, avg?.all ?? null, mine.bySize)}</p>

          <div className="stats analysis-stats">
            <Tile label={`${stockSymbol} opened the way the token moved`} value={mine.all.openedSameWay} avg={avg?.all.openedSameWay} />
            <Tile label="…and came back the same day" value={within(mine.all, 1)} avg={within(avg?.all, 1)} />
            <Tile label="…came back within 10 trading days" value={within(mine.all, 10)} avg={within(avg?.all, 10)} />
            <Tile label="…came back within 30 trading days" value={within(mine.all, 30)} avg={within(avg?.all, 30)} />
          </div>

          <div className="analysis-block">
            <div className="analysis-block-head">
              <div>
                <h4>How many came back to the old close, within…</h4>
                <p className="muted small">
                  Trading days after the market reopened. Recent gaps count only once enough days have passed, so a recent range
                  may show "—" for longer spans.
                </p>
              </div>
            </div>
            <div className="table-scroll">
              <table className="within-table">
                <thead>
                  <tr>
                    <th />
                    {mine.all.filledWithin.map((w) => (
                      <th key={w.days} className="num">
                        {w.days === 1 ? "Same day" : `${w.days} days`}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="strong">
                    <td>{stockSymbol}</td>
                    {mine.all.filledWithin.map((w) => (
                      <td key={w.days} className="num" title={`${w.gaps} gaps`}>
                        {pct(w.share)}
                      </td>
                    ))}
                  </tr>
                  {avg && (
                    <tr>
                      <td className="muted">Average stock</td>
                      {avg.all.filledWithin.map((w) => (
                        <td key={w.days} className="num muted" title={`${w.gaps} gaps`}>
                          {pct(w.share)}
                        </td>
                      ))}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="analysis-block">
            <div className="analysis-block-head">
              <div>
                <h4>How fast did {stockSymbol} come back to its old close?</h4>
                <p className="muted small">
                  Each bar is 100% of the times {stockSymbol} opened with a jump (gaps with 30 trading days of data after them).
                  Hover a color for its share.
                </p>
              </div>
              <ul className="legend">
                {TIMING_BANDS.map((b, i) => (
                  <li key={b.label}>
                    <span className={`swatch fill-${i}`} />
                    {b.label}
                  </li>
                ))}
                <li>
                  <span className="swatch fill-none" />
                  Didn't come back within 30 days
                </li>
              </ul>
            </div>
            <div className="fill-rows">
              <FillRow label={`${stockSymbol}, all gaps`} stats={mine.all} strong />
              {avg && <FillRow label="Average of all stocks" stats={avg.all} />}
              <div className="fill-group">By how much the token moved</div>
              {mine.bySize.map((b) => (
                <FillRow key={b.label} label={SIZE_WORDS[b.label] ?? b.label} stats={b.stats} />
              ))}
              <div className="fill-group">By how long the market was closed</div>
              {mine.byKind.map((b) => (
                <FillRow key={b.label} label={b.label === "overnight" ? "Overnight (weeknights)" : "Weekend or holiday"} stats={b.stats} />
              ))}
            </div>
          </div>

          <Hedge stockSymbol={stockSymbol} tokenSymbol={tokenSymbol} rangeText={rangeText} mine={mine.hedge.all} avg={avg?.hedge.all ?? null} byKind={mine.hedge.byKind} />

          <details className="analysis-note">
            <summary>How this is measured</summary>
            <ul>
              <li>
                <b>Gap</b> = how much {tokenSymbol} moved from the moment the market closed until just before it reopened. Moves
                under 0.1% are ignored.
              </li>
              <li>
                The "came back" numbers only count times {stockSymbol} actually <b>opened with a jump</b> in the token's direction
                (otherwise there's nothing to come back from).
              </li>
              <li>
                <b>Came back</b> = {stockSymbol} traded at or through its old closing price after reopening, using hourly high and
                low prices.
              </li>
              <li>
                Counts only closures inside the range the charts show (token data goes back 12 months). Uses hourly data. Stocks often revisit their previous close anyway, so read this as a
                description of what happened, not a trading signal.
              </li>
            </ul>
          </details>
        </>
      )}
    </section>
  );
}

/** One or two plain sentences answering the question for this stock. */
function takeaway(stock: string, token: string, rangeText: string, s: GapStats, avg: GapStats | null, bySize: { label: string; stats: GapStats }[]) {
  const parts: string[] = [];
  parts.push(
    `In ${rangeText}, ${token} moved while the market was closed ${s.gaps} times, and ${stock} opened in the same direction ${pct(s.openedSameWay)} of the time.`,
  );
  const sameDay = within(s, 1);
  const avgSameDay = within(avg, 1);
  if (sameDay != null) {
    let compare = "";
    if (avgSameDay != null) {
      const d = sameDay - avgSameDay;
      compare =
        Math.abs(d) < 0.03
          ? `, about the same as the average stock (${pct(avgSameDay)})`
          : `, ${d > 0 ? "more" : "less"} often than the average stock (${pct(avgSameDay)})`;
    }
    parts.push(`After opening with a jump, it came back to its old close the same day ${pct(sameDay)} of the time${compare}.`);
  }
  const small = bySize[0]?.stats;
  const big = bySize.at(-1)?.stats;
  if (within(small, 1) != null && within(big, 1) != null && big!.realGaps >= 5) {
    parts.push(`Small moves usually came back (${pct(within(small, 1))} same day); very large moves mostly stuck (${pct(within(big, 1))}).`);
  }
  return parts.join(" ");
}

function Tile({ label, value, avg }: { label: string; value: number | null; avg: number | null | undefined }) {
  const d = value != null && avg != null ? value - avg : null;
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{pct(value)}</div>
      <div className="stat-note muted">
        Average stock: {pct(avg)}
        {d != null && Math.abs(d) >= 0.03 && <span> · {d > 0 ? "higher" : "lower"}</span>}
      </div>
    </div>
  );
}

function FillRow({ label, stats, strong }: { label: string; stats: GapStats; strong?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const t = stats.fillTiming;
  const segments = t ? [...t.bands, { label: "Didn't come back within 30 days", share: t.notFilled }] : [];
  return (
    <div className={`fill-row${strong ? " strong" : ""}`}>
      <div className="fill-label">
        {label}
        <div className="muted small">{t?.gaps ?? 0} times</div>
      </div>
      <div className="fill-bar" onPointerLeave={() => setHover(null)}>
        {t ? (
          segments.map((seg, i) =>
            seg.share > 0 ? (
              <div
                key={seg.label}
                className={`fill-seg ${i < t.bands.length ? `fill-${i}` : "fill-none"}`}
                style={{ flexGrow: seg.share }}
                tabIndex={0}
                aria-label={`${seg.label}: ${pct(seg.share)}`}
                onPointerEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              />
            ) : null,
          )
        ) : (
          <div className="muted small">Not enough data</div>
        )}
        {hover != null && segments[hover] && (
          <div className="fill-tip">
            <strong>{pct(segments[hover]!.share, 1)}</strong> <span className="muted">{segments[hover]!.label.toLowerCase()}</span>
          </div>
        )}
      </div>
      <div className="fill-value">
        <strong>{pct(within(stats, 1))}</strong> <span className="muted">same day</span>
      </div>
    </div>
  );
}

/** Tiny illustration of a gap and a fill: close → token moves while closed → stock opens with a jump → comes back. */
function GapDiagram({ issuer }: { issuer: Issuer }) {
  const closeY = 78;
  const gapY = 38;
  return (
    <svg className="gap-diagram" viewBox="0 0 300 130" role="img" aria-label="Diagram: the stock closes, the token moves while the market is closed, the stock opens with a jump and later comes back to its old close.">
      <rect x="80" y="10" width="100" height="100" className="d-zone" />
      <text x="130" y="24" textAnchor="middle" className="d-zone-label">market closed</text>

      <line x1="10" x2="290" y1={closeY} y2={closeY} className="d-close" />
      <text x="12" y={closeY - 6} className="d-text">old close</text>

      {/* stock before the close */}
      <polyline points={`10,92 30,84 50,88 65,80 80,${closeY}`} className="d-stock" />
      <circle cx="80" cy={closeY} r="3.5" className="d-stock-dot" />
      {/* token while closed */}
      <polyline points={`80,${closeY} 100,70 115,62 130,58 145,48 162,44 180,${gapY}`} className={`d-token d-${issuer}`} />
      {/* gap bracket */}
      <line x1="186" x2="186" y1={gapY} y2={closeY} className="d-bracket" />
      <text x="190" y={(gapY + closeY) / 2 + 4} className="d-text d-strong">gap</text>
      {/* stock after the open: jumps, then comes back to the close */}
      <polyline points={`180,${gapY} 200,48 222,60 240,${closeY} 262,70 290,64`} className="d-stock" />
      <circle cx="180" cy={gapY} r="3.5" className="d-stock-dot" />
      <circle cx="240" cy={closeY} r="5" className="d-fill" />
      <text x="240" y={closeY + 22} textAnchor="middle" className="d-text d-strong">filled ✓</text>

      <text x="40" y="122" textAnchor="middle" className="d-text">stock</text>
      <text x="130" y="122" textAnchor="middle" className="d-text">token keeps trading</text>
      <text x="235" y="122" textAnchor="middle" className="d-text">stock reopens</text>
    </svg>
  );
}

const signed = (x: number, digits = 2) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(digits)}%`;

/** Can the token hedge the stock while the market is closed? */
function Hedge({
  stockSymbol,
  tokenSymbol,
  rangeText,
  mine,
  avg,
  byKind,
}: {
  stockSymbol: string;
  tokenSymbol: string;
  rangeText: string;
  mine: HedgeStats | null;
  avg: HedgeStats | null;
  byKind: { label: string; stats: HedgeStats | null }[];
}) {
  if (!mine) return null;
  const verdict =
    mine.nights < FEW_GAPS
      ? { cls: "", text: `Only ${mine.nights} closures in this range: too few to judge. Zoom out to see how well ${tokenSymbol} hedges.` }
      : mine.riskRemoved >= 0.8 && mine.correlation >= 0.9
      ? { cls: "good", text: `✓ Works well: ${tokenSymbol} tracks ${stockSymbol} closely while the market is closed.` }
      : mine.riskRemoved >= 0.5
        ? { cls: "", text: `~ Partly works: ${tokenSymbol} follows ${stockSymbol}, but loosely.` }
        : {
            cls: "bad",
            text: `✗ Unreliable: ${tokenSymbol}'s price sometimes drifts far from ${stockSymbol} (thin trading or bad price data), so it doesn't hedge well.`,
          };
  const worst = mine.worstNight;
  return (
    <div className="analysis-block">
      <div className="analysis-block-head">
        <div>
          <h4>
            Can {tokenSymbol} protect a {stockSymbol} position while the market is closed?
          </h4>
          <p className="muted small">
            The hedge: when the market closes, take the opposite position in {tokenSymbol} for the same dollar amount, and close
            both at the open. What's left is the stock's opening jump minus the token's move. All {mine.nights} closures in {rangeText}.
          </p>
        </div>
      </div>

      <p className={`verdict ${verdict.cls}`}>{verdict.text}</p>

      <div className="stats hedge-stats">
        <div className="stat">
          <div className="stat-label">Typical opening jump, no hedge</div>
          <div className="stat-value">{pct(mine.typicalJump, 2)}</div>
          <div className="stat-note muted">Average stock: {pct(avg?.typicalJump, 2)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Typical jump left after hedging</div>
          <div className="stat-value">{pct(mine.typicalLeftOver, 2)}</div>
          <div className="stat-note muted">Average stock: {pct(avg?.typicalLeftOver, 2)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Overnight risk removed</div>
          <div className="stat-value">{mine.riskRemoved > 0 ? pct(mine.riskRemoved) : "None"}</div>
          <div className="stat-note muted">
            Average stock: {pct(avg?.riskRemoved)} ·{" "}
            {byKind.map((k) => `${k.label === "overnight" ? "weeknights" : "weekends"} ${k.stats && k.stats.riskRemoved > 0 ? pct(k.stats.riskRemoved) : "none"}`).join(" · ")}
          </div>
        </div>
      </div>

      <p className="muted small hedge-note">
        Biggest opening jump: <b>{signed(worst.stockGap, 1)}</b> after{" "}
        {new Date(worst.closedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}; with the hedge
        it would have been <b>{signed(worst.leftOver, 1)}</b>. Price moves track {mine.correlation.toFixed(2)} (1.00 = perfectly).
        Ignores trading costs, the token's premium to the stock, and whether you can short the token.
      </p>
    </div>
  );
}
