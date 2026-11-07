import { useEffect, useState } from 'react';
import { DEVICE_LABELS, newDevice, newWindow, type AddableKind } from '../scene/defaults';
import type { Device, Opening, SceneV1 } from '../scene/types';
import { quantity, type Quantity, type UnitSystem } from './units';

// ------------------------------------------------------------------ fields

interface FieldSpec {
  /** Dot path into the device/opening, e.g. "pos.0". */
  path: string;
  label: string;
  q: Quantity | 'bool' | 'select';
  min?: number;
  max?: number;
  options?: { value: string | number; label: string }[];
}

const POS_XY: FieldSpec[] = [
  { path: 'pos.0', label: 'x', q: 'len' },
  { path: 'pos.1', label: 'y', q: 'len' },
];
const POS_XYZ: FieldSpec[] = [...POS_XY, { path: 'pos.2', label: 'z (height)', q: 'len', min: 0 }];
const HEADING: FieldSpec = { path: 'heading', label: 'Heading (0 = +y, clockwise)', q: 'deg' };
const CFM: FieldSpec = { path: 'airflowCfm', label: 'Airflow', q: 'cfm', min: 0 };
const AC: FieldSpec[] = [
  { path: 'capacityBtuh', label: 'Capacity', q: 'btuh', min: 0 },
  CFM,
  { path: 'setpoint', label: 'Setpoint (phase 3)', q: 'temp' },
];

const EDGES = [
  { value: 0, label: 'Edge 0 (south)' },
  { value: 1, label: 'Edge 1 (east)' },
  { value: 2, label: 'Edge 2 (north)' },
  { value: 3, label: 'Edge 3 (west)' },
];

function deviceFields(d: Device, scene: SceneV1): FieldSpec[] {
  switch (d.type) {
    case 'heat_source':
      return [
        ...POS_XYZ,
        { path: 'size.0', label: 'Size x', q: 'len', min: 0 },
        { path: 'size.1', label: 'Size y', q: 'len', min: 0 },
        { path: 'size.2', label: 'Size z', q: 'len', min: 0 },
        { path: 'watts', label: 'Heat (person ≈ 100, PC 100–300)', q: 'watts' },
      ];
    case 'window_ac':
      return [
        { path: 'mountedIn', label: 'Mounted in', q: 'select', options: scene.openings.map((o) => ({ value: o.id, label: o.id })) },
        ...AC,
        { path: 'shr', label: 'Sensible heat ratio', q: 'num', min: 0.4, max: 1 },
      ];
    case 'portable_ac':
      return [...POS_XY, HEADING, ...AC, { path: 'exhaustCfm', label: 'Exhaust airflow', q: 'cfm', min: 0 }, { path: 'shr', label: 'Sensible heat ratio', q: 'num', min: 0.4, max: 1 }];
    case 'mini_split':
      return [...POS_XYZ, HEADING, ...AC, { path: 'louverDeg', label: 'Louver angle down', q: 'deg', min: 0, max: 80 }];
    case 'supply_vent':
      return [
        ...POS_XYZ,
        { path: 'size.0', label: 'Width', q: 'len', min: 0 },
        { path: 'size.1', label: 'Length', q: 'len', min: 0 },
        CFM,
        { path: 'supplyTemp', label: 'Supply temperature', q: 'temp' },
        { path: 'direction.0', label: 'Jet direction x', q: 'num' },
        { path: 'direction.1', label: 'Jet direction y', q: 'num' },
        { path: 'direction.2', label: 'Jet direction z', q: 'num' },
      ];
    case 'return_vent':
      return [...POS_XYZ, { path: 'size.0', label: 'Width', q: 'len', min: 0 }, { path: 'size.1', label: 'Length', q: 'len', min: 0 }, CFM];
    case 'box_fan':
      return [...POS_XYZ, HEADING, { path: 'diameter', label: 'Diameter', q: 'len', min: 0.1 }, CFM];
    case 'ceiling_fan':
      return [...POS_XYZ, { path: 'diameter', label: 'Diameter', q: 'len', min: 0.3 }, CFM, { path: 'reverse', label: 'Reverse (updraft)', q: 'bool' }];
    case 'tower_fan':
      return [
        ...POS_XY,
        HEADING,
        { path: 'slotHeight', label: 'Slot height', q: 'len', min: 0.2 },
        CFM,
        { path: 'oscillateDeg', label: 'Oscillation', q: 'deg', min: 0, max: 180 },
        { path: 'periodSec', label: 'Oscillation period', q: 'sec', min: 1 },
      ];
  }
}

const WINDOW_FIELDS: FieldSpec[] = [
  { path: 'edge', label: 'Wall', q: 'select', options: EDGES },
  { path: 'offset', label: 'Offset along wall', q: 'len', min: 0 },
  { path: 'width', label: 'Width', q: 'len', min: 0.1 },
  { path: 'sill', label: 'Sill height', q: 'len', min: 0 },
  { path: 'height', label: 'Height', q: 'len', min: 0.1 },
  {
    path: 'state',
    label: 'State',
    q: 'select',
    options: [
      { value: 'closed', label: 'Closed' },
      { value: 'open', label: 'Open' },
    ],
  },
];

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);
}

function setPath<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split('.');
  const clone = (o: unknown): unknown => (Array.isArray(o) ? [...o] : { ...(o as object) });
  const root = clone(obj) as Record<string, unknown>;
  let cur = root;
  for (let i = 0; i < keys.length - 1; i++) {
    cur[keys[i]] = clone(cur[keys[i]]);
    cur = cur[keys[i]] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
  return root as T;
}

/** Number input in display units. Keeps the typed text while focused; commits valid numbers. */
function NumberField(props: { value: number; q: Quantity; units: UnitSystem; min?: number; max?: number; onChange: (si: number) => void }) {
  const spec = quantity[props.q];
  const shown = Number(spec.to(props.value, props.units).toFixed(spec.digits));
  const [text, setText] = useState(String(shown));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(String(shown));
  }, [shown, focused]);
  return (
    <span className="numfield">
      <input
        type="number"
        value={text}
        step={spec.digits === 0 ? 1 : 1 / 10 ** Math.min(spec.digits, 2)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value === '' || !Number.isFinite(v)) return;
          let si = spec.from(v, props.units);
          if (props.min !== undefined) si = Math.max(props.min, si);
          if (props.max !== undefined) si = Math.min(props.max, si);
          props.onChange(si);
        }}
      />
      <span className="unit">{spec.unit(props.units)}</span>
    </span>
  );
}

function Fields<T>(props: { item: T; fields: FieldSpec[]; units: UnitSystem; onChange: (next: T) => void }) {
  return (
    <div className="fields">
      {props.fields.map((f) => {
        const value = getPath(props.item, f.path);
        return (
          <label key={f.path} className="field">
            <span>{f.label}</span>
            {f.q === 'bool' ? (
              <input type="checkbox" checked={Boolean(value)} onChange={(e) => props.onChange(setPath(props.item, f.path, e.target.checked))} />
            ) : f.q === 'select' ? (
              <select
                value={String(value)}
                onChange={(e) => {
                  const opt = f.options!.find((o) => String(o.value) === e.target.value)!;
                  props.onChange(setPath(props.item, f.path, opt.value));
                }}
              >
                {f.options!.map((o) => (
                  <option key={String(o.value)} value={String(o.value)}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <NumberField
                value={Number(value ?? 0)}
                q={f.q}
                units={props.units}
                min={f.min}
                max={f.max}
                onChange={(v) => props.onChange(setPath(props.item, f.path, v))}
              />
            )}
          </label>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ panels

export function RoomPanel(props: { scene: SceneV1; units: UnitSystem; onChange: (s: SceneV1) => void }) {
  const { scene, units } = props;
  const room = scene.rooms[0];
  const xs = room.outline.map((p) => p[0]);
  const ys = room.outline.map((p) => p[1]);
  const w = Math.max(...xs) - Math.min(...xs);
  const d = Math.max(...ys) - Math.min(...ys);
  const setRoom = (patch: Partial<typeof room>) => props.onChange({ ...scene, rooms: [{ ...room, ...patch }, ...scene.rooms.slice(1)] });
  const setSize = (nw: number, nd: number) =>
    setRoom({
      outline: [
        [0, 0],
        [nw, 0],
        [nw, nd],
        [0, nd],
      ],
    });
  const fields = (
    <div className="fields">
      <label className="field">
        <span>Width (x)</span>
        <NumberField value={w} q="len" units={units} min={1} max={15} onChange={(v) => setSize(v, d)} />
      </label>
      <label className="field">
        <span>Depth (y)</span>
        <NumberField value={d} q="len" units={units} min={1} max={15} onChange={(v) => setSize(w, v)} />
      </label>
      <label className="field">
        <span>Ceiling height</span>
        <NumberField value={room.height} q="len" units={units} min={1.8} max={6} onChange={(v) => setRoom({ height: v })} />
      </label>
      <label className="field">
        <span>Starting temperature</span>
        <NumberField value={room.initialTemp} q="temp" units={units} onChange={(v) => setRoom({ initialTemp: v })} />
      </label>
      <label className="field">
        <span>Outdoor temperature</span>
        <NumberField value={scene.outdoor.temp} q="temp" units={units} onChange={(v) => props.onChange({ ...scene, outdoor: { ...scene.outdoor, temp: v } })} />
      </label>
      <label className="field">
        <span>Wind speed</span>
        <NumberField value={scene.outdoor.windSpeed} q="wind" units={units} min={0} onChange={(v) => props.onChange({ ...scene, outdoor: { ...scene.outdoor, windSpeed: v } })} />
      </label>
      <label className="field">
        <span>Wind from (0 = north)</span>
        <NumberField value={scene.outdoor.windFrom} q="deg" units={units} onChange={(v) => props.onChange({ ...scene, outdoor: { ...scene.outdoor, windFrom: ((v % 360) + 360) % 360 } })} />
      </label>
    </div>
  );
  return (
    <section className="panel">
      <h3>Room</h3>
      {room.outline.length !== 4 ? <p className="muted small">Only rectangular rooms are editable in phase 2.</p> : fields}
      <p className="muted small">Changing the size or height rebuilds the grid and restarts the sim.</p>
    </section>
  );
}

const DEVICE_ICON: Record<AddableKind, string> = {
  window: '▭',
  heat_source: '♨',
  window_ac: '❄',
  portable_ac: '❄',
  mini_split: '❄',
  supply_vent: '↓',
  return_vent: '↑',
  box_fan: '✣',
  ceiling_fan: '✣',
  tower_fan: '✣',
};

export function DevicesPanel(props: {
  scene: SceneV1;
  units: UnitSystem;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChange: (s: SceneV1) => void;
  onNotice: (msg: string) => void;
}) {
  const { scene, units, selected } = props;
  const [adding, setAdding] = useState(false);

  const add = (kind: AddableKind) => {
    setAdding(false);
    if (kind === 'window') {
      const w = newWindow(scene);
      props.onChange({ ...scene, openings: [...scene.openings, w] });
      props.onSelect(w.id);
      return;
    }
    const d = newDevice(scene, kind);
    if (!d) {
      props.onNotice('A window AC needs a free window. Add a window first.');
      return;
    }
    props.onChange({ ...scene, devices: [...scene.devices, d] });
    props.onSelect(d.id);
  };

  const remove = (id: string) => {
    props.onChange({
      ...scene,
      openings: scene.openings.filter((o) => o.id !== id),
      // a window AC goes with its window
      devices: scene.devices.filter((d) => d.id !== id && !(d.type === 'window_ac' && d.mountedIn === id)),
    });
    props.onSelect(null);
  };

  const setDevice = (next: Device) => props.onChange({ ...scene, devices: scene.devices.map((d) => (d.id === next.id ? next : d)) });
  const setOpening = (next: Opening) => props.onChange({ ...scene, openings: scene.openings.map((o) => (o.id === next.id ? next : o)) });

  const selDevice = scene.devices.find((d) => d.id === selected);
  const selOpening = scene.openings.find((o) => o.id === selected);

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Windows & devices</h3>
        <button className="small-btn" onClick={() => setAdding((a) => !a)}>
          {adding ? 'Cancel' : '+ Add'}
        </button>
      </div>
      {adding && (
        <div className="add-grid">
          {(Object.keys(DEVICE_LABELS) as AddableKind[]).map((k) => (
            <button key={k} onClick={() => add(k)}>
              <span className="icon">{DEVICE_ICON[k]}</span> {DEVICE_LABELS[k]}
            </button>
          ))}
        </div>
      )}
      <ul className="device-list">
        {scene.openings.map((o) => (
          <li key={o.id} className={selected === o.id ? 'sel' : ''} onClick={() => props.onSelect(o.id)}>
            <span className="icon">{DEVICE_ICON.window}</span>
            <span className="name">{o.id}</span>
            <span className="kind">{o.state === 'open' ? 'open window' : 'closed window'}</span>
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
            <span className="icon">{DEVICE_ICON[d.type]}</span>
            <span className="name">{d.id}</span>
            <span className="kind">{DEVICE_LABELS[d.type]}</span>
          </li>
        ))}
      </ul>
      {scene.openings.length + scene.devices.length === 0 && <p className="muted small">Empty room. Add a window or device.</p>}

      {(selDevice || selOpening) && (
        <div className="inspector">
          <div className="panel-head">
            <h4>{selected}</h4>
            <button className="small-btn danger" onClick={() => remove(selected!)}>
              Delete
            </button>
          </div>
          {selDevice && <Fields item={selDevice} fields={deviceFields(selDevice, scene)} units={units} onChange={setDevice} />}
          {selOpening && <Fields item={selOpening} fields={WINDOW_FIELDS} units={units} onChange={setOpening} />}
          <p className="muted small">Drag it on the floor plan to move it.</p>
        </div>
      )}
    </section>
  );
}
