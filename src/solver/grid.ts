/**
 * Voxelized scene: the only input the solver accepts.
 *
 * Indexing: cell (i,j,k) lives at flat index i + nx*(j + ny*k), with z up.
 * Faces of the staggered MAC grid:
 *   u (x-faces): (nx+1)*ny*nz,  index i + (nx+1)*(j + ny*k), i in [0, nx]
 *   v (y-faces): nx*(ny+1)*nz,  index i + nx*(j + (ny+1)*k), j in [0, ny]
 *   w (z-faces): nx*ny*(nz+1),  index i + nx*(j + ny*k),     k in [0, nz]
 * u face i sits between cells i-1 and i (likewise for v, w).
 */
export const CellType = {
  Fluid: 0,
  Solid: 1,
  Inlet: 2,
  Outlet: 3,
  Open: 4,
} as const;
export type CellType = (typeof CellType)[keyof typeof CellType];

export type Vec3 = [number, number, number];

/** Volumetric heat released uniformly into a set of fluid cells. Negative watts = heat sink. */
export interface HeatSource {
  id: string;
  /** Flat cell indices (all fluid). */
  cells: Int32Array;
  watts: number;
  enabled: boolean;
}

/**
 * Body force (acceleration, m/s²) on every active face inside a cell-index box.
 * Zero net mass by construction: it only pushes air that is already there.
 * Phase 2 builds fan actuator disks on top of this.
 */
export interface MomentumSource {
  id: string;
  /** Inclusive-exclusive cell-index box [lo, hi). */
  lo: Vec3;
  hi: Vec3;
  accel: Vec3;
  enabled: boolean;
}

export interface VoxelScene {
  nx: number;
  ny: number;
  nz: number;
  /** Cell size, m. */
  h: number;
  /** World position (m) of the min corner of cell (0,0,0). */
  origin: Vec3;
  cellType: Uint8Array;
  /** Initial temperature per cell, °C. */
  initialTemp: Float32Array;
  heatSources: HeatSource[];
  momentumSources: MomentumSource[];
}

export function cellIndex(nx: number, ny: number, i: number, j: number, k: number): number {
  return i + nx * (j + ny * k);
}

/** Sealed rectangular box: fluid interior of `size` meters wrapped in a one-cell solid shell. */
export function createBoxScene(opts: { size: Vec3; h: number; temp: number }): VoxelScene {
  const { size, h, temp } = opts;
  const nx = Math.round(size[0] / h) + 2;
  const ny = Math.round(size[1] / h) + 2;
  const nz = Math.round(size[2] / h) + 2;
  const n = nx * ny * nz;
  const cellType = new Uint8Array(n).fill(CellType.Solid);
  for (let k = 1; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) cellType[cellIndex(nx, ny, i, j, k)] = CellType.Fluid;
  return {
    nx,
    ny,
    nz,
    h,
    origin: [-h, -h, -h],
    cellType,
    initialTemp: new Float32Array(n).fill(temp),
    heatSources: [],
    momentumSources: [],
  };
}

/** Mark a cell-index box [lo, hi) as solid (furniture, interior walls). */
export function addSolidBox(scene: VoxelScene, lo: Vec3, hi: Vec3): void {
  const { nx, ny } = scene;
  for (let k = lo[2]; k < hi[2]; k++)
    for (let j = lo[1]; j < hi[1]; j++)
      for (let i = lo[0]; i < hi[0]; i++) scene.cellType[cellIndex(nx, ny, i, j, k)] = CellType.Solid;
}

/** Add a heat source over the fluid cells of a cell-index box [lo, hi). */
export function addHeatBox(scene: VoxelScene, id: string, lo: Vec3, hi: Vec3, watts: number): HeatSource {
  const { nx, ny } = scene;
  const cells: number[] = [];
  for (let k = lo[2]; k < hi[2]; k++)
    for (let j = lo[1]; j < hi[1]; j++)
      for (let i = lo[0]; i < hi[0]; i++) {
        const c = cellIndex(nx, ny, i, j, k);
        if (scene.cellType[c] === CellType.Fluid) cells.push(c);
      }
  if (cells.length === 0) throw new Error(`heat source ${id} covers no fluid cells`);
  const src: HeatSource = { id, cells: Int32Array.from(cells), watts, enabled: true };
  scene.heatSources.push(src);
  return src;
}

export function addMomentumBox(scene: VoxelScene, id: string, lo: Vec3, hi: Vec3, accel: Vec3): MomentumSource {
  const src: MomentumSource = { id, lo, hi, accel, enabled: true };
  scene.momentumSources.push(src);
  return src;
}
