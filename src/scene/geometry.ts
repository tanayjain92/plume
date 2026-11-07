import type { Device, Opening, Room, SceneV1, Vec2, Vec3 } from './types';

/** Unit conversions applied once, when a scene is voxelized. */
export const CFM_TO_M3S = 0.000471947;
export const BTUH_TO_W = 0.29307107;

/** Fixed device dimensions (m) where the scene format has no field for them. */
export const DIMS = {
  windowAcWidth: 0.6,
  windowAcHeight: 0.4,
  windowAcJetUpDeg: 15,
  miniSplit: { width: 0.8, depth: 0.2, height: 0.3 },
  portableAc: { width: 0.45, depth: 0.4, height: 0.75, jetUpDeg: 45 },
  towerFan: { slotWidth: 0.12, base: 0.1, body: 0.3 },
  boxFanStand: 0.05,
};

/** Ray-casting point-in-polygon test. */
export function pointInPolygon(x: number, y: number, poly: Vec2[]): boolean {
  let inside = false;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const [xa, ya] = poly[a];
    const [xb, yb] = poly[b];
    if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}

export function polygonArea(poly: Vec2[]): number {
  return Math.abs(signedArea(poly));
}

/** Area-weighted centroid of a simple polygon. */
export function polygonCentroid(poly: Vec2[]): Vec2 {
  const a = signedArea(poly);
  if (Math.abs(a) < 1e-12) {
    const n = poly.length || 1;
    return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    const cr = x0 * y1 - x1 * y0;
    cx += (x0 + x1) * cr;
    cy += (y0 + y1) * cr;
  }
  return [cx / (6 * a), cy / (6 * a)];
}

/** True if segments ab and cd cross (touching at shared endpoints does not count). */
export function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** A closed outline with at least 3 corners, non-zero area, and no edges crossing each other. */
export function isSimplePolygon(poly: Vec2[]): boolean {
  const n = poly.length;
  if (n < 3 || polygonArea(poly) < 1e-6) return false;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue; // adjacent edges share a corner
      if (segmentsCross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return false;
    }
  return true;
}

/** Nearest wall of a room to a plan point: edge index, distance along it (clamped), and distance from it. */
export function nearestEdge(room: Room, x: number, y: number): { edge: number; along: number; dist: number; frame: EdgeFrame } {
  let best = { edge: 0, along: 0, dist: Infinity, frame: edgeFrame(room, 0) };
  for (let e = 0; e < room.outline.length; e++) {
    const f = edgeFrame(room, e);
    const rx = x - f.p0[0];
    const ry = y - f.p0[1];
    const along = Math.max(0, Math.min(f.length, rx * f.t[0] + ry * f.t[1]));
    const px = f.p0[0] + f.t[0] * along;
    const py = f.p0[1] + f.t[1] * along;
    const dist = Math.hypot(x - px, y - py);
    if (dist < best.dist) best = { edge: e, along, dist, frame: f };
  }
  return best;
}

/** Horizontal unit vector for a heading in degrees clockwise from +y. */
export function headingDir(deg: number): Vec3 {
  const r = (deg * Math.PI) / 180;
  return [Math.sin(r), Math.cos(r), 0];
}

/** Heading in degrees clockwise from +y for a horizontal direction. */
export function dirHeading(d: Vec2 | Vec3): number {
  return (((Math.atan2(d[0], d[1]) * 180) / Math.PI) % 360 + 360) % 360;
}

export function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
}

function signedArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

export interface EdgeFrame {
  p0: Vec2;
  p1: Vec2;
  /** Unit vector along the edge, p0 -> p1. */
  t: Vec2;
  /** Outward unit normal. */
  n: Vec2;
  length: number;
}

/** Geometry of edge `e` of a room outline, with the outward normal for either winding. */
export function edgeFrame(room: Room, e: number): EdgeFrame {
  const o = room.outline;
  const p0 = o[e % o.length];
  const p1 = o[(e + 1) % o.length];
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const length = Math.hypot(dx, dy) || 1;
  const t: Vec2 = [dx / length, dy / length];
  const ccw = signedArea(o) > 0;
  const n: Vec2 = ccw ? [t[1], -t[0]] : [-t[1], t[0]];
  return { p0, p1, t, n, length };
}

/** Box (world coords, lo/hi corners) of an opening in its wall, one wall-thickness deep outward. */
export function openingBox(room: Room, op: Opening, thickness: number): { lo: Vec3; hi: Vec3; frame: EdgeFrame } {
  const f = edgeFrame(room, op.edge);
  const a: Vec2 = [f.p0[0] + f.t[0] * op.offset, f.p0[1] + f.t[1] * op.offset];
  const b: Vec2 = [a[0] + f.t[0] * op.width, a[1] + f.t[1] * op.width];
  const c: Vec2 = [a[0] + f.n[0] * thickness, a[1] + f.n[1] * thickness];
  const d: Vec2 = [b[0] + f.n[0] * thickness, b[1] + f.n[1] * thickness];
  const xs = [a[0], b[0], c[0], d[0]];
  const ys = [a[1], b[1], c[1], d[1]];
  return {
    lo: [Math.min(...xs), Math.min(...ys), op.sill],
    hi: [Math.max(...xs), Math.max(...ys), op.sill + op.height],
    frame: f,
  };
}

/** Where a window AC sits inside its window: offset along the edge, width, and z range. */
export function windowAcRect(op: Opening): { offset: number; width: number; z0: number; z1: number } {
  const width = Math.min(op.width, DIMS.windowAcWidth);
  const height = Math.min(op.height, DIMS.windowAcHeight);
  return { offset: op.offset + (op.width - width) / 2, width, z0: op.sill, z1: op.sill + height };
}

/** Axis-aligned footprint box for a box-shaped device facing a heading (snapped to the nearest axis). */
export function headingBox(pos: Vec3, heading: number, width: number, depth: number, height: number): { lo: Vec3; hi: Vec3 } {
  const d = headingDir(heading);
  const alongX = Math.abs(d[0]) >= Math.abs(d[1]);
  const sx = alongX ? depth : width;
  const sy = alongX ? width : depth;
  return {
    lo: [pos[0] - sx / 2, pos[1] - sy / 2, pos[2]],
    hi: [pos[0] + sx / 2, pos[1] + sy / 2, pos[2] + height],
  };
}

export interface DeviceShape {
  id: string;
  kind: Device['type'] | 'window';
  lo: Vec3;
  hi: Vec3;
  /** Direction the device pushes air (unit vector), if any. */
  dir?: Vec3;
  /** Flow out of the room (returns), shown as an inward arrow. */
  intake?: boolean;
  enabled: boolean;
  open?: boolean;
}

/** Approximate 3D boxes of every device and window, for drawing and hit-testing in the editor. */
export function sceneShapes(scene: SceneV1): DeviceShape[] {
  const shapes: DeviceShape[] = [];
  const room = (id: string) => scene.rooms.find((r) => r.id === id);
  const wallT = scene.grid.cellSize;
  for (const op of scene.openings) {
    const r = room(op.room);
    if (!r) continue;
    const { lo, hi } = openingBox(r, op, wallT);
    shapes.push({ id: op.id, kind: 'window', lo, hi, enabled: true, open: op.state === 'open' });
  }
  for (const d of scene.devices) {
    switch (d.type) {
      case 'heat_source':
        shapes.push({
          id: d.id,
          kind: d.type,
          lo: [d.pos[0] - d.size[0] / 2, d.pos[1] - d.size[1] / 2, d.pos[2]],
          hi: [d.pos[0] + d.size[0] / 2, d.pos[1] + d.size[1] / 2, d.pos[2] + d.size[2]],
          enabled: d.enabled,
        });
        break;
      case 'sun_patch':
        shapes.push({
          id: d.id,
          kind: d.type,
          lo: [d.pos[0] - d.size[0] / 2, d.pos[1] - d.size[1] / 2, 0],
          hi: [d.pos[0] + d.size[0] / 2, d.pos[1] + d.size[1] / 2, 0.05],
          enabled: d.enabled,
        });
        break;
      case 'window_ac': {
        const op = scene.openings.find((o) => o.id === d.mountedIn);
        const r = op && room(op.room);
        if (!op || !r) break;
        const rect = windowAcRect(op);
        const f = edgeFrame(r, op.edge);
        const { lo, hi } = openingBox(r, { ...op, offset: rect.offset, width: rect.width, sill: rect.z0, height: rect.z1 - rect.z0 }, -0.3);
        shapes.push({ id: d.id, kind: d.type, lo, hi, dir: [-f.n[0], -f.n[1], 0], enabled: d.enabled });
        break;
      }
      case 'mini_split': {
        const { width, depth, height } = DIMS.miniSplit;
        const b = headingBox(d.pos, d.heading, width, depth, height);
        const h = headingDir(d.heading);
        const l = (d.louverDeg * Math.PI) / 180;
        shapes.push({ id: d.id, kind: d.type, ...b, dir: [h[0] * Math.cos(l), h[1] * Math.cos(l), -Math.sin(l)], enabled: d.enabled });
        break;
      }
      case 'portable_ac': {
        const { width, depth, height } = DIMS.portableAc;
        const b = headingBox(d.pos, d.heading, width, depth, height);
        shapes.push({ id: d.id, kind: d.type, ...b, dir: normalize([...headingDir(d.heading).slice(0, 2), 1] as Vec3), enabled: d.enabled });
        break;
      }
      case 'supply_vent':
      case 'return_vent': {
        const s = d.size;
        const half = Math.max(s[0], s[1]) / 2;
        shapes.push({
          id: d.id,
          kind: d.type,
          lo: [d.pos[0] - half, d.pos[1] - half, d.pos[2] - 0.05],
          hi: [d.pos[0] + half, d.pos[1] + half, d.pos[2] + 0.05],
          dir: d.type === 'supply_vent' ? normalize(d.direction) : undefined,
          intake: d.type === 'return_vent',
          enabled: d.enabled,
        });
        break;
      }
      case 'box_fan': {
        const r = d.diameter / 2;
        const zc = d.pos[2] + DIMS.boxFanStand + r;
        shapes.push({
          id: d.id,
          kind: d.type,
          lo: [d.pos[0] - r, d.pos[1] - r, zc - r],
          hi: [d.pos[0] + r, d.pos[1] + r, zc + r],
          dir: headingDir(d.heading),
          enabled: d.enabled,
        });
        break;
      }
      case 'ceiling_fan': {
        const r = d.diameter / 2;
        shapes.push({
          id: d.id,
          kind: d.type,
          lo: [d.pos[0] - r, d.pos[1] - r, d.pos[2] - 0.05],
          hi: [d.pos[0] + r, d.pos[1] + r, d.pos[2] + 0.05],
          dir: [0, 0, d.reverse ? 1 : -1],
          enabled: d.enabled,
        });
        break;
      }
      case 'tower_fan': {
        const b = DIMS.towerFan.body / 2;
        shapes.push({
          id: d.id,
          kind: d.type,
          lo: [d.pos[0] - b, d.pos[1] - b, d.pos[2]],
          hi: [d.pos[0] + b, d.pos[1] + b, d.pos[2] + DIMS.towerFan.base + d.slotHeight + 0.1],
          dir: headingDir(d.heading),
          enabled: d.enabled,
        });
        break;
      }
    }
  }
  return shapes;
}
