import { strengthFor } from './defaults';
import { dirHeading, edgeFrame, headingDir, sceneShapes } from './geometry';
import { sunDirection, sunPatches } from './solar';
import type { Device, Opening, SceneV1 } from './types';

/** A drag handle on a selected item, in plan (world) coordinates. */
export interface Handle {
  id: string;
  x: number;
  y: number;
  /** CSS cursor while hovering it. */
  cursor: string;
}

export const MIN_WINDOW = 0.3;
/** Length of the sun's aim arrow in the plan, m. */
export const SUN_ARROW = 1.0;
const MIN_SIZE = 0.1;

/**
 * Aim arrow on fans and ACs in the plan: it points where the device blows,
 * and its length shows how strong it is (shortest = weakest setting,
 * longest = strongest). Dragging the tip sets both.
 */
export const AIM_ARROW = { min: 0.4, max: 1.6 };
const AIMABLE = new Set<Device['type']>(['box_fan', 'tower_fan', 'portable_ac', 'mini_split']);

/** Where a device's aim arrow starts and ends in the plan (null if it has none). */
export function aimArrow(scene: SceneV1, d: Device): { from: [number, number]; to: [number, number] } | null {
  if (!AIMABLE.has(d.type) || !('heading' in d)) return null;
  const st = strengthFor(d);
  const shape = sceneShapes(scene).find((s) => s.id === d.id);
  if (!st || !shape) return null;
  const frac = Math.max(0, Math.min(1, (st.get(d) - st.min) / (st.max - st.min)));
  const len = AIM_ARROW.min + frac * (AIM_ARROW.max - AIM_ARROW.min);
  const from: [number, number] = [(shape.lo[0] + shape.hi[0]) / 2, (shape.lo[1] + shape.hi[1]) / 2];
  const h = headingDir(d.heading);
  return { from, to: [from[0] + h[0] * len, from[1] + h[1] * len] };
}

/** Point a device's aim arrow at (x, y): heading in 5° steps, strength from the arrow's length. */
function dragAim(scene: SceneV1, d: Device, x: number, y: number): Device {
  const arrow = aimArrow(scene, d);
  const st = strengthFor(d);
  if (!arrow || !st || !('heading' in d)) return d;
  const dx = x - arrow.from[0];
  const dy = y - arrow.from[1];
  const dist = Math.hypot(dx, dy);
  if (dist < 0.05) return d;
  const heading = ((Math.round(dirHeading([dx, dy]) / 5) * 5) % 360 + 360) % 360;
  // Arrow length maps linearly onto the device's setting range (the same range as its slider).
  const frac = Math.max(0, Math.min(1, (dist - AIM_ARROW.min) / (AIM_ARROW.max - AIM_ARROW.min)));
  // Snap to the slider step counted up from the minimum; the full-length arrow is exactly the maximum.
  const v = frac >= 1 ? st.max : st.min + Math.round((frac * (st.max - st.min)) / st.step) * st.step;
  return st.set({ ...d, heading } as Device, Math.max(st.min, Math.min(st.max, v)));
}
const snap = (v: number) => Math.round(v * 20) / 20; // 5 cm

function findWindow(scene: SceneV1, id: string): Opening | undefined {
  return scene.openings.find((o) => o.id === id);
}

function windowEnds(scene: SceneV1, op: Opening) {
  const room = scene.rooms.find((r) => r.id === op.room)!;
  const f = edgeFrame(room, op.edge);
  const at = (s: number) => [f.p0[0] + f.t[0] * s, f.p0[1] + f.t[1] * s] as const;
  return { f, start: at(op.offset), end: at(op.offset + op.width) };
}

const ceilingMounted = (scene: SceneV1, d: Device) => 'pos' in d && d.pos[2] >= scene.rooms[0].height - 0.05;

/** Id of the selectable sunlit floor patch that `sunId` casts through `windowId`. */
export const sunlightId = (sunId: string, windowId: string) => `sunlight:${sunId}:${windowId}`;

function parseSunlight(scene: SceneV1, id: string) {
  if (!id.startsWith('sunlight:')) return null;
  const [, sunId, windowId] = id.split(':');
  const patch = sunPatches(scene).find((p) => p.sunId === sunId && p.windowId === windowId);
  const sun = scene.devices.find((d) => d.id === sunId);
  const op = scene.openings.find((o) => o.id === windowId);
  if (!patch || !sun || sun.type !== 'sun' || !op) return null;
  return { patch, sun, op };
}

const mid = (a: readonly number[], b: readonly number[]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as const;

/** Plan-view resize handles for a selected window or device (empty if it can't be resized). */
export function handlesFor(scene: SceneV1, id: string): Handle[] {
  const sl = parseSunlight(scene, id);
  if (sl) {
    // quad: [sill/start, sill/end, top/end, top/start]; the sides follow the window ends,
    // the far edge (window top) follows the sun's height.
    const q = sl.patch.quad;
    const left = mid(q[0], q[3]);
    const right = mid(q[1], q[2]);
    const far = mid(q[3], q[2]);
    return [
      { id: 'left', x: left[0], y: left[1], cursor: 'col-resize' },
      { id: 'right', x: right[0], y: right[1], cursor: 'col-resize' },
      { id: 'reach', x: far[0], y: far[1], cursor: 'row-resize' },
    ];
  }
  const op = findWindow(scene, id);
  if (op) {
    const { f, start, end } = windowEnds(scene, op);
    const cursor = Math.abs(f.t[0]) >= Math.abs(f.t[1]) ? 'ew-resize' : 'ns-resize';
    return [
      { id: 'start', x: start[0], y: start[1], cursor },
      { id: 'end', x: end[0], y: end[1], cursor },
    ];
  }
  const d = scene.devices.find((x) => x.id === id);
  if (!d) return [];
  const corners = (cx: number, cy: number, sx: number, sy: number): Handle[] => [
    { id: 'sw', x: cx - sx / 2, y: cy - sy / 2, cursor: 'nesw-resize' },
    { id: 'se', x: cx + sx / 2, y: cy - sy / 2, cursor: 'nwse-resize' },
    { id: 'ne', x: cx + sx / 2, y: cy + sy / 2, cursor: 'nesw-resize' },
    { id: 'nw', x: cx - sx / 2, y: cy + sy / 2, cursor: 'nwse-resize' },
  ];
  const aim = aimArrow(scene, d);
  const aimHandle: Handle[] = aim ? [{ id: 'aim', x: aim.to[0], y: aim.to[1], cursor: 'grab' }] : [];
  switch (d.type) {
    case 'sun': {
      // drag the arrow tip to aim the sunlight
      const h = headingDir(d.heading);
      return [{ id: 'aim', x: d.pos[0] + h[0] * SUN_ARROW, y: d.pos[1] + h[1] * SUN_ARROW, cursor: 'grab' }];
    }
    case 'heat_source':
    case 'sun_patch':
      return corners(d.pos[0], d.pos[1], d.size[0], d.size[1]);
    case 'supply_vent':
    case 'return_vent':
      return ceilingMounted(scene, d) ? corners(d.pos[0], d.pos[1], d.size[0], d.size[1]) : [];
    case 'ceiling_fan':
      return [{ id: 'radius', x: d.pos[0] + d.diameter / 2, y: d.pos[1], cursor: 'ew-resize' }];
    case 'box_fan': {
      // the blade disk is across the heading, so the handle sits to its side
      const h = headingDir(d.heading);
      return [{ id: 'radius', x: d.pos[0] + h[1] * (d.diameter / 2), y: d.pos[1] - h[0] * (d.diameter / 2), cursor: 'ew-resize' }, ...aimHandle];
    }
    default:
      return aimHandle;
  }
}

/** Drag a handle to plan point (x, y). Returns the edited scene (unchanged if the handle is unknown). */
export function dragHandle(scene: SceneV1, id: string, handle: string, x: number, y: number): SceneV1 {
  const sl = parseSunlight(scene, id);
  if (sl) {
    const { sun, op } = sl;
    const d = sunDirection(sun);
    if (handle === 'left' || handle === 'right') {
      // Trace the floor point back up the sunbeam to the wall, at mid window height, and move that window end.
      const zMid = op.sill + op.height / 2;
      const t = zMid / -d[2];
      return dragHandle(scene, op.id, handle === 'left' ? 'start' : 'end', x - d[0] * t, y - d[1] * t);
    }
    if (handle === 'reach') {
      // Far edge = window top projected down the beam: depth = top · cos(incidence) / tan(elevation).
      const room = scene.rooms.find((r) => r.id === op.room)!;
      const f = edgeFrame(room, op.edge);
      const depth = -((x - f.p0[0]) * f.n[0] + (y - f.p0[1]) * f.n[1]);
      const hdir = headingDir(sun.heading);
      const cosIn = -(hdir[0] * f.n[0] + hdir[1] * f.n[1]);
      if (depth < 0.05 || cosIn <= 0.01) return scene;
      const elev = (Math.atan(((op.sill + op.height) * cosIn) / depth) * 180) / Math.PI;
      const elevationDeg = Math.round(Math.max(5, Math.min(85, elev)));
      return { ...scene, devices: scene.devices.map((v) => (v.id === sun.id ? { ...sun, elevationDeg } : v)) };
    }
    return scene;
  }
  const op = findWindow(scene, id);
  if (op) {
    const { f } = windowEnds(scene, op);
    const s = (x - f.p0[0]) * f.t[0] + (y - f.p0[1]) * f.t[1];
    let { offset, width } = op;
    const right = op.offset + op.width;
    if (handle === 'start') {
      offset = snap(Math.max(0, Math.min(right - MIN_WINDOW, s)));
      width = snap(right - offset);
    } else if (handle === 'end') {
      width = snap(Math.max(MIN_WINDOW, Math.min(f.length - offset, s - offset)));
    } else return scene;
    return { ...scene, openings: scene.openings.map((o) => (o.id === id ? { ...o, offset, width } : o)) };
  }

  const d = scene.devices.find((v) => v.id === id);
  if (!d) return scene;
  if (handle === 'aim' && d.type !== 'sun') {
    const aimed = dragAim(scene, d, x, y);
    return aimed === d ? scene : { ...scene, devices: scene.devices.map((v) => (v.id === id ? aimed : v)) };
  }
  let next: Device = d;
  switch (d.type) {
    case 'sun': {
      if (handle !== 'aim' || Math.hypot(x - d.pos[0], y - d.pos[1]) < 0.05) return scene;
      next = { ...d, heading: Math.round(dirHeading([x - d.pos[0], y - d.pos[1]])) };
      break;
    }
    case 'heat_source':
    case 'sun_patch':
    case 'supply_vent':
    case 'return_vent': {
      const sign = { sw: [-1, -1], se: [1, -1], ne: [1, 1], nw: [-1, 1] }[handle];
      if (!sign) return scene;
      // the opposite corner stays put
      const ox = d.pos[0] - (sign[0] * d.size[0]) / 2;
      const oy = d.pos[1] - (sign[1] * d.size[1]) / 2;
      const nx = sign[0] > 0 ? Math.max(ox + MIN_SIZE, x) : Math.min(ox - MIN_SIZE, x);
      const ny = sign[1] > 0 ? Math.max(oy + MIN_SIZE, y) : Math.min(oy - MIN_SIZE, y);
      const sx = snap(Math.abs(nx - ox));
      const sy = snap(Math.abs(ny - oy));
      const cx = snap(ox + (sign[0] * sx) / 2);
      const cy = snap(oy + (sign[1] * sy) / 2);
      next = { ...d, pos: [cx, cy, d.pos[2]], size: d.type === 'heat_source' ? [sx, sy, d.size[2]] : [sx, sy] } as Device;
      break;
    }
    case 'ceiling_fan':
    case 'box_fan': {
      if (handle !== 'radius') return scene;
      const r = Math.hypot(x - d.pos[0], y - d.pos[1]);
      next = { ...d, diameter: snap(Math.max(0.2, Math.min(d.type === 'ceiling_fan' ? 2.0 : 1.0, 2 * r))) };
      break;
    }
    default:
      return scene;
  }
  return { ...scene, devices: scene.devices.map((v) => (v.id === id ? next : v)) };
}

/** Make a window wider or narrower by `delta` meters, keeping its center and staying on the wall. */
export function resizeWindow(scene: SceneV1, id: string, delta: number): SceneV1 {
  const op = findWindow(scene, id);
  if (!op) return scene;
  const { f } = windowEnds(scene, op);
  const width = snap(Math.max(MIN_WINDOW, Math.min(f.length, op.width + delta)));
  const center = op.offset + op.width / 2;
  const offset = snap(Math.max(0, Math.min(f.length - width, center - width / 2)));
  return { ...scene, openings: scene.openings.map((o) => (o.id === id ? { ...o, offset, width } : o)) };
}

export function toggleWindow(scene: SceneV1, id: string): SceneV1 {
  return { ...scene, openings: scene.openings.map((o) => (o.id === id ? { ...o, state: o.state === 'open' ? 'closed' : 'open' } : o)) };
}

/** Remove a window or device. A window AC goes with its window. */
export function removeItem(scene: SceneV1, id: string): SceneV1 {
  return {
    ...scene,
    openings: scene.openings.filter((o) => o.id !== id),
    devices: scene.devices.filter((d) => d.id !== id && !(d.type === 'window_ac' && d.mountedIn === id)),
  };
}
