import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { edgeFrame, sceneShapes, type DeviceShape } from '../scene/geometry';
import { PRESETS } from '../scene/presets';
import type { SceneV1 } from '../scene/types';
import type { Frame, FromWorker, GridInfo, ToWorker } from '../worker/protocol';
import { DevicesPanel, RoomPanel } from './Editor';
import { SliceView, type FieldKind, type Glyph, type Overlays } from './SliceView';
import { cellAt, cellCenter, type SliceAxis } from './slice';
import {
  deltaFromDisplay,
  deltaToDisplay,
  fmtDuration,
  fmtFlow,
  fmtLength,
  fmtPower,
  fmtSpeed,
  fmtTemp,
  fmtTempDelta,
  tempFromDisplay,
  tempToDisplay,
  type UnitSystem,
} from './units';

const SPEEDS: { label: string; value: number }[] = [
  { label: '1×', value: 1 },
  { label: '5×', value: 5 },
  { label: '20×', value: 20 },
  { label: 'Max', value: 0 },
];

const FIELDS: { id: FieldKind; label: string }[] = [
  { id: 'temperature', label: 'Temperature' },
  { id: 'speed', label: 'Air speed' },
  { id: 'divergence', label: 'Divergence (debug)' },
  { id: 'pressure', label: 'Pressure (debug)' },
];

const DIV_TOL = 1e-4;

const GLYPH_COLORS: Record<DeviceShape['kind'], string> = {
  window: '#6ec6ff',
  heat_source: '#ff9f43',
  window_ac: '#4dd0e1',
  portable_ac: '#4dd0e1',
  mini_split: '#4dd0e1',
  supply_vent: '#80deea',
  return_vent: '#b0bec5',
  box_fan: '#c5e1a5',
  ceiling_fan: '#c5e1a5',
  tower_fan: '#c5e1a5',
};

type Drag = { kind: 'device'; id: string; a: number; b: number; scene0: SceneV1 } | { kind: 'section' } | { kind: 'plan' };

function roomBounds(scene: SceneV1) {
  const r = scene.rooms[0];
  const xs = r.outline.map((p) => p[0]);
  const ys = r.outline.map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), height: r.height };
}

export function App() {
  const workerRef = useRef<Worker | null>(null);
  const [presetId, setPresetId] = useState(PRESETS[0].id);
  const [scene, setScene] = useState<SceneV1>(() => structuredClone(PRESETS[0].scene));
  const keepStateRef = useRef(false);
  const [grid, setGrid] = useState<GridInfo | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [solverLog, setSolverLog] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(0);
  const [units, setUnits] = useState<UnitSystem>('imperial');
  const [selected, setSelected] = useState<string | null>(null);

  const [field, setField] = useState<FieldKind>('temperature');
  const [overlays, setOverlays] = useState<Overlays>({ arrows: true, particles: true, drafts: false });
  const [planZ, setPlanZ] = useState(1.1);
  const [sectionAxis, setSectionAxis] = useState<SliceAxis>('y');
  const [sectionPos, setSectionPos] = useState(1.8);
  const [tempCenter, setTempCenter] = useState(24);
  const [tempHalfRange, setTempHalfRange] = useState(4);
  const [draftThreshold, setDraftThreshold] = useState(0.25);
  const dragRef = useRef<Drag | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const send = useCallback((msg: ToWorker) => workerRef.current?.postMessage(msg), []);

  useEffect(() => {
    const worker = new Worker(new URL('../worker/simWorker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      const msg = ev.data;
      switch (msg.type) {
        case 'ready':
          setGrid(msg.grid);
          setWarnings(msg.warnings);
          if (msg.restarted) setSolverLog([]);
          break;
        case 'frame':
          setFrame(msg);
          break;
        case 'warn':
        case 'error':
          setSolverLog((log) => (log[0] === msg.message ? log : [`${msg.type === 'error' ? 'Error: ' : ''}${msg.message}`, ...log].slice(0, 6)));
          break;
      }
    };
    worker.onerror = (e) => setSolverLog((log) => [`Worker error: ${e.message}`, ...log].slice(0, 6));
    worker.postMessage({ type: 'speed', speed: 0 } satisfies ToWorker);
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  // Every scene edit goes to the worker. Live edits keep the flow; loading a preset or file restarts.
  useEffect(() => {
    send({ type: 'scene', scene, keepState: keepStateRef.current });
    keepStateRef.current = true;
  }, [scene, send]);

  const loadScene = (next: SceneV1) => {
    keepStateRef.current = false;
    setScene(next);
    setSelected(null);
    setFrame(null);
    const b = roomBounds(next);
    setPlanZ(Math.min(1.1, b.height - 0.1));
    setSectionPos(sectionAxis === 'y' ? (b.y0 + b.y1) / 2 : (b.x0 + b.x1) / 2);
    // SPEC: diverging scale centered on the thermostat setpoint (room start temp if there's no AC),
    // wide enough that the starting room still reads on the scale.
    const setpoint = next.devices.find((d) => 'setpoint' in d) as { setpoint: number } | undefined;
    const center = setpoint ? setpoint.setpoint : next.rooms[0].initialTemp;
    setTempCenter(center);
    setTempHalfRange(Math.max(4, Math.ceil(Math.abs(next.rooms[0].initialTemp - center) + 1)));
  };

  const editScene = (next: SceneV1) => {
    const prev = roomBounds(scene);
    const now = roomBounds(next);
    // A new grid size can't carry the flow over; the worker restarts on its own.
    if (prev.x1 - prev.x0 !== now.x1 - now.x0 || prev.y1 - prev.y0 !== now.y1 - now.y0 || prev.height !== now.height) setFrame(null);
    setScene(next);
  };

  const toggleRun = () => {
    const next = !running;
    setRunning(next);
    send({ type: 'run', running: next });
  };

  const changeSpeed = (v: number) => {
    setSpeed(v);
    send({ type: 'speed', speed: v });
  };

  const changeSectionAxis = (axis: SliceAxis) => {
    if (!grid) return;
    setSectionAxis(axis);
    const n = axis === 'x' ? grid.nx : grid.ny;
    setSectionPos(cellCenter(grid, axis, Math.floor(n / 2)));
  };

  const saveScene = () => {
    const blob = new Blob([JSON.stringify(scene, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(scene.name ?? 'room').replace(/[^\w-]+/g, '_')}.plume.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const openScene = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as SceneV1;
      if (parsed.version !== 1 || !Array.isArray(parsed.rooms) || !parsed.rooms.length) throw new Error('not a version 1 Plume scene');
      loadScene({ ...parsed, walls: parsed.walls ?? [], openings: parsed.openings ?? [], devices: parsed.devices ?? [] });
      setNotice(`Opened ${file.name}`);
    } catch (err) {
      setNotice(`Couldn't open ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // ---------------------------------------------------------- glyphs + dragging

  const shapes = useMemo(() => sceneShapes(scene), [scene]);

  const glyphsFor = (axis: SliceAxis, sliceIndex: number): Glyph[] => {
    if (!grid) return [];
    const { h, origin } = grid;
    const ax = axis === 'z' ? [0, 1] : axis === 'y' ? [0, 2] : [1, 2];
    const nAxis = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
    const sliceWorld = cellCenter(grid, axis, sliceIndex);
    return shapes.map((s) => {
      const crosses = axis === 'z' || (sliceWorld >= s.lo[nAxis] - 0.3 && sliceWorld <= s.hi[nAxis] + 0.3);
      return {
        id: s.id,
        a0: (s.lo[ax[0]] - origin[ax[0]]) / h,
        a1: (s.hi[ax[0]] - origin[ax[0]]) / h,
        b0: (s.lo[ax[1]] - origin[ax[1]]) / h,
        b1: (s.hi[ax[1]] - origin[ax[1]]) / h,
        dir: s.dir ? [s.dir[ax[0]], s.dir[ax[1]]] : undefined,
        intake: s.intake,
        color: GLYPH_COLORS[s.kind],
        label: s.id,
        selected: s.id === selected,
        faded: !s.enabled || !crosses,
        dashed: s.kind === 'window' && !s.open,
      };
    });
  };

  const planK = grid ? cellAt(grid, 'z', planZ) : 1;
  const sectionIndex = grid ? cellAt(grid, sectionAxis, sectionPos) : 1;
  const planGlyphs = grid ? glyphsFor('z', planK) : [];
  const sectionGlyphs = grid ? glyphsFor(sectionAxis, sectionIndex) : [];

  const hitTest = (glyphs: Glyph[], a: number, b: number): Glyph | null => {
    const pad = 0.6;
    let best: Glyph | null = null;
    let bestArea = Infinity;
    for (const g of glyphs) {
      const [a0, a1] = [Math.min(g.a0, g.a1) - pad, Math.max(g.a0, g.a1) + pad];
      const [b0, b1] = [Math.min(g.b0, g.b1) - pad, Math.max(g.b0, g.b1) + pad];
      if (a < a0 || a > a1 || b < b0 || b > b1) continue;
      const area = (a1 - a0) * (b1 - b0);
      if (area < bestArea) {
        bestArea = area;
        best = g;
      }
    }
    return best;
  };

  const moveSection = (a: number, b: number) => {
    if (!grid) return;
    const i = Math.floor(sectionAxis === 'y' ? b : a);
    const n = sectionAxis === 'y' ? grid.ny : grid.nx;
    setSectionPos(cellCenter(grid, sectionAxis, Math.max(1, Math.min(n - 2, i))));
  };

  const dragDevice = (drag: Extract<Drag, { kind: 'device' }>, a: number, b: number) => {
    if (!grid) return;
    const s0 = drag.scene0;
    const dx = (a - drag.a) * grid.h;
    const dy = (b - drag.b) * grid.h;
    const rb = roomBounds(s0);
    const clampX = (x: number) => Math.max(rb.x0 + 0.05, Math.min(rb.x1 - 0.05, x));
    const clampY = (y: number) => Math.max(rb.y0 + 0.05, Math.min(rb.y1 - 0.05, y));
    const moveOpening = (id: string) => {
      const op = s0.openings.find((o) => o.id === id);
      const room = op && s0.rooms.find((r) => r.id === op.room);
      if (!op || !room) return s0.openings;
      const f = edgeFrame(room, op.edge);
      const offset = Math.max(0, Math.min(f.length - op.width, op.offset + dx * f.t[0] + dy * f.t[1]));
      return s0.openings.map((o) => (o.id === id ? { ...o, offset: Math.round(offset * 20) / 20 } : o));
    };
    const dev = s0.devices.find((d) => d.id === drag.id);
    if (!dev) {
      editScene({ ...s0, openings: moveOpening(drag.id) });
      return;
    }
    if (dev.type === 'window_ac') {
      editScene({ ...s0, openings: moveOpening(dev.mountedIn) });
      return;
    }
    const pos = [...dev.pos] as [number, number, number];
    pos[0] = Math.round(clampX(pos[0] + dx) * 20) / 20;
    pos[1] = Math.round(clampY(pos[1] + dy) * 20) / 20;
    editScene({ ...s0, devices: s0.devices.map((d) => (d.id === dev.id ? ({ ...d, pos } as typeof d) : d)) });
  };

  // ---------------------------------------------------------------- render

  const stats = frame?.stats;
  const devices = frame?.devices;
  const rb = roomBounds(scene);
  const sectionMax = sectionAxis === 'x' ? rb.x1 - 0.05 : rb.y1 - 0.05;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            ≋
          </span>
          <div>
            <h1>Plume</h1>
            <p>Room airflow simulator · phase 2 single room editor</p>
          </div>
        </div>
        <div className="transport">
          <button className={`primary ${running ? 'running' : ''}`} onClick={toggleRun} disabled={!grid}>
            {running ? 'Pause' : 'Run'}
          </button>
          <button onClick={() => send({ type: 'step' })} disabled={!grid || running}>
            Step
          </button>
          <button onClick={() => send({ type: 'reset' })} disabled={!grid}>
            Reset
          </button>
          <div className="seg" role="group" aria-label="Simulation speed">
            {SPEEDS.map((s) => (
              <button key={s.label} className={speed === s.value ? 'on' : ''} onClick={() => changeSpeed(s.value)}>
                {s.label}
              </button>
            ))}
          </div>
          <div className="seg" role="group" aria-label="Units">
            <button className={units === 'imperial' ? 'on' : ''} onClick={() => setUnits('imperial')}>
              °F · ft
            </button>
            <button className={units === 'metric' ? 'on' : ''} onClick={() => setUnits('metric')}>
              °C · m
            </button>
          </div>
        </div>
      </header>

      <aside className="sidebar">
        <section className="panel">
          <h3>Scene</h3>
          <select
            value={presetId}
            onChange={(e) => {
              setPresetId(e.target.value);
              loadScene(structuredClone(PRESETS.find((p) => p.id === e.target.value)!.scene));
            }}
          >
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <p className="muted">{PRESETS.find((p) => p.id === presetId)?.description}</p>
          <div className="row-buttons">
            <button onClick={() => fileRef.current?.click()}>Open…</button>
            <button onClick={saveScene}>Save…</button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void openScene(f);
                e.target.value = '';
              }}
            />
          </div>
          {notice && <p className="muted small">{notice}</p>}
          {grid && (
            <p className="muted small">
              Grid {grid.nx - 2} × {grid.ny - 2} × {grid.nz - 2} cells at {fmtLength(grid.h, units, 2)} ·{' '}
              {stats ? stats.fluidCells.toLocaleString() : '–'} air cells
            </p>
          )}
          {warnings.length > 0 && (
            <ul className="notes">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </section>

        <RoomPanel scene={scene} units={units} onChange={editScene} />
        <DevicesPanel scene={scene} units={units} selected={selected} onSelect={setSelected} onChange={editScene} onNotice={setNotice} />

        <section className="panel">
          <h3>View</h3>
          <div className="field-list">
            {FIELDS.map((f) => (
              <label key={f.id} className="radio">
                <input type="radio" name="field" checked={field === f.id} onChange={() => setField(f.id)} />
                {f.label}
              </label>
            ))}
          </div>
          <div className="overlay-list">
            {(
              [
                ['arrows', 'Airflow arrows'],
                ['particles', 'Particle tracers'],
                ['drafts', `Draft zones (> ${fmtSpeed(draftThreshold, units)})`],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="check">
                <input type="checkbox" checked={overlays[key]} onChange={(e) => setOverlays((o) => ({ ...o, [key]: e.target.checked }))} />
                {label}
              </label>
            ))}
          </div>

          <label className="slider">
            <span>
              Plan height <b>{grid ? fmtLength(cellCenter(grid, 'z', planK), units) : '–'}</b>
            </span>
            <input type="range" min={0.05} max={rb.height - 0.05} step={0.1} value={planZ} onChange={(e) => setPlanZ(Number(e.target.value))} />
          </label>

          <div className="row">
            <span>Section</span>
            <div className="seg small" role="group" aria-label="Section orientation">
              <button className={sectionAxis === 'y' ? 'on' : ''} onClick={() => changeSectionAxis('y')}>
                along x
              </button>
              <button className={sectionAxis === 'x' ? 'on' : ''} onClick={() => changeSectionAxis('x')}>
                along y
              </button>
            </div>
          </div>
          <label className="slider">
            <span>
              Section at {sectionAxis} = <b>{grid ? fmtLength(cellCenter(grid, sectionAxis, sectionIndex), units) : '–'}</b>
            </span>
            <input type="range" min={0.05} max={sectionMax} step={0.1} value={sectionPos} onChange={(e) => setSectionPos(Number(e.target.value))} />
          </label>

          <div className="row">
            <label className="num">
              <span>Color center</span>
              <input
                type="number"
                step={0.5}
                value={Number(tempToDisplay(tempCenter, units).toFixed(1))}
                onChange={(e) => setTempCenter(tempFromDisplay(Number(e.target.value), units))}
              />
            </label>
            <label className="num">
              <span>± range</span>
              <input
                type="number"
                step={0.5}
                min={0.5}
                value={Number(deltaToDisplay(tempHalfRange, units).toFixed(1))}
                onChange={(e) => setTempHalfRange(Math.max(0.1, deltaFromDisplay(Number(e.target.value), units)))}
              />
            </label>
          </div>
          <label className="slider">
            <span>
              Draft threshold <b>{fmtSpeed(draftThreshold, units)}</b>
            </span>
            <input type="range" min={0.05} max={1} step={0.05} value={draftThreshold} onChange={(e) => setDraftThreshold(Number(e.target.value))} />
          </label>
        </section>

        {solverLog.length > 0 && (
          <section className="panel warn">
            <h3>Solver warnings</h3>
            <ul className="notes">
              {solverLog.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </section>
        )}
      </aside>

      <main className="main">
        <div className="stats">
          <Stat label="Room time" value={stats ? fmtDuration(stats.time) : '–'} sub={stats ? `${stats.realtimeFactor.toFixed(1)}× realtime` : ''} />
          <Stat label="Average" value={stats ? fmtTemp(stats.meanT, units, 2) : '–'} sub={stats ? `${fmtTemp(stats.minT, units)} – ${fmtTemp(stats.maxT, units)}` : ''} />
          <Stat
            label="Floor → ceiling"
            value={stats ? fmtTempDelta(stats.ceilingT - stats.floorT, units, 2) : '–'}
            sub={stats ? `${fmtTemp(stats.floorT, units)} → ${fmtTemp(stats.ceilingT, units)}` : ''}
          />
          <Stat label="Max air speed" value={stats ? fmtSpeed(stats.maxSpeed, units) : '–'} sub={stats ? `${stats.stepsPerSec.toFixed(0)} steps/s` : ''} />
          <Stat
            label="Outdoor air in"
            value={stats ? fmtFlow(stats.openInflow + Math.max(0, stats.leakFlow), units) : '–'}
            sub={stats ? (stats.leakFlow < -1e-4 ? `${fmtFlow(-stats.leakFlow, units)} leaking out` : stats.leakFlow > 1e-4 ? 'via leakage' : 'via open windows') : ''}
          />
          <Stat
            label="Max divergence"
            value={stats ? `${stats.maxDiv.toExponential(1)} /s` : '–'}
            sub={stats ? `${stats.pressureIterations} PCG iters` : ''}
            tone={stats ? (stats.maxDiv < DIV_TOL && stats.pressureConverged ? 'ok' : 'bad') : undefined}
          />
        </div>

        {grid ? (
          <div className="views">
            <SliceView
              title={`Floor plan at ${fmtLength(cellCenter(grid, 'z', planK), units)}`}
              dragHint="drag a device to move it · drag empty space to move the section"
              grid={grid}
              frame={frame}
              axis="z"
              index={planK}
              field={field}
              overlays={overlays}
              tempCenter={tempCenter}
              tempHalfRange={tempHalfRange}
              draftThreshold={draftThreshold}
              units={units}
              glyphs={planGlyphs}
              marker={{ orientation: sectionAxis === 'y' ? 'horizontal' : 'vertical', at: sectionIndex + 0.5 }}
              onPointerDown={(a, b) => {
                const hit = hitTest(planGlyphs, a, b);
                if (hit) {
                  setSelected(hit.id);
                  dragRef.current = { kind: 'device', id: hit.id, a, b, scene0: scene };
                } else {
                  dragRef.current = { kind: 'section' };
                  moveSection(a, b);
                }
              }}
              onPointerDrag={(a, b) => {
                const d = dragRef.current;
                if (d?.kind === 'device') dragDevice(d, a, b);
                else if (d?.kind === 'section') moveSection(a, b);
              }}
              onPointerUp={() => (dragRef.current = null)}
            />
            <SliceView
              title={`Section at ${sectionAxis} = ${fmtLength(cellCenter(grid, sectionAxis, sectionIndex), units)}`}
              dragHint="drag to move the plan height · click a device to select it"
              grid={grid}
              frame={frame}
              axis={sectionAxis}
              index={sectionIndex}
              field={field}
              overlays={overlays}
              tempCenter={tempCenter}
              tempHalfRange={tempHalfRange}
              draftThreshold={draftThreshold}
              units={units}
              glyphs={sectionGlyphs}
              marker={{ orientation: 'horizontal', at: planK + 0.5 }}
              onPointerDown={(a, b) => {
                const hit = hitTest(sectionGlyphs.filter((g) => !g.faded || g.selected), a, b);
                if (hit) {
                  setSelected(hit.id);
                  dragRef.current = null;
                  return;
                }
                dragRef.current = { kind: 'plan' };
                setPlanZ(cellCenter(grid, 'z', Math.max(1, Math.min(grid.nz - 2, Math.floor(b)))));
              }}
              onPointerDrag={(_a, b) => {
                if (dragRef.current?.kind === 'plan') setPlanZ(cellCenter(grid, 'z', Math.max(1, Math.min(grid.nz - 2, Math.floor(b)))));
              }}
              onPointerUp={() => (dragRef.current = null)}
            />
          </div>
        ) : (
          <div className="loading">Building the grid…</div>
        )}

        {devices && (devices.acUnits.length > 0 || devices.fans.length > 0 || devices.ports.length > 0) && (
          <section className="panel readouts">
            <h3>Devices live</h3>
            <div className="readout-grid">
              {devices.acUnits.map((ac) => (
                <div key={ac.id} className={`readout-card ${ac.enabled ? '' : 'off'}`}>
                  <b>{ac.id}</b>
                  <span>
                    {ac.enabled
                      ? `supply ${fmtTemp(ac.supplyT, units)} ← return ${fmtTemp(ac.returnT, units)} (Δ ${fmtTempDelta(ac.returnT - ac.supplyT, units)})`
                      : 'off'}
                  </span>
                  {ac.enabled && (
                    <span className="muted small">
                      removing {fmtPower(ac.coolingW, units)} sensible · {fmtFlow(ac.flow, units)}
                    </span>
                  )}
                </div>
              ))}
              {devices.fans.map((f) => (
                <div key={f.id} className={`readout-card ${f.delivered > 0 ? '' : 'off'}`}>
                  <b>{f.id}</b>
                  <span>{f.delivered > 0 ? `${Math.round(f.delivered * 100)}% of rated airflow` : 'off'}</span>
                  {Math.abs(f.headingOffsetDeg) > 0.5 && <span className="muted small">sweep {f.headingOffsetDeg > 0 ? '+' : ''}{f.headingOffsetDeg.toFixed(0)}°</span>}
                </div>
              ))}
              {devices.ports
                .filter((p) => !p.id.includes(':'))
                .map((p) => (
                  <div key={p.id} className={`readout-card ${p.flow !== 0 ? '' : 'off'}`}>
                    <b>{p.id}</b>
                    <span>{p.flow === 0 ? 'off' : p.flow > 0 ? `supplying ${fmtFlow(p.flow, units)} at ${fmtTemp(p.temp, units)}` : `returning ${fmtFlow(-p.flow, units)}`}</span>
                  </div>
                ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function Stat(props: { label: string; value: string; sub?: string; tone?: 'ok' | 'bad' }) {
  return (
    <div className={`stat ${props.tone ?? ''}`}>
      <div className="stat-label">{props.label}</div>
      <div className="stat-value">{props.value}</div>
      <div className="stat-sub">{props.sub || ' '}</div>
    </div>
  );
}
