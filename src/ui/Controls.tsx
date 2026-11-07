import { DEFAULT_ENVELOPE, hasHeading, INSULATION_LEVELS, LEAK_LEVELS, strengthFor, TOOLS, type ToolKind } from '../scene/defaults';
import { resizeWindow } from '../scene/editing';
import { patchArea } from '../scene/solar';
import type { Device, Opening, SceneV1 } from '../scene/types';
import { deviceFields, Fields, NumberField, windowFields } from './Editor';
import { floorFraction, sunPatches } from '../scene/solar';
import { fmtLength, fmtPower, fmtSpeed, fmtTemp, quantity, type UnitSystem } from './units';

export interface SensorReading {
  T: number;
  speed: number;
  /** °C per minute of room time, if known. */
  trend?: number;
}

const GROUPS = ['Cooling', 'Fans', 'Openings', 'Heat', 'Measure'] as const;

const KIND_LABEL: Record<Device['type'], string> = {
  sensor: 'Temp sensor',
  heat_source: 'Heat source',
  sun: 'Sun',
  sun_patch: 'Sun patch',
  window_ac: 'Window AC',
  portable_ac: 'Portable AC',
  mini_split: 'Mini split',
  supply_vent: 'Supply vent',
  return_vent: 'Return vent',
  box_fan: 'Box fan',
  ceiling_fan: 'Ceiling fan',
  tower_fan: 'Tower fan',
};

const KIND_ICON: Record<Device['type'] | 'window', string> = {
  sensor: '🌡',
  window: '▭',
  heat_source: '♨',
  sun: '☀',
  sun_patch: '☀',
  window_ac: '❄',
  portable_ac: '❄',
  mini_split: '❄',
  supply_vent: '⇩',
  return_vent: '⇧',
  box_fan: '▣',
  ceiling_fan: '✢',
  tower_fan: '▮',
};

function fmtStrength(v: number, q: 'btuh' | 'cfm' | 'watts' | 'wm2', units: UnitSystem): string {
  if (q === 'wm2') return `${Math.round(v)} W/m²`;
  const spec = quantity[q];
  return `${spec.to(v, units).toFixed(spec.digits)} ${spec.unit(units)}`;
}

export function ControlsPanel(props: {
  scene: SceneV1;
  units: UnitSystem;
  tool: ToolKind | null;
  onTool: (t: ToolKind | null) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChange: (s: SceneV1) => void;
  onRedefine: () => void;
  readings: Record<string, SensorReading>;
}) {
  const { scene, units, tool, selected } = props;
  const room = scene.rooms[0];
  const selDevice = scene.devices.find((d) => d.id === selected);
  const selWindow = scene.openings.find((o) => o.id === selected);
  const activeTool = TOOLS.find((t) => t.kind === tool);

  const setDevice = (next: Device) => props.onChange({ ...scene, devices: scene.devices.map((d) => (d.id === next.id ? next : d)) });
  const setWindow = (next: Opening) => props.onChange({ ...scene, openings: scene.openings.map((o) => (o.id === next.id ? next : o)) });
  const remove = (id: string) => {
    props.onChange({
      ...scene,
      openings: scene.openings.filter((o) => o.id !== id),
      // a window AC goes with its window
      devices: scene.devices.filter((d) => d.id !== id && !(d.type === 'window_ac' && d.mountedIn === id)),
    });
    props.onSelect(null);
  };

  return (
    <aside className="controls">
      <section className="panel">
        <h3>Controls</h3>
        <button className={`tool select-tool ${tool === null ? 'on' : ''}`} onClick={() => props.onTool(null)} title="Select objects to move, resize and change them">
          <span className="tool-icon">↖</span>
          <span>
            Select <span className="muted small">· click an object to change it</span>
          </span>
        </button>
        {GROUPS.map((g) => (
          <div key={g} className="tool-group">
            <div className="group-label">{g}</div>
            <div className="tool-grid">
              {TOOLS.filter((t) => t.group === g).map((t) => (
                <button key={t.kind} className={`tool ${tool === t.kind ? 'on' : ''}`} onClick={() => props.onTool(tool === t.kind ? null : t.kind)} title={t.hint}>
                  <span className="tool-icon">{t.icon}</span>
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
        {activeTool && (
          <p className="tool-hint">
            {activeTool.hint} <span className="muted">Esc to cancel.</span>
          </p>
        )}
      </section>

      {selected?.startsWith('sunlight:') && <SunlightPanel id={selected} scene={scene} units={units} onChange={props.onChange} />}

      {(selDevice || selWindow) && (
        <section className="panel selected">
          <div className="panel-head">
            <h4>
              <span className="icon">{KIND_ICON[selDevice ? selDevice.type : 'window']}</span> {selected}
            </h4>
            {selDevice && (
              <label className="switch" title={selDevice.enabled ? 'On' : 'Off'}>
                <input type="checkbox" checked={selDevice.enabled} onChange={(e) => setDevice({ ...selDevice, enabled: e.target.checked } as Device)} />
                <span>{selDevice.enabled ? 'On' : 'Off'}</span>
              </label>
            )}
          </div>

          {selDevice?.type === 'sensor' && <SensorPanel device={selDevice} reading={props.readings[selDevice.id]} height={room.height} units={units} onChange={setDevice} />}
          {selDevice && selDevice.type !== 'sensor' && <DeviceStrength device={selDevice} scene={scene} units={units} onChange={setDevice} />}

          {selWindow && (
            <div className="strength">
              <div className="group-label">Window</div>
              <div className="chips">
                {(['closed', 'open'] as const).map((s) => (
                  <button key={s} className={selWindow.state === s ? 'on' : ''} onClick={() => setWindow({ ...selWindow, state: s })}>
                    {s === 'open' ? 'Open' : 'Closed'}
                  </button>
                ))}
              </div>
              {scene.devices.some((d) => d.type === 'window_ac' && d.mountedIn === selWindow.id) && <p className="muted small">A window AC fills this window.</p>}
            </div>
          )}

          <details className="more">
            <summary>More settings</summary>
            {selDevice && <Fields item={selDevice} fields={deviceFields(selDevice, scene)} units={units} onChange={setDevice} />}
            {selWindow && <Fields item={selWindow} fields={windowFields(room)} units={units} onChange={setWindow} />}
          </details>
          <div className="row-buttons">
            <button className="danger" onClick={() => remove(selected!)}>
              Remove
            </button>
          </div>
          <p className="muted small">Drag it in the top view to move it.</p>
        </section>
      )}

      <section className="panel">
        <h3>In this room</h3>
        {scene.openings.length + scene.devices.length === 0 ? (
          <p className="muted small">Nothing yet. Pick something under Controls, then click in the room.</p>
        ) : (
          <ul className="device-list">
            {scene.openings.map((o) => (
              <li key={o.id} className={selected === o.id ? 'sel' : ''} onClick={() => props.onSelect(o.id)}>
                <span className="icon">{KIND_ICON.window}</span>
                <span className="name">{o.id}</span>
                <span className="kind">{o.state === 'open' ? 'open' : 'closed'}</span>
              </li>
            ))}
            {scene.devices.map((d) => (
              <li key={d.id} className={`${selected === d.id ? 'sel' : ''} ${d.enabled ? '' : 'off'}`} onClick={() => props.onSelect(d.id)}>
                <input
                  type="checkbox"
                  checked={d.enabled}
                  title={d.enabled ? 'Turn off' : 'Turn on'}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setDevice({ ...d, enabled: e.target.checked } as Device)}
                />
                <span className="icon">{KIND_ICON[d.type]}</span>
                <span className="name">{d.id}</span>
                <span className="kind">{d.type === 'sensor' && props.readings[d.id] ? fmtTemp(props.readings[d.id].T, units) : KIND_LABEL[d.type]}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h3>Room & weather</h3>
        <div className="fields">
          <label className="field">
            <span>Room starts at</span>
            <NumberField value={room.initialTemp} q="temp" units={units} onChange={(v) => props.onChange({ ...scene, rooms: [{ ...room, initialTemp: v }] })} />
          </label>
          <label className="field">
            <span>Outside</span>
            <NumberField value={scene.outdoor.temp} q="temp" units={units} onChange={(v) => props.onChange({ ...scene, outdoor: { ...scene.outdoor, temp: v } })} />
          </label>
          <label className="field">
            <span>Wind speed</span>
            <NumberField value={scene.outdoor.windSpeed} q="wind" units={units} min={0} onChange={(v) => props.onChange({ ...scene, outdoor: { ...scene.outdoor, windSpeed: v } })} />
          </label>
          <label className="field">
            <span>Wind from (0° = top of plan)</span>
            <NumberField value={scene.outdoor.windFrom} q="deg" units={units} onChange={(v) => props.onChange({ ...scene, outdoor: { ...scene.outdoor, windFrom: ((v % 360) + 360) % 360 } })} />
          </label>
        </div>
        <Insulation scene={scene} onChange={props.onChange} />
        <p className="muted small">
          Ceiling {fmtLength(room.height, units)}. Floor and ceiling are treated as not losing heat (rooms above and below). The starting temperature applies on Reset; wind only matters with an open window.
        </p>
        <div className="row-buttons">
          <button onClick={props.onRedefine}>Redefine space…</button>
        </div>
      </section>
    </aside>
  );
}

function DeviceStrength(props: { device: Device; scene: SceneV1; units: UnitSystem; onChange: (d: Device) => void }) {
  const { device: d, units } = props;
  const s = strengthFor(d);
  return (
    <div className="strength">
      {s && (
        <>
          <div className="strength-head">
            <span className="group-label">{s.label}</span>
            <b>{fmtStrength(s.get(d), s.q, units)}</b>
          </div>
          <div className="chips">
            {s.chips.map((c) => (
              <button key={c.label} className={s.get(d) === c.value ? 'on' : ''} onClick={() => props.onChange(s.set(d, c.value))}>
                {c.label}
              </button>
            ))}
          </div>
          <input type="range" min={s.min} max={s.max} step={s.step} value={s.get(d)} onChange={(e) => props.onChange(s.set(d, Number(e.target.value)))} />
        </>
      )}
      {hasHeading(d) && (
        <div className="aim">
          <span className="group-label">Direction</span>
          <div className="chips">
            <button onClick={() => props.onChange({ ...d, heading: (((d.heading - 45) % 360) + 360) % 360 })} title="Rotate left">
              ⟲ 45°
            </button>
            <span className="compass" style={{ transform: `rotate(${d.heading}deg)` }}>
              ↑
            </span>
            <button onClick={() => props.onChange({ ...d, heading: (d.heading + 45) % 360 })} title="Rotate right">
              45° ⟳
            </button>
          </div>
        </div>
      )}
      {d.type === 'ceiling_fan' && (
        <div className="chips">
          <button className={!d.reverse ? 'on' : ''} onClick={() => props.onChange({ ...d, reverse: false })}>
            Summer (down)
          </button>
          <button className={d.reverse ? 'on' : ''} onClick={() => props.onChange({ ...d, reverse: true })}>
            Winter (up)
          </button>
        </div>
      )}
      {d.type === 'tower_fan' && (
        <div className="chips">
          <button className={d.oscillateDeg > 0 ? 'on' : ''} onClick={() => props.onChange({ ...d, oscillateDeg: d.oscillateDeg > 0 ? 0 : 70 })}>
            {d.oscillateDeg > 0 ? 'Oscillating' : 'Oscillate off'}
          </button>
        </div>
      )}
      {d.type === 'supply_vent' && <p className="muted small">Set the supply air temperature under More settings.</p>}
      {d.type === 'sun' && (
        <div className="aim">
          <div className="strength-head">
            <span className="group-label">Sun height</span>
            <b>{Math.round(d.elevationDeg)}°</b>
          </div>
          <div className="chips">
            {(
              [
                ['Low (morning)', 15],
                ['Mid', 35],
                ['High (midday)', 60],
              ] as const
            ).map(([label, v]) => (
              <button key={label} className={d.elevationDeg === v ? 'on' : ''} onClick={() => props.onChange({ ...d, elevationDeg: v })}>
                {label}
              </button>
            ))}
          </div>
          <input type="range" min={5} max={85} step={1} value={d.elevationDeg} onChange={(e) => props.onChange({ ...d, elevationDeg: Number(e.target.value) })} />
          <p className="muted small">Drag the arrow in the top view to aim it. Low sun reaches deep into the room; high sun lands near the window.</p>
          <SunReach sunId={d.id} scene={props.scene} units={units} />
        </div>
      )}
    </div>
  );
}

function SunReach(props: { sunId: string; scene: SceneV1; units: UnitSystem }) {
  const patches = sunPatches(props.scene).filter((p) => p.sunId === props.sunId);
  if (patches.length === 0) return <p className="warn-text small">Not shining through any window. Aim it at a window, or add a window on this side.</p>;
  const outline = props.scene.rooms[0].outline;
  const entering = patches.reduce((s, p) => s + p.enteringW, 0);
  const onFloor = patches.reduce((s, p) => s + p.enteringW * floorFraction(p, outline), 0);
  const floorPct = entering > 0 ? Math.round((100 * onFloor) / entering) : 0;
  return (
    <>
      <p className="small">
        Shining in through {patches.map((p) => p.windowId).join(', ')}: {fmtPower(entering, props.units)} of sunlight.
      </p>
      {floorPct < 95 && (
        <p className="warn-text small">
          Only {floorPct}% lands on the floor; the rest hits a wall, which doesn't heat the room until phase 3. Raise the sun or aim it more squarely at the window.
        </p>
      )}
    </>
  );
}

function Insulation(props: { scene: SceneV1; onChange: (s: SceneV1) => void }) {
  const { scene } = props;
  const env = scene.envelope;
  const room = scene.rooms[0];
  if (!env)
    return (
      <p className="warn-text small">
        No insulation settings: walls let no heat through.{' '}
        <button className="link" onClick={() => props.onChange({ ...scene, envelope: { ...DEFAULT_ENVELOPE } })}>
          Add average insulation
        </button>
      </p>
    );
  const setEnv = (patch: Partial<typeof env>) => props.onChange({ ...scene, envelope: { ...env, ...patch } });
  const ext = env.exteriorEdges ?? room.outline.map((_, i) => i);
  return (
    <div className="strength">
      <span className="group-label">Wall insulation</span>
      <div className="chips">
        {INSULATION_LEVELS.map((l) => (
          <button key={l.label} className={env.wallU === l.wallU ? 'on' : ''} onClick={() => setEnv({ wallU: l.wallU })} title={`U = ${l.wallU} W/m²·K`}>
            {l.label}
          </button>
        ))}
      </div>
      <span className="group-label">Air leaks</span>
      <div className="chips">
        {LEAK_LEVELS.map((l) => (
          <button key={l.label} className={env.ach === l.ach ? 'on' : ''} onClick={() => setEnv({ ach: l.ach })} title={`${l.ach} air changes per hour`}>
            {l.label}
          </button>
        ))}
      </div>
      <span className="group-label">Walls facing outside</span>
      <div className="chips">
        {room.outline.map((_, i) => (
          <button
            key={i}
            className={ext.includes(i) ? 'on' : ''}
            onClick={() => {
              const next = ext.includes(i) ? ext.filter((e) => e !== i) : [...ext, i].sort((a, b) => a - b);
              setEnv({ exteriorEdges: next.length === room.outline.length ? undefined : next });
            }}
          >
            Wall {i + 1}
          </button>
        ))}
      </div>
    </div>
  );
}

const SENSOR_HEIGHTS = [
  ['Ankle', 0.1],
  ['Seated', 1.1],
  ['Standing', 1.7],
] as const;

function SensorPanel(props: { device: Extract<Device, { type: 'sensor' }>; reading?: SensorReading; height: number; units: UnitSystem; onChange: (d: Device) => void }) {
  const { device: d, reading: r, units } = props;
  const near = Math.round((props.height - 0.2) * 100) / 100;
  return (
    <div className="strength">
      <div className="sensor-reading">
        {r ? (
          <>
            <b>{fmtTemp(r.T, units, 1)}</b>
            <span className="muted">
              air moving {fmtSpeed(r.speed, units)}
              {r.trend !== undefined && Math.abs(r.trend) > 0.005 ? ` · ${r.trend > 0 ? 'warming' : 'cooling'} ${(Math.abs(r.trend) * (units === 'imperial' ? 1.8 : 1)).toFixed(2)}°/min` : ''}
            </span>
          </>
        ) : (
          <span className="muted">Run the simulation to get a reading.</span>
        )}
      </div>
      <span className="group-label">Height</span>
      <div className="chips">
        {[...SENSOR_HEIGHTS, ['Ceiling', near] as const].map(([label, z]) => (
          <button key={label} className={Math.abs(d.pos[2] - z) < 0.01 ? 'on' : ''} onClick={() => props.onChange({ ...d, pos: [d.pos[0], d.pos[1], z] })}>
            {label}
          </button>
        ))}
      </div>
      <p className="muted small">At {fmtLength(d.pos[2], units)} above the floor. Sensors only read the air; they don't change it.</p>
    </div>
  );
}

function SunlightPanel(props: { id: string; scene: SceneV1; units: UnitSystem; onChange: (s: SceneV1) => void }) {
  const { scene, units } = props;
  const [, sunId, windowId] = props.id.split(':');
  const patch = sunPatches(scene).find((p) => p.sunId === sunId && p.windowId === windowId);
  const sun = scene.devices.find((d) => d.id === sunId);
  if (!patch || !sun || sun.type !== 'sun') return null;
  const area = patchArea(patch);
  const setSun = (elevationDeg: number) =>
    props.onChange({ ...scene, devices: scene.devices.map((d) => (d.id === sun.id ? { ...sun, elevationDeg: Math.max(5, Math.min(85, elevationDeg)) } : d)) });
  return (
    <section className="panel selected">
      <div className="panel-head">
        <h4>
          <span className="icon">☀</span> Sunlight through {windowId}
        </h4>
      </div>
      <p className="small">
        {units === 'imperial' ? `${Math.round(area / 0.0929)} ft²` : `${area.toFixed(1)} m²`} of sunlit floor, {fmtPower(patch.enteringW, units)} of sunlight.
      </p>
      <span className="group-label">Make it bigger or smaller</span>
      <div className="chips">
        <button onClick={() => props.onChange(resizeWindow(scene, windowId, -0.15))}>Narrower window</button>
        <button onClick={() => props.onChange(resizeWindow(scene, windowId, 0.15))}>Wider window</button>
      </div>
      <div className="chips">
        <button onClick={() => setSun(sun.elevationDeg + 5)}>Sun higher (shorter)</button>
        <button onClick={() => setSun(sun.elevationDeg - 5)}>Sun lower (longer)</button>
      </div>
      <p className="muted small">The patch is where the sun lands through the window. Drag its sides to resize the window, or its far edge to change how high the sun is.</p>
    </section>
  );
}
