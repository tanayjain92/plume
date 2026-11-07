import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hasHeading, placeTool, TOOLS, type ToolKind } from '../scene/defaults';
import { dragHandle, handlesFor, removeItem, resizeWindow, SUN_ARROW, toggleWindow } from '../scene/editing';
import { sunPatches } from '../scene/solar';
import { edgeFrame, pointInPolygon, sceneShapes, type DeviceShape } from '../scene/geometry';
import type { Device, SceneV1 } from '../scene/types';
import type { Frame, FromWorker, GridInfo, ToWorker } from '../worker/protocol';
import { ControlsPanel } from './Controls';
import { SetupScreen } from './SetupScreen';
import { SliceView, type FieldKind, type Glyph, type Overlays } from './SliceView';
import { cellAt, cellCenter, type SliceAxis } from './slice';
import { deltaFromDisplay, deltaToDisplay, fmtDuration, fmtFlow, fmtLength, fmtPower, fmtSpeed, fmtTemp, fmtTempDelta, tempFromDisplay, tempToDisplay, type UnitSystem } from './units';

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
  sun: '#ffca28',
  sunlight: '#ffe082',
  sun_patch: '#ffd54f',
  window_ac: '#4dd0e1',
  portable_ac: '#4dd0e1',
  mini_split: '#4dd0e1',
  supply_vent: '#80deea',
  return_vent: '#b0bec5',
  box_fan: '#c5e1a5',
  ceiling_fan: '#c5e1a5',
  tower_fan: '#c5e1a5',
};

type ViewMode = 'top' | 'side';
type Drag =
  | { kind: 'move'; id: string; a: number; b: number; scene0: SceneV1 }
  | { kind: 'handle'; id: string; handle: string; scene0: SceneV1 };

/** Margin around the room in the top view, m: room for the sun outside. */
const OUTSIDE_MARGIN = 1.2;

export function App() {
  const workerRef = useRef<Worker | null>(null);
  const [scene, setScene] = useState<SceneV1 | null>(null);
  const [showSetup, setShowSetup] = useState(true);
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
  const [tool, setTool] = useState<ToolKind | null>(null);
  const [hoverWorld, setHoverWorld] = useState<[number, number] | null>(null);

  const [view, setView] = useState<ViewMode>('top');
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

  // Every scene edit goes to the worker. Live edits keep the flow; a new space restarts.
  useEffect(() => {
    if (!scene) return;
    send({ type: 'scene', scene, keepState: keepStateRef.current });
    keepStateRef.current = true;
  }, [scene, send]);

  const room = scene?.rooms[0];
  const bounds = useMemo(() => {
    if (!room) return { x0: 0, x1: 1, y0: 0, y1: 1, height: 1 };
    const xs = room.outline.map((p) => p[0]);
    const ys = room.outline.map((p) => p[1]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), height: room.height };
  }, [room]);

  const loadScene = (next: SceneV1) => {
    keepStateRef.current = false;
    setScene(next);
    setShowSetup(false);
    setSelected(null);
    setTool(null);
    setFrame(null);
    setGrid(null);
    setView('top');
    const r = next.rooms[0];
    const xs = r.outline.map((p) => p[0]);
    const ys = r.outline.map((p) => p[1]);
    setPlanZ(Math.min(1.1, r.height - 0.1));
    setSectionPos(sectionAxis === 'y' ? (Math.min(...ys) + Math.max(...ys)) / 2 : (Math.min(...xs) + Math.max(...xs)) / 2);
    // SPEC: diverging scale centered on the thermostat setpoint (room start temp if there's no AC).
    const setpoint = next.devices.find((d) => 'setpoint' in d) as { setpoint: number } | undefined;
    const center = setpoint ? setpoint.setpoint : 22;
    setTempCenter(center);
    setTempHalfRange(Math.max(4, Math.ceil(Math.abs(r.initialTemp - center) + 1)));
    if (!running) {
      setRunning(true);
      send({ type: 'run', running: true });
    }
  };

  const editScene = (next: SceneV1) => setScene(next);

  const toggleRun = () => {
    const next = !running;
    setRunning(next);
    send({ type: 'run', running: next });
  };

  const changeSpeed = (v: number) => {
    setSpeed(v);
    send({ type: 'speed', speed: v });
  };

  const pickTool = (t: ToolKind | null) => {
    setTool(t);
    if (t) {
      setView('top');
      setSelected(null);
    }
  };

  const saveScene = () => {
    if (!scene) return;
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

  // Keyboard: Esc cancels a tool or deselects; Delete removes the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'Escape') {
        if (tool) setTool(null);
        else setSelected(null);
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected && scene && !showSetup) {
        setScene(removeItem(scene, selected));
        setSelected(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tool, selected, scene, showSetup]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const fileInput = (
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
  );

  if (showSetup || !scene) {
    return (
      <>
        <SetupScreen units={units} onUnits={setUnits} onCreate={loadScene} onOpenFile={() => fileRef.current?.click()} onCancel={scene ? () => setShowSetup(false) : undefined} />
        {fileInput}
        {notice && <div className="toast">{notice}</div>}
      </>
    );
  }

  // ---------------------------------------------------------- view geometry

  const sliceAxis: SliceAxis = view === 'top' ? 'z' : sectionAxis;
  const sliceIndex = grid ? (view === 'top' ? cellAt(grid, 'z', planZ) : cellAt(grid, sectionAxis, sectionPos)) : 1;
  const padCells = grid && view === 'top' ? Math.round(OUTSIDE_MARGIN / grid.h) : 0;

  /** World plan point -> slice cell coords (top view). */
  const toCell = (x: number, y: number): [number, number] => {
    const { h, origin } = grid!;
    return [(x - origin[0]) / h, (y - origin[1]) / h];
  };
  const toWorld = (a: number, b: number): [number, number] => {
    const { h, origin } = grid!;
    return [origin[0] + a * h, origin[1] + b * h];
  };

  const toGlyphs = (shapes: DeviceShape[], ghostId?: string): Glyph[] => {
    if (!grid) return [];
    const { h, origin } = grid;
    const ax = sliceAxis === 'z' ? [0, 1] : sliceAxis === 'y' ? [0, 2] : [1, 2];
    const nAxis = sliceAxis === 'x' ? 0 : sliceAxis === 'y' ? 1 : 2;
    const sliceWorld = cellCenter(grid, sliceAxis, sliceIndex);
    const out: Glyph[] = [];
    for (const s of shapes) {
      // The sun and its light only make sense from above.
      if ((s.kind === 'sun' || s.kind === 'sunlight') && sliceAxis !== 'z') continue;
      const crosses = sliceAxis === 'z' || (sliceWorld >= s.lo[nAxis] - 0.3 && sliceWorld <= s.hi[nAxis] + 0.3);
      const g: Glyph = {
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
        ghost: s.id === ghostId,
      };
      if (s.poly) g.poly = s.poly.map(([x, y]) => toCell(x, y));
      if (s.kind === 'sun' && s.dir) {
        g.round = true;
        const cx = (s.lo[0] + s.hi[0]) / 2;
        const cy = (s.lo[1] + s.hi[1]) / 2;
        g.arrowTo = toCell(cx + s.dir[0] * SUN_ARROW, cy + s.dir[1] * SUN_ARROW);
        g.dir = undefined;
      }
      out.push(g);
    }
    return out;
  };

  const sunlight = (s: SceneV1): DeviceShape[] =>
    sunPatches(s).map((p) => ({ id: `sunlight:${p.sunId}:${p.windowId}`, kind: 'sunlight', poly: p.quad, lo: [0, 0, 0], hi: [0, 0, 0], enabled: true }));

  const shapes = [...sunlight(scene), ...sceneShapes(scene)];
  let glyphs = toGlyphs(shapes);
  // Ghost preview of the active tool under the cursor.
  if (tool && hoverWorld && view === 'top') {
    const r = placeTool(scene, tool, hoverWorld[0], hoverWorld[1]);
    if (!('error' in r)) {
      const preview = [...sunlight(r.scene), ...sceneShapes(r.scene)].filter((s) => !shapes.some((o) => o.id === s.id) || s.id === r.id);
      glyphs = [...glyphs.filter((g) => g.id !== r.id), ...toGlyphs(preview).map((g) => ({ ...g, ghost: true }))];
    }
  }

  const handles =
    grid && view === 'top' && selected && !tool
      ? handlesFor(scene, selected).map((hd) => {
          const [a, b] = toCell(hd.x, hd.y);
          return { id: hd.id, a, b, cursor: hd.cursor };
        })
      : [];

  const hitHandle = (a: number, b: number) => handles.find((hd) => Math.hypot(hd.a - a, hd.b - b) < 1.0) ?? null;

  const hitTest = (a: number, b: number): Glyph | null => {
    const pad = 0.6;
    let best: Glyph | null = null;
    let bestArea = Infinity;
    for (const g of glyphs) {
      if (g.ghost || g.poly || (view === 'side' && g.faded && !g.selected)) continue;
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

  const dragTo = (drag: Drag, a: number, b: number) => {
    if (!grid) return;
    const s0 = drag.scene0;
    if (drag.kind === 'handle') {
      const [x, y] = toWorld(a, b);
      editScene(dragHandle(s0, drag.id, drag.handle, x, y));
      return;
    }
    const dx = (a - drag.a) * grid.h;
    const dy = (b - drag.b) * grid.h;
    const r0 = s0.rooms[0];
    const moveOpening = (id: string) => {
      const op = s0.openings.find((o) => o.id === id);
      if (!op) return s0.openings;
      const f = edgeFrame(r0, op.edge);
      const offset = Math.max(0, Math.min(f.length - op.width, op.offset + dx * f.t[0] + dy * f.t[1]));
      return s0.openings.map((o) => (o.id === id ? { ...o, offset: Math.round(offset * 20) / 20 } : o));
    };
    const dev = s0.devices.find((d) => d.id === drag.id);
    if (!dev) return editScene({ ...s0, openings: moveOpening(drag.id) });
    if (dev.type === 'window_ac') return editScene({ ...s0, openings: moveOpening(dev.mountedIn) });
    const x = Math.round((dev.pos[0] + dx) * 20) / 20;
    const y = Math.round((dev.pos[1] + dy) * 20) / 20;
    const inside = pointInPolygon(x, y, r0.outline);
    if (dev.type === 'sun' ? inside : !inside) return; // the sun stays outside; everything else inside
    editScene({ ...s0, devices: s0.devices.map((d) => (d.id === dev.id ? ({ ...d, pos: [x, y, dev.pos[2]] } as typeof d) : d)) });
  };

  const onDown = (a: number, b: number) => {
    if (!grid) return;
    if (tool && view === 'top') {
      const [x, y] = toWorld(a, b);
      const r = placeTool(scene, tool, x, y);
      if ('error' in r) setNotice(r.error);
      else {
        editScene(r.scene);
        setSelected(r.id);
        setTool(null); // back to Select
      }
      return;
    }
    const hd = hitHandle(a, b);
    if (hd && selected) {
      dragRef.current = { kind: 'handle', id: selected, handle: hd.id, scene0: scene };
      return;
    }
    const hit = hitTest(a, b);
    if (hit) {
      setSelected(hit.id);
      dragRef.current = view === 'top' ? { kind: 'move', id: hit.id, a, b, scene0: scene } : null;
    } else {
      setSelected(null);
      dragRef.current = null;
    }
  };

  const onDoubleClick = (a: number, b: number) => {
    const hit = hitTest(a, b);
    if (hit && scene.openings.some((o) => o.id === hit.id)) editScene(toggleWindow(scene, hit.id));
  };

  // Cursor feedback in Select mode.
  let cursor: string | undefined;
  if (!tool && hoverWorld && grid) {
    const [ha, hb] = toCell(hoverWorld[0], hoverWorld[1]);
    const hd = hitHandle(ha, hb);
    cursor = hd ? handles.find((x) => x.id === hd.id)!.cursor : hitTest(ha, hb) ? (view === 'top' ? 'move' : 'pointer') : undefined;
  }

  // Quick actions above the selected object.
  const selGlyph = glyphs.find((g) => g.id === selected && !g.ghost);
  const selWindow = scene.openings.find((o) => o.id === selected);
  const selDevice = scene.devices.find((d) => d.id === selected);
  const setDev = (next: Device) => editScene({ ...scene, devices: scene.devices.map((d) => (d.id === next.id ? next : d)) });
  const actionBar =
    selGlyph && !tool && view === 'top'
      ? {
          a: Math.min(selGlyph.a0, selGlyph.a1),
          b: Math.max(selGlyph.b0, selGlyph.b1),
          node: (
            <>
              {selWindow && (
                <>
                  <div className="seg small">
                    <button className={selWindow.state === 'open' ? 'on' : ''} onClick={() => selWindow.state !== 'open' && editScene(toggleWindow(scene, selWindow.id))}>
                      Open
                    </button>
                    <button className={selWindow.state === 'closed' ? 'on' : ''} onClick={() => selWindow.state !== 'closed' && editScene(toggleWindow(scene, selWindow.id))}>
                      Closed
                    </button>
                  </div>
                  <button title="Narrower" onClick={() => editScene(resizeWindow(scene, selWindow.id, -0.15))}>
                    −
                  </button>
                  <span className="ab-value">{fmtLength(selWindow.width, units)}</span>
                  <button title="Wider" onClick={() => editScene(resizeWindow(scene, selWindow.id, 0.15))}>
                    +
                  </button>
                </>
              )}
              {selDevice && (
                <>
                  <button className={selDevice.enabled ? 'on' : ''} onClick={() => setDev({ ...selDevice, enabled: !selDevice.enabled } as Device)}>
                    {selDevice.enabled ? 'On' : 'Off'}
                  </button>
                  {hasHeading(selDevice) && (
                    <>
                      <button title="Rotate left" onClick={() => setDev({ ...selDevice, heading: (((selDevice.heading - (selDevice.type === 'sun' ? 15 : 45)) % 360) + 360) % 360 })}>
                        ⟲
                      </button>
                      <button title="Rotate right" onClick={() => setDev({ ...selDevice, heading: (selDevice.heading + (selDevice.type === 'sun' ? 15 : 45)) % 360 })}>
                        ⟳
                      </button>
                    </>
                  )}
                </>
              )}
              <button
                className="danger"
                title="Remove (Delete key)"
                onClick={() => {
                  editScene(removeItem(scene, selected!));
                  setSelected(null);
                }}
              >
                Remove
              </button>
            </>
          ),
        }
      : undefined;

  // ---------------------------------------------------------------- render

  const stats = frame?.stats;
  const devices = frame?.devices;
  const sectionMax = sectionAxis === 'x' ? bounds.x1 - 0.05 : bounds.y1 - 0.05;
  const viewTitle = !grid
    ? ''
    : view === 'top'
      ? `Top view at ${fmtLength(cellCenter(grid, 'z', sliceIndex), units)} above the floor`
      : `Side view cut at ${sectionAxis} = ${fmtLength(cellCenter(grid, sectionAxis, sliceIndex), units)}`;
  const activeTool = TOOLS.find((t) => t.kind === tool);

  return (
    <div className="app2">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            ≋
          </span>
          <div>
            <h1>Plume</h1>
            <p>{scene.name ?? 'Room'} · {grid ? `${fmtLength(bounds.x1 - bounds.x0, units)} × ${fmtLength(bounds.y1 - bounds.y0, units)}` : ''}</p>
          </div>
        </div>
        <div className="transport">
          <button className={`primary ${running ? 'running' : ''}`} onClick={toggleRun} disabled={!grid}>
            {running ? 'Pause' : 'Run'}
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
          <button onClick={() => fileRef.current?.click()}>Open…</button>
          <button onClick={saveScene}>Save…</button>
          <button onClick={() => setShowSetup(true)}>New space</button>
          {fileInput}
        </div>
      </header>

      <main className="main">
        <div className="stats">
          <Stat label="Room time" value={stats ? fmtDuration(stats.time) : '–'} sub={stats ? `${stats.realtimeFactor.toFixed(1)}× realtime` : ''} />
          <Stat label="Average" value={stats ? fmtTemp(stats.meanT, units, 1) : '–'} sub={stats ? `${fmtTemp(stats.minT, units)} – ${fmtTemp(stats.maxT, units)}` : ''} />
          <Stat
            label="Floor → ceiling"
            value={stats ? fmtTempDelta(stats.ceilingT - stats.floorT, units, 1) : '–'}
            sub={stats ? `${fmtTemp(stats.floorT, units)} → ${fmtTemp(stats.ceilingT, units)}` : ''}
          />
          <Stat label="Max air speed" value={stats ? fmtSpeed(stats.maxSpeed, units) : '–'} sub={stats ? `${stats.stepsPerSec.toFixed(0)} steps/s` : ''} />
          <Stat
            label="Outdoor air in"
            value={stats ? fmtFlow(stats.openInflow + Math.max(0, stats.leakFlow), units) : '–'}
            sub={stats ? (stats.leakFlow < -1e-4 ? `${fmtFlow(-stats.leakFlow, units)} leaking out` : stats.leakFlow > 1e-4 ? 'via leakage' : 'via open windows') : ''}
          />
          <Stat
            label="Solver health"
            value={stats ? (stats.maxDiv < DIV_TOL && stats.pressureConverged ? 'Good' : 'Check') : '–'}
            sub={stats ? `divergence ${stats.maxDiv.toExponential(1)} /s` : ''}
            tone={stats ? (stats.maxDiv < DIV_TOL && stats.pressureConverged ? 'ok' : 'bad') : undefined}
          />
        </div>

        <section className="panel viewbar">
          <div className="seg" role="group" aria-label="View">
            <button className={view === 'top' ? 'on' : ''} onClick={() => setView('top')}>
              Top view
            </button>
            <button className={view === 'side' ? 'on' : ''} onClick={() => setView('side')} disabled={Boolean(tool)}>
              Side view
            </button>
          </div>
          {view === 'top' ? (
            <label className="inline-slider">
              <span>Height</span>
              <input type="range" min={0.05} max={bounds.height - 0.05} step={0.1} value={planZ} onChange={(e) => setPlanZ(Number(e.target.value))} />
              <b>{grid ? fmtLength(cellCenter(grid, 'z', sliceIndex), units) : ''}</b>
            </label>
          ) : (
            <>
              <div className="seg small" role="group" aria-label="Cut direction">
                <button className={sectionAxis === 'y' ? 'on' : ''} onClick={() => setSectionAxis('y')}>
                  Cut along x
                </button>
                <button className={sectionAxis === 'x' ? 'on' : ''} onClick={() => setSectionAxis('x')}>
                  Cut along y
                </button>
              </div>
              <label className="inline-slider">
                <span>Cut at</span>
                <input type="range" min={0.05} max={sectionMax} step={0.1} value={sectionPos} onChange={(e) => setSectionPos(Number(e.target.value))} />
                <b>{grid ? fmtLength(cellCenter(grid, sectionAxis, sliceIndex), units) : ''}</b>
              </label>
            </>
          )}
          <select value={field} onChange={(e) => setField(e.target.value as FieldKind)} aria-label="Color by">
            {FIELDS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          {(
            [
              ['arrows', 'Arrows'],
              ['particles', 'Particles'],
              ['drafts', 'Drafts'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="check">
              <input type="checkbox" checked={overlays[key]} onChange={(e) => setOverlays((o) => ({ ...o, [key]: e.target.checked }))} />
              {label}
            </label>
          ))}
          <details className="color-settings">
            <summary>Scale</summary>
            <div className="popover">
              <label className="num">
                <span>Center</span>
                <input type="number" step={0.5} value={Number(tempToDisplay(tempCenter, units).toFixed(1))} onChange={(e) => setTempCenter(tempFromDisplay(Number(e.target.value), units))} />
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
              <label className="slider">
                <span>
                  Draft above <b>{fmtSpeed(draftThreshold, units)}</b>
                </span>
                <input type="range" min={0.05} max={1} step={0.05} value={draftThreshold} onChange={(e) => setDraftThreshold(Number(e.target.value))} />
              </label>
            </div>
          </details>
        </section>

        {grid ? (
          <div className={`single-view ${tool ? 'placing' : ''}`}>
            <SliceView
              title={viewTitle}
              dragHint={activeTool ? activeTool.hint : view === 'top' ? 'click to select · drag to move' : 'click to select'}
              grid={grid}
              frame={frame}
              axis={sliceAxis}
              index={sliceIndex}
              field={field}
              overlays={overlays}
              tempCenter={tempCenter}
              tempHalfRange={tempHalfRange}
              draftThreshold={draftThreshold}
              units={units}
              glyphs={glyphs}
              pad={padCells}
              handles={handles}
              actionBar={actionBar}
              cursor={cursor}
              clipPoly={view === 'top' ? scene.rooms[0].outline.map(([x, y]) => toCell(x, y)) : undefined}
              onDoubleClick={onDoubleClick}
              onPointerDown={onDown}
              onPointerDrag={(a, b) => dragRef.current && dragTo(dragRef.current, a, b)}
              onPointerUp={() => (dragRef.current = null)}
              onHover={(pt) => setHoverWorld(pt ? toWorld(pt.a, pt.b) : null)}
            />
          </div>
        ) : (
          <div className="loading">Building the grid…</div>
        )}

        {devices && (devices.acUnits.length > 0 || devices.fans.length > 0 || devices.ports.some((p) => !p.id.includes(':'))) && (
          <section className="panel readouts">
            <h3>Devices live</h3>
            <div className="readout-grid">
              {devices.acUnits.map((ac) => (
                <div key={ac.id} className={`readout-card ${ac.enabled ? '' : 'off'}`}>
                  <b>{ac.id}</b>
                  <span>{ac.enabled ? `blowing ${fmtTemp(ac.supplyT, units)} · room air in at ${fmtTemp(ac.returnT, units)}` : 'off'}</span>
                  {ac.enabled && (
                    <span className="muted small">
                      removing {fmtPower(ac.coolingW, units)} · {fmtFlow(ac.flow, units)}
                    </span>
                  )}
                </div>
              ))}
              {devices.fans.map((f) => (
                <div key={f.id} className={`readout-card ${f.delivered > 0 ? '' : 'off'}`}>
                  <b>{f.id}</b>
                  <span>{f.delivered > 0 ? `${Math.round(f.delivered * 100)}% of rated airflow` : 'off'}</span>
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

        {(warnings.length > 0 || solverLog.length > 0) && (
          <section className="panel notes-panel">
            <h3>Notes</h3>
            <ul className="notes">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
              {solverLog.map((w, i) => (
                <li key={`log${i}`} className="log">
                  {w}
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>

      <ControlsPanel scene={scene} units={units} tool={tool} onTool={pickTool} selected={selected} onSelect={setSelected} onChange={editScene} onRedefine={() => setShowSetup(true)} />
      {notice && <div className="toast">{notice}</div>}
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
