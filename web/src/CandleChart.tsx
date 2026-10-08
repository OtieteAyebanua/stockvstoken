import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { clampView, DAY, fmtCandleTime, fmtChange, fmtPrice, fmtVolume, niceTicks, timeTicks, type Candle, type View } from "./series";

/** Space for the price scale on the right and the time scale at the bottom. */
const AXIS_RIGHT = 68;
const AXIS_BOTTOM = 28;
const TOP = 12;
/** Volume bars fill the bottom of the plot, under the candles. */
const VOLUME_SHARE = 0.18;
/** Candles stay out of the volume area, with a little room above. */
const PRICE_SHARE = 0.78;
const BODY = 0.72;
const MAX_BODY = 18;
const DRAG_THRESHOLD = 3;
const FONT = "11px system-ui, -apple-system, 'Segoe UI', sans-serif";

interface Props {
  symbol: string;
  intervalLabel: string;
  candles: Candle[];
  interval: number;
  view: View;
  onView: (view: View) => void;
  /** Double-click: back to the latest candles. */
  onReset: () => void;
}

/**
 * TradingView-style candlestick chart: candles side by side (no empty nights or weekends), green up
 * and red down, volume underneath, price scale on the right. Scroll or pinch zooms around the
 * pointer, drag or horizontal scroll pans. Drawn on canvas so thousands of candles stay smooth.
 */
export function CandleChart({ symbol, intervalLabel, candles, interval, view, onView, onReset }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 600, height: 400 });
  const [theme, setTheme] = useState(0);
  const [hover, setHover] = useState<{ i: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Canvas colors come from CSS variables; redraw when the color scheme flips.
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const bump = () => setTheme((n) => n + 1);
    mq.addEventListener("change", bump);
    return () => mq.removeEventListener("change", bump);
  }, []);

  const { width, height } = size;
  const plotW = Math.max(1, width - AXIS_RIGHT);
  const plotH = Math.max(1, height - AXIS_BOTTOM - TOP);
  const [from, to] = view;
  const slot = plotW / (to - from);
  /** x of candle i's center. */
  const xOf = (i: number) => (i + 0.5 - from) * slot;
  const indexAt = (x: number) => Math.floor(from + x / slot);

  const first = Math.max(0, Math.floor(from));
  const last = Math.min(candles.length - 1, Math.ceil(to) - 1);

  // Price scale fitted to the visible candles.
  let lo = Infinity;
  let hi = -Infinity;
  let maxVol = 0;
  for (let i = first; i <= last; i++) {
    const c = candles[i]!;
    lo = Math.min(lo, c.low);
    hi = Math.max(hi, c.high);
    maxVol = Math.max(maxVol, c.volume);
  }
  if (lo > hi) [lo, hi] = [0, 1];
  const pad = (hi - lo) * 0.06 || hi * 0.01 || 1;
  const p0 = lo - pad;
  const p1 = hi + pad;
  const priceH = plotH * PRICE_SHARE;
  const yOf = (p: number) => TOP + (1 - (p - p0) / (p1 - p0)) * priceH;
  const priceAt = (y: number) => p0 + (1 - (y - TOP) / priceH) * (p1 - p0);

  const hovered = hover && hover.i >= 0 && hover.i < candles.length ? candles[hover.i]! : null;
  const shownIndex = hovered ? hover!.i : candles.length - 1;
  const shown = candles[shownIndex] ?? null;
  const prevClose = shownIndex > 0 ? candles[shownIndex - 1]!.close : shown?.open;

  // --- drawing ---
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const css = getComputedStyle(canvas);
    const color = (name: string) => css.getPropertyValue(name).trim();
    const up = color("--up");
    const down = color("--down");
    ctx.font = FONT;
    ctx.lineWidth = 1;

    // Grid: price lines, and a line where each time block starts.
    const yTicks = niceTicks(p0, p1, Math.max(3, Math.floor(priceH / 56)));
    const ticks = timeTicks(candles, from, to, Math.max(2, Math.floor(plotW / 90)), interval < DAY);
    const tickX = (i: number) => Math.round((i - from) * slot) + 0.5;
    ctx.strokeStyle = color("--grid");
    ctx.beginPath();
    for (const p of yTicks) {
      const y = Math.round(yOf(p)) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(plotW, y);
    }
    for (const t of ticks) {
      ctx.moveTo(tickX(t.i), TOP);
      ctx.lineTo(tickX(t.i), TOP + plotH);
    }
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotW, TOP + plotH);
    ctx.clip();

    // Gaps from the market being closed: from a session's last close to the next session's opening
    // price, centered on the close→open boundary. Only between trading days; moves within a session
    // aren't marked. Intraday, the band is widened so it reads as a zone rather than a candle; on
    // daily/weekly candles every boundary is a close, so it stays one candle wide.
    ctx.fillStyle = color("--gap");
    ctx.strokeStyle = color("--gap-edge");
    const gapW = Math.max(1, interval < DAY ? Math.max(slot * 2, 18) : slot);
    for (let i = Math.max(first, 1); i <= last; i++) {
      const c = candles[i]!;
      const prev = candles[i - 1]!;
      if (c.day === prev.day || c.open === prev.close) continue;
      const left = Math.round((i - from) * slot - gapW / 2);
      const top = Math.round(yOf(Math.max(c.open, prev.close)));
      const bottom = Math.round(yOf(Math.min(c.open, prev.close)));
      const w = Math.round(gapW);
      ctx.fillRect(left, top, w, Math.max(1, bottom - top));
      ctx.beginPath();
      ctx.moveTo(left, top + 0.5);
      ctx.lineTo(left + w, top + 0.5);
      ctx.moveTo(left, bottom - 0.5);
      ctx.lineTo(left + w, bottom - 0.5);
      ctx.stroke();
    }

    // Volume, faint, along the bottom.
    const bodyW = Math.max(1, Math.min(slot * BODY, MAX_BODY));
    const volBase = TOP + plotH;
    if (maxVol > 0) {
      ctx.globalAlpha = 0.3;
      for (let i = first; i <= last; i++) {
        const c = candles[i]!;
        const h = (c.volume / maxVol) * plotH * VOLUME_SHARE;
        ctx.fillStyle = c.close >= c.open ? up : down;
        ctx.fillRect(Math.round(xOf(i) - bodyW / 2), Math.round(volBase - h), Math.max(1, Math.round(bodyW)), Math.ceil(h));
      }
      ctx.globalAlpha = 1;
    }

    // Candles: wick, then a solid body in the up/down color.
    for (let i = first; i <= last; i++) {
      const c = candles[i]!;
      const ink = c.close >= c.open ? up : down;
      const cx = Math.round(xOf(i)) + 0.5;
      ctx.strokeStyle = ink;
      ctx.beginPath();
      ctx.moveTo(cx, Math.round(yOf(c.high)));
      ctx.lineTo(cx, Math.round(yOf(c.low)));
      ctx.stroke();
      if (bodyW >= 3) {
        const top = Math.round(yOf(Math.max(c.open, c.close)));
        const h = Math.max(1, Math.round(yOf(Math.min(c.open, c.close))) - top);
        ctx.fillStyle = ink;
        ctx.fillRect(Math.round(cx - bodyW / 2), top, Math.round(bodyW), h);
      }
    }

    // Last price: dotted line across the plot.
    const lastC = candles.at(-1);
    const lastInk = lastC && lastC.close >= lastC.open ? up : down;
    if (lastC) {
      ctx.strokeStyle = lastInk;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      const y = Math.round(yOf(lastC.close)) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Crosshair.
    if (hover && !dragging) {
      ctx.strokeStyle = color("--crosshair");
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      const x = Math.round(xOf(hover.i)) + 0.5;
      ctx.moveTo(x, TOP);
      ctx.lineTo(x, TOP + plotH);
      const y = Math.round(hover.y) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();

    // Scales: price on the right, time along the bottom.
    ctx.strokeStyle = color("--axis");
    ctx.beginPath();
    ctx.moveTo(plotW + 0.5, 0);
    ctx.lineTo(plotW + 0.5, TOP + plotH);
    ctx.moveTo(0, TOP + plotH + 0.5);
    ctx.lineTo(width, TOP + plotH + 0.5);
    ctx.stroke();
    ctx.fillStyle = color("--muted");
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const p of yTicks) ctx.fillText(fmtPrice(p), plotW + 8, yOf(p));

    // Time labels, skipping any that would run off the plot or sit under the crosshair's time tag.
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const tagX = hover && !dragging ? xOf(hover.i) : null;
    for (const t of ticks) {
      ctx.font = t.major ? `600 ${FONT}` : FONT;
      const x = tickX(t.i);
      const half = ctx.measureText(t.label).width / 2;
      if (x - half < 2 || x + half > plotW - 2) continue;
      if (tagX != null && Math.abs(x - tagX) < half + 70) continue;
      ctx.fillStyle = color(t.major ? "--text-secondary" : "--muted");
      ctx.fillText(t.label, x, height - 9);
    }
    ctx.font = FONT;

    /** A filled label on a scale, e.g. the last price or the crosshair's time. */
    const tag = (text: string, x: number, y: number, bg: string, centered: boolean) => {
      const w = ctx.measureText(text).width + 12;
      const left = centered ? Math.min(Math.max(x - w / 2, 0), plotW - w) : x;
      ctx.fillStyle = bg;
      ctx.fillRect(left, y - 10, w, 20);
      ctx.fillStyle = color("--tag-text");
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(text, left + 6, y);
    };
    if (lastC) {
      const y = Math.min(Math.max(yOf(lastC.close), TOP + 10), TOP + plotH - 10);
      tag(fmtPrice(lastC.close), plotW + 1, y, lastInk, false);
    }
    if (hover && !dragging && hovered) {
      tag(fmtPrice(priceAt(hover.y)), plotW + 1, hover.y, color("--tag"), false);
      tag(fmtCandleTime(hovered, interval), xOf(hover.i), TOP + plotH + 14, color("--tag"), true);
    }
  }, [candles, width, height, from, to, hover, dragging, theme, interval]);

  // --- interaction ---
  const latest = useRef({ view, onView, count: candles.length, plotW });
  latest.current = { view, onView, count: candles.length, plotW };

  // Wheel needs a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { view: [a, b], onView, count, plotW } = latest.current;
      const span = b - a;
      const scale = e.deltaMode === 1 ? 16 : 1; // lines → pixels
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const shift = ((e.deltaX * scale) / plotW) * span;
        onView(clampView([a + shift, b + shift], count));
      } else {
        const rect = canvas.getBoundingClientRect();
        const anchor = a + ((e.clientX - rect.left) / plotW) * span;
        const factor = Math.exp(e.deltaY * scale * (e.ctrlKey ? 0.01 : 0.002));
        onView(clampView([anchor - (anchor - a) * factor, anchor + (b - anchor) * factor], count));
      }
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  const drag = useRef<{ x: number; moved: boolean } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (d) {
      const dx = e.clientX - d.x;
      if (!d.moved && Math.abs(dx) < DRAG_THRESHOLD) return;
      if (!d.moved) {
        d.moved = true;
        setDragging(true);
      }
      d.x = e.clientX;
      const shift = (-dx / plotW) * (to - from);
      onView(clampView([from + shift, to + shift], candles.length));
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const inPlot = x >= 0 && x < plotW && y >= TOP && y <= TOP + plotH;
    const i = indexAt(x);
    setHover(inPlot && i >= 0 && i < candles.length ? { i, y } : null);
  };
  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };

  const isUp = shown != null && prevClose != null && shown.close >= prevClose;
  const prevCandle = shownIndex > 0 ? candles[shownIndex - 1] : undefined;
  const gap = shown && prevCandle && prevCandle.day !== shown.day && shown.open !== prevCandle.close ? (shown.open / prevCandle.close - 1) * 100 : null;

  return (
    <div className="chart" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className={dragging ? "is-dragging" : undefined}
        style={{ width, height }}
        role="img"
        aria-label={`${symbol} ${intervalLabel} candlestick chart. Scroll to zoom, drag to move through time, double-click for the latest candles.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => !drag.current && setHover(null)}
        onDoubleClick={onReset}
      />
      {shown && prevClose != null && (
        <div className="legend">
          <span className="legend-symbol">
            {symbol} · {intervalLabel}
          </span>
          {(["open", "high", "low", "close"] as const).map((k) => (
            <span key={k} className="legend-value">
              <span className="legend-key">{k[0]!.toUpperCase()}</span>
              <span className={isUp ? "up" : "down"}>{fmtPrice(shown[k])}</span>
            </span>
          ))}
          <span className={`legend-value ${isUp ? "up" : "down"}`}>{fmtChange(prevClose, shown.close)}</span>
          {gap != null && (
            <span className="legend-value legend-gap">
              <span className="legend-key">Gap from close</span>
              {gap >= 0 ? "+" : "−"}
              {Math.abs(gap).toFixed(2)}%
            </span>
          )}
          <span className="legend-value">
            <span className="legend-key">Vol</span>
            {fmtVolume(shown.volume)}
          </span>
        </div>
      )}
      {!candles.length && <div className="chart-empty">No data</div>}
    </div>
  );
}
