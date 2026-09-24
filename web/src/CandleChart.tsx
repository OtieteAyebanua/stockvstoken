import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  candleAt,
  fmtAxisPrice,
  fmtPrice,
  fmtSpan,
  inGap,
  niceTicks,
  sliceWindow,
  timeAxisTicks,
  visibleGaps,
  type Candle,
  type Gap,
  type SeriesKey,
} from "./series";

const HEIGHT = 340;
const PAD = { top: 12, right: 16, bottom: 28, left: 60 };
/** Share of a candle's time span its body fills. */
const BODY = 0.7;
const MAX_BODY = 14;
/** Drags shorter than this are treated as clicks, not pans. */
const DRAG_THRESHOLD = 3;
/** Closed-market zones closer together than this (px on average) are dropped as noise. */
const MIN_CLOSED_SPACING = 6;

interface Props {
  title: string;
  subtitle: string;
  /** Rendered beside the title (e.g. a token picker). Space is reserved either way so plots line up. */
  controls?: ReactNode;
  series: SeriesKey;
  symbol: string;
  /** Every candle at the chosen interval; the chart shows the ones inside `view`. */
  candles: Candle[];
  interval: number;
  /** Visible time window, shared across charts. */
  view: [number, number];
  /** Price scale, shared across charts so they're directly comparable. */
  yDomain: [number, number];
  /** Hovered time, shared across charts. */
  hoverT: number | null;
  onHover: (t: number | null) => void;
  /** Zoom by `factor` (<1 in, >1 out) keeping the time `anchor` under the pointer. */
  onZoom: (anchor: number, factor: number) => void;
  /** Pan by a fraction of the visible window (positive = later). */
  onPan: (fraction: number) => void;
  /** When the US stock market was closed; shaded on the chart. */
  closedGaps: Gap[];
}

/**
 * Candlestick chart on a calendar time axis, so stock and token charts line up moment for moment
 * and market closures show as shaded zones. Drawn on canvas so a year of hourly candles stays
 * smooth. Wheel/pinch zooms, drag or horizontal scroll pans.
 */
export function CandleChart(props: Props) {
  const { title, subtitle, controls, series, symbol, candles, interval, view, yDomain, hoverT, onHover, closedGaps } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const figRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(480);
  const [theme, setTheme] = useState(0);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
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

  const visible = useMemo(() => sliceWindow(candles, view[0], view[1]), [candles, view]);
  const plotW = Math.max(1, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const [v0, v1] = view;
  const x = (t: number) => PAD.left + ((t - v0) / (v1 - v0)) * plotW;
  const [y0, y1] = yDomain;
  const y = (v: number) => PAD.top + (1 - (v - y0) / (y1 - y0)) * plotH;

  const gaps = useMemo(() => visibleGaps(closedGaps, interval, v0, v1), [closedGaps, interval, v0, v1]);
  const xTicks = useMemo(() => timeAxisTicks(v0, v1, Math.max(2, Math.floor(plotW / 75))), [v0, v1, plotW]);

  const hovered = hoverT == null ? null : candleAt(visible, hoverT);
  // Highlight the candle under the crosshair, not the last one before a closure.
  const activeCandle = hovered && !hovered.stale ? hovered.candle : null;

  // --- drawing ---
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const fig = figRef.current;
    if (!canvas || !fig) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, HEIGHT);

    const css = getComputedStyle(fig);
    const color = (name: string) => css.getPropertyValue(name).trim();
    const c = color("--c");
    const surface = color("--surface");

    // Market closed: see-through zones from each close to the next open, behind everything else.
    if (gaps.length && plotW / gaps.length >= MIN_CLOSED_SPACING) {
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.font = "10px system-ui, -apple-system, 'Segoe UI', sans-serif";
      for (const [start, end] of gaps) {
        const left = x(Math.max(start, v0));
        const w = x(Math.min(end, v1)) - left;
        ctx.fillStyle = color("--closed");
        ctx.fillRect(left, PAD.top, w, plotH);
        // Label every zone: across the top if it fits, otherwise running down the zone.
        const label = "Market closed";
        ctx.fillStyle = color("--closed-label");
        if (w >= ctx.measureText(label).width + 8) {
          ctx.fillText(label, left + w / 2, PAD.top + 4);
        } else if (w >= 11) {
          ctx.save();
          ctx.translate(left + w / 2, PAD.top + 4);
          ctx.rotate(Math.PI / 2);
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(label, 0, 0);
          ctx.restore();
        }
      }
    }

    // Grid + price axis
    const yTicks = niceTicks(y0, y1);
    const yStep = (yTicks[1] ?? 1) - (yTicks[0] ?? 0);
    ctx.font = "11px system-ui, -apple-system, 'Segoe UI', sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    for (const v of yTicks) {
      const yy = Math.round(y(v)) + 0.5;
      ctx.strokeStyle = color("--grid");
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD.left, yy);
      ctx.lineTo(PAD.left + plotW, yy);
      ctx.stroke();
      ctx.fillStyle = color("--muted");
      ctx.fillText(fmtAxisPrice(v, yStep), PAD.left - 8, yy);
    }

    // Time axis
    const base = PAD.top + plotH + 0.5;
    ctx.strokeStyle = color("--baseline");
    ctx.beginPath();
    ctx.moveTo(PAD.left, base);
    ctx.lineTo(PAD.left + plotW, base);
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    for (const { t, label } of xTicks) {
      const xx = Math.round(x(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(xx, base);
      ctx.lineTo(xx, base + 4);
      ctx.stroke();
      ctx.fillStyle = color("--muted");
      ctx.fillText(label, xx, HEIGHT - 8);
    }

    // Candles: hollow = up, solid = down, all in the series color.
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.left, PAD.top, plotW, plotH);
    ctx.clip();
    ctx.lineWidth = 1;
    const msToPx = plotW / (v1 - v0);
    for (const k of visible) {
      const bodyW = Math.min((k.end - k.start) * msToPx * BODY, MAX_BODY);
      const cx = Math.round(x((k.start + k.end) / 2)) + 0.5;
      const top = y(Math.max(k.open, k.close));
      const h = Math.max(1, y(Math.min(k.open, k.close)) - top);
      const ink = k === activeCandle ? color("--text-primary") : c;
      ctx.strokeStyle = ink;
      ctx.beginPath();
      ctx.moveTo(cx, y(k.high));
      ctx.lineTo(cx, y(k.low));
      ctx.stroke();
      if (bodyW < 2) continue; // at this density the wick already shows the range
      const left = Math.round(cx - bodyW / 2) + 0.5;
      const w = Math.round(bodyW) - 1;
      if (k.close >= k.open) {
        ctx.fillStyle = surface;
        ctx.fillRect(left, top, w, h);
        ctx.strokeRect(left, top, w, h);
      } else {
        ctx.fillStyle = ink;
        ctx.fillRect(left - 0.5, top - 0.5, w + 1, h + 1);
      }
    }
    ctx.restore();

    // Crosshair
    if (hoverT != null) {
      const xx = Math.round(x(hoverT)) + 0.5;
      ctx.strokeStyle = color("--muted");
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(xx, PAD.top);
      ctx.lineTo(xx, PAD.top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [visible, width, v0, v1, y0, y1, hoverT, activeCandle, theme, gaps, xTicks]);

  // --- interaction ---
  const latest = useRef({ props, plotW });
  latest.current = { props, plotW };

  /** Time at a client x position. */
  const timeAt = (clientX: number) => {
    const { props, plotW } = latest.current;
    const [v0, v1] = props.view;
    const rect = canvasRef.current!.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left - PAD.left) / plotW));
    return v0 + frac * (v1 - v0);
  };

  // Wheel needs a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { props, plotW } = latest.current;
      const scale = e.deltaMode === 1 ? 16 : 1; // lines → pixels
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        props.onPan((e.deltaX * scale) / plotW);
      } else {
        props.onZoom(timeAt(e.clientX), Math.exp(e.deltaY * scale * (e.ctrlKey ? 0.01 : 0.0015)));
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
        onHover(null);
      }
      d.x = e.clientX;
      props.onPan(-dx / plotW);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const inPlot = e.clientX - rect.left >= PAD.left && e.clientX - rect.left <= PAD.left + plotW;
    onHover(inPlot ? timeAt(e.clientX) : null);
  };
  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };

  const tooltipRight = hoverT != null && x(hoverT) < PAD.left + plotW / 2;

  return (
    <figure className={`chart series-${series}`} ref={figRef}>
      <figcaption>
        <div className="chart-heading">
          <div>
            <div className="chart-title">{title}</div>
            <div className="chart-subtitle">{subtitle}</div>
          </div>
          <div className="chart-controls">{controls}</div>
        </div>
      </figcaption>

      <div className="chart-plot" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className={dragging ? "is-dragging" : undefined}
          style={{ width, height: HEIGHT }}
          role="img"
          aria-label={`${symbol} candlestick chart, ${subtitle}. Scroll to zoom, drag to pan.`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={() => !drag.current && onHover(null)}
        />

        {visible.length === 0 && <div className="chart-empty">No data in this window</div>}

        {hovered && !dragging && (
          <div className="tooltip" style={tooltipRight ? { right: PAD.right + 4 } : { left: PAD.left + 4 }}>
            <div className="tooltip-time">
              <span className={`key key-${series}`} />
              {symbol} · {fmtSpan(hovered.candle, interval)}
            </div>
            <dl className="ohlc">
              {(["open", "high", "low", "close"] as const).map((k) => (
                <div key={k}>
                  <dt>{k[0]!.toUpperCase()}</dt>
                  <dd>{fmtPrice(hovered.candle[k])}</dd>
                </div>
              ))}
            </dl>
            <div className="tooltip-note">{changeLabel(hovered.candle)}</div>
            {hovered.stale && <div className="tooltip-note">No candle here · showing the last one</div>}
            {hoverT != null && inGap(closedGaps, hoverT) && <div className="tooltip-note">US stock market closed</div>}
          </div>
        )}
      </div>
    </figure>
  );
}

function changeLabel(c: Candle) {
  const d = ((c.close - c.open) / c.open) * 100;
  return `${d >= 0 ? "▲ +" : "▼ −"}${Math.abs(d).toFixed(2)}% open → close`;
}
