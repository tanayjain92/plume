import { DIMS, dirHeading, nearestEdge, pointInPolygon, polygonCentroid } from './geometry';
import type { Device, Opening, Room, SceneV1, Vec2 } from './types';

// ------------------------------------------------------------------ space

export interface StandardSize {
  id: string;
  label: string;
  /** Plan size in feet (rooms are sold in feet in the US); stored in meters. */
  widthFt: number;
  depthFt: number;
  slow?: boolean;
}

export const STANDARD_SIZES: StandardSize[] = [
  { id: 'small-bedroom', label: 'Small bedroom', widthFt: 10, depthFt: 10 },
  { id: 'bedroom', label: 'Bedroom', widthFt: 12, depthFt: 12 },
  { id: 'office', label: 'Home office', widthFt: 10, depthFt: 12 },
  { id: 'primary', label: 'Primary bedroom', widthFt: 14, depthFt: 16 },
  { id: 'living', label: 'Living room', widthFt: 16, depthFt: 20, slow: true },
  { id: 'studio', label: 'Studio apartment', widthFt: 20, depthFt: 24, slow: true },
];

export const FT = 0.3048;

/** Largest plan extent the editor allows, m (bigger grids get slow on the CPU solver). */
export const MAX_EXTENT = 12;

export function rectOutline(w: number, d: number): Vec2[] {
  return [
    [0, 0],
    [w, 0],
    [w, d],
    [0, d],
  ];
}

/** A fresh, empty scene for a room outline (meters, any winding; moved so its corner is at the origin). */
export function newSpace(opts: { name: string; outline: Vec2[]; height: number; roomTemp: number; outdoorTemp: number }): SceneV1 {
  const minX = Math.min(...opts.outline.map((p) => p[0]));
  const minY = Math.min(...opts.outline.map((p) => p[1]));
  const outline = opts.outline.map(([x, y]) => [round(x - minX), round(y - minY)] as Vec2);
  return {
    version: 1,
    name: opts.name,
    grid: { cellSize: 0.1 },
    outdoor: { temp: opts.outdoorTemp, windSpeed: 2, windFrom: 270, solar: 500 },
    rooms: [{ id: 'room', outline, height: opts.height, initialTemp: opts.roomTemp }],
    walls: [],
    openings: [],
    devices: [],
  };
}

const round = (v: number, step = 0.01) => Math.round(v / step) * step;

// ------------------------------------------------------------------ tools

export type ToolKind =
  | 'window'
  | 'window_ac'
  | 'portable_ac'
  | 'mini_split'
  | 'supply_vent'
  | 'return_vent'
  | 'ceiling_fan'
  | 'tower_fan'
  | 'box_fan'
  | 'sun'
  | 'person'
  | 'heater'
  | 'computer';

export interface Tool {
  kind: ToolKind;
  label: string;
  group: 'Cooling' | 'Fans' | 'Openings' | 'Heat';
  icon: string;
  /** Snaps to the nearest wall when placed. */
  wall?: boolean;
  hint: string;
}

export const TOOLS: Tool[] = [
  { kind: 'window_ac', label: 'Window AC', group: 'Cooling', icon: '❄', wall: true, hint: 'Click a wall to put a window AC there.' },
  { kind: 'portable_ac', label: 'Portable AC', group: 'Cooling', icon: '❄', hint: 'Click the floor where the unit stands.' },
  { kind: 'mini_split', label: 'Mini split', group: 'Cooling', icon: '❄', wall: true, hint: 'Click a wall to mount the indoor head.' },
  { kind: 'supply_vent', label: 'Ceiling vent', group: 'Cooling', icon: '⇩', hint: 'Click where the supply diffuser is in the ceiling.' },
  { kind: 'return_vent', label: 'Return vent', group: 'Cooling', icon: '⇧', hint: 'Click where the return grille is in the ceiling.' },
  { kind: 'ceiling_fan', label: 'Ceiling fan', group: 'Fans', icon: '✢', hint: 'Click where the fan hangs.' },
  { kind: 'tower_fan', label: 'Tower fan', group: 'Fans', icon: '▮', hint: 'Click the floor. It aims at the middle of the room.' },
  { kind: 'box_fan', label: 'Box fan', group: 'Fans', icon: '▣', hint: 'Click the floor. It aims at the middle of the room.' },
  { kind: 'window', label: 'Window', group: 'Openings', icon: '▭', wall: true, hint: 'Click a wall to add an open window.' },
  { kind: 'sun', label: 'Sunshine', group: 'Heat', icon: '☀', hint: 'Click the floor where sunlight lands.' },
  { kind: 'person', label: 'Person', group: 'Heat', icon: '☺', hint: 'Click where someone is.' },
  { kind: 'heater', label: 'Space heater', group: 'Heat', icon: '♨', hint: 'Click the floor.' },
  { kind: 'computer', label: 'Computer', group: 'Heat', icon: '⌨', hint: 'Click where the PC is.' },
];

function uniqueId(scene: SceneV1, base: string): string {
  const taken = new Set([...scene.devices.map((d) => d.id), ...scene.openings.map((o) => o.id)]);
  for (let n = 1; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** Heading (deg) from a point toward the room's centroid. */
function aimAtCenter(room: Room, x: number, y: number): number {
  const [cx, cy] = polygonCentroid(room.outline);
  if (Math.hypot(cx - x, cy - y) < 0.05) return 0;
  return Math.round(dirHeading([cx - x, cy - y]));
}

export type PlaceResult = { scene: SceneV1; id: string } | { error: string };

/**
 * Place a tool at a plan point (meters). Wall tools snap to the nearest wall;
 * everything else must be inside the room.
 */
export function placeTool(scene: SceneV1, kind: ToolKind, x: number, y: number): PlaceResult {
  const room = scene.rooms[0];
  const tool = TOOLS.find((t) => t.kind === kind)!;
  const inside = pointInPolygon(x, y, room.outline);

  if (tool.wall) {
    const near = nearestEdge(room, x, y);
    const f = near.frame;
    if (kind === 'window' || kind === 'window_ac') {
      const width = Math.min(kind === 'window' ? 0.9 : 0.8, f.length - 0.1);
      if (width < 0.4) return { error: 'That wall is too short for a window.' };
      const offset = round(Math.max(0.05, Math.min(f.length - width - 0.05, near.along - width / 2)), 0.05);
      const win: Opening = {
        id: uniqueId(scene, 'Window'),
        type: 'window',
        room: room.id,
        edge: near.edge,
        offset,
        width,
        sill: 0.9,
        height: 1.2,
        state: kind === 'window' ? 'open' : 'closed',
        glazingU: 2.8,
      };
      if (kind === 'window') return { scene: { ...scene, openings: [...scene.openings, win] }, id: win.id };
      const ac: Device = { id: uniqueId(scene, 'Window AC'), type: 'window_ac', mountedIn: win.id, capacityBtuh: 8000, airflowCfm: 220, shr: 0.7, setpoint: 22, enabled: true };
      return { scene: { ...scene, openings: [...scene.openings, win], devices: [...scene.devices, ac] }, id: ac.id };
    }
    // mini split: head on the wall, blowing into the room
    const along = Math.max(DIMS.miniSplit.width / 2, Math.min(f.length - DIMS.miniSplit.width / 2, near.along));
    const inset = DIMS.miniSplit.depth / 2 + 0.05;
    const px = f.p0[0] + f.t[0] * along - f.n[0] * inset;
    const py = f.p0[1] + f.t[1] * along - f.n[1] * inset;
    const dev: Device = {
      id: uniqueId(scene, 'Mini split'),
      type: 'mini_split',
      pos: [round(px), round(py), round(Math.max(0.5, room.height - 0.6))],
      heading: Math.round(dirHeading([-f.n[0], -f.n[1]])),
      capacityBtuh: 9000,
      airflowCfm: 300,
      louverDeg: 30,
      setpoint: 22,
      enabled: true,
    };
    return { scene: { ...scene, devices: [...scene.devices, dev] }, id: dev.id };
  }

  if (!inside) return { error: 'Click inside the room.' };
  const pos = (z: number): [number, number, number] => [round(x), round(y), round(z)];
  const aim = aimAtCenter(room, x, y);
  let dev: Device;
  switch (kind) {
    case 'portable_ac':
      dev = { id: uniqueId(scene, 'Portable AC'), type: 'portable_ac', pos: pos(0), heading: aim, capacityBtuh: 8000, airflowCfm: 220, exhaustCfm: 90, shr: 0.7, setpoint: 22, enabled: true };
      break;
    case 'supply_vent':
      dev = { id: uniqueId(scene, 'Supply vent'), type: 'supply_vent', pos: pos(room.height), size: [0.3, 0.3], airflowCfm: 100, supplyTemp: 15, direction: [0, 0, -1], enabled: true };
      break;
    case 'return_vent':
      dev = { id: uniqueId(scene, 'Return vent'), type: 'return_vent', pos: pos(room.height), size: [0.4, 0.4], airflowCfm: 100, enabled: true };
      break;
    case 'ceiling_fan':
      dev = { id: uniqueId(scene, 'Ceiling fan'), type: 'ceiling_fan', pos: pos(Math.max(0.5, room.height - 0.4)), diameter: 1.3, airflowCfm: 3500, reverse: false, enabled: true };
      break;
    case 'tower_fan':
      dev = { id: uniqueId(scene, 'Tower fan'), type: 'tower_fan', pos: pos(0), heading: aim, slotHeight: 0.8, airflowCfm: 250, oscillateDeg: 70, periodSec: 12, enabled: true };
      break;
    case 'box_fan':
      dev = { id: uniqueId(scene, 'Box fan'), type: 'box_fan', pos: pos(0), heading: aim, diameter: 0.5, airflowCfm: 1300, enabled: true };
      break;
    case 'sun':
      dev = { id: uniqueId(scene, 'Sunshine'), type: 'sun_patch', pos: pos(0), size: [1.0, 1.2], wm2: 300, enabled: true };
      break;
    case 'person':
      dev = { id: uniqueId(scene, 'Person'), type: 'heat_source', pos: pos(0), size: [0.4, 0.3, 1.7], watts: 100, enabled: true };
      break;
    case 'heater':
      dev = { id: uniqueId(scene, 'Space heater'), type: 'heat_source', pos: pos(0), size: [0.3, 0.2, 0.6], watts: 1500, enabled: true };
      break;
    case 'computer':
      dev = { id: uniqueId(scene, 'Computer'), type: 'heat_source', pos: pos(0), size: [0.2, 0.45, 0.45], watts: 200, enabled: true };
      break;
    default:
      return { error: `Can't place ${kind} here.` };
  }
  return { scene: { ...scene, devices: [...scene.devices, dev] }, id: dev.id };
}

// ------------------------------------------------------------------ strength

export interface Strength<T> {
  label: string;
  /** Quick picks. */
  chips: { label: string; value: number }[];
  min: number;
  max: number;
  step: number;
  /** How the value is shown: product units the UI converts. */
  q: 'btuh' | 'cfm' | 'watts' | 'wm2';
  get: (item: T) => number;
  set: (item: T, v: number) => T;
}

const acStrength = <T extends { capacityBtuh: number; airflowCfm: number }>(cfmPer1000: number, chips: number[], extra?: (d: T) => Partial<T>): Strength<T> => ({
  label: 'Cooling capacity',
  chips: chips.map((v) => ({ label: `${v / 1000}k`, value: v })),
  min: 4000,
  max: 24000,
  step: 500,
  q: 'btuh',
  get: (d) => d.capacityBtuh,
  set: (d, v) => {
    const next = { ...d, capacityBtuh: v, airflowCfm: Math.round((v / 1000) * cfmPer1000) };
    return { ...next, ...(extra ? extra(next) : {}) };
  },
});

const flowStrength = <T extends { airflowCfm: number }>(label: string, low: number, med: number, high: number, max: number): Strength<T> => ({
  label,
  chips: [
    { label: 'Low', value: low },
    { label: 'Med', value: med },
    { label: 'High', value: high },
  ],
  min: Math.round(low / 4),
  max,
  step: 10,
  q: 'cfm',
  get: (d) => d.airflowCfm,
  set: (d, v) => ({ ...d, airflowCfm: v }),
});

/** The one "how strong" control for each kind of device. Null for windows (they use open/closed). */
export function strengthFor(d: Device): Strength<Device> | null {
  switch (d.type) {
    case 'window_ac':
      return acStrength<typeof d>(27.5, [5000, 8000, 12000]) as Strength<Device>;
    case 'portable_ac':
      return acStrength<typeof d>(27.5, [8000, 10000, 14000], (n) => ({ exhaustCfm: Math.round(n.airflowCfm * 0.4) })) as Strength<Device>;
    case 'mini_split':
      return acStrength<typeof d>(33, [9000, 12000, 18000]) as Strength<Device>;
    case 'supply_vent':
      return flowStrength<typeof d>('Airflow', 60, 100, 150, 400) as Strength<Device>;
    case 'return_vent':
      return flowStrength<typeof d>('Airflow', 60, 100, 150, 400) as Strength<Device>;
    case 'ceiling_fan':
      return flowStrength<typeof d>('Fan speed', 2000, 3500, 5000, 7000) as Strength<Device>;
    case 'tower_fan':
      return flowStrength<typeof d>('Fan speed', 150, 250, 350, 500) as Strength<Device>;
    case 'box_fan':
      return flowStrength<typeof d>('Fan speed', 800, 1300, 1800, 2500) as Strength<Device>;
    case 'sun_patch':
      return {
        label: 'Sun strength',
        chips: [
          { label: 'Hazy', value: 150 },
          { label: 'Sunny', value: 300 },
          { label: 'Blazing', value: 500 },
        ],
        min: 0,
        max: 800,
        step: 10,
        q: 'wm2',
        get: (x) => (x as typeof d).wm2,
        set: (x, v) => ({ ...(x as typeof d), wm2: v }),
      };
    case 'heat_source':
      return {
        label: 'Heat output',
        chips: [
          { label: 'Person', value: 100 },
          { label: 'PC', value: 250 },
          { label: 'Heater lo', value: 750 },
          { label: 'Heater hi', value: 1500 },
        ],
        min: 0,
        max: 2000,
        step: 10,
        q: 'watts',
        get: (x) => (x as typeof d).watts,
        set: (x, v) => ({ ...(x as typeof d), watts: v }),
      };
  }
}

/** Devices that point somewhere and can be rotated. */
export function hasHeading(d: Device): d is Extract<Device, { heading: number }> {
  return 'heading' in d;
}
