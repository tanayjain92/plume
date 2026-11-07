import { useEffect, useRef, useState } from 'react';
import { FT, MAX_EXTENT, newSpace, rectOutline, STANDARD_SIZES } from '../scene/defaults';
import { isSimplePolygon, polygonArea, segmentsCross } from '../scene/geometry';
import { PRESETS } from '../scene/presets';
import type { SceneV1, Vec2 } from '../scene/types';
import { NumberField } from './Editor';
import { fmtLength, type UnitSystem } from './units';

type Mode = 'standard' | 'custom' | 'draw';

const HEIGHTS_FT = [8, 9, 10];

export function SetupScreen(props: {
  units: UnitSystem;
  onUnits: (u: UnitSystem) => void;
  onCreate: (scene: SceneV1) => void;
  onOpenFile: () => void;
  onCancel?: () => void;
}) {
  const { units } = props;
  const [mode, setMode] = useState<Mode>('standard');
  const [sizeId, setSizeId] = useState('bedroom');
  const [customW, setCustomW] = useState(12 * FT);
  const [customD, setCustomD] = useState(14 * FT);
  const [drawn, setDrawn] = useState<Vec2[] | null>(null);
  const [height, setHeight] = useState(8 * FT);
  const [roomTemp, setRoomTemp] = useState(27);
  const [outdoorTemp, setOutdoorTemp] = useState(33);

  const std = STANDARD_SIZES.find((s) => s.id === sizeId)!;
  const outline: Vec2[] | null =
    mode === 'standard' ? rectOutline(std.widthFt * FT, std.depthFt * FT) : mode === 'custom' ? rectOutline(customW, customD) : drawn;
  const name = mode === 'standard' ? std.label : mode === 'custom' ? 'Custom room' : 'Drawn room';
  const area = outline ? polygonArea(outline) : 0;

  const create = () => {
    if (!outline) return;
    props.onCreate(newSpace({ name, outline, height, roomTemp, outdoorTemp }));
  };

  const fmtArea = (m2: number) => (units === 'imperial' ? `${Math.round(m2 / (FT * FT))} ft²` : `${m2.toFixed(1)} m²`);
  const dims = (wFt: number, dFt: number) =>
    units === 'imperial' ? `${wFt} × ${dFt} ft` : `${(wFt * FT).toFixed(1)} × ${(dFt * FT).toFixed(1)} m`;

  return (
    <div className="setup">
      <div className="setup-card">
        <header className="setup-head">
          <div className="brand">
            <span className="logo" aria-hidden>
              ≋
            </span>
            <div>
              <h1>Define your space</h1>
              <p>Pick a standard room size, enter your own, or draw the floor plan.</p>
            </div>
          </div>
          <div className="seg" role="group" aria-label="Units">
            <button className={units === 'imperial' ? 'on' : ''} onClick={() => props.onUnits('imperial')}>
              °F · ft
            </button>
            <button className={units === 'metric' ? 'on' : ''} onClick={() => props.onUnits('metric')}>
              °C · m
            </button>
          </div>
        </header>

        <div className="tabs" role="tablist">
          {(
            [
              ['standard', 'Standard sizes'],
              ['custom', 'Custom size'],
              ['draw', 'Draw it'],
            ] as const
          ).map(([m, label]) => (
            <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
              {label}
            </button>
          ))}
        </div>

        {mode === 'standard' && (
          <div className="size-grid">
            {STANDARD_SIZES.map((s) => {
              // one scale for all cards, so sizes compare at a glance
              const k = 48 / Math.max(...STANDARD_SIZES.map((z) => Math.max(z.widthFt, z.depthFt)));
              return (
                <button key={s.id} className={`size-card ${sizeId === s.id ? 'on' : ''}`} onClick={() => setSizeId(s.id)}>
                  <span className="size-shape" style={{ width: s.widthFt * k, height: s.depthFt * k }} />
                  <span className="size-label">{s.label}</span>
                  <span className="size-dims">{dims(s.widthFt, s.depthFt)}</span>
                  {s.slow && <span className="size-tag">simulates slower</span>}
                </button>
              );
            })}
          </div>
        )}

        {mode === 'custom' && (
          <div className="fields custom-size">
            <label className="field">
              <span>Width</span>
              <NumberField value={customW} q="len" units={units} min={1.5} max={MAX_EXTENT} onChange={setCustomW} />
            </label>
            <label className="field">
              <span>Depth</span>
              <NumberField value={customD} q="len" units={units} min={1.5} max={MAX_EXTENT} onChange={setCustomD} />
            </label>
            <p className="muted small">Up to {fmtLength(MAX_EXTENT, units, 0)} on a side. Bigger rooms simulate more slowly.</p>
          </div>
        )}

        {mode === 'draw' && <DrawRoom units={units} onChange={setDrawn} />}

        <div className="setup-row">
          <div className="field-group">
            <span className="group-label">Ceiling height</span>
            <div className="chips">
              {HEIGHTS_FT.map((hf) => (
                <button key={hf} className={Math.abs(height - hf * FT) < 0.01 ? 'on' : ''} onClick={() => setHeight(hf * FT)}>
                  {units === 'imperial' ? `${hf} ft` : `${(hf * FT).toFixed(2)} m`}
                </button>
              ))}
              <NumberField value={height} q="len" units={units} min={1.8} max={6} onChange={setHeight} />
            </div>
          </div>
          <div className="field-group">
            <span className="group-label">Room starts at</span>
            <NumberField value={roomTemp} q="temp" units={units} onChange={setRoomTemp} />
          </div>
          <div className="field-group">
            <span className="group-label">Outside is</span>
            <NumberField value={outdoorTemp} q="temp" units={units} onChange={setOutdoorTemp} />
          </div>
        </div>

        <footer className="setup-foot">
          <div className="setup-alt">
            <button className="link" onClick={props.onOpenFile}>
              Open a saved space…
            </button>
            <span className="muted">or try an example:</span>
            {PRESETS.slice(0, 3).map((p) => (
              <button key={p.id} className="link" onClick={() => props.onCreate(structuredClone(p.scene))}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="setup-go">
            {outline && <span className="muted">{fmtArea(area)}</span>}
            {props.onCancel && <button onClick={props.onCancel}>Cancel</button>}
            <button className="primary" disabled={!outline} onClick={create}>
              Create space
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ drawing

const VIEW_W = 12; // meters across the drawing area
const VIEW_H = 9;

/** Click corners to draw a room outline. Snaps to a grid and to 45° angles (hold Shift for free angles). */
function DrawRoom(props: { units: UnitSystem; onChange: (outline: Vec2[] | null) => void }) {
  const { units } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(720);
  const [pts, setPts] = useState<Vec2[]>([]);
  const [closed, setClosed] = useState(false);
  const [hover, setHover] = useState<Vec2 | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const scale = width / VIEW_W; // px per meter
  const height = VIEW_H * scale;
  const snap = units === 'imperial' ? 0.5 * FT : 0.1;
  const gridMinor = units === 'imperial' ? FT : 0.5;
  const gridMajor = units === 'imperial' ? 5 * FT : 1;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(320, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    props.onChange(closed && isSimplePolygon(pts) ? pts : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pts, closed]);

  const toWorld = (e: React.PointerEvent<HTMLCanvasElement>, free: boolean): Vec2 => {
    const r = e.currentTarget.getBoundingClientRect();
    let x = (e.clientX - r.left) / scale;
    let y = VIEW_H - (e.clientY - r.top) / scale;
    const last = pts[pts.length - 1];
    if (last && !free) {
      // snap direction to a multiple of 45°, then the length to the grid
      const dx = x - last[0];
      const dy = y - last[1];
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.round(Math.hypot(dx, dy) / snap) * snap;
      x = last[0] + Math.cos(ang) * len;
      y = last[1] + Math.sin(ang) * len;
      if (Math.abs(Math.cos(ang)) < 1e-9) x = last[0];
      if (Math.abs(Math.sin(ang)) < 1e-9) y = last[1];
    } else {
      x = Math.round(x / snap) * snap;
      y = Math.round(y / snap) * snap;
    }
    return [Math.max(0, Math.min(VIEW_W, x)), Math.max(0, Math.min(VIEW_H, y))];
  };

  const nearFirst = (p: Vec2) => pts.length >= 3 && Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) * scale < 14;

  const click = (p: Vec2) => {
    setMessage(null);
    if (closed) return;
    if (nearFirst(p)) {
      if (!isSimplePolygon(pts)) {
        setMessage('Walls cross each other. Undo a corner and try again.');
        return;
      }
      setClosed(true);
      return;
    }
    const last = pts[pts.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.2) return;
    // the new wall must not cross an existing one
    if (last) for (let i = 0; i + 1 < pts.length - 1; i++) if (segmentsCross(pts[i], pts[i + 1], last, p)) return setMessage("Walls can't cross.");
    const all = [...pts, p];
    const xs = all.map((q) => q[0]);
    const ys = all.map((q) => q[1]);
    if (Math.max(...xs) - Math.min(...xs) > MAX_EXTENT || Math.max(...ys) - Math.min(...ys) > MAX_EXTENT) return setMessage(`Keep the space within ${fmtLength(MAX_EXTENT, units, 0)}.`);
    setPts(all);
  };

  const undo = () => {
    setMessage(null);
    if (closed) setClosed(false);
    else setPts((p) => p.slice(0, -1));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'Backspace' || (e.key === 'z' && (e.ctrlKey || e.metaKey))) && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // draw
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    c.style.width = `${width}px`;
    c.style.height = `${height}px`;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#161920';
    ctx.fillRect(0, 0, width, height);
    const X = (x: number) => x * scale;
    const Y = (y: number) => (VIEW_H - y) * scale;
    for (const [step, color] of [
      [gridMinor, '#20242d'],
      [gridMajor, '#2c313d'],
    ] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= VIEW_W + 1e-9; x += step) {
        ctx.moveTo(X(x) + 0.5, 0);
        ctx.lineTo(X(x) + 0.5, height);
      }
      for (let y = 0; y <= VIEW_H + 1e-9; y += step) {
        ctx.moveTo(0, Y(y) + 0.5);
        ctx.lineTo(width, Y(y) + 0.5);
      }
      ctx.stroke();
    }
    const label = (a: Vec2, b: Vec2) => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.3) return;
      ctx.fillStyle = '#e7e9ee';
      ctx.font = '12px Inter, Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(fmtLength(len, units, 1), X((a[0] + b[0]) / 2), Y((a[1] + b[1]) / 2) - 6);
    };
    if (pts.length) {
      if (closed) {
        ctx.fillStyle = 'rgba(90, 169, 255, 0.15)';
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
        ctx.closePath();
        ctx.fill();
      }
      ctx.strokeStyle = '#5aa9ff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
      if (closed) ctx.closePath();
      ctx.stroke();
      for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) label(pts[i], pts[(i + 1) % pts.length]);
      if (!closed && hover) {
        const last = pts[pts.length - 1];
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = nearFirst(hover) ? '#4cc38a' : '#9097a7';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(X(last[0]), Y(last[1]));
        ctx.lineTo(X(hover[0]), Y(hover[1]));
        ctx.stroke();
        ctx.setLineDash([]);
        label(last, hover);
      }
      pts.forEach((p, i) => {
        ctx.fillStyle = i === 0 && !closed && pts.length >= 3 ? '#4cc38a' : '#5aa9ff';
        ctx.beginPath();
        ctx.arc(X(p[0]), Y(p[1]), i === 0 && !closed ? 6 : 4, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    if (!closed && hover) {
      ctx.strokeStyle = '#e7e9ee';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(X(hover[0]), Y(hover[1]), 5, 0, Math.PI * 2);
      ctx.stroke();
    }
  });

  const status = closed
    ? `Done: ${pts.length} walls, ${units === 'imperial' ? `${Math.round(polygonArea(pts) / (FT * FT))} ft²` : `${polygonArea(pts).toFixed(1)} m²`}.`
    : pts.length === 0
      ? 'Click to place the first corner.'
      : pts.length < 3
        ? 'Click to place the next corner. Hold Shift for angles other than 45°.'
        : 'Keep adding corners, or click the green first corner to close the room.';

  return (
    <div className="draw">
      <div ref={wrapRef} className="draw-canvas">
        <canvas
          ref={canvasRef}
          onPointerMove={(e) => setHover(toWorld(e, e.shiftKey))}
          onPointerLeave={() => setHover(null)}
          onPointerDown={(e) => click(toWorld(e, e.shiftKey))}
        />
      </div>
      <div className="draw-bar">
        <span className={message ? 'warn-text' : 'muted'}>{message ?? status}</span>
        <div className="row-buttons">
          <button onClick={undo} disabled={!pts.length}>
            Undo
          </button>
          <button
            onClick={() => {
              setPts([]);
              setClosed(false);
              setMessage(null);
            }}
            disabled={!pts.length}
          >
            Clear
          </button>
        </div>
      </div>
      <p className="muted small">
        Grid squares are {units === 'imperial' ? '1 ft (bold every 5 ft)' : '0.5 m (bold every 1 m)'}. Corners snap to {units === 'imperial' ? '6 in' : '10 cm'}.
      </p>
    </div>
  );
}
