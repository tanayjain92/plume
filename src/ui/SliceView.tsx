import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
}

/** A device drawn on the slice, in slice cell coordinates. */
export interface Glyph {
  id: string;
  a0: number;
  b0: number;
  a1: number;
  b1: number;
  /** In-plane direction of the air it pushes, unit-ish. */
  dir?: [number, number];
  intake?: boolean;
  color: string;
  label: string;
  selected: boolean;
  /** Turned off, or not crossing this slice. */
  faded: boolean;
  dashed?: boolean;
  /** Placement preview under the cursor. */
  ghost?: boolean;
  /** Polygon in slice cell coords instead of a box (sunlit floor patches). */
  poly?: [number, number][];
  /** Draw an arrow from the center to this point instead of the dir arrow (the sun). */
  arrowTo?: [number, number];
  round?: boolean;
  /** Shaded solid (the user picked a color for it): opaque, so particles don't show through. */
  filled?: boolean;
  /** Draw it as what it is instead of a box (a person, or a kind of fan). */
  look?: Look;
  /** In-plane direction it faces (slice coords, b up), for drawing fans. */
  facing?: [number, number];
  /** Always-visible value tag next to the glyph (sensor readings). */
  badge?: string;
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
  glyphs: Glyph[];
  dragHint?: string;
  onPointerDown?: (a: number, b: number) => void;
  onPointerDrag?: (a: number, b: number) => void;
  onPointerUp?: () => void;
  onHover?: (pt: { a: number; b: number } | null) => void;
  onDoubleClick?: (a: number, b: number) => void;
  /** Margin (cells) drawn around the grid, so things outside the room (the sun) are visible. */
  pad?: number;
  /** Resize/aim handles of the selected object, slice cell coords. */
  handles?: { id: string; a: number; b: number }[];
  /** Floating quick-action bar anchored above a point (slice cell coords). */
  actionBar?: { a: number; b: number; node: ReactNode };
  /** Room outline in slice cell coords; polygon glyphs are clipped to it. */
  clipPoly?: [number, number][];
  cursor?: string;
}

const ARROW_REF_SPEED = 0.5; // m/s that draws a full-length arrow
const STREAK_SECONDS = 0.35;
const WALL_COLOR = '#2b2f38';
const OPEN_COLOR = '#6ec6ff';
const SLAB_HALF = 1.5; // particles live within ±1.5 cells of the slice plane

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
  const pad = props.pad ?? 0;

  // Latest props for the animation loop without restarting it.
  const live = useRef({ props, geom, cellPx, hover });
  live.current = { props, geom, cellPx, hover };

  // Per-slice data derived from the latest frame, consumed by the RAF loop.
  const sliceData = useRef<{ va: Float32Array; vb: Float32Array; speed: Float32Array; cellKind: Uint8Array } | null>(null);

  // Fit the slice to the container width.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // Fit both the width of the panel and the height left in the window (room for the legend below).
    const fit = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      const availH = Math.max(420, window.innerHeight - top - 80);
      setCellPx(Math.max(4, Math.min(40,Math.floor(el.clientWidth / (geom.W + 2 * pad)), Math.floor(availH / (geom.H + 2 * pad)))));
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener('resize', fit);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, [geom.W, geom.H, pad]);

  // Rebuild the heatmap image and slice arrays when data or color settings change.
  useEffect(() => {
    const { W, H, cell } = geom;
    // 0 fluid, 1 solid, 4 open (matches CellType)
    const cellKind = new Uint8Array(W * H);
    for (let b = 0; b < H; b++) for (let a = 0; a < W; a++) cellKind[a + W * b] = grid.cellType[cell(a, b)];

    if (!heatRef.current) heatRef.current = document.createElement('canvas');
    const heat = heatRef.current;
    heat.width = W;
    heat.height = H;
    const ctx = heat.getContext('2d')!;
    const img = ctx.createImageData(W, H);

    if (!frame || frame.T.length !== grid.nx * grid.ny * grid.nz) {
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
    sliceData.current = { va, vb, speed, cellKind };

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
        for (let a = 0; a < W; a++) if (cellKind[a + W * b] === 0) mx = Math.max(mx, Math.abs(arr[cell(a, b)]));
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
        caption: field === 'divergence' ? 'Divergence error (should be ~0 everywhere)' : 'Pressure relative to room mean',
      };
    }

    const span = hi - lo || 1;
    const rgb = new Uint8Array(W * H * 3);
    for (let b = 0; b < H; b++)
      for (let a = 0; a < W; a++) {
        const s = a + W * b;
        if (cellKind[s] !== 0) continue;
        const t = Math.max(0, Math.min(1, (value(cell(a, b), s) - lo) / span));
        const li = Math.round(t * 255) * 3;
        rgb[s * 3] = lut[li];
        rgb[s * 3 + 1] = lut[li + 1];
        rgb[s * 3 + 2] = lut[li + 2];
      }
    // Non-fluid cells borrow a fluid neighbor's color so smoothing doesn't bleed wall gray into the room.
    for (let b = 0; b < H; b++)
      for (let a = 0; a < W; a++) {
        const s = a + W * b;
        if (cellKind[s] === 0) continue;
        const nbs = [a > 0 ? s - 1 : -1, a < W - 1 ? s + 1 : -1, b > 0 ? s - W : -1, b < H - 1 ? s + W : -1];
        const nb = nbs.find((nn) => nn >= 0 && cellKind[nn] === 0);
        if (nb === undefined) continue;
        rgb[s * 3] = rgb[nb * 3];
        rgb[s * 3 + 1] = rgb[nb * 3 + 1];
        rgb[s * 3 + 2] = rgb[nb * 3 + 2];
      }
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

  // Animation loop: heatmap, walls, drafts, arrows, particles, glyphs, markers.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    let last = performance.now();
    const N_MAX = 2500;
    // 3D particle positions in grid cell coordinates (cell i spans [i, i+1)).
    const px = new Float32Array(N_MAX);
    const py = new Float32Array(N_MAX);
    const pz = new Float32Array(N_MAX);
    const age = new Float32Array(N_MAX);
    const life = new Float32Array(N_MAX);
    let seededFor = '';

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const { props: p, geom: g, cellPx: cp, hover: hv } = live.current;
      const { grid: gr, frame: fr } = p;
      const { W, H } = g;
      const P = p.pad ?? 0;
      const cssW = (W + 2 * P) * cp;
      const cssH = (H + 2 * P) * cp;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      if (P > 0) {
        // outdoors
        ctx.fillStyle = '#18202b';
        ctx.fillRect(0, 0, cssW, cssH);
        ctx.fillStyle = 'rgba(144, 151, 167, 0.5)';
        ctx.font = '11px Inter, Segoe UI, system-ui, sans-serif';
        ctx.fillText('outside', 6, 14);
      }

      const sd = sliceData.current;
      const heat = heatRef.current;
      if (heat && sd && heat.width === W && heat.height === H) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(heat, P * cp, P * cp, W * cp, H * cp);
      }

      const X = (a: number) => (a + P) * cp;
      const Y = (b: number) => (H + P - b) * cp;

      if (sd) {
        for (let b = 0; b < H; b++)
          for (let a = 0; a < W; a++) {
            const k = sd.cellKind[a + W * b];
            if (k === 0) continue;
            ctx.fillStyle = k === 4 ? OPEN_COLOR : WALL_COLOR;
            ctx.fillRect(X(a), Y(b + 1), cp + 0.5, cp + 0.5);
          }
      }

      if (sd && p.overlays.drafts) {
        ctx.fillStyle = 'rgba(190, 120, 255, 0.28)';
        for (let b = 0; b < H; b++)
          for (let a = 0; a < W; a++) {
            const s = a + W * b;
            if (sd.cellKind[s] === 0 && sd.speed[s] > p.draftThreshold) ctx.fillRect(X(a), Y(b + 1), cp, cp);
          }
      }

      if (sd && p.overlays.arrows) {
        const stride = Math.max(2, Math.round(W / 20));
        ctx.lineCap = 'round';
        for (let b = Math.floor(stride / 2); b < H; b += stride)
          for (let a = Math.floor(stride / 2); a < W; a += stride) {
            const s = a + W * b;
            if (sd.cellKind[s] !== 0) continue;
            const vx = sd.va[s];
            const vy = sd.vb[s];
            const sp = Math.hypot(vx, vy);
            if (sp < 0.005) continue;
            const frac = Math.min(1, sp / ARROW_REF_SPEED);
            drawArrow(ctx, X(a + 0.5), Y(b + 0.5), vx / sp, -vy / sp, Math.max(3, frac * stride * cp * 0.9), `rgba(20, 22, 28, ${0.3 + 0.7 * frac})`, 1.6);
          }
      }

      // 3D particles inside a thin slab around the slice, projected onto it.
      if (sd && fr && p.overlays.particles && fr.ux.length === gr.nx * gr.ny * gr.nz) {
        const { nx, ny, nz } = gr;
        const ext = [nx, ny, nz];
        const nAxis = p.axis === 'x' ? 0 : p.axis === 'y' ? 1 : 2;
        const aAxis = g.axisA === 'x' ? 0 : 1;
        const bAxis = g.axisB === 'y' ? 1 : 2;
        const center = p.index + 0.5;
        const count = Math.min(N_MAX, Math.round(W * H * 1.2));
        const pos = [px, py, pz];
        const fluidAt = (x: number, y: number, z: number) => {
          const i = Math.floor(x);
          const j = Math.floor(y);
          const k = Math.floor(z);
          if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return false;
          return gr.cellType[i + nx * (j + ny * k)] === 0;
        };
        const respawn = (i: number) => {
          for (let tries = 0; tries < 40; tries++) {
            const q = [0, 0, 0];
            q[aAxis] = Math.random() * ext[aAxis];
            q[bAxis] = Math.random() * ext[bAxis];
            q[nAxis] = center + (Math.random() * 2 - 1) * SLAB_HALF;
            if (fluidAt(q[0], q[1], q[2])) {
              px[i] = q[0];
              py[i] = q[1];
              pz[i] = q[2];
              age[i] = 0;
              life[i] = 2 + Math.random() * 4;
              return;
            }
          }
          life[i] = 0;
        };
        const key = `${p.axis}:${p.index}:${nx}x${ny}x${nz}`;
        if (seededFor !== key) {
          for (let i = 0; i < count; i++) {
            respawn(i);
            age[i] = Math.random() * life[i];
          }
          seededFor = key;
        }
        const ih = 1 / gr.h;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        for (let i = 0; i < count; i++) {
          const vx = sample3(fr.ux, nx, ny, nz, px[i], py[i], pz[i]);
          const vy = sample3(fr.uy, nx, ny, nz, px[i], py[i], pz[i]);
          const vz = sample3(fr.uz, nx, ny, nz, px[i], py[i], pz[i]);
          px[i] += vx * ih * dt; // particles move at true speed: m/s -> cells/s
          py[i] += vy * ih * dt;
          pz[i] += vz * ih * dt;
          age[i] += dt;
          if (age[i] > life[i] || Math.abs(pos[nAxis][i] - center) > SLAB_HALF || !fluidAt(px[i], py[i], pz[i])) {
            respawn(i);
            continue;
          }
          const v = [vx, vy, vz];
          const va = v[aAxis];
          const vb = v[bAxis];
          const sp = Math.hypot(va, vb) || 1;
          const tail = Math.max(0.15, Math.hypot(va, vb) * ih * STREAK_SECONDS);
          const a = pos[aAxis][i];
          const b = pos[bAxis][i];
          // The slab is a few cells thick; don't draw particles over cells that are wall in this plane.
          if (sd.cellKind[Math.floor(a) + W * Math.floor(b)] !== 0) continue;
          ctx.moveTo(X(a), Y(b));
          ctx.lineTo(X(a - (va / sp) * tail), Y(b - (vb / sp) * tail));
        }
        ctx.stroke();
      }

      // Device glyphs.
      ctx.font = '11px Inter, Segoe UI, system-ui, sans-serif';
      for (const gl of p.glyphs) {
        if (gl.poly) {
          ctx.save();
          if (p.clipPoly) {
            ctx.beginPath();
            p.clipPoly.forEach(([a, b], i) => (i ? ctx.lineTo(X(a), Y(b)) : ctx.moveTo(X(a), Y(b))));
            ctx.closePath();
            ctx.clip();
          }
          ctx.globalAlpha = gl.faded ? 0.25 : gl.ghost ? 0.4 : 0.55;
          ctx.fillStyle = gl.color;
          ctx.beginPath();
          gl.poly.forEach(([a, b], i) => (i ? ctx.lineTo(X(a), Y(b)) : ctx.moveTo(X(a), Y(b))));
          ctx.closePath();
          ctx.fill();
          ctx.globalAlpha = 1;
          if (gl.selected) {
            ctx.strokeStyle = '#ffd250';
            ctx.lineWidth = 2.5;
            ctx.setLineDash([6, 4]);
            ctx.stroke();
            ctx.setLineDash([]);
          }
          ctx.restore();
          continue;
        }
        const x0 = X(Math.min(gl.a0, gl.a1));
        const x1 = X(Math.max(gl.a0, gl.a1));
        const y0 = Y(Math.max(gl.b0, gl.b1));
        const y1 = Y(Math.min(gl.b0, gl.b1));
        const w = Math.max(3, x1 - x0);
        const hgt = Math.max(3, y1 - y0);
        ctx.globalAlpha = gl.ghost ? 0.75 : gl.faded ? 0.35 : 1;
        ctx.setLineDash(gl.dashed || gl.ghost ? [4, 3] : []);
        // colored objects get a dark outline so their details (a head, fan blades) still show
        ctx.strokeStyle = gl.selected || gl.ghost ? '#ffd250' : gl.filled ? 'rgba(0, 0, 0, 0.55)' : gl.color;
        ctx.lineWidth = gl.selected ? 2.5 : 1.5;
        if (gl.round) {
          const r = Math.max(w, hgt) / 2;
          ctx.fillStyle = gl.color + (gl.filled ? '' : '99');
          ctx.beginPath();
          ctx.arc(x0 + w / 2, y0 + hgt / 2, r, 0, Math.PI * 2);
          fillSolid(ctx, gl.filled);
          ctx.stroke();
          // rays (the sun only; sensors are plain dots)
          ctx.beginPath();
          for (let k = 0; k < (gl.badge ? 0 : 8); k++) {
            const ang = (k * Math.PI) / 4;
            ctx.moveTo(x0 + w / 2 + Math.cos(ang) * r * 1.3, y0 + hgt / 2 + Math.sin(ang) * r * 1.3);
            ctx.lineTo(x0 + w / 2 + Math.cos(ang) * r * 1.7, y0 + hgt / 2 + Math.sin(ang) * r * 1.7);
          }
          ctx.stroke();
        } else {
          ctx.fillStyle = gl.color + (gl.filled ? '' : '33');
          ctx.beginPath();
          if (gl.look) lookPath(ctx, gl.look, x0, y0, w, hgt, p.axis === 'z', gl.facing);
          else ctx.rect(x0, y0, w, hgt);
          fillSolid(ctx, gl.filled);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        if (gl.arrowTo) {
          const cx = x0 + w / 2;
          const cy = y0 + hgt / 2;
          const tx = X(gl.arrowTo[0]);
          const ty = Y(gl.arrowTo[1]);
          const len = Math.hypot(tx - cx, ty - cy);
          if (len > 4) drawArrow(ctx, cx, cy, (tx - cx) / len, (ty - cy) / len, len, gl.color, 2.5);
        } else if (gl.dir && Math.hypot(gl.dir[0], gl.dir[1]) > 0.15) {
          const l = Math.hypot(gl.dir[0], gl.dir[1]);
          const ux = gl.dir[0] / l;
          const uy = -gl.dir[1] / l;
          const cx = x0 + w / 2;
          const cy = y0 + hgt / 2;
          const len = Math.max(18, Math.min(40, Math.max(w, hgt))) * Math.min(1, l + 0.3);
          if (gl.intake) drawArrow(ctx, cx - ux * len, cy - uy * len, ux, uy, len, gl.color, 2.2);
          else drawArrow(ctx, cx + (ux * len) / 2, cy + (uy * len) / 2, ux, uy, len, gl.color, 2.2);
        }
        if (gl.badge) {
          ctx.font = 'bold 12px Inter, Segoe UI, system-ui, sans-serif';
          const tw = ctx.measureText(gl.badge).width;
          const bx = x0 + w + 4;
          const by = y0 + hgt / 2 - 9;
          ctx.globalAlpha = 1;
          ctx.fillStyle = 'rgba(18, 20, 26, 0.88)';
          ctx.strokeStyle = gl.selected ? '#ffd250' : gl.color;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.roundRect(bx, by, tw + 10, 18, 9);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#ffffff';
          ctx.fillText(gl.badge, bx + 5, by + 13);
          ctx.font = '11px Inter, Segoe UI, system-ui, sans-serif';
        } else if (gl.selected || cp >= 10) {
          ctx.fillStyle = gl.selected ? '#ffd250' : '#e7e9ee';
          ctx.fillText(gl.label, x0, y0 - 3);
        }
        ctx.globalAlpha = 1;
      }

      for (const hd of p.handles ?? []) {
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#12141a';
        ctx.lineWidth = 1.5;
        ctx.fillRect(X(hd.a) - 5, Y(hd.b) - 5, 10, 10);
        ctx.strokeRect(X(hd.a) - 5, Y(hd.b) - 5, 10, 10);
      }

      if (p.marker) {
        ctx.save();
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = 'rgba(255, 210, 80, 0.8)';
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
  }, []);

  const toCells = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      a: ((e.clientX - rect.left) / rect.width) * (geom.W + 2 * pad) - pad,
      b: geom.H + pad - ((e.clientY - rect.top) / rect.height) * (geom.H + 2 * pad),
    };
  };

  let readout = ' ';
  if (hover && frame && frame.T.length === grid.nx * grid.ny * grid.nz) {
    const a = Math.floor(hover.a);
    const b = Math.floor(hover.b);
    if (a >= 0 && b >= 0 && a < geom.W && b < geom.H) {
      const c = geom.cell(a, b);
      const pos = `${geom.axisA} ${fmtLength(cellCenter(grid, geom.axisA, a), units)}, ${geom.axisB} ${fmtLength(cellCenter(grid, geom.axisB, b), units)}`;
      const kind = grid.cellType[c];
      if (kind === 4) readout = `${pos} · open window`;
      else if (kind !== 0) readout = `${pos} · wall or solid`;
      else {
        const sp = Math.hypot(frame.ux[c], frame.uy[c], frame.uz[c]);
        const vert = frame.uz[c];
        readout = `${pos} · ${fmtTemp(frame.T[c], units)} · ${fmtSpeed(sp, units)}${Math.abs(vert) > 0.01 ? (vert > 0 ? ' rising' : ' sinking') : ''}`;
        if (field === 'divergence') readout += ` · div ${frame.div[c].toExponential(1)} 1/s`;
        if (field === 'pressure') readout += ` · ${frame.p[c].toFixed(3)} Pa`;
      }
    }
  }

  const interactive = Boolean(props.onPointerDown);
  return (
    <section className="slice">
      <header className="slice-head">
        <h2>{props.title}</h2>
        {props.dragHint && <span className="hint">{props.dragHint}</span>}
      </header>
      <div ref={wrapRef} className="slice-canvas-wrap">
        <canvas
          ref={canvasRef}
          className={interactive ? 'draggable' : undefined}
          style={props.cursor ? { cursor: props.cursor } : undefined}
          onDoubleClick={(e) => {
            const { a, b } = toCells(e as unknown as React.PointerEvent<HTMLCanvasElement>);
            props.onDoubleClick?.(a, b);
          }}
          onPointerDown={(e) => {
            if (!props.onPointerDown) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            const { a, b } = toCells(e);
            props.onPointerDown(a, b);
          }}
          onPointerMove={(e) => {
            const pt = toCells(e);
            setHover(pt);
            props.onHover?.(pt);
            if (props.onPointerDrag && e.buttons & 1) props.onPointerDrag(pt.a, pt.b);
          }}
          onPointerUp={() => props.onPointerUp?.()}
          onPointerLeave={() => {
            setHover(null);
            props.onHover?.(null);
          }}
        />
        {props.actionBar && (
          <div
            className="action-bar"
            style={{
              left: Math.max(0, (props.actionBar.a + pad) * cellPx),
              top: Math.max(0, (geom.H + pad - props.actionBar.b) * cellPx - 46),
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {props.actionBar.node}
          </div>
        )}
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

/** Fill the current path; a colored (filled) glyph is fully opaque even when faded, so nothing shows through it. */
function fillSolid(ctx: CanvasRenderingContext2D, solid?: boolean): void {
  const a = ctx.globalAlpha;
  if (solid) ctx.globalAlpha = 1;
  ctx.fill();
  ctx.globalAlpha = a;
}

export type Look = 'person' | 'box_fan' | 'ceiling_fan' | 'tower_fan';

/** Outline of a person or fan inside the glyph box (x, y, w, h), as one path to fill and stroke. */
function lookPath(ctx: CanvasRenderingContext2D, look: Look, x: number, y: number, w: number, h: number, fromAbove: boolean, facing?: [number, number]): void {
  const cx = x + w / 2;
  const cy = y + h / 2;
  switch (look) {
    case 'person':
      return personPath(ctx, x, y, w, h, fromAbove);
    case 'ceiling_fan': {
      const r = Math.min(w, fromAbove ? h : w) / 2;
      if (fromAbove) {
        bladesPath(ctx, cx, cy, r, 4, Math.PI / 4);
        ctx.moveTo(cx + r * 0.16, cy);
        ctx.arc(cx, cy, r * 0.16, 0, Math.PI * 2);
      } else {
        // blades seen edge-on, hanging from a short rod
        const t = Math.max(3, h);
        ctx.ellipse(cx, cy, w / 2, t / 2, 0, 0, Math.PI * 2);
        ctx.rect(cx - 2, cy - t / 2 - 8, 4, 8);
      }
      return;
    }
    case 'box_fan': {
      const L = Math.min(w, h);
      const f = facing ?? [0, 1];
      const fl = Math.hypot(f[0], f[1]);
      if (fromAbove || fl > 0.5) {
        // edge-on: a slim frame across the way it blows
        const ux = f[0] / (fl || 1);
        const uy = -f[1] / (fl || 1); // screen y is down
        const px = -uy;
        const py = ux;
        const T = L * 0.22;
        const c = [
          [cx + px * (L / 2) + ux * (T / 2), cy + py * (L / 2) + uy * (T / 2)],
          [cx - px * (L / 2) + ux * (T / 2), cy - py * (L / 2) + uy * (T / 2)],
          [cx - px * (L / 2) - ux * (T / 2), cy - py * (L / 2) - uy * (T / 2)],
          [cx + px * (L / 2) - ux * (T / 2), cy + py * (L / 2) - uy * (T / 2)],
        ];
        ctx.moveTo(c[0][0], c[0][1]);
        for (let k = 1; k < 4; k++) ctx.lineTo(c[k][0], c[k][1]);
        ctx.closePath();
        // grille bars
        for (let k = 1; k < 4; k++) {
          const s = -L / 2 + (k * L) / 4;
          ctx.moveTo(cx + px * s + ux * (T / 2), cy + py * s + uy * (T / 2));
          ctx.lineTo(cx + px * s - ux * (T / 2), cy + py * s - uy * (T / 2));
        }
      } else {
        // face-on: square frame, round guard, three blades
        ctx.roundRect(cx - L / 2, cy - L / 2, L, L, L * 0.08);
        ctx.moveTo(cx + L * 0.42, cy);
        ctx.arc(cx, cy, L * 0.42, 0, Math.PI * 2);
        bladesPath(ctx, cx, cy, L * 0.4, 3, -Math.PI / 2);
      }
      return;
    }
    case 'tower_fan': {
      const rad = Math.min(w, h) * 0.4;
      ctx.roundRect(x, y, w, h, rad);
      if (fromAbove) {
        // grille on the front face
        const f = facing ?? [0, 1];
        const fl = Math.hypot(f[0], f[1]) || 1;
        const ux = f[0] / fl;
        const uy = -f[1] / fl;
        ctx.moveTo(cx - uy * w * 0.3 + ux * w * 0.3, cy + ux * h * 0.3 + uy * h * 0.3);
        ctx.lineTo(cx + uy * w * 0.3 + ux * w * 0.3, cy - ux * h * 0.3 + uy * h * 0.3);
      } else {
        // horizontal slots up the column
        for (let sy = y + h * 0.15; sy < y + h * 0.85; sy += Math.max(4, h / 14)) {
          ctx.moveTo(x + w * 0.25, sy);
          ctx.lineTo(x + w * 0.75, sy);
        }
      }
      return;
    }
  }
}

/** n fan blades around (cx, cy), radius r, starting at angle a0. */
function bladesPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, n: number, a0: number): void {
  for (let k = 0; k < n; k++) {
    const a = a0 + (k * 2 * Math.PI) / n;
    const bx = cx + Math.cos(a) * r * 0.55;
    const by = cy + Math.sin(a) * r * 0.55;
    ctx.moveTo(bx + Math.cos(a) * r * 0.45, by + Math.sin(a) * r * 0.45);
    ctx.ellipse(bx, by, r * 0.45, r * 0.15, a, 0, Math.PI * 2);
  }
}

/**
 * A person inside the box (x, y, w, h), as a path. From above: shoulders and a
 * head. From the side (or front): head, body, arms and legs.
 */
function personPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fromAbove: boolean): void {
  const cx = x + w / 2;
  if (fromAbove) {
    const cy = y + h / 2;
    ctx.ellipse(cx, cy, w / 2, h * 0.32, 0, 0, Math.PI * 2);
    ctx.moveTo(cx + Math.min(w, h) * 0.3, cy);
    ctx.arc(cx, cy, Math.min(w, h) * 0.3, 0, Math.PI * 2);
    return;
  }
  const headR = Math.min(w * 0.32, h * 0.075);
  const neck = y + 2 * headR + h * 0.01;
  const hip = y + h * 0.53;
  const bodyW = w * 0.62;
  const legW = w * 0.24;
  ctx.moveTo(cx + headR, y + headR);
  ctx.arc(cx, y + headR, headR, 0, Math.PI * 2);
  // body
  ctx.roundRect(cx - bodyW / 2, neck, bodyW, hip - neck, Math.min(bodyW / 3, 6));
  // arms
  ctx.roundRect(x, neck + 2, w * 0.17, (hip - neck) * 0.95, w * 0.08);
  ctx.roundRect(x + w - w * 0.17, neck + 2, w * 0.17, (hip - neck) * 0.95, w * 0.08);
  // legs
  ctx.roundRect(cx - bodyW / 2, hip - 1, legW, y + h - hip + 1, legW / 3);
  ctx.roundRect(cx + bodyW / 2 - legW, hip - 1, legW, y + h - hip + 1, legW / 3);
}

function drawArrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, ux: number, uy: number, len: number, color: string, width: number): void {
  const x1 = x0 + ux * len;
  const y1 = y0 + uy * len;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  const head = Math.min(7, len * 0.4);
  ctx.lineTo(x1 - ux * head - uy * head * 0.5, y1 - uy * head + ux * head * 0.5);
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - ux * head + uy * head * 0.5, y1 - uy * head - ux * head * 0.5);
  ctx.stroke();
}

/** Trilinear sample of a cell-centered field at grid coordinates (cell i center at i + 0.5). */
function sample3(a: Float32Array, nx: number, ny: number, nz: number, x: number, y: number, z: number): number {
  const gx = Math.max(0, Math.min(nx - 1.0001, x - 0.5));
  const gy = Math.max(0, Math.min(ny - 1.0001, y - 0.5));
  const gz = Math.max(0, Math.min(nz - 1.0001, z - 0.5));
  const i = gx | 0;
  const j = gy | 0;
  const k = gz | 0;
  const fx = gx - i;
  const fy = gy - j;
  const fz = gz - k;
  const nxy = nx * ny;
  const b = i + nx * (j + ny * k);
  const c00 = a[b] + fx * (a[b + 1] - a[b]);
  const c10 = a[b + nx] + fx * (a[b + nx + 1] - a[b + nx]);
  const c01 = a[b + nxy] + fx * (a[b + nxy + 1] - a[b + nxy]);
  const c11 = a[b + nxy + nx] + fx * (a[b + nxy + nx + 1] - a[b + nxy + nx]);
  const c0 = c00 + fy * (c10 - c00);
  const c1 = c01 + fy * (c11 - c01);
  return c0 + fz * (c1 - c0);
}
