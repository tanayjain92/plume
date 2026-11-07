import { useEffect, useMemo, useRef, useState } from 'react';
import type { Frame, GridInfo } from '../worker/protocol';
import { LUT_DIVERGING, LUT_SEQUENTIAL, lutGradient } from './colormap';
import { cellCenter, sliceGeometry, type SliceAxis } from './slice';
import { fmtLength, fmtSpeed, fmtTemp, type UnitSystem } from './units';

export type FieldKind = 'temperature' | 'speed' | 'divergence' | 'pressure';

export interface Overlays {
  arrows: boolean;
  particles: boolean;
  drafts: boolean;
}

export interface Marker {
  orientation: 'vertical' | 'horizontal';
  /** Position in slice cell coordinates (a for vertical, b for horizontal). */
  at: number;
  label: string;
}

interface Props {
  title: string;
  grid: GridInfo;
  frame: Frame | null;
  axis: SliceAxis;
  index: number;
  field: FieldKind;
  overlays: Overlays;
  tempCenter: number;
  tempHalfRange: number;
  draftThreshold: number;
  units: UnitSystem;
  marker?: Marker;
  dragHint?: string;
  onDrag?: (a: number, b: number) => void;
}

const SOLID = 1; // CellType.Solid; UI only needs "not fluid"
const ARROW_REF_SPEED = 0.5; // m/s that draws a full-length arrow
const STREAK_SECONDS = 0.35;
const WALL_COLOR = '#2b2f38';

interface Legend {
  lut: Uint8Array;
  left: string;
  mid: string;
  right: string;
  caption: string;
}

export function SliceView(props: Props) {
  const { grid, frame, axis, index, field, units } = props;
  const geom = useMemo(() => sliceGeometry(grid, axis, index), [grid, axis, index]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const heatRef = useRef<HTMLCanvasElement | null>(null);
  const [cellPx, setCellPx] = useState(12);
  const [hover, setHover] = useState<{ a: number; b: number } | null>(null);
  const [legend, setLegend] = useState<Legend | null>(null);

  // Latest props for the animation loop without restarting it.
  const live = useRef({ props, geom, cellPx, hover });
  live.current = { props, geom, cellPx, hover };

  // Per-slice data derived from the latest frame, consumed by the RAF loop.
  const sliceData = useRef<{ va: Float32Array; vb: Float32Array; speed: Float32Array; solid: Uint8Array } | null>(null);

  // Fit the slice to the container width.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const width = el.clientWidth;
      setCellPx(Math.max(4, Math.min(24, Math.floor(width / geom.W))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [geom.W]);

  // Rebuild the heatmap image and slice velocity arrays when data or color settings change.
  useEffect(() => {
    const { W, H, cell } = geom;
    const solid = new Uint8Array(W * H);
    for (let b = 0; b < H; b++) for (let a = 0; a < W; a++) solid[a + W * b] = grid.cellType[cell(a, b)] === 0 ? 0 : SOLID;

    if (!heatRef.current) heatRef.current = document.createElement('canvas');
    const heat = heatRef.current;
    heat.width = W;
    heat.height = H;
    const ctx = heat.getContext('2d')!;
    const img = ctx.createImageData(W, H);

    if (!frame) {
      sliceData.current = null;
      ctx.clearRect(0, 0, W, H);
      setLegend(null);
      return;
    }

    const va = new Float32Array(W * H);
    const vb = new Float32Array(W * H);
    const speed = new Float32Array(W * H);
    const A = frame[geom.velA];
    const B = frame[geom.velB];
    for (let b = 0; b < H; b++)
      for (let a = 0; a < W; a++) {
        const c = cell(a, b);
        const s = a + W * b;
        va[s] = A[c];
        vb[s] = B[c];
        speed[s] = Math.hypot(frame.ux[c], frame.uy[c], frame.uz[c]);
      }
    sliceData.current = { va, vb, speed, solid };

    // Field -> [0,1] mapping and legend.
    let lut = LUT_DIVERGING;
    let value: (c: number, s: number) => number;
    let lo: number;
    let hi: number;
    let lg: Legend;
    if (field === 'temperature') {
      const { tempCenter: c0, tempHalfRange: r } = props;
      lo = c0 - r;
      hi = c0 + r;
      value = (c) => frame.T[c];
      lg = { lut, left: fmtTemp(lo, units), mid: fmtTemp(c0, units), right: fmtTemp(hi, units), caption: 'Temperature' };
    } else if (field === 'speed') {
      lut = LUT_SEQUENTIAL;
      lo = 0;
      hi = ARROW_REF_SPEED;
      value = (_c, s) => speed[s];
      lg = { lut, left: fmtSpeed(0, units), mid: fmtSpeed(hi / 2, units), right: fmtSpeed(hi, units), caption: 'Air speed' };
    } else {
      const arr = field === 'divergence' ? frame.div : frame.p;
      let mx = 0;
      for (let b = 0; b < H; b++)
        for (let a = 0; a < W; a++) if (!solid[a + W * b]) mx = Math.max(mx, Math.abs(arr[cell(a, b)]));
      mx = Math.max(mx, field === 'divergence' ? 1e-7 : 1e-6);
      lo = -mx;
      hi = mx;
      value = (c) => arr[c];
      const f = (v: number) => (field === 'divergence' ? `${v.toExponential(1)} 1/s` : `${v.toFixed(3)} Pa`);
      lg = {
        lut,
        left: f(-mx),
        mid: '0',
        right: f(mx),
        caption: field === 'divergence' ? 'Divergence (should be ~0 everywhere)' : 'Pressure relative to room mean',
      };
    }

    const span = hi - lo || 1;
    const rgb = new Uint8Array(W * H * 3);
    for (let b = 0; b < H; b++)
      for (let a = 0; a < W; a++) {
        const s = a + W * b;
        if (solid[s]) continue;
        const t = Math.max(0, Math.min(1, (value(cell(a, b), s) - lo) / span));
        const li = Math.round(t * 255) * 3;
        rgb[s * 3] = lut[li];
        rgb[s * 3 + 1] = lut[li + 1];
        rgb[s * 3 + 2] = lut[li + 2];
      }
    // Solid cells borrow a fluid neighbor's color so smoothing doesn't bleed wall gray into the room.
    for (let b = 0; b < H; b++)
      for (let a = 0; a < W; a++) {
        const s = a + W * b;
        if (!solid[s]) continue;
        const nbs = [a > 0 ? s - 1 : -1, a < W - 1 ? s + 1 : -1, b > 0 ? s - W : -1, b < H - 1 ? s + W : -1];
        const nb = nbs.find((n) => n >= 0 && !solid[n]);
        if (nb === undefined) continue;
        rgb[s * 3] = rgb[nb * 3];
        rgb[s * 3 + 1] = rgb[nb * 3 + 1];
        rgb[s * 3 + 2] = rgb[nb * 3 + 2];
      }
    // Flip vertically so +b points up.
    for (let b = 0; b < H; b++)
      for (let a = 0; a < W; a++) {
        const s = a + W * b;
        const p = (a + W * (H - 1 - b)) * 4;
        img.data[p] = rgb[s * 3];
        img.data[p + 1] = rgb[s * 3 + 1];
        img.data[p + 2] = rgb[s * 3 + 2];
        img.data[p + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    setLegend(lg);
  }, [frame, geom, field, props.tempCenter, props.tempHalfRange, units, grid]);

  // Animation loop: heatmap, walls, drafts, arrows, particles, markers.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    let last = performance.now();
    const N_MAX = 2500;
    const px = new Float32Array(N_MAX);
    const py = new Float32Array(N_MAX);
    const age = new Float32Array(N_MAX);
    const life = new Float32Array(N_MAX);
    let seeded = false;
    let seededFor = '';

    const respawn = (i: number, W: number, H: number, solid: Uint8Array) => {
      for (let tries = 0; tries < 50; tries++) {
        const x = Math.random() * W;
        const y = Math.random() * H;
        if (!solid[Math.floor(x) + W * Math.floor(y)]) {
          px[i] = x;
          py[i] = y;
          age[i] = 0;
          life[i] = 2 + Math.random() * 4;
          return;
        }
      }
    };

    const sampleVel = (x: number, y: number, W: number, H: number, va: Float32Array, vb: Float32Array): [number, number] => {
      const gx = Math.max(0, Math.min(W - 1.001, x - 0.5));
      const gy = Math.max(0, Math.min(H - 1.001, y - 0.5));
      const i0 = Math.floor(gx);
      const j0 = Math.floor(gy);
      const fx = gx - i0;
      const fy = gy - j0;
      const s = i0 + W * j0;
      const bil = (a: Float32Array) =>
        (a[s] * (1 - fx) + a[s + 1] * fx) * (1 - fy) + (a[s + W] * (1 - fx) + a[s + W + 1] * fx) * fy;
      return [bil(va), bil(vb)];
    };

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const { props: p, geom: g, cellPx: cp, hover: hv } = live.current;
      const { W, H } = g;
      const cssW = W * cp;
      const cssH = H * cp;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const sd = sliceData.current;
      const heat = heatRef.current;
      if (heat && sd && heat.width === W && heat.height === H) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(heat, 0, 0, cssW, cssH);
      }

      const X = (a: number) => a * cp;
      const Y = (b: number) => (H - b) * cp;

      // Walls / solids, crisp.
      if (sd) {
        ctx.fillStyle = WALL_COLOR;
        for (let b = 0; b < H; b++)
          for (let a = 0; a < W; a++) if (sd.solid[a + W * b]) ctx.fillRect(X(a), Y(b + 1), cp + 0.5, cp + 0.5);
      }

      if (sd && p.overlays.drafts) {
        ctx.fillStyle = 'rgba(190, 120, 255, 0.28)';
        ctx.strokeStyle = 'rgba(210, 160, 255, 0.55)';
        ctx.lineWidth = 1;
        for (let b = 0; b < H; b++)
          for (let a = 0; a < W; a++) {
            const s = a + W * b;
            if (!sd.solid[s] && sd.speed[s] > p.draftThreshold) ctx.fillRect(X(a), Y(b + 1), cp, cp);
          }
      }

      if (sd && p.overlays.arrows) {
        const stride = Math.max(2, Math.round(W / 20));
        ctx.lineCap = 'round';
        for (let b = Math.floor(stride / 2); b < H; b += stride)
          for (let a = Math.floor(stride / 2); a < W; a += stride) {
            const s = a + W * b;
            if (sd.solid[s]) continue;
            const vx = sd.va[s];
            const vy = sd.vb[s];
            const sp = Math.hypot(vx, vy);
            if (sp < 0.005) continue;
            const frac = Math.min(1, sp / ARROW_REF_SPEED);
            const len = Math.max(3, frac * stride * cp * 0.9);
            const ux = vx / sp;
            const uy = -vy / sp; // canvas y is down
            const x0 = X(a + 0.5) - (ux * len) / 2;
            const y0 = Y(b + 0.5) - (uy * len) / 2;
            const x1 = x0 + ux * len;
            const y1 = y0 + uy * len;
            ctx.strokeStyle = `rgba(20, 22, 28, ${0.3 + 0.7 * frac})`;
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(x1, y1);
            const head = Math.min(6, len * 0.4);
            ctx.lineTo(x1 - ux * head - uy * head * 0.5, y1 - uy * head + ux * head * 0.5);
            ctx.moveTo(x1, y1);
            ctx.lineTo(x1 - ux * head + uy * head * 0.5, y1 - uy * head - ux * head * 0.5);
            ctx.stroke();
          }
      }

      if (sd && p.overlays.particles) {
        const key = `${W}x${H}`;
        const count = Math.min(N_MAX, Math.round(W * H * 1.2));
        if (!seeded || seededFor !== key) {
          for (let i = 0; i < count; i++) {
            respawn(i, W, H, sd.solid);
            age[i] = Math.random() * life[i];
          }
          seeded = true;
          seededFor = key;
        }
        const ih = 1 / grid.h;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        for (let i = 0; i < count; i++) {
          const [vx, vy] = sampleVel(px[i], py[i], W, H, sd.va, sd.vb);
          // particles move at true speed: m/s -> cells/s
          px[i] += vx * ih * dt;
          py[i] += vy * ih * dt;
          age[i] += dt;
          const ci = Math.floor(px[i]) + W * Math.floor(py[i]);
          if (age[i] > life[i] || px[i] < 0 || py[i] < 0 || px[i] >= W || py[i] >= H || sd.solid[ci]) {
            respawn(i, W, H, sd.solid);
            continue;
          }
          const tail = Math.max(0.15, Math.hypot(vx, vy) * ih * STREAK_SECONDS);
          const sp = Math.hypot(vx, vy) || 1;
          ctx.moveTo(X(px[i]), Y(py[i]));
          ctx.lineTo(X(px[i] - (vx / sp) * tail), Y(py[i] - (vy / sp) * tail));
        }
        ctx.stroke();
      }

      if (p.marker) {
        ctx.save();
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = 'rgba(255, 210, 80, 0.95)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (p.marker.orientation === 'vertical') {
          ctx.moveTo(X(p.marker.at), 0);
          ctx.lineTo(X(p.marker.at), cssH);
        } else {
          ctx.moveTo(0, Y(p.marker.at));
          ctx.lineTo(cssW, Y(p.marker.at));
        }
        ctx.stroke();
        ctx.restore();
      }

      if (hv) {
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(X(Math.floor(hv.a)), Y(Math.floor(hv.b) + 1), cp, cp);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [grid]);

  const toCells = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const a = ((e.clientX - rect.left) / rect.width) * geom.W;
    const b = geom.H - ((e.clientY - rect.top) / rect.height) * geom.H;
    return { a, b };
  };

  let readout = ' ';
  if (hover && frame) {
    const a = Math.floor(hover.a);
    const b = Math.floor(hover.b);
    if (a >= 0 && b >= 0 && a < geom.W && b < geom.H) {
      const c = geom.cell(a, b);
      const pos = `${geom.axisA} ${fmtLength(cellCenter(grid, geom.axisA, a), units)}, ${geom.axisB} ${fmtLength(cellCenter(grid, geom.axisB, b), units)}`;
      if (grid.cellType[c] !== 0) readout = `${pos} · wall`;
      else {
        const sp = Math.hypot(frame.ux[c], frame.uy[c], frame.uz[c]);
        const vert = frame.uz[c];
        readout = `${pos} · ${fmtTemp(frame.T[c], units)} · ${fmtSpeed(sp, units)}${
          Math.abs(vert) > 0.01 ? (vert > 0 ? ' rising' : ' sinking') : ''
        }`;
        if (field === 'divergence') readout += ` · div ${frame.div[c].toExponential(1)} 1/s`;
        if (field === 'pressure') readout += ` · ${frame.p[c].toFixed(3)} Pa`;
      }
    }
  }

  return (
    <section className="slice">
      <header className="slice-head">
        <h2>{props.title}</h2>
        {props.dragHint && <span className="hint">{props.dragHint}</span>}
      </header>
      <div ref={wrapRef} className="slice-canvas-wrap">
        <canvas
          ref={canvasRef}
          className={props.onDrag ? 'draggable' : undefined}
          onPointerDown={(e) => {
            if (!props.onDrag) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            const { a, b } = toCells(e);
            props.onDrag(a, b);
          }}
          onPointerMove={(e) => {
            const pt = toCells(e);
            setHover(pt);
            if (props.onDrag && e.buttons & 1) props.onDrag(pt.a, pt.b);
          }}
          onPointerLeave={() => setHover(null)}
        />
      </div>
      <div className="readout">{readout}</div>
      {legend && (
        <div className="legend">
          <div className="legend-caption">{legend.caption}</div>
          <div className="legend-bar" style={{ background: lutGradient(legend.lut) }} />
          <div className="legend-labels">
            <span>{legend.left}</span>
            <span>{legend.mid}</span>
            <span>{legend.right}</span>
          </div>
        </div>
      )}
    </section>
  );
}

