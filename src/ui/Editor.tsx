import { useEffect, useState } from 'react';
import type { Device, Room, SceneV1 } from '../scene/types';
import { quantity, type Quantity, type UnitSystem } from './units';

// Field specs for the "More settings" inspector of each device type.

export interface FieldSpec {
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
const POS_XYZ: FieldSpec[] = [...POS_XY, { path: 'pos.2', label: 'Height above floor', q: 'len', min: 0 }];
const HEADING: FieldSpec = { path: 'heading', label: 'Points toward (0° = up the plan)', q: 'deg' };
const CFM: FieldSpec = { path: 'airflowCfm', label: 'Airflow', q: 'cfm', min: 0 };
const SETPOINT: FieldSpec = { path: 'setpoint', label: 'Thermostat (phase 3)', q: 'temp' };

export function deviceFields(d: Device, scene: SceneV1): FieldSpec[] {
  switch (d.type) {
    case 'heat_source':
      return [
        ...POS_XYZ,
        { path: 'size.0', label: 'Size x', q: 'len', min: 0 },
        { path: 'size.1', label: 'Size y', q: 'len', min: 0 },
        { path: 'size.2', label: 'Size z', q: 'len', min: 0 },
      ];
    case 'sun':
      return [
        { path: 'heading', label: 'Sunlight heading (0° = up the plan)', q: 'deg' },
        { path: 'elevationDeg', label: 'Sun height above horizon', q: 'deg', min: 5, max: 85 },
      ];
    case 'sun_patch':
      return [...POS_XY, { path: 'size.0', label: 'Patch size x', q: 'len', min: 0.1 }, { path: 'size.1', label: 'Patch size y', q: 'len', min: 0.1 }];
    case 'window_ac':
      return [
        { path: 'mountedIn', label: 'In window', q: 'select', options: scene.openings.map((o) => ({ value: o.id, label: o.id })) },
        CFM,
        { path: 'shr', label: 'Sensible heat ratio', q: 'num', min: 0.4, max: 1 },
        SETPOINT,
      ];
    case 'portable_ac':
      return [...POS_XY, HEADING, CFM, { path: 'exhaustCfm', label: 'Exhaust airflow', q: 'cfm', min: 0 }, { path: 'shr', label: 'Sensible heat ratio', q: 'num', min: 0.4, max: 1 }, SETPOINT];
    case 'mini_split':
      return [...POS_XYZ, HEADING, CFM, { path: 'louverDeg', label: 'Louver angle down', q: 'deg', min: 0, max: 80 }, SETPOINT];
    case 'supply_vent':
      return [
        ...POS_XYZ,
        { path: 'size.0', label: 'Width', q: 'len', min: 0 },
        { path: 'size.1', label: 'Length', q: 'len', min: 0 },
        { path: 'supplyTemp', label: 'Supply air temperature', q: 'temp' },
      ];
    case 'return_vent':
      return [...POS_XYZ, { path: 'size.0', label: 'Width', q: 'len', min: 0 }, { path: 'size.1', label: 'Length', q: 'len', min: 0 }];
    case 'box_fan':
      return [...POS_XYZ, HEADING, { path: 'diameter', label: 'Diameter', q: 'len', min: 0.1 }];
    case 'ceiling_fan':
      return [...POS_XYZ, { path: 'diameter', label: 'Diameter', q: 'len', min: 0.3 }];
    case 'tower_fan':
      return [...POS_XY, HEADING, { path: 'slotHeight', label: 'Slot height', q: 'len', min: 0.2 }, { path: 'oscillateDeg', label: 'Oscillation', q: 'deg', min: 0, max: 180 }, { path: 'periodSec', label: 'Oscillation period', q: 'sec', min: 1 }];
  }
}

export function windowFields(room: Room): FieldSpec[] {
  return [
    { path: 'edge', label: 'Wall', q: 'select', options: room.outline.map((_, i) => ({ value: i, label: `Wall ${i + 1}` })) },
    { path: 'offset', label: 'Distance along wall', q: 'len', min: 0 },
    { path: 'width', label: 'Width', q: 'len', min: 0.2 },
    { path: 'sill', label: 'Sill height', q: 'len', min: 0 },
    { path: 'height', label: 'Height', q: 'len', min: 0.2 },
  ];
}

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);
}

export function setPath<T>(obj: T, path: string, value: unknown): T {
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
export function NumberField(props: { value: number; q: Quantity; units: UnitSystem; min?: number; max?: number; onChange: (si: number) => void }) {
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

export function Fields<T>(props: { item: T; fields: FieldSpec[]; units: UnitSystem; onChange: (next: T) => void }) {
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
              <NumberField value={Number(value ?? 0)} q={f.q} units={props.units} min={f.min} max={f.max} onChange={(v) => props.onChange(setPath(props.item, f.path, v))} />
            )}
          </label>
        );
      })}
    </div>
  );
}
