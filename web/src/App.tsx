import { useEffect, useRef, useState } from "react";
import { TickerView } from "./TickerView";
import type { IndexFile, TickerFile } from "./types";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}. Run \`npm run fetch\` first.`);
  return res.json() as Promise<T>;
}

export function App() {
  const [index, setIndex] = useState<IndexFile | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<TickerFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cache = useRef(new Map<string, TickerFile>());

  useEffect(() => {
    getJson<IndexFile>("/index.json")
      .then((idx) => {
        setIndex(idx);
        setSelected(idx.tickers[0]?.ticker ?? null);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    const entry = index?.tickers.find((t) => t.ticker === selected);
    if (!entry) return;
    const cached = cache.current.get(entry.ticker);
    if (cached) return setFile(cached);

    let cancelled = false;
    setLoading(true);
    getJson<TickerFile>(`/${entry.file}`)
      .then((f) => {
        cache.current.set(entry.ticker, f);
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

  return (
    <div className="layout">
      <nav className="sidebar" aria-label="Stocks">
        <div className="sidebar-title">Stocks</div>
        <ul>
          {index.tickers.map((t) => (
            <li key={t.ticker}>
              <button aria-current={t.ticker === selected} onClick={() => setSelected(t.ticker)}>
                <span className="ticker">{t.ticker}</span>
                <span className="issuers">
                  {t.tokens.map((k) => (
                    <span key={k.issuer} className={`key key-${k.issuer}`} title={k.symbol} />
                  ))}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="sidebar-foot muted">Updated {new Date(index.generatedAt).toLocaleDateString()}</div>
      </nav>

      <main className={loading ? "content is-loading" : "content"}>
        {file ? <TickerView file={file} /> : <p className="muted">Loading…</p>}
      </main>
    </div>
  );
}
