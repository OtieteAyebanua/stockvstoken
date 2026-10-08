import { useMemo, useState } from "react";
import type { Candle } from "./series";

const MIN_DAYS = 1;
const MAX_DAYS = 60;

interface Props {
  /** Daily candles: one per trading session. */
  daily: Candle[];
  extended: boolean;
}

interface Gap {
  up: boolean;
  /** Session the price got back to the previous close (1 = the gap's own session), or null if not within MAX_DAYS. */
  fillDay: number | null;
  /** Sessions of data from the gap's session on, including it. */
  after: number;
}

/** Every gap the market's close caused: a session opening away from the previous session's close. */
function findGaps(daily: Candle[], horizon: number): Gap[] {
  const gaps: Gap[] = [];
  for (let d = 1; d < daily.length; d++) {
    const prevClose = daily[d - 1]!.close;
    const open = daily[d]!.open;
    if (open === prevClose) continue;
    const up = open > prevClose;
    let fillDay: number | null = null;
    for (let k = 0; k < horizon && d + k < daily.length; k++) {
      const s = daily[d + k]!;
      if (up ? s.low <= prevClose : s.high >= prevClose) {
        fillDay = k + 1;
        break;
      }
    }
    gaps.push({ up, fillDay, after: daily.length - d });
  }
  return gaps;
}

/** Share of gaps that came back within `days`, counting only gaps with that many sessions of data after them. */
function fillRate(gaps: Gap[], days: number) {
  const eligible = gaps.filter((g) => g.after >= days);
  const hit = eligible.filter((g) => g.fillDay != null && g.fillDay <= days).length;
  return { share: eligible.length ? hit / eligible.length : null, hit, n: eligible.length };
}

const pct = (x: number | null) => (x == null ? "—" : `${Math.round(x * 100)}%`);

export function GapStats({ daily, extended }: Props) {
  const [days, setDays] = useState(5);
  const [draft, setDraft] = useState("5");

  const gaps = useMemo(() => findGaps(daily, MAX_DAYS), [daily]);
  const all = fillRate(gaps, days);
  const up = fillRate(gaps.filter((g) => g.up), days);
  const down = fillRate(gaps.filter((g) => !g.up), days);
  const byDay = useMemo(() => Array.from({ length: days }, (_, i) => fillRate(gaps, i + 1)), [gaps, days]);

  const commit = (value: number) => {
    const next = Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.round(value) || MIN_DAYS));
    setDays(next);
    setDraft(String(next));
  };

  const since = daily[0] && new Date(daily[0].start).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", year: "numeric" });

  return (
    <section className="gap-stats" aria-label="How often gaps from the market close got filled">
      <div className="gs-head">
        <h3>
          <span className="gap-swatch" aria-hidden />
          Gap fill
        </h3>
        <label className="days-input">
          Came back within
          <span className="stepper">
            <button type="button" aria-label="One day less" onClick={() => commit(days - 1)} disabled={days <= MIN_DAYS}>
              −
            </button>
            <input
              type="number"
              inputMode="numeric"
              min={MIN_DAYS}
              max={MAX_DAYS}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                const v = Number(e.target.value);
                if (e.target.value !== "" && v >= MIN_DAYS && v <= MAX_DAYS) setDays(Math.round(v));
              }}
              onBlur={() => commit(Number(draft))}
              onKeyDown={(e) => e.key === "Enter" && commit(Number(draft))}
            />
            <button type="button" aria-label="One day more" onClick={() => commit(days + 1)} disabled={days >= MAX_DAYS}>
              +
            </button>
          </span>
          trading {days === 1 ? "day" : "days"}
        </label>
        <span
          className="gs-info"
          title={`A gap is a session opening away from the previous close (${extended ? "8 PM → 4 AM with extended hours" : "4 PM → 9:30 AM"}). Came back = price traded at or through that close. Day 1 is the gap's own session. Gaps too recent to have ${days} days after them are left out.`}
        >
          ⓘ
        </span>
      </div>

      <div className="gs-body">
        <div className="gs-tiles">
          <Tile label="All gaps" rate={all} main />
          <Tile label="Gap up" rate={up} />
          <Tile label="Gap down" rate={down} />
        </div>

        <div className="gs-days" aria-label={`Share that came back by day 1 to ${days}`}>
          <div className="gs-days-bars">
            {byDay.map((r, i) => (
              <div key={i} className="gs-day" title={`By day ${i + 1}: ${pct(r.share)} (${r.hit} of ${r.n})`}>
                <div className="gs-day-bar" style={{ height: `${(r.share ?? 0) * 100}%` }} />
              </div>
            ))}
          </div>
          <div className="gs-days-axis">
            <span>
              Day 1 · <b>{pct(byDay[0]?.share ?? null)}</b>
            </span>
            {days > 1 && (
              <span>
                Day {days} · <b>{pct(byDay.at(-1)?.share ?? null)}</b>
              </span>
            )}
          </div>
        </div>
      </div>

      <p className="gs-foot">
        {gaps.length.toLocaleString()} gaps since {since}
      </p>
    </section>
  );
}

function Tile({ label, rate, main }: { label: string; rate: ReturnType<typeof fillRate>; main?: boolean }) {
  return (
    <div className={`gs-tile${main ? " main" : ""}`}>
      <div className="gs-tile-label">{label}</div>
      <div className="gs-tile-value">{pct(rate.share)}</div>
      <div className="gs-tile-note">
        {rate.hit.toLocaleString()} of {rate.n.toLocaleString()}
      </div>
    </div>
  );
}
