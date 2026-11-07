import { CP, G, KELVIN, NU_EFF_DEFAULT, PR_EFF, RHO } from './constants';
import { CellType, type HeatSource, type MomentumSource, type VoxelScene } from './grid';
import { solverWarn } from './log';
import { PressureSolver, type PressureResult } from './pressure';
import { sampleGrid } from './sample';

export interface SolverOptions {
  /** Nominal timestep, s. step() sub-divides it to keep velocity CFL <= cflMax. */
  dt: number;
  /** Effective kinematic viscosity, m²/s. */
  nu: number;
  /** Effective thermal diffusivity, m²/s. */
  alpha: number;
  /** Max velocity CFL number per sub-step (max face speed · dt / h). */
  cflMax: number;
  /** Max summed advective CFL for the explicit temperature transport sub-steps. */
  tempCflMax: number;
  /** Target max cell divergence after projection, 1/s. */
  divTol: number;
  pressureMaxIter: number;
  buoyancy: boolean;
}

export const DEFAULT_OPTIONS: SolverOptions = {
  dt: 0.05,
  nu: NU_EFF_DEFAULT,
  alpha: NU_EFF_DEFAULT / PR_EFF,
  cflMax: 1,
  tempCflMax: 0.4,
  divTol: 1e-5,
  pressureMaxIter: 2000,
  buoyancy: true,
};

export interface SolverStats {
  time: number;
  steps: number;
  meanT: number;
  minT: number;
  maxT: number;
  /** Mean temperature of the lowest / highest fluid layer, °C. */
  floorT: number;
  ceilingT: number;
  /** Max |div u| over fluid cells, 1/s. */
  maxDiv: number;
  /** Max face speed component, m/s. */
  maxSpeed: number;
  pressureIterations: number;
  pressureConverged: boolean;
  fluidCells: number;
}

/**
 * CPU reference solver: incompressible Navier-Stokes + Boussinesq buoyancy
 * on a staggered MAC grid, with conservative temperature transport.
 *
 * Pure: no DOM, no React, no worker globals, no randomness, no wall clock.
 */
export class FluidSolver {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly h: number;
  readonly n: number;
  readonly opts: SolverOptions;

  readonly cellType: Uint8Array;
  readonly fluid: Uint8Array;
  readonly u: Float32Array;
  readonly v: Float32Array;
  readonly w: Float32Array;
  readonly T: Float32Array;
  /** 1 where the face lies between two fluid cells and can carry flow. */
  readonly uMask: Uint8Array;
  readonly vMask: Uint8Array;
  readonly wMask: Uint8Array;

  readonly heatSources: HeatSource[];
  readonly momentumSources: MomentumSource[];

  time = 0;
  steps = 0;
  lastPressure: PressureResult = { iterations: 0, residual: 0, converged: true };

  private readonly uTmp: Float32Array;
  private readonly vTmp: Float32Array;
  private readonly wTmp: Float32Array;
  private readonly tAcc: Float64Array;
  private readonly rhs: Float64Array;
  private readonly pressure: PressureSolver;
  private readonly fluidCount: number;
  private lastPressureDt = 0;

  constructor(scene: VoxelScene, options: Partial<SolverOptions> = {}) {
    const { nx, ny, nz, h } = scene;
    if (nx < 3 || ny < 3 || nz < 3) throw new Error('grid must be at least 3 cells in every direction');
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.h = h;
    this.n = nx * ny * nz;
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    if (options.nu !== undefined && options.alpha === undefined) this.opts.alpha = options.nu / PR_EFF;

    this.cellType = scene.cellType.slice();
    this.fluid = new Uint8Array(this.n);
    let fluidCount = 0;
    for (let c = 0; c < this.n; c++) {
      if (this.cellType[c] === CellType.Fluid) {
        this.fluid[c] = 1;
        fluidCount++;
      }
    }
    this.fluidCount = fluidCount;

    this.u = new Float32Array((nx + 1) * ny * nz);
    this.v = new Float32Array(nx * (ny + 1) * nz);
    this.w = new Float32Array(nx * ny * (nz + 1));
    this.uTmp = new Float32Array(this.u.length);
    this.vTmp = new Float32Array(this.v.length);
    this.wTmp = new Float32Array(this.w.length);
    this.T = scene.initialTemp.slice();
    this.tAcc = new Float64Array(this.n);
    this.rhs = new Float64Array(this.n);

    this.uMask = new Uint8Array(this.u.length);
    this.vMask = new Uint8Array(this.v.length);
    this.wMask = new Uint8Array(this.w.length);
    this.buildFaceMasks();

    this.pressure = new PressureSolver(nx, ny, nz, this.fluid);

    this.heatSources = scene.heatSources.map((s) => ({ ...s, cells: s.cells.slice() }));
    this.momentumSources = scene.momentumSources.map((s) => ({
      ...s,
      lo: [...s.lo],
      hi: [...s.hi],
      accel: [...s.accel],
    }));
    for (const s of this.heatSources) {
      for (const c of s.cells) {
        if (!this.fluid[c]) throw new Error(`heat source ${s.id} includes non-fluid cell ${c}`);
      }
    }
  }

  private buildFaceMasks(): void {
    const { nx, ny, nz, fluid } = this;
    const nxy = nx * ny;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 1; i < nx; i++) {
          const c = i + nx * (j + ny * k);
          if (fluid[c - 1] && fluid[c]) this.uMask[i + (nx + 1) * (j + ny * k)] = 1;
        }
    for (let k = 0; k < nz; k++)
      for (let j = 1; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = i + nx * (j + ny * k);
          if (fluid[c - nx] && fluid[c]) this.vMask[i + nx * (j + (ny + 1) * k)] = 1;
        }
    for (let k = 1; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = i + nx * (j + ny * k);
          if (fluid[c - nxy] && fluid[c]) this.wMask[c] = 1;
        }
  }

  // ---------------------------------------------------------------- stepping

  /** Advance by dt seconds (default opts.dt), sub-stepping to respect the CFL limit. */
  step(dt: number = this.opts.dt): void {
    const { h, opts } = this;
    const maxSpeed = this.maxFaceSpeed();
    const diffusionLimit = (opts.nu * dt) / (h * h) / (1 / 6);
    const sub = Math.max(1, Math.ceil((maxSpeed * dt) / (opts.cflMax * h)), Math.ceil(diffusionLimit));
    const sdt = dt / sub;
    for (let s = 0; s < sub; s++) this.substep(sdt);
    this.steps++;
  }

  private substep(dt: number): void {
    this.applyHeatSources(dt);
    this.applyMomentumSources(dt);
    if (this.opts.buoyancy) this.applyBuoyancy(dt);
    this.advectVelocity(dt); // u -> uTmp
    this.diffuseVelocity(dt); // uTmp -> u
    this.project(dt);
    this.transportTemperature(dt);
    // Steps 6-7 of SPEC (wall/window heat exchange, controllers) arrive in phase 3.
    this.time += dt;
  }

  private applyHeatSources(dt: number): void {
    const cellVolume = this.h * this.h * this.h;
    for (const src of this.heatSources) {
      if (!src.enabled || src.watts === 0 || src.cells.length === 0) continue;
      const dT = (src.watts * dt) / (RHO * CP * cellVolume * src.cells.length);
      for (let m = 0; m < src.cells.length; m++) this.T[src.cells[m]] += dT;
    }
  }

  private applyMomentumSources(dt: number): void {
    const { nx, ny, u, v, w, uMask, vMask, wMask } = this;
    for (const src of this.momentumSources) {
      if (!src.enabled) continue;
      const [ax, ay, az] = src.accel;
      const [i0, j0, k0] = src.lo;
      const [i1, j1, k1] = src.hi;
      if (ax !== 0)
        for (let k = k0; k < k1; k++)
          for (let j = j0; j < j1; j++)
            for (let i = i0; i <= i1; i++) {
              const f = i + (nx + 1) * (j + ny * k);
              if (uMask[f]) u[f] += ax * dt;
            }
      if (ay !== 0)
        for (let k = k0; k < k1; k++)
          for (let j = j0; j <= j1; j++)
            for (let i = i0; i < i1; i++) {
              const f = i + nx * (j + (ny + 1) * k);
              if (vMask[f]) v[f] += ay * dt;
            }
      if (az !== 0)
        for (let k = k0; k <= k1; k++)
          for (let j = j0; j < j1; j++)
            for (let i = i0; i < i1; i++) {
              const f = i + nx * (j + ny * k);
              if (wMask[f]) w[f] += az * dt;
            }
    }
  }

  /** Boussinesq: w += dt · g·β·(T_face − T_ref), T_ref = current mean fluid temperature. */
  private applyBuoyancy(dt: number): void {
    const { w, wMask, T } = this;
    const nxy = this.nx * this.ny;
    const tRef = this.meanTemperature();
    const beta = 1 / (tRef + KELVIN);
    const k = dt * G * beta;
    for (let f = 0; f < w.length; f++) {
      if (!wMask[f]) continue;
      w[f] += k * (0.5 * (T[f - nxy] + T[f]) - tRef);
    }
  }

  /** Semi-Lagrangian advection with an RK2 (midpoint) backtrace. Writes uTmp/vTmp/wTmp. */
  private advectVelocity(dt: number): void {
    const { nx, ny, nz, h, u, v, w } = this;
    const ih = 1 / h;
    const su = (x: number, y: number, z: number) => sampleGrid(u, nx + 1, ny, nz, x * ih, y * ih - 0.5, z * ih - 0.5);
    const sv = (x: number, y: number, z: number) => sampleGrid(v, nx, ny + 1, nz, x * ih - 0.5, y * ih, z * ih - 0.5);
    const sw = (x: number, y: number, z: number) => sampleGrid(w, nx, ny, nz + 1, x * ih - 0.5, y * ih - 0.5, z * ih);
    const hdt = 0.5 * dt;

    const { uMask, vMask, wMask, uTmp, vTmp, wTmp } = this;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i <= nx; i++) {
          const f = i + (nx + 1) * (j + ny * k);
          if (!uMask[f]) {
            uTmp[f] = 0;
            continue;
          }
          const x = i * h;
          const y = (j + 0.5) * h;
          const z = (k + 0.5) * h;
          const mx = x - hdt * u[f];
          const my = y - hdt * sv(x, y, z);
          const mz = z - hdt * sw(x, y, z);
          uTmp[f] = su(x - dt * su(mx, my, mz), y - dt * sv(mx, my, mz), z - dt * sw(mx, my, mz));
        }
    for (let k = 0; k < nz; k++)
      for (let j = 0; j <= ny; j++)
        for (let i = 0; i < nx; i++) {
          const f = i + nx * (j + (ny + 1) * k);
          if (!vMask[f]) {
            vTmp[f] = 0;
            continue;
          }
          const x = (i + 0.5) * h;
          const y = j * h;
          const z = (k + 0.5) * h;
          const mx = x - hdt * su(x, y, z);
          const my = y - hdt * v[f];
          const mz = z - hdt * sw(x, y, z);
          vTmp[f] = sv(x - dt * su(mx, my, mz), y - dt * sv(mx, my, mz), z - dt * sw(mx, my, mz));
        }
    for (let k = 0; k <= nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const f = i + nx * (j + ny * k);
          if (!wMask[f]) {
            wTmp[f] = 0;
            continue;
          }
          const x = (i + 0.5) * h;
          const y = (j + 0.5) * h;
          const z = k * h;
          const mx = x - hdt * su(x, y, z);
          const my = y - hdt * sv(x, y, z);
          const mz = z - hdt * w[f];
          wTmp[f] = sw(x - dt * su(mx, my, mz), y - dt * sv(mx, my, mz), z - dt * sw(mx, my, mz));
        }
  }

  /**
   * Explicit viscous diffusion, uTmp -> u. Normal-direction neighbors use their
   * stored value (0 at walls: no penetration); tangential neighbors across a
   * wall are skipped (free slip).
   */
  private diffuseVelocity(dt: number): void {
    const { nx, ny, h } = this;
    const kd = (this.opts.nu * dt) / (h * h);
    diffuseComponent(this.uTmp, this.u, this.uMask, kd, 1, nx + 1, (nx + 1) * ny, 0);
    diffuseComponent(this.vTmp, this.v, this.vMask, kd, 1, nx, nx * (ny + 1), 1);
    diffuseComponent(this.wTmp, this.w, this.wMask, kd, 1, nx, nx * ny, 2);
  }

  /** Make the velocity field divergence free on every fluid cell. */
  private project(dt: number): void {
    const { nx, ny, nz, h, u, v, w, rhs, pressure } = this;
    const nxy = nx * ny;
    const list = pressure.fluidList;
    for (let m = 0; m < list.length; m++) {
      const c = list[m];
      const i = c % nx;
      const jk = (c - i) / nx;
      const j = jk % ny;
      const k = (jk - j) / ny;
      const fu = i + (nx + 1) * (j + ny * k);
      const fv = i + nx * (j + (ny + 1) * k);
      rhs[c] = -(u[fu + 1] - u[fu] + v[fv + nx] - v[fv] + w[c + nxy] - w[c]);
    }

    if (this.lastPressureDt > 0 && this.lastPressureDt !== dt) pressure.scaleSolution(dt / this.lastPressureDt);
    this.lastPressureDt = dt;
    this.lastPressure = pressure.solve(rhs, this.opts.divTol * h, this.opts.pressureMaxIter);
    const p = pressure.p;

    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 1; i < nx; i++) {
          const f = i + (nx + 1) * (j + ny * k);
          if (!this.uMask[f]) continue;
          const c = i + nx * (j + ny * k);
          u[f] -= p[c] - p[c - 1];
        }
    for (let k = 0; k < nz; k++)
      for (let j = 1; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const f = i + nx * (j + (ny + 1) * k);
          if (!this.vMask[f]) continue;
          const c = i + nx * (j + ny * k);
          v[f] -= p[c] - p[c - nx];
        }
    for (let c = nxy; c < w.length - nxy; c++) {
      if (!this.wMask[c]) continue;
      w[c] -= p[c] - p[c - nxy];
    }
  }

  /**
   * Conservative finite-volume transport of temperature: MUSCL reconstruction
   * with a minmod limiter, forward Euler, sub-stepped for stability. Every face
   * flux is subtracted from one cell and added to its neighbor, and solid faces
   * carry no flux, so a sealed adiabatic room conserves heat exactly.
   */
  private transportTemperature(dt: number): void {
    const { nx, ny, nz, h, u, v, w, uMask, vMask, wMask, fluid, T, tAcc, opts } = this;
    const nxy = nx * ny;
    const maxU = maxAbsMasked(u, uMask);
    const maxV = maxAbsMasked(v, vMask);
    const maxW = maxAbsMasked(w, wMask);
    const cflSum = ((maxU + maxV + maxW) * dt) / h;
    const diffNum = (opts.alpha * dt) / (h * h);
    const sub = Math.max(1, Math.ceil(cflSum / opts.tempCflMax + diffNum / 0.15));
    const tdt = dt / sub;
    const ka = tdt / h;
    const kd = (opts.alpha * tdt) / (h * h);

    for (let s = 0; s < sub; s++) {
      for (let c = 0; c < this.n; c++) tAcc[c] = T[c];

      for (let k = 0; k < nz; k++)
        for (let j = 0; j < ny; j++)
          for (let i = 1; i < nx; i++) {
            const f = i + (nx + 1) * (j + ny * k);
            if (!uMask[f]) continue;
            const R = i + nx * (j + ny * k);
            const flux = faceFlux(T, fluid, R - 1, R, 1, u[f], ka, kd);
            tAcc[R - 1] -= flux;
            tAcc[R] += flux;
          }
      for (let k = 0; k < nz; k++)
        for (let j = 1; j < ny; j++)
          for (let i = 0; i < nx; i++) {
            const f = i + nx * (j + (ny + 1) * k);
            if (!vMask[f]) continue;
            const R = i + nx * (j + ny * k);
            const flux = faceFlux(T, fluid, R - nx, R, nx, v[f], ka, kd);
            tAcc[R - nx] -= flux;
            tAcc[R] += flux;
          }
      for (let R = nxy; R < this.n; R++) {
        if (!wMask[R]) continue;
        const flux = faceFlux(T, fluid, R - nxy, R, nxy, w[R], ka, kd);
        tAcc[R - nxy] -= flux;
        tAcc[R] += flux;
      }

      for (let c = 0; c < this.n; c++) T[c] = tAcc[c];
    }
  }

  // ---------------------------------------------------------------- queries

  meanTemperature(): number {
    const { T, fluid } = this;
    let s = 0;
    for (let c = 0; c < this.n; c++) if (fluid[c]) s += T[c];
    return s / this.fluidCount;
  }

  maxFaceSpeed(): number {
    return Math.max(maxAbsMasked(this.u, this.uMask), maxAbsMasked(this.v, this.vMask), maxAbsMasked(this.w, this.wMask));
  }

  /** Divergence per cell (1/s), zero outside fluid. */
  divergence(out: Float32Array = new Float32Array(this.n)): Float32Array {
    const { nx, ny, nz, h, u, v, w, fluid } = this;
    const nxy = nx * ny;
    const ih = 1 / h;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = i + nx * (j + ny * k);
          if (!fluid[c]) {
            out[c] = 0;
            continue;
          }
          const fu = i + (nx + 1) * (j + ny * k);
          const fv = i + nx * (j + (ny + 1) * k);
          out[c] = (u[fu + 1] - u[fu] + v[fv + nx] - v[fv] + w[c + nxy] - w[c]) * ih;
        }
    return out;
  }

  maxDivergence(): number {
    const d = this.divergence();
    let mx = 0;
    for (let c = 0; c < this.n; c++) if (this.fluid[c] && Math.abs(d[c]) > mx) mx = Math.abs(d[c]);
    return mx;
  }

  /** Physical pressure (Pa) relative to the mean of each sealed region. */
  pressurePa(out: Float32Array = new Float32Array(this.n)): Float32Array {
    const p = this.pressure.p;
    const scale = this.lastPressureDt > 0 ? (RHO * this.h) / this.lastPressureDt : 0;
    for (let c = 0; c < this.n; c++) out[c] = this.fluid[c] ? p[c] * scale : 0;
    return out;
  }

  /** Cell-centered velocity (average of the two faces), m/s. */
  cellVelocity(
    ux: Float32Array = new Float32Array(this.n),
    uy: Float32Array = new Float32Array(this.n),
    uz: Float32Array = new Float32Array(this.n),
  ): [Float32Array, Float32Array, Float32Array] {
    const { nx, ny, nz, u, v, w } = this;
    const nxy = nx * ny;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = i + nx * (j + ny * k);
          const fu = i + (nx + 1) * (j + ny * k);
          const fv = i + nx * (j + (ny + 1) * k);
          ux[c] = 0.5 * (u[fu] + u[fu + 1]);
          uy[c] = 0.5 * (v[fv] + v[fv + nx]);
          uz[c] = 0.5 * (w[c] + w[c + nxy]);
        }
    return [ux, uy, uz];
  }

  /** Mean temperature of fluid cells in layer k, or NaN if the layer has none. */
  layerMeanT(k: number): number {
    const { nx, ny, T, fluid } = this;
    let s = 0;
    let cnt = 0;
    for (let c = nx * ny * k; c < nx * ny * (k + 1); c++) {
      if (fluid[c]) {
        s += T[c];
        cnt++;
      }
    }
    return cnt ? s / cnt : NaN;
  }

  stats(): SolverStats {
    const { T, fluid } = this;
    let sum = 0;
    let mn = Infinity;
    let mx = -Infinity;
    for (let c = 0; c < this.n; c++) {
      if (!fluid[c]) continue;
      const t = T[c];
      sum += t;
      if (t < mn) mn = t;
      if (t > mx) mx = t;
    }
    let floorT = NaN;
    let ceilingT = NaN;
    for (let k = 0; k < this.nz && Number.isNaN(floorT); k++) floorT = this.layerMeanT(k);
    for (let k = this.nz - 1; k >= 0 && Number.isNaN(ceilingT); k--) ceilingT = this.layerMeanT(k);
    return {
      time: this.time,
      steps: this.steps,
      meanT: sum / this.fluidCount,
      minT: mn,
      maxT: mx,
      floorT,
      ceilingT,
      maxDiv: this.maxDivergence(),
      maxSpeed: this.maxFaceSpeed(),
      pressureIterations: this.lastPressure.iterations,
      pressureConverged: this.lastPressure.converged,
      fluidCells: this.fluidCount,
    };
  }

  // ---------------------------------------------------------------- live edits

  setHeatSource(id: string, patch: { watts?: number; enabled?: boolean }): void {
    const src = this.heatSources.find((s) => s.id === id);
    if (!src) {
      solverWarn(`setHeatSource: unknown id ${id}`);
      return;
    }
    if (patch.watts !== undefined) src.watts = patch.watts;
    if (patch.enabled !== undefined) src.enabled = patch.enabled;
  }

  setMomentumSource(id: string, patch: { accel?: [number, number, number]; enabled?: boolean }): void {
    const src = this.momentumSources.find((s) => s.id === id);
    if (!src) {
      solverWarn(`setMomentumSource: unknown id ${id}`);
      return;
    }
    if (patch.accel) src.accel = [...patch.accel];
    if (patch.enabled !== undefined) src.enabled = patch.enabled;
  }
}

// -------------------------------------------------------------------- kernels

function maxAbsMasked(a: Float32Array, mask: Uint8Array): number {
  let mx = 0;
  for (let f = 0; f < a.length; f++) {
    if (!mask[f]) continue;
    const s = Math.abs(a[f]);
    if (s > mx) mx = s;
  }
  return mx;
}

function minmod(a: number, b: number): number {
  if (a > 0 && b > 0) return a < b ? a : b;
  if (a < 0 && b < 0) return a > b ? a : b;
  return 0;
}

/**
 * Temperature moved from cell L to its +stride neighbor R through one face
 * during a sub-step (already multiplied by dt/h). Advective part uses a
 * MUSCL/minmod upwind reconstruction; diffusive part is a central difference.
 */
function faceFlux(
  T: Float32Array,
  fluid: Uint8Array,
  L: number,
  R: number,
  stride: number,
  vel: number,
  ka: number,
  kd: number,
): number {
  const TL = T[L];
  const TR = T[R];
  let tf: number;
  if (vel >= 0) {
    const LL = L - stride;
    tf = fluid[LL] ? TL + 0.5 * minmod(TR - TL, TL - T[LL]) : TL;
  } else {
    const RR = R + stride;
    tf = fluid[RR] ? TR - 0.5 * minmod(TR - TL, T[RR] - TR) : TR;
  }
  return ka * vel * tf - kd * (TR - TL);
}

/**
 * Explicit diffusion of one face-velocity component, src -> dst.
 * axis: which stride (0: s1, 1: s2, 2: s3) is the component's normal direction.
 */
function diffuseComponent(
  src: Float32Array,
  dst: Float32Array,
  mask: Uint8Array,
  kd: number,
  s1: number,
  s2: number,
  s3: number,
  axis: 0 | 1 | 2,
): void {
  const strides = [s1, s2, s3];
  const normal = strides[axis];
  const t1 = strides[(axis + 1) % 3];
  const t2 = strides[(axis + 2) % 3];
  for (let f = 0; f < src.length; f++) {
    if (!mask[f]) {
      dst[f] = 0;
      continue;
    }
    const c = src[f];
    let lap = src[f - normal] + src[f + normal] - 2 * c;
    if (mask[f - t1]) lap += src[f - t1] - c;
    if (mask[f + t1]) lap += src[f + t1] - c;
    if (mask[f - t2]) lap += src[f - t2] - c;
    if (mask[f + t2]) lap += src[f + t2] - c;
    dst[f] = c + kd * lap;
  }
}
