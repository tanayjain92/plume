import { useCallback, useEffect, useRef, useState } from 'react';
import { PRESETS } from '../scene/presets';
import type { Frame, FromWorker, GridInfo, SourceInfo, ToWorker } from '../worker/protocol';
import { SliceView, type FieldKind, type Overlays } from './SliceView';
import { cellAt, cellCenter, type SliceAxis } from './slice';
import {
  deltaFromDisplay,
  deltaToDisplay,
  fmtDuration,
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

export function App() {
  const workerRef = useRef<Worker | null>(null);
  const [presetId, setPresetId] = useState(PRESETS[0].id);
  const [grid, setGrid] = useState<GridInfo | null>(null);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [solverLog, setSolverLog] = useState<string[]>([]);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(0);
  const [units, setUnits] = useState<UnitSystem>('imperial');

  const [field, setField] = useState<FieldKind>('temperature');
  const [overlays, setOverlays] = useState<Overlays>({ arrows: true, particles: true, drafts: false });
  const [planZ, setPlanZ] = useState(1.1);
  const [sectionAxis, setSectionAxis] = useState<SliceAxis>('y');
  const [sectionPos, setSectionPos] = useState(1.8);
  const [tempCenter, setTempCenter] = useState(28);
  const [tempHalfRange, setTempHalfRange] = useState(2);
  const [draftThreshold, setDraftThreshold] = useState(0.25);

  const preset = PRESETS.find((p) => p.id === presetId)!;
  const send = useCallback((msg: ToWorker) => workerRef.current?.postMessage(msg), []);

  useEffect(() => {
    const worker = new Worker(new URL('../worker/simWorker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      const msg = ev.data;
      switch (msg.type) {
        case 'ready':
          setGrid(msg.grid);
          setSources(msg.sources);
          setWarnings(msg.warnings);
          break;
        case 'frame':
          setFrame(msg);
          break;
        case 'warn':
        case 'error':
          setSolverLog((log) => [`${msg.type === 'error' ? 'Error: ' : ''}${msg.message}`, ...log].slice(0, 6));
          break;
      }
    };
    worker.onerror = (e) => setSolverLog((log) => [`Worker error: ${e.message}`, ...log].slice(0, 6));
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  // Load a preset (and re-sync speed) whenever it changes.
  useEffect(() => {
    const scene = preset.scene;
    send({ type: 'speed', speed });
    send({ type: 'load', scene });
    const room = scene.rooms[0];
    setTempCenter(room.initialTemp);
    setPlanZ(Math.min(1.1, room.height - 0.1));
    const ys = room.outline.map((p) => p[1]);
    const xs = room.outline.map((p) => p[0]);
    setSectionPos(sectionAxis === 'y' ? (Math.min(...ys) + Math.max(...ys)) / 2 : (Math.min(...xs) + Math.max(...xs)) / 2);
    setSolverLog([]);
    setFrame(null);
    send({ type: 'run', running });
  }, [presetId, send]);

  const toggleRun = () => {
    const next = !running;
    setRunning(next);
    send({ type: 'run', running: next });
  };

  const changeSpeed = (v: number) => {
    setSpeed(v);
    send({ type: 'speed', speed: v });
  };

  const updateSource = (id: string, patch: { watts?: number; enabled?: boolean }) => {
    setSources((list) => list.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    send({ type: 'heat', id, ...patch });
  };

  const changeSectionAxis = (axis: SliceAxis) => {
    if (!grid) return;
    setSectionAxis(axis);
    const n = axis === 'x' ? grid.nx : grid.ny;
    setSectionPos(cellCenter(grid, axis, Math.floor(n / 2)));
  };

  const stats = frame?.stats;
  const roomHeight = preset.scene.rooms[0].height;
  const planK = grid ? cellAt(grid, 'z', planZ) : 1;
  const sectionIndex = grid ? cellAt(grid, sectionAxis, sectionPos) : 1;
  const sectionMax = grid ? cellCenter(grid, sectionAxis, (sectionAxis === 'x' ? grid.nx : grid.ny) - 2) : 1;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            ≋
          </span>
          <div>
            <h1>Plume</h1>
            <p>Room airflow simulator · phase 1 solver core</p>
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
          <select value={presetId} onChange={(e) => setPresetId(e.target.value)}>
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <p className="muted">{preset.description}</p>
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

        <section className="panel">
          <h3>Heat sources</h3>
          {sources.length === 0 && <p className="muted">None in this scene.</p>}
          {sources.map((s) => (
            <div key={s.id} className="source">
              <label className="check">
                <input
                  type="checkbox"
                  checked={s.enabled}
                  onChange={(e) => updateSource(s.id, { enabled: e.target.checked })}
                />
                <span className="source-name">{s.id}</span>
                <span className="source-val">{fmtPower(s.watts, units)}</span>
              </label>
              <input
                type="range"
                min={-1000}
                max={1500}
                step={10}
                value={s.watts}
                onChange={(e) => updateSource(s.id, { watts: Number(e.target.value) })}
              />
            </div>
          ))}
          <p className="muted small">Toggle and drag live while the sim runs. Negative values are heat sinks.</p>
        </section>

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
                <input
                  type="checkbox"
                  checked={overlays[key]}
                  onChange={(e) => setOverlays((o) => ({ ...o, [key]: e.target.checked }))}
                />
                {label}
              </label>
            ))}
          </div>

          <label className="slider">
            <span>
              Plan height <b>{fmtLength(planZ, units)}</b>
            </span>
            <input
              type="range"
              min={0.05}
              max={roomHeight - 0.05}
              step={0.1}
              value={planZ}
              onChange={(e) => setPlanZ(Number(e.target.value))}
            />
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
              Section at {sectionAxis} = <b>{fmtLength(sectionPos, units)}</b>
            </span>
            <input
              type="range"
              min={0.05}
              max={sectionMax}
              step={0.1}
              value={sectionPos}
              onChange={(e) => setSectionPos(Number(e.target.value))}
            />
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
            <input
              type="range"
              min={0.05}
              max={1}
              step={0.05}
              value={draftThreshold}
              onChange={(e) => setDraftThreshold(Number(e.target.value))}
            />
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
              dragHint="drag to move the section"
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
              marker={{
                orientation: sectionAxis === 'y' ? 'horizontal' : 'vertical',
                at: sectionIndex + 0.5,
                label: 'section',
              }}
              onDrag={(a, b) => {
                const i = Math.floor(sectionAxis === 'y' ? b : a);
                const n = sectionAxis === 'y' ? grid.ny : grid.nx;
                setSectionPos(cellCenter(grid, sectionAxis, Math.max(1, Math.min(n - 2, i))));
              }}
            />
            <SliceView
              title={`Section at ${sectionAxis} = ${fmtLength(cellCenter(grid, sectionAxis, sectionIndex), units)}`}
              dragHint="drag to move the plan height"
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
              marker={{ orientation: 'horizontal', at: planK + 0.5, label: 'plan' }}
              onDrag={(_a, b) => {
                const k = Math.max(1, Math.min(grid.nz - 2, Math.floor(b)));
                setPlanZ(cellCenter(grid, 'z', k));
              }}
            />
          </div>
        ) : (
          <div className="loading">Building the grid…</div>
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
