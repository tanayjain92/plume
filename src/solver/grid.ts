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

/**
 * A set of boundary faces (between a fluid cell and a solid cell) with a
 * prescribed normal velocity: supply/return vents and AC grilles.
 */
export interface FlowPort {
  id: string;
  /** Face index into u, v or w (see axes). */
  faces: Int32Array;
  /** 0 = u (x), 1 = v (y), 2 = w (z). */
  axes: Uint8Array;
  /** +1 if "into the room" is the +axis direction for this face, else -1. */
  inward: Int8Array;
  /** The fluid cell each face belongs to. */
  cells: Int32Array;
  /** Total face area, m². */
  area: number;
  /** Volumetric flow, m³/s. Positive = into the room, negative = out. */
  flow: number;
  /** Temperature of entering air, °C (unused for outflow; AC units overwrite it every step). */
  temp: number;
  /** Optional jet direction for inflow (unit vector). Its tangential part is imposed on the first fluid cells. */
  jetDir: Vec3 | null;
  enabled: boolean;
}

/**
 * Fan: relaxes the face velocities inside a region toward speed·dir with time
 * constant FAN_TAU. Pure momentum source, zero net mass. Optional oscillation
 * rotates dir about +z by ±oscillateDeg/2 with period periodSec.
 */
export interface FanForce {
  id: string;
  faces: Int32Array;
  axes: Uint8Array;
  /** Target speed, m/s. */
  speed: number;
  /** Unit direction at the center of the oscillation. */
  dir: Vec3;
  oscillateDeg: number;
  periodSec: number;
  enabled: boolean;
}

/**
 * AC unit: couples a supply port to a return port. Every step the supply
 * temperature is set to (flow-weighted return temperature) − ΔT, where ΔT is
 * capped by sensible capacity: Q = ρ·cp·V̇·ΔT. Condenser heat goes outdoors.
 */
export interface AcUnit {
  id: string;
  supplyPort: string;
  returnPort: string;
  /** Sensible cooling capacity, W. */
  sensibleW: number;
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
  /** Outdoor air temperature, °C: open cells and inward leakage use it. */
  outdoorTemp: number;
  /** Wind pressure on each Open cell, Pa (0 elsewhere). The stack-effect part is added by the solver. */
  openPressure: Float32Array;
  heatSources: HeatSource[];
  momentumSources: MomentumSource[];
  ports: FlowPort[];
  fans: FanForce[];
  acUnits: AcUnit[];
}

export function cellIndex(nx: number, ny: number, i: number, j: number, k: number): number {
  return i + nx * (j + ny * k);
}

/** Index of the face on the low side of cell (i,j,k) along an axis. */
export function lowFace(nx: number, ny: number, axis: number, i: number, j: number, k: number): number {
  if (axis === 0) return i + (nx + 1) * (j + ny * k);
  if (axis === 1) return i + nx * (j + (ny + 1) * k);
  return i + nx * (j + ny * k);
}

/** World position (m) of the center of face `f` on axis `axis`. */
export function facePosition(scene: Pick<VoxelScene, 'nx' | 'ny' | 'h' | 'origin'>, axis: number, f: number): Vec3 {
  const { nx, ny, h, origin } = scene;
  let i: number, j: number, k: number;
  if (axis === 0) {
    i = f % (nx + 1);
    const r = (f - i) / (nx + 1);
    j = r % ny;
    k = (r - j) / ny;
    return [origin[0] + i * h, origin[1] + (j + 0.5) * h, origin[2] + (k + 0.5) * h];
  }
  if (axis === 1) {
    i = f % nx;
    const r = (f - i) / nx;
    j = r % (ny + 1);
    k = (r - j) / (ny + 1);
    return [origin[0] + (i + 0.5) * h, origin[1] + j * h, origin[2] + (k + 0.5) * h];
  }
  i = f % nx;
  const r = (f - i) / nx;
  j = r % ny;
  k = (r - j) / ny;
  return [origin[0] + (i + 0.5) * h, origin[1] + (j + 0.5) * h, origin[2] + k * h];
}

/**
 * Port on the boundary faces of fluid cells in the cell box [lo, hi) whose
 * neighbor in direction (axis, side) is solid. side = +1 means the wall is on
 * the +axis side of the fluid cell.
 */
export function makePort(
  scene: VoxelScene,
  id: string,
  lo: Vec3,
  hi: Vec3,
  axis: 0 | 1 | 2,
  side: 1 | -1,
  flow: number,
  temp: number,
  jetDir: Vec3 | null = null,
): FlowPort {
  const { nx, ny, h, cellType } = scene;
  const stride = axis === 0 ? 1 : axis === 1 ? nx : nx * ny;
  const faces: number[] = [];
  const cells: number[] = [];
  for (let k = lo[2]; k < hi[2]; k++)
    for (let j = lo[1]; j < hi[1]; j++)
      for (let i = lo[0]; i < hi[0]; i++) {
        const c = cellIndex(nx, ny, i, j, k);
        if (cellType[c] !== CellType.Fluid || cellType[c + side * stride] !== CellType.Solid) continue;
        const ijk = [i, j, k];
        if (side === 1) ijk[axis]++;
        faces.push(lowFace(nx, ny, axis, ijk[0], ijk[1], ijk[2]));
        cells.push(c);
      }
  return {
    id,
    faces: Int32Array.from(faces),
    axes: new Uint8Array(faces.length).fill(axis),
    inward: new Int8Array(faces.length).fill(-side),
    cells: Int32Array.from(cells),
    area: faces.length * h * h,
    flow,
    temp,
    jetDir,
    enabled: true,
  };
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
    outdoorTemp: temp,
    openPressure: new Float32Array(n),
    heatSources: [],
    momentumSources: [],
    ports: [],
    fans: [],
    acUnits: [],
  };
}

/** Turn a cell box [lo, hi) into open (fixed-pressure, outdoor-temperature) cells, e.g. an open window. */
export function addOpenBox(scene: VoxelScene, lo: Vec3, hi: Vec3, windPa = 0): void {
  const { nx, ny } = scene;
  for (let k = lo[2]; k < hi[2]; k++)
    for (let j = lo[1]; j < hi[1]; j++)
      for (let i = lo[0]; i < hi[0]; i++) {
        const c = cellIndex(nx, ny, i, j, k);
        scene.cellType[c] = CellType.Open;
        scene.openPressure[c] = windPa;
      }
}

/** Fan region: every u/v/w face (for axes where dir is nonzero) whose center lies in the cell box [lo, hi). */
export function addFanBox(scene: VoxelScene, id: string, lo: Vec3, hi: Vec3, dir: Vec3, speed: number): FanForce {
  const { nx, ny } = scene;
  const faces: number[] = [];
  const axes: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    if (dir[axis] === 0) continue;
    const ext = [0, 0, 0];
    ext[axis] = 1;
    for (let k = lo[2]; k < hi[2] + ext[2]; k++)
      for (let j = lo[1]; j < hi[1] + ext[1]; j++)
        for (let i = lo[0]; i < hi[0] + ext[0]; i++) {
          faces.push(lowFace(nx, ny, axis, i, j, k));
          axes.push(axis);
        }
  }
  const fan: FanForce = {
    id,
    faces: Int32Array.from(faces),
    axes: Uint8Array.from(axes),
    speed,
    dir,
    oscillateDeg: 0,
    periodSec: 0,
    enabled: true,
  };
  scene.fans.push(fan);
  return fan;
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
