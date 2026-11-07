import { CellType, type HeatSource, type VoxelScene } from '../solver/grid';
import type { SceneV1, Vec2 } from './types';

export interface VoxelizeResult {
  voxels: VoxelScene;
  /** Scene features that were ignored because their phase has not been built yet. */
  warnings: string[];
}

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

/** Number of cells covering `length` meters, robust to float noise (4 / 0.1 = 40, not 41). */
function cellsFor(length: number, h: number): number {
  return Math.max(1, Math.ceil(length / h - 1e-6));
}

/**
 * Turns scene JSON into cell types and device masks.
 *
 * The grid covers the bounding box of all rooms plus a one-cell solid shell on
 * every side (floor, ceiling and outer walls). A cell is fluid if its center
 * lies inside a room polygon and below that room's ceiling.
 *
 * Phase 1 supports rooms and heat sources. Walls, openings, doors and the other
 * device types are reported in `warnings` and otherwise ignored.
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

  const nx = cellsFor(maxX - minX, h) + 2;
  const ny = cellsFor(maxY - minY, h) + 2;
  const nz = cellsFor(maxH, h) + 2;
  const n = nx * ny * nz;
  const origin: [number, number, number] = [minX - h, minY - h, -h];
  const cellType = new Uint8Array(n).fill(CellType.Solid);
  const initialTemp = new Float32Array(n);
  const meanInitial = scene.rooms.reduce((s, r) => s + r.initialTemp, 0) / scene.rooms.length;
  initialTemp.fill(meanInitial);

  for (const room of scene.rooms) {
    for (let k = 1; k < nz - 1; k++) {
      const z = origin[2] + (k + 0.5) * h;
      if (z >= room.height) continue;
      for (let j = 1; j < ny - 1; j++) {
        const y = origin[1] + (j + 0.5) * h;
        for (let i = 1; i < nx - 1; i++) {
          const x = origin[0] + (i + 0.5) * h;
          if (!pointInPolygon(x, y, room.outline)) continue;
          const c = i + nx * (j + ny * k);
          cellType[c] = CellType.Fluid;
          initialTemp[c] = room.initialTemp;
        }
      }
    }
  }

  const heatSources: HeatSource[] = [];
  const unsupported = new Map<string, number>();
  for (const dev of scene.devices) {
    if (dev.type !== 'heat_source') {
      unsupported.set(dev.type, (unsupported.get(dev.type) ?? 0) + 1);
      continue;
    }
    // pos is the center of the bottom face of the box
    const lo = [dev.pos[0] - dev.size[0] / 2, dev.pos[1] - dev.size[1] / 2, dev.pos[2]];
    const hi = [dev.pos[0] + dev.size[0] / 2, dev.pos[1] + dev.size[1] / 2, dev.pos[2] + dev.size[2]];
    const cells: number[] = [];
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const x = origin[0] + (i + 0.5) * h;
          const y = origin[1] + (j + 0.5) * h;
          const z = origin[2] + (k + 0.5) * h;
          if (x < lo[0] || x > hi[0] || y < lo[1] || y > hi[1] || z < lo[2] || z > hi[2]) continue;
          const c = i + nx * (j + ny * k);
          if (cellType[c] === CellType.Fluid) cells.push(c);
        }
    if (cells.length === 0) {
      // Box thinner than a cell: use the fluid cell nearest its center.
      const cx = (lo[0] + hi[0]) / 2;
      const cy = (lo[1] + hi[1]) / 2;
      const cz = (lo[2] + hi[2]) / 2;
      let best = -1;
      let bestD = Infinity;
      for (let c = 0; c < n; c++) {
        if (cellType[c] !== CellType.Fluid) continue;
        const i = c % nx;
        const j = Math.floor(c / nx) % ny;
        const k = Math.floor(c / (nx * ny));
        const d =
          (origin[0] + (i + 0.5) * h - cx) ** 2 + (origin[1] + (j + 0.5) * h - cy) ** 2 + (origin[2] + (k + 0.5) * h - cz) ** 2;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (best < 0) {
        warnings.push(`heat source "${dev.id}" is outside every room; ignored`);
        continue;
      }
      cells.push(best);
    }
    heatSources.push({ id: dev.id, cells: Int32Array.from(cells), watts: dev.watts, enabled: dev.enabled });
  }

  for (const [type, count] of unsupported) {
    warnings.push(`${count} ${type} device${count > 1 ? 's' : ''} ignored (arrives in phase 2)`);
  }
  if (scene.walls.some((w) => w.exterior)) warnings.push('wall conduction ignored; all walls adiabatic until phase 3');
  if (scene.openings.length) warnings.push(`${scene.openings.length} opening(s) drawn as solid wall until phase 2`);
  if (scene.doors?.length) warnings.push('doors ignored until phase 5');

  return {
    voxels: { nx, ny, nz, h, origin, cellType, initialTemp, heatSources, momentumSources: [] },
    warnings,
  };
}
