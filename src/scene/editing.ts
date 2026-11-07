import { dirHeading, edgeFrame, headingDir } from './geometry';
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

/** Plan-view resize handles for a selected window or device (empty if it can't be resized). */
export function handlesFor(scene: SceneV1, id: string): Handle[] {
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
      return [{ id: 'radius', x: d.pos[0] + h[1] * (d.diameter / 2), y: d.pos[1] - h[0] * (d.diameter / 2), cursor: 'ew-resize' }];
    }
    default:
      return [];
  }
}

/** Drag a handle to plan point (x, y). Returns the edited scene (unchanged if the handle is unknown). */
export function dragHandle(scene: SceneV1, id: string, handle: string, x: number, y: number): SceneV1 {
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
