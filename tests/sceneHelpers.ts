import type { Device, Opening, SceneV1 } from '../src/scene/types';
import { voxelize } from '../src/scene/voxelize';
import { FluidSolver, setSolverLogger } from '../src/solver';

/** Rectangular room scene, CCW outline: edge 0 = south (y=0), 1 = east (x=w), 2 = north (y=d), 3 = west (x=0). */
export function roomScene(opts: {
  w?: number;
  d?: number;
  height?: number;
  temp?: number;
  outdoorTemp?: number;
  windSpeed?: number;
  windFrom?: number;
  openings?: Opening[];
  devices?: Device[];
}): SceneV1 {
  const { w = 3, d = 3, height = 2.4, temp = 25 } = opts;
  return {
    version: 1,
    grid: { cellSize: 0.1 },
    outdoor: { temp: opts.outdoorTemp ?? temp, windSpeed: opts.windSpeed ?? 0, windFrom: opts.windFrom ?? 270, solar: 0 },
    rooms: [{ id: 'room', outline: [[0, 0], [w, 0], [w, d], [0, d]], height, initialTemp: temp }],
    walls: [],
    openings: opts.openings ?? [],
    devices: opts.devices ?? [],
  };
}

export function window(id: string, edge: number, offset: number, width: number, sill: number, height: number, state: 'open' | 'closed' = 'open'): Opening {
  return { id, type: 'window', room: 'room', edge, offset, width, sill, height, state };
}

/** Voxelize + build a solver, capturing solver warnings. */
export function build(scene: SceneV1) {
  const log: string[] = [];
  setSolverLogger((m) => log.push(m));
  const { voxels, warnings } = voxelize(scene);
  const solver = new FluidSolver(voxels);
  return { solver, warnings, log, voxels };
}

export function run(solver: FluidSolver, steps: number): void {
  for (let s = 0; s < steps; s++) solver.step();
}

/**
 * Net +x flow (m³/s) through the u faces at grid column i, over cells with
 * world z in [z0, z1). Positive = toward +x.
 */
export function flowX(solver: FluidSolver, i: number, z0 = -Infinity, z1 = Infinity): number {
  const { nx, ny, nz, h, origin, u } = solver;
  let s = 0;
  for (let k = 0; k < nz; k++) {
    const z = origin[2] + (k + 0.5) * h;
    if (z < z0 || z >= z1) continue;
    for (let j = 0; j < ny; j++) s += u[i + (nx + 1) * (j + ny * k)] * h * h;
  }
  return s;
}

/** Mean of a cell-centered field over cells whose world centers lie in a box. */
export function boxMean(solver: FluidSolver, field: ArrayLike<number>, lo: number[], hi: number[]): number {
  const { nx, ny, nz, h, origin, fluid } = solver;
  let s = 0;
  let n = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = i + nx * (j + ny * k);
        if (!fluid[c]) continue;
        const p = [origin[0] + (i + 0.5) * h, origin[1] + (j + 0.5) * h, origin[2] + (k + 0.5) * h];
        if (p[0] < lo[0] || p[0] > hi[0] || p[1] < lo[1] || p[1] > hi[1] || p[2] < lo[2] || p[2] > hi[2]) continue;
        s += field[c];
        n++;
      }
  if (n === 0) throw new Error('boxMean: empty box');
  return s / n;
}
