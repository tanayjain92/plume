import { RHO } from '../solver/constants';
import {
  CellType,
  lowFace,
  facePosition,
  type AcUnit,
  type FanForce,
  type FlowPort,
  type HeatSource,
  type VoxelScene,
} from '../solver/grid';
import {
  BTUH_TO_W,
  CFM_TO_M3S,
  DIMS,
  edgeFrame,
  headingBox,
  headingDir,
  normalize,
  pointInPolygon,
  windowAcRect,
  type EdgeFrame,
} from './geometry';
import { sunPatches } from './solar';
import type { Opening, Room, SceneV1, Vec2, Vec3 } from './types';

export interface VoxelizeResult {
  voxels: VoxelScene;
  /** Scene features that were ignored or adjusted, in plain words. Never silently dropped. */
  warnings: string[];
}

export { pointInPolygon };

/** Number of cells covering `length` meters, robust to float noise (4 / 0.1 = 40, not 41). */
function cellsFor(length: number, h: number): number {
  // Exactly the cells whose centers fall inside [0, length]: rounding up would leave a dead row
  // of solid cells along the far wall (a 10 ft = 30.48-cell room would get 31 columns, 30 of them air).
  return Math.max(1, Math.round(length / h));
}

/**
 * Half-open span test for cell centers: [lo, hi). When an opening's edges land
 * exactly on cell centers, this still gives width / h cells (not one extra).
 */
function inSpan(v: number, lo: number, hi: number): boolean {
  return v >= lo - 1e-6 && v < hi - 1e-6;
}

/** Wind pressure coefficient on a wall: windward ≈ +0.7, leeward ≈ −0.4, sides in between. */
function windCp(wallNormal: Vec2, windFromDeg: number): number {
  const from = headingDir(windFromDeg); // direction the wind comes from
  const c = wallNormal[0] * from[0] + wallNormal[1] * from[1];
  return c >= 0 ? 0.7 * c : 0.4 * c;
}

class Grid {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly n: number;
  constructor(
    readonly h: number,
    readonly origin: Vec3,
    dims: Vec3,
    readonly cellType: Uint8Array,
  ) {
    [this.nx, this.ny, this.nz] = dims;
    this.n = this.nx * this.ny * this.nz;
  }
  idx(i: number, j: number, k: number): number {
    return i + this.nx * (j + this.ny * k);
  }
  ijk(c: number): Vec3 {
    const i = c % this.nx;
    const r = (c - i) / this.nx;
    const j = r % this.ny;
    return [i, j, (r - j) / this.ny];
  }
  center(c: number): Vec3 {
    const [i, j, k] = this.ijk(c);
    const { h, origin } = this;
    return [origin[0] + (i + 0.5) * h, origin[1] + (j + 0.5) * h, origin[2] + (k + 0.5) * h];
  }
  isFluid(c: number): boolean {
    return c >= 0 && c < this.n && this.cellType[c] === CellType.Fluid;
  }
  stride(axis: number): number {
    return axis === 0 ? 1 : axis === 1 ? this.nx : this.nx * this.ny;
  }
  /** All cells whose centers satisfy a predicate. */
  cellsWhere(pred: (p: Vec3, c: number) => boolean): number[] {
    const out: number[] = [];
    for (let c = 0; c < this.n; c++) if (pred(this.center(c), c)) out.push(c);
    return out;
  }
  /** Fluid cell nearest to a world point (or -1). */
  nearestFluid(p: Vec3): number {
    let best = -1;
    let bestD = Infinity;
    for (let c = 0; c < this.n; c++) {
      if (this.cellType[c] !== CellType.Fluid) continue;
      const q = this.center(c);
      const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }
  /**
   * Port on the faces between each given fluid cell and its solid neighbor on
   * `side` of `axis`. Cells without a solid neighbor there are skipped.
   */
  port(id: string, cells: number[], axis: number, side: 1 | -1, flow: number, temp: number, jetDir: Vec3 | null): FlowPort {
    const faces: number[] = [];
    const used: number[] = [];
    for (const c of cells) {
      if (!this.isFluid(c) || this.cellType[c + side * this.stride(axis)] !== CellType.Solid) continue;
      const ijk = this.ijk(c);
      if (side === 1) ijk[axis]++;
      faces.push(lowFace(this.nx, this.ny, axis, ijk[0], ijk[1], ijk[2]));
      used.push(c);
    }
    return {
      id,
      faces: Int32Array.from(faces),
      axes: new Uint8Array(faces.length).fill(axis),
      inward: new Int8Array(faces.length).fill(-side),
      cells: Int32Array.from(used),
      area: faces.length * this.h * this.h,
      flow,
      temp,
      jetDir,
      enabled: true,
    };
  }
  /** Faces of the given axes whose centers satisfy a predicate (for fan regions). */
  facesWhere(axes: number[], pred: (p: Vec3) => boolean): { faces: number[]; axes: number[] } {
    const faces: number[] = [];
    const ax: number[] = [];
    const counts = [(this.nx + 1) * this.ny * this.nz, this.nx * (this.ny + 1) * this.nz, this.nx * this.ny * (this.nz + 1)];
    for (const a of axes) {
      for (let f = 0; f < counts[a]; f++) {
        if (pred(facePosition(this, a, f))) {
          faces.push(f);
          ax.push(a);
        }
      }
    }
    return { faces, axes: ax };
  }
}

/** The axis (0 = x, 1 = y) and sign an edge's outward normal mostly points along. */
function normalAxis(n: Vec2): { axis: 0 | 1; side: 1 | -1 } {
  return Math.abs(n[0]) >= Math.abs(n[1]) ? { axis: 0, side: n[0] > 0 ? 1 : -1 } : { axis: 1, side: n[1] > 0 ? 1 : -1 };
}

/** Coordinates of a world point relative to an edge: s along it, d outward from it. */
function edgeCoords(f: EdgeFrame, p: Vec3): { s: number; d: number } {
  const rx = p[0] - f.p0[0];
  const ry = p[1] - f.p0[1];
  return { s: rx * f.t[0] + ry * f.t[1], d: rx * f.n[0] + ry * f.n[1] };
}

/**
 * Turns scene JSON into cell types, boundary conditions and device masks.
 *
 * The grid covers the bounding box of all rooms plus a one-cell solid shell on
 * every side (floor, ceiling and outer walls). A cell is fluid if its center
 * lies inside a room polygon and below that room's ceiling. Devices with
 * bodies (mini split head, portable AC) become solid cells; vents and AC
 * grilles become flow ports on wall faces; fans become momentum regions;
 * open windows become open (fixed-pressure) cells.
 */
export function voxelize(scene: SceneV1): VoxelizeResult {
  const warnings: string[] = [];
  const h = scene.grid.cellSize;
  if (!(h > 0)) throw new Error('grid.cellSize must be positive');
  if (scene.rooms.length === 0) throw new Error('scene has no rooms');

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxH = 0;
  for (const room of scene.rooms) {
    for (const [x, y] of room.outline) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    maxH = Math.max(maxH, room.height);
  }

  const dims: Vec3 = [cellsFor(maxX - minX, h) + 2, cellsFor(maxY - minY, h) + 2, cellsFor(maxH, h) + 2];
  const origin: Vec3 = [minX - h, minY - h, -h];
  const g = new Grid(h, origin, dims, new Uint8Array(dims[0] * dims[1] * dims[2]).fill(CellType.Solid));
  const { nx, ny, nz, n, cellType } = g;
  const initialTemp = new Float32Array(n);
  const meanInitial = scene.rooms.reduce((s, r) => s + r.initialTemp, 0) / scene.rooms.length;
  initialTemp.fill(meanInitial);
  const openPressure = new Float32Array(n);

  // Rooms.
  for (const room of scene.rooms) {
    for (let k = 1; k < nz - 1; k++) {
      const z = origin[2] + (k + 0.5) * h;
      if (z >= room.height) continue;
      for (let j = 1; j < ny - 1; j++) {
        const y = origin[1] + (j + 0.5) * h;
        for (let i = 1; i < nx - 1; i++) {
          const x = origin[0] + (i + 0.5) * h;
          if (!pointInPolygon(x, y, room.outline)) continue;
          const c = g.idx(i, j, k);
          cellType[c] = CellType.Fluid;
          initialTemp[c] = room.initialTemp;
        }
      }
    }
  }

  const roomById = new Map(scene.rooms.map((r) => [r.id, r]));
  const openingById = new Map(scene.openings.map((o) => [o.id, o]));
  const acWindows = new Set(scene.devices.flatMap((d) => (d.type === 'window_ac' ? [d.mountedIn] : [])));

  // Wall cells of an opening: just outside the edge, within its span and height.
  const openingCells = (room: Room, op: Opening, s0 = op.offset, s1 = op.offset + op.width, z0 = op.sill, z1 = op.sill + op.height) => {
    const f = edgeFrame(room, op.edge);
    return g.cellsWhere((p) => {
      const { s, d } = edgeCoords(f, p);
      return d > 0 && d < h && inSpan(s, s0, s1) && inSpan(p[2], z0, z1);
    });
  };
  // Fluid cells just inside an edge, within a span and height.
  const insideCells = (room: Room, op: Opening, s0: number, s1: number, z0: number, z1: number) => {
    const f = edgeFrame(room, op.edge);
    return g.cellsWhere((p, c) => {
      if (cellType[c] !== CellType.Fluid) return false;
      const { s, d } = edgeCoords(f, p);
      return d < 0 && d > -h && inSpan(s, s0, s1) && inSpan(p[2], z0, z1);
    });
  };

  // Openings: open windows become open cells (unless an AC fills the window).
  let closedWindows = 0;
  for (const op of scene.openings) {
    const room = roomById.get(op.room);
    if (!room) {
      warnings.push(`window "${op.id}" refers to unknown room "${op.room}"; ignored`);
      continue;
    }
    if (op.edge < 0 || op.edge >= room.outline.length) {
      warnings.push(`window "${op.id}" uses edge ${op.edge}, but room "${room.id}" has ${room.outline.length} edges; ignored`);
      continue;
    }
    if (op.state !== 'open' || acWindows.has(op.id)) {
      closedWindows++;
      continue;
    }
    const cells = openingCells(room, op).filter((c) => cellType[c] === CellType.Solid);
    if (cells.length === 0) {
      warnings.push(`window "${op.id}" is smaller than one grid cell; ignored`);
      continue;
    }
    const f = edgeFrame(room, op.edge);
    const pa = windCp(f.n, scene.outdoor.windFrom) * 0.5 * RHO * scene.outdoor.windSpeed ** 2;
    for (const c of cells) {
      cellType[c] = CellType.Open;
      openPressure[c] = pa;
    }
  }

  // Device bodies become solid before ports and fans are placed around them.
  const bodies = new Map<string, Set<number>>();
  for (const d of scene.devices) {
    if (d.type !== 'mini_split' && d.type !== 'portable_ac') continue;
    const dim = d.type === 'mini_split' ? DIMS.miniSplit : DIMS.portableAc;
    const { lo, hi } = headingBox(d.pos, d.heading, dim.width, dim.depth, dim.height);
    for (const c of g.cellsWhere((p) => p[0] > lo[0] && p[0] < hi[0] && p[1] > lo[1] && p[1] < hi[1] && p[2] > lo[2] && p[2] < hi[2])) {
      if (cellType[c] === CellType.Fluid) cellType[c] = CellType.Solid;
      else continue;
      if (!bodies.has(d.id)) bodies.set(d.id, new Set());
      bodies.get(d.id)!.add(c);
    }
  }

  const heatSources: HeatSource[] = [];
  const ports: FlowPort[] = [];
  const fans: FanForce[] = [];
  const acUnits: AcUnit[] = [];
  const addPort = (p: FlowPort, what: string): boolean => {
    if (p.faces.length === 0) {
      warnings.push(`${what} has no wall, floor or ceiling face to attach to; ignored`);
      return false;
    }
    ports.push(p);
    return true;
  };

  for (const dev of scene.devices) {
    switch (dev.type) {
      case 'heat_source': {
        const lo = [dev.pos[0] - dev.size[0] / 2, dev.pos[1] - dev.size[1] / 2, dev.pos[2]];
        const hi = [dev.pos[0] + dev.size[0] / 2, dev.pos[1] + dev.size[1] / 2, dev.pos[2] + dev.size[2]];
        let cells = g.cellsWhere(
          (p, c) => cellType[c] === CellType.Fluid && p[0] >= lo[0] && p[0] <= hi[0] && p[1] >= lo[1] && p[1] <= hi[1] && p[2] >= lo[2] && p[2] <= hi[2],
        );
        if (cells.length === 0) {
          // Box thinner than a cell: use the fluid cell nearest its center.
          const c = g.nearestFluid([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]);
          if (c < 0) {
            warnings.push(`heat source "${dev.id}" is outside every room; ignored`);
            break;
          }
          cells = [c];
        }
        heatSources.push({ id: dev.id, cells: Int32Array.from(cells), watts: dev.watts, enabled: dev.enabled });
        break;
      }

      case 'sun': {
        // Sunlight through each window that faces the sun, landing on the floor.
        const patches = sunPatches(scene).filter((p) => p.sunId === dev.id);
        let landed = 0;
        for (const patch of patches) {
          const cells: number[] = [];
          for (let j = 1; j < ny - 1; j++)
            for (let i = 1; i < nx - 1; i++) {
              const x = origin[0] + (i + 0.5) * h;
              const y = origin[1] + (j + 0.5) * h;
              if (!pointInPolygon(x, y, patch.quad)) continue;
              for (let k = 1; k < nz - 1; k++) {
                const c = g.idx(i, j, k);
                if (cellType[c] === CellType.Fluid) {
                  cells.push(c);
                  break;
                }
                if (cellType[c] !== CellType.Solid) break;
              }
            }
          if (cells.length === 0) continue;
          landed++;
          heatSources.push({
            id: `${dev.id} via ${patch.windowId}`,
            cells: Int32Array.from(cells),
            watts: patch.floorWm2 * cells.length * h * h,
            enabled: dev.enabled,
          });
        }
        if (dev.enabled && landed === 0)
          warnings.push(`the sun isn't shining through any window onto the floor (aim it at a window, or add one on that side)`);
        break;
      }

      case 'sun_patch': {
        // Solar gain absorbed by the sunlit floor, released into the lowest air cell of each column.
        const cells: number[] = [];
        for (let j = 1; j < ny - 1; j++)
          for (let i = 1; i < nx - 1; i++) {
            const x = origin[0] + (i + 0.5) * h;
            const y = origin[1] + (j + 0.5) * h;
            if (Math.abs(x - dev.pos[0]) > dev.size[0] / 2 || Math.abs(y - dev.pos[1]) > dev.size[1] / 2) continue;
            for (let k = 1; k < nz - 1; k++) {
              const c = g.idx(i, j, k);
              if (cellType[c] === CellType.Fluid) {
                cells.push(c);
                break;
              }
              if (cellType[c] !== CellType.Solid) break;
            }
          }
        if (cells.length === 0) {
          warnings.push(`sun patch "${dev.id}" is outside the room; ignored`);
          break;
        }
        heatSources.push({ id: dev.id, cells: Int32Array.from(cells), watts: dev.wm2 * cells.length * h * h, enabled: dev.enabled });
        break;
      }

      case 'window_ac': {
        const op = openingById.get(dev.mountedIn);
        const room = op && roomById.get(op.room);
        if (!op || !room) {
          warnings.push(`window AC "${dev.id}" is mounted in unknown window "${dev.mountedIn}"; ignored`);
          break;
        }
        const f = edgeFrame(room, op.edge);
        const { axis, side } = normalAxis(f.n);
        const r = windowAcRect(op);
        const zMid = (r.z0 + r.z1) / 2;
        const inside = insideCells(room, op, r.offset, r.offset + r.width, r.z0, r.z1);
        const up = (DIMS.windowAcJetUpDeg * Math.PI) / 180;
        const jet = normalize([-f.n[0] * Math.cos(up), -f.n[1] * Math.cos(up), Math.sin(up)]);
        const flow = dev.airflowCfm * CFM_TO_M3S;
        const sup = g.port(`${dev.id}:supply`, inside.filter((c) => g.center(c)[2] >= zMid), axis, side, flow, 20, jet);
        const ret = g.port(`${dev.id}:return`, inside.filter((c) => g.center(c)[2] < zMid), axis, side, -flow, 20, null);
        if (sup.faces.length === 0 || ret.faces.length === 0) {
          warnings.push(`window AC "${dev.id}" doesn't fit its window at this grid size; ignored`);
          break;
        }
        sup.enabled = ret.enabled = dev.enabled;
        ports.push(sup, ret);
        acUnits.push({ id: dev.id, supplyPort: sup.id, returnPort: ret.id, sensibleW: dev.capacityBtuh * dev.shr * BTUH_TO_W, enabled: dev.enabled });
        break;
      }

      case 'mini_split':
      case 'portable_ac': {
        const isSplit = dev.type === 'mini_split';
        const dim = isSplit ? DIMS.miniSplit : DIMS.portableAc;
        const body = bodies.get(dev.id);
        if (!body) {
          warnings.push(`${dev.type} "${dev.id}" is outside the room or smaller than a grid cell; ignored`);
          break;
        }
        const { lo } = headingBox(dev.pos, dev.heading, dim.width, dim.depth, dim.height);
        const hd = headingDir(dev.heading);
        const hAxis: 0 | 1 = Math.abs(hd[0]) >= Math.abs(hd[1]) ? 0 : 1;
        const hSign: 1 | -1 = hd[hAxis] > 0 ? 1 : -1;
        const hs = hSign * g.stride(hAxis);
        const zs = g.stride(2);
        const fluidNear = (offset: number) => g.cellsWhere((_p, c) => cellType[c] === CellType.Fluid && body.has(c - offset));
        const frontCells = fluidNear(hs); // body cell is right behind
        const backCells = fluidNear(-hs); // body cell is right in front
        const above = fluidNear(zs);
        const flow = dev.airflowCfm * CFM_TO_M3S;
        let sup: FlowPort;
        let ret: FlowPort;
        if (isSplit) {
          const l = (dev.louverDeg * Math.PI) / 180;
          const jet = normalize([hd[0] * Math.cos(l), hd[1] * Math.cos(l), -Math.sin(l)]);
          const zSplit = lo[2] + (2 / 3) * dim.height;
          sup = g.port(`${dev.id}:supply`, frontCells.filter((c) => g.center(c)[2] < zSplit), hAxis, (-hSign) as 1 | -1, flow, 20, jet);
          ret = g.port(`${dev.id}:return`, above, 2, -1, -flow, 20, null);
          if (ret.faces.length === 0)
            ret = g.port(`${dev.id}:return`, frontCells.filter((c) => g.center(c)[2] >= zSplit), hAxis, (-hSign) as 1 | -1, -flow, 20, null);
        } else {
          const upA = (DIMS.portableAc.jetUpDeg * Math.PI) / 180;
          const jet = normalize([hd[0] * Math.cos(upA), hd[1] * Math.cos(upA), Math.sin(upA)]);
          sup = g.port(`${dev.id}:supply`, above, 2, -1, flow, 20, jet);
          const exhaust = dev.exhaustCfm * CFM_TO_M3S;
          ret = g.port(`${dev.id}:return`, backCells, hAxis, hSign, -(flow + exhaust), 20, null);
        }
        if (!addPort(sup, `${dev.type} "${dev.id}" supply`) || !addPort(ret, `${dev.type} "${dev.id}" return`)) {
          if (ports.at(-1) === sup) ports.pop();
          break;
        }
        sup.enabled = ret.enabled = dev.enabled;
        acUnits.push({ id: dev.id, supplyPort: sup.id, returnPort: ret.id, sensibleW: dev.capacityBtuh * (dev.type === 'mini_split' ? 0.7 : dev.shr) * BTUH_TO_W, enabled: dev.enabled });
        break;
      }

      case 'supply_vent':
      case 'return_vent': {
        const start = g.nearestFluid(dev.pos);
        if (start < 0) {
          warnings.push(`${dev.type} "${dev.id}" is outside every room; ignored`);
          break;
        }
        // Mount on the nearest wall, floor or ceiling.
        let best = { axis: 2, side: 1 as 1 | -1, dist: Infinity };
        for (const axis of [2, 0, 1]) {
          for (const side of [1, -1] as const) {
            let c = start;
            let dist = 0;
            while (g.isFluid(c + side * g.stride(axis))) {
              c += side * g.stride(axis);
              dist++;
            }
            if (dist < best.dist) best = { axis, side, dist };
          }
        }
        const { axis, side } = best;
        const tang = [0, 1, 2].filter((a) => a !== axis);
        const sp = g.center(start);
        const sizes = dev.size;
        const cols = g.cellsWhere(
          (p, c) =>
            cellType[c] === CellType.Fluid &&
            Math.abs(p[tang[0]] - dev.pos[tang[0]]) <= Math.max(sizes[0], h) / 2 &&
            Math.abs(p[tang[1]] - dev.pos[tang[1]]) <= Math.max(sizes[1], h) / 2 &&
            Math.abs(p[axis] - sp[axis]) < h / 2,
        );
        // March each column to the boundary.
        const boundaryCells = cols.map((c) => {
          while (g.isFluid(c + side * g.stride(axis))) c += side * g.stride(axis);
          return c;
        });
        const flow = dev.airflowCfm * CFM_TO_M3S;
        if (dev.type === 'supply_vent') {
          const inwardN: Vec3 = [0, 0, 0];
          inwardN[axis] = -side;
          let jet = normalize(dev.direction ?? [0, 0, 0]);
          const dn = jet[0] * inwardN[0] + jet[1] * inwardN[1] + jet[2] * inwardN[2];
          if (Math.hypot(...jet) === 0) jet = inwardN;
          else if (dn < 0.25) {
            warnings.push(`supply vent "${dev.id}" direction points along or into its ${['x', 'y', 'z'][axis]} surface; using straight out instead`);
            jet = inwardN;
          }
          const p = g.port(dev.id, boundaryCells, axis, side, flow, dev.supplyTemp, jet);
          p.enabled = dev.enabled;
          addPort(p, `supply vent "${dev.id}"`);
        } else {
          const p = g.port(dev.id, boundaryCells, axis, side, -flow, 20, null);
          p.enabled = dev.enabled;
          addPort(p, `return vent "${dev.id}"`);
        }
        break;
      }

      case 'box_fan':
      case 'ceiling_fan': {
        const r = dev.diameter / 2;
        const isCeiling = dev.type === 'ceiling_fan';
        const center: Vec3 = isCeiling ? [...dev.pos] : [dev.pos[0], dev.pos[1], dev.pos[2] + DIMS.boxFanStand + r];
        const nrm: Vec3 = isCeiling ? [0, 0, dev.reverse ? 1 : -1] : headingDir(dev.heading);
        const reg = g.facesWhere(isCeiling ? [2] : [0, 1], (p) => {
          const d: Vec3 = [p[0] - center[0], p[1] - center[1], p[2] - center[2]];
          const along = d[0] * nrm[0] + d[1] * nrm[1] + d[2] * nrm[2];
          const radial = Math.hypot(d[0] - along * nrm[0], d[1] - along * nrm[1], d[2] - along * nrm[2]);
          return Math.abs(along) <= 0.75 * h && radial <= Math.max(r, h);
        });
        if (reg.faces.length === 0) {
          warnings.push(`${dev.type} "${dev.id}" is outside the room; ignored`);
          break;
        }
        fans.push({
          id: dev.id,
          faces: Int32Array.from(reg.faces),
          axes: Uint8Array.from(reg.axes),
          speed: (dev.airflowCfm * CFM_TO_M3S) / (Math.PI * r * r),
          dir: nrm,
          oscillateDeg: 0,
          periodSec: 0,
          enabled: dev.enabled,
        });
        break;
      }

      case 'tower_fan': {
        const z0 = dev.pos[2] + DIMS.towerFan.base;
        const z1 = z0 + dev.slotHeight;
        const reach = DIMS.towerFan.slotWidth / 2 + h / 2;
        const reg = g.facesWhere([0, 1], (p) => Math.hypot(p[0] - dev.pos[0], p[1] - dev.pos[1]) <= reach && p[2] >= z0 && p[2] <= z1);
        if (reg.faces.length === 0) {
          warnings.push(`tower fan "${dev.id}" is outside the room; ignored`);
          break;
        }
        fans.push({
          id: dev.id,
          faces: Int32Array.from(reg.faces),
          axes: Uint8Array.from(reg.axes),
          speed: (dev.airflowCfm * CFM_TO_M3S) / (dev.slotHeight * DIMS.towerFan.slotWidth),
          dir: headingDir(dev.heading),
          oscillateDeg: dev.oscillateDeg,
          periodSec: dev.periodSec,
          enabled: dev.enabled,
        });
        break;
      }
    }
  }

  if (scene.walls.some((w) => w.exterior)) warnings.push('walls are adiabatic (no conduction to outdoors) until phase 3');
  if (closedWindows) warnings.push(`${closedWindows} closed window(s) are solid wall; glazing heat gain arrives in phase 3`);
  if (scene.devices.some((d) => 'setpoint' in d)) warnings.push('AC units run continuously; thermostat cycling arrives in phase 3');
  if (scene.doors?.length) warnings.push('doors ignored until phase 5');

  return {
    voxels: {
      nx,
      ny,
      nz,
      h,
      origin,
      cellType,
      initialTemp,
      outdoorTemp: scene.outdoor.temp,
      openPressure,
      heatSources,
      momentumSources: [],
      ports,
      fans,
      acUnits,
    },
    warnings,
  };
}
