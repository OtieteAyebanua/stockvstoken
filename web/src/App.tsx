import { useEffect, useRef, useState } from "react";
import { fmtPrice } from "./series";
import { TickerView } from "./TickerView";
import type { IndexFile, TickerFile } from "./types";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}. Run \`npm run fetch\` first.`);
  return res.json() as Promise<T>;
}

/** Largest company first; anything without a rank goes last. */
const bySize = (index: IndexFile) => [...index.stocks].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.symbol.localeCompare(b.symbol));

export function App() {
  const [index, setIndex] = useState<IndexFile | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<TickerFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const cache = useRef(new Map<string, TickerFile>());

  useEffect(() => {
    getJson<IndexFile>("/index.json")
      .then((idx) => {
        setIndex(idx);
        setSelected(bySize(idx)[0]?.symbol ?? null);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    const entry = index?.stocks.find((t) => t.symbol === selected);
    if (!entry) return;
    const cached = cache.current.get(entry.symbol);
    if (cached) return setFile(cached);

    let cancelled = false;
    setLoading(true);
    getJson<TickerFile>(`/${entry.file}`)
      .then((f) => {
        cache.current.set(entry.symbol, f);
        if (!cancelled) setFile(f);
      })
      .catch((err: Error) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [index, selected]);

  if (error) return <main className="message error">{error}</main>;
  if (!index) return <main className="message muted">Loading…</main>;

  const q = query.trim().toLowerCase();
  const shown = bySize(index).filter((t) => !q || t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q));

  return (
    <div className="layout">
      <nav className="sidebar" aria-label="Stocks">
        <div className="sidebar-head">
          <div className="sidebar-title">Watchlist</div>
          <input className="search" type="search" placeholder="Search symbol or name" aria-label="Search stocks" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="watch-cols" aria-hidden>
            <span>Symbol</span>
            <span>Last</span>
            <span>Chg%</span>
          </div>
        </div>
        <ul className="watchlist">
          {shown.map((t) => {
            const chg = t.lastClose != null && t.prevClose ? (t.lastClose / t.prevClose - 1) * 100 : null;
            return (
              <li key={t.symbol}>
                <button aria-current={t.symbol === selected} onClick={() => setSelected(t.symbol)} title={t.name}>
                  <span className="watch-id">
                    <span className="ticker">{t.symbol}</span>
                    <span className="stock-name">{t.name}</span>
                  </span>
                  <span className="watch-num">{t.lastClose != null ? fmtPrice(t.lastClose) : "—"}</span>
                  <span className={`watch-num ${chg == null ? "" : chg >= 0 ? "up" : "down"}`}>
                    {chg == null ? "—" : `${chg >= 0 ? "+" : "−"}${Math.abs(chg).toFixed(2)}%`}
                  </span>
                </button>
              </li>
            );
          })}
          {!shown.length && <li className="muted small watch-empty">No match</li>}
        </ul>
        <div className="sidebar-foot muted small">
          {index.stocks.length} stocks · 5-minute data · closes as of the last trading day
        </div>
      </nav>

      <main className={loading ? "content is-loading" : "content"}>
        {file ? <TickerView file={file} /> : <p className="muted message">Loading…</p>}
      </main>
    </div>
  );
}
