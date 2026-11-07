import { CP, G, KELVIN, NU_EFF_DEFAULT, PR_EFF, RHO } from './constants';
import {
  CellType,
  type AcUnit,
  type FanForce,
  type FlowPort,
  type HeatSource,
  type MomentumSource,
  type Vec3,
  type VoxelScene,
} from './grid';
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

/** Fan relaxation time constant, s: how fast a fan drives its region toward the target velocity. */
export const FAN_TAU = 0.1;
/**
 * Fans hold their rated airflow: a controller scales each fan's forcing target
 * until the measured mean velocity through its region matches the rating.
 * Time constant of that controller (s), and the largest gain allowed.
 */
const FAN_CTRL_TAU = 0.15;
const FAN_GAIN_MAX = 25;
/** Leakage below this (m³/s, ≈0.2 CFM) is float noise, not an unbalanced room. */
const LEAK_WARN = 1e-4;

export interface SolverStats {
  time: number;
  steps: number;
  meanT: number;
  minT: number;
  maxT: number;
  /** Mean temperature of the lowest / highest fluid layer, °C. */
  floorT: number;
  ceilingT: number;
  /** Max |div u − leak| over fluid cells, 1/s. */
  maxDiv: number;
  /** Max face speed component, m/s. */
  maxSpeed: number;
  pressureIterations: number;
  pressureConverged: boolean;
  fluidCells: number;
  /** Net envelope leakage of sealed regions, m³/s. Positive = outdoor air leaking in. */
  leakFlow: number;
  /** Air entering through open windows, m³/s (an equal amount leaves, net of ports). */
  openInflow: number;
}

export interface AcReport {
  id: string;
  enabled: boolean;
  supplyT: number;
  returnT: number;
  /** Sensible heat removed from the room air, W. */
  coolingW: number;
  flow: number;
}

export interface DeviceReport {
  acUnits: AcReport[];
  ports: { id: string; flow: number; temp: number }[];
  /** delivered = measured mean velocity through the fan / rated velocity (≈1 once the controller settles). */
  fans: { id: string; headingOffsetDeg: number; delivered: number }[];
}

/**
 * CPU reference solver: incompressible Navier-Stokes + Boussinesq buoyancy
 * on a staggered MAC grid, with conservative temperature transport.
 *
 * Boundary types: solid cells (no flow), open cells (fixed pressure from
 * wind + stack effect, outdoor temperature), flow ports (fixed normal
 * velocity on wall faces), fans (momentum sources), heat sources.
 *
 * Pure: no DOM, no React, no worker globals, no randomness, no wall clock.
 */
export class FluidSolver {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly h: number;
  readonly n: number;
  readonly origin: Vec3;
  readonly opts: SolverOptions;
  readonly outdoorTemp: number;

  readonly cellType: Uint8Array;
  readonly fluid: Uint8Array;
  readonly open: Uint8Array;
  readonly openPressure: Float32Array;
  readonly u: Float32Array;
  readonly v: Float32Array;
  readonly w: Float32Array;
  readonly T: Float32Array;
  /** 1 where the face lies between fluid/open cells (at least one fluid) and is pressure-projected. */
  readonly uMask: Uint8Array;
  readonly vMask: Uint8Array;
  readonly wMask: Uint8Array;

  readonly heatSources: HeatSource[];
  readonly momentumSources: MomentumSource[];
  readonly ports: FlowPort[];
  readonly fans: FanForce[];
  readonly acUnits: AcUnit[];

  time = 0;
  steps = 0;
  lastPressure: PressureResult = { iterations: 0, residual: 0, converged: true };
  /** Uniform leakage divergence per sealed region, 1/s (positive = air entering). */
  readonly regionLeak: Float64Array;

  private readonly uTmp: Float32Array;
  private readonly vTmp: Float32Array;
  private readonly wTmp: Float32Array;
  private readonly tAcc: Float64Array;
  private readonly rhs: Float64Array;
  private readonly pressure: PressureSolver;
  private readonly fluidCount: number;
  /** Faces between a fluid and an open cell: face, axis, inward sign (+1 if fluid is on the +axis side). */
  private readonly openFaces: { face: number; axis: number; inward: number }[] = [];
  private readonly acState = new Map<string, { returnT: number }>();
  private readonly fanGain = new Map<string, number>();
  private readonly fanWarned = new Set<string>();
  private lastPressureDt = 0;
  private leakWarned = false;

  constructor(scene: VoxelScene, options: Partial<SolverOptions> = {}) {
    const { nx, ny, nz, h } = scene;
    if (nx < 3 || ny < 3 || nz < 3) throw new Error('grid must be at least 3 cells in every direction');
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.h = h;
    this.n = nx * ny * nz;
    this.origin = [...scene.origin];
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    if (options.nu !== undefined && options.alpha === undefined) this.opts.alpha = options.nu / PR_EFF;
    this.outdoorTemp = scene.outdoorTemp ?? 20;

    this.cellType = scene.cellType.slice();
    this.fluid = new Uint8Array(this.n);
    this.open = new Uint8Array(this.n);
    let fluidCount = 0;
    for (let c = 0; c < this.n; c++) {
      if (this.cellType[c] === CellType.Fluid) {
        this.fluid[c] = 1;
        fluidCount++;
      } else if (this.cellType[c] === CellType.Open) this.open[c] = 1;
    }
    this.fluidCount = fluidCount;
    this.openPressure = scene.openPressure ? scene.openPressure.slice() : new Float32Array(this.n);

    this.u = new Float32Array((nx + 1) * ny * nz);
    this.v = new Float32Array(nx * (ny + 1) * nz);
    this.w = new Float32Array(nx * ny * (nz + 1));
    this.uTmp = new Float32Array(this.u.length);
    this.vTmp = new Float32Array(this.v.length);
    this.wTmp = new Float32Array(this.w.length);
    this.T = scene.initialTemp.slice();
    for (let c = 0; c < this.n; c++) if (this.open[c]) this.T[c] = this.outdoorTemp;
    this.tAcc = new Float64Array(this.n);
    this.rhs = new Float64Array(this.n);

    this.uMask = new Uint8Array(this.u.length);
    this.vMask = new Uint8Array(this.v.length);
    this.wMask = new Uint8Array(this.w.length);
    this.buildFaceMasks();

    this.pressure = new PressureSolver(nx, ny, nz, this.fluid, this.open);
    this.regionLeak = new Float64Array(this.pressure.componentCount);

    this.heatSources = (scene.heatSources ?? []).map((s) => ({ ...s, cells: s.cells.slice() }));
    this.momentumSources = (scene.momentumSources ?? []).map((s) => ({
      ...s,
      lo: [...s.lo],
      hi: [...s.hi],
      accel: [...s.accel],
    }));
    this.ports = (scene.ports ?? []).map((p) => ({ ...p, jetDir: p.jetDir ? [...p.jetDir] : null }));
    this.fans = (scene.fans ?? []).map((f) => ({ ...f, dir: [...f.dir] }));
    this.acUnits = (scene.acUnits ?? []).map((a) => ({ ...a }));

    for (const s of this.heatSources)
      for (const c of s.cells) if (!this.fluid[c]) throw new Error(`heat source ${s.id} includes non-fluid cell ${c}`);
    for (const p of this.ports) {
      if (p.faces.length === 0) solverWarn(`flow port ${p.id} has no faces; it does nothing`);
      for (let m = 0; m < p.faces.length; m++) {
        if (this.maskFor(p.axes[m])[p.faces[m]]) throw new Error(`flow port ${p.id} uses a pressure-solved face`);
        if (!this.fluid[p.cells[m]]) throw new Error(`flow port ${p.id} is attached to a non-fluid cell`);
      }
    }
    for (const a of this.acUnits) {
      if (!this.port(a.supplyPort) || !this.port(a.returnPort)) throw new Error(`AC ${a.id} references a missing port`);
    }
  }

  private maskFor(axis: number): Uint8Array {
    return axis === 0 ? this.uMask : axis === 1 ? this.vMask : this.wMask;
  }

  private velFor(axis: number): Float32Array {
    return axis === 0 ? this.u : axis === 1 ? this.v : this.w;
  }

  private port(id: string): FlowPort | undefined {
    return this.ports.find((p) => p.id === id);
  }

  private buildFaceMasks(): void {
    const { nx, ny, nz, fluid, open } = this;
    const nxy = nx * ny;
    const set = (mask: Uint8Array, f: number, L: number, R: number, axis: number) => {
      const lf = fluid[L];
      const rf = fluid[R];
      if (!(lf || rf)) return;
      if (!(lf || open[L]) || !(rf || open[R])) return;
      mask[f] = 1;
      if (!lf || !rf) this.openFaces.push({ face: f, axis, inward: rf ? 1 : -1 });
    };
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 1; i < nx; i++) {
          const c = i + nx * (j + ny * k);
          set(this.uMask, i + (nx + 1) * (j + ny * k), c - 1, c, 0);
        }
    for (let k = 0; k < nz; k++)
      for (let j = 1; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = i + nx * (j + ny * k);
          set(this.vMask, i + nx * (j + (ny + 1) * k), c - nx, c, 1);
        }
    for (let k = 1; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = i + nx * (j + ny * k);
          set(this.wMask, c, c - nxy, c, 2);
        }
  }

  // ---------------------------------------------------------------- stepping

  /** Advance by dt seconds (default opts.dt), sub-stepping to respect the CFL limit. */
  step(dt: number = this.opts.dt): void {
    const { h, opts } = this;
    const maxSpeed = Math.max(this.maxFaceSpeed(), this.maxPortSpeed(), this.maxFanSpeed());
    const diffusionLimit = (opts.nu * dt) / (h * h) / (1 / 6);
    const sub = Math.max(1, Math.ceil((maxSpeed * dt) / (opts.cflMax * h)), Math.ceil(diffusionLimit));
    const sdt = dt / sub;
    for (let s = 0; s < sub; s++) this.substep(sdt);
    this.steps++;
  }

  private substep(dt: number): void {
    this.applyHeatSources(dt);
    this.updateAcUnits();
    this.applyFans(dt);
    this.applyMomentumSources(dt);
    if (this.opts.buoyancy) this.applyBuoyancy(dt);
    this.advectVelocity(dt); // u -> uTmp
    this.diffuseVelocity(dt); // uTmp -> u (inactive faces zeroed)
    this.applyPorts(); // prescribed vent velocities + inflow jets
    this.project(dt);
    this.updateFanGains(dt);
    this.transportTemperature(dt);
    // Steps 6-7 of SPEC (wall/window heat exchange, thermostats) arrive in phase 3.
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

  /** Supply temperature = return temperature − sensible capacity / (ρ·cp·V̇). */
  private updateAcUnits(): void {
    for (const ac of this.acUnits) {
      const sup = this.port(ac.supplyPort)!;
      const ret = this.port(ac.returnPort)!;
      sup.enabled = ac.enabled;
      ret.enabled = ac.enabled;
      const returnT = this.portAirTemp(ret);
      this.acState.set(ac.id, { returnT });
      if (sup.flow > 0) sup.temp = returnT - ac.sensibleW / (RHO * CP * sup.flow);
    }
  }

  /** Mean temperature of the air next to a port's faces, °C. */
  private portAirTemp(p: FlowPort): number {
    let s = 0;
    for (let m = 0; m < p.cells.length; m++) s += this.T[p.cells[m]];
    return p.cells.length ? s / p.cells.length : NaN;
  }

  private fanDir(f: FanForce): Vec3 {
    if (!f.oscillateDeg || !f.periodSec) return f.dir;
    const a = ((f.oscillateDeg / 2) * Math.PI * Math.sin((2 * Math.PI * this.time) / f.periodSec)) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    // rotate clockwise (seen from above) about +z, matching heading convention
    return [f.dir[0] * c + f.dir[1] * s, -f.dir[0] * s + f.dir[1] * c, f.dir[2]];
  }

  private applyFans(dt: number): void {
    const relax = 1 - Math.exp(-dt / FAN_TAU);
    for (const f of this.fans) {
      if (!f.enabled || f.speed === 0) continue;
      const d = this.fanDir(f);
      const target = f.speed * (this.fanGain.get(f.id) ?? 1);
      for (let m = 0; m < f.faces.length; m++) {
        const axis = f.axes[m];
        const face = f.faces[m];
        if (!this.maskFor(axis)[face]) continue;
        const vel = this.velFor(axis);
        vel[face] += (target * d[axis] - vel[face]) * relax;
      }
    }
  }

  /** Mean velocity along the fan's current direction over its (open) region faces, m/s. */
  private fanDelivered(f: FanForce): number {
    const d = this.fanDir(f);
    let s = 0;
    let n = 0;
    for (let m = 0; m < f.faces.length; m++) {
      const axis = f.axes[m];
      if (!this.maskFor(axis)[f.faces[m]]) continue;
      s += this.velFor(axis)[f.faces[m]] * d[axis];
      n++;
    }
    // Faces of an oscillating fan split between axes; normalize by the direction's spread over them.
    let wsum = 0;
    for (let m = 0; m < f.faces.length; m++) if (this.maskFor(f.axes[m])[f.faces[m]]) wsum += d[f.axes[m]] * d[f.axes[m]];
    return n && wsum ? s / wsum : 0;
  }

  /** Integral controller: nudge each fan's gain so its delivered velocity approaches its rating. */
  private updateFanGains(dt: number): void {
    for (const f of this.fans) {
      if (!f.enabled || f.speed === 0) continue;
      const g = this.fanGain.get(f.id) ?? 1;
      let next = g + (dt / FAN_CTRL_TAU) * ((f.speed - this.fanDelivered(f)) / f.speed);
      if (next > FAN_GAIN_MAX || next < 0) {
        if (!this.fanWarned.has(f.id)) {
          this.fanWarned.add(f.id);
          solverWarn(`fan ${f.id} can't reach its rated airflow (is it blocked by a wall?); its forcing gain is capped at ${FAN_GAIN_MAX}`);
        }
        next = Math.max(0, Math.min(FAN_GAIN_MAX, next));
      }
      this.fanGain.set(f.id, next);
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

  /**
   * Set prescribed vent velocities, and impose the tangential part of inflow
   * jets on the first fluid cell (a louver turning the air).
   */
  private applyPorts(): void {
    const { nx, ny } = this;
    const strides = [1, nx, nx * ny];
    for (const p of this.ports) {
      const vn = p.enabled && p.area > 0 ? p.flow / p.area : 0;
      for (let m = 0; m < p.faces.length; m++) this.velFor(p.axes[m])[p.faces[m]] = vn * p.inward[m];
      if (!p.jetDir || vn <= 0) continue;
      for (let m = 0; m < p.faces.length; m++) {
        const axis = p.axes[m];
        const dn = p.jetDir[axis] * p.inward[m];
        if (dn <= 0) continue;
        const c = p.cells[m];
        for (let t = 0; t < 3; t++) {
          if (t === axis) continue;
          const vt = (vn * p.jetDir[t]) / dn;
          const mask = this.maskFor(t);
          const vel = this.velFor(t);
          const lo = this.cellFace(c, t);
          const hi = lo + strides[t];
          if (mask[lo]) vel[lo] = vt;
          if (mask[hi]) vel[hi] = vt;
        }
      }
    }
  }

  /** Low-side face of cell c along axis t. */
  private cellFace(c: number, t: number): number {
    const { nx, ny } = this;
    const i = c % nx;
    const r = (c - i) / nx;
    const j = r % ny;
    const k = (r - j) / ny;
    if (t === 0) return i + (nx + 1) * (j + ny * k);
    if (t === 1) return i + nx * (j + (ny + 1) * k);
    return c;
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

  /** Open-cell pressure: wind (from the scene) + stack effect from the indoor/outdoor temperature difference. */
  private setOpenPressure(dt: number): void {
    const { nx, ny, h, pressure } = this;
    if (pressure.openCells.length === 0) return;
    const tRef = this.meanTemperature();
    const beta = 1 / (tRef + KELVIN);
    const toSolver = dt / (RHO * h);
    for (const o of pressure.openCells) {
      const k = Math.floor(o / (nx * ny));
      const z = this.origin[2] + (k + 0.5) * h; // height above the floor (floor is z = 0)
      const stack = RHO * G * beta * (this.outdoorTemp - tRef) * z;
      pressure.p[o] = (this.openPressure[o] + stack) * toSolver;
    }
  }

  /** Make the velocity field divergence free on every fluid cell (up to uniform leakage of sealed regions). */
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
    this.setOpenPressure(dt);
    this.lastPressure = pressure.solve(rhs, this.opts.divTol * h, this.opts.pressureMaxIter);
    const p = pressure.p;

    // Sealed regions with unbalanced ports: rhs mean = −(mean flux divergence), i.e. leakage.
    let leakFlow = 0;
    for (let id = 0; id < this.regionLeak.length; id++) {
      this.regionLeak[id] = pressure.compOpen[id] ? 0 : -pressure.regionMean[id] / h;
      leakFlow += this.regionLeak[id] * pressure.compSize[id] * h * h * h;
    }
    if (Math.abs(leakFlow) > LEAK_WARN && !this.leakWarned) {
      this.leakWarned = true;
      solverWarn(
        `sealed room air is unbalanced by ${Math.abs(leakFlow).toFixed(4)} m³/s; treating it as envelope leakage ` +
          (leakFlow > 0 ? 'of outdoor air into the room' : 'out of the room') +
          '. Expected for a single-hose portable AC; otherwise add a matching return vent or open a window to balance it.',
      );
    } else if (Math.abs(leakFlow) < LEAK_WARN / 10) this.leakWarned = false;

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
   * carry no flux, so a sealed adiabatic room conserves heat exactly. Ports
   * bring air in at their temperature and take it out at the cell's; sealed
   * region leakage enters at the outdoor temperature and leaves at the cell's.
   */
  private transportTemperature(dt: number): void {
    const { nx, ny, nz, h, u, v, w, uMask, vMask, wMask, fluid, T, tAcc, opts } = this;
    const nxy = nx * ny;
    const maxU = maxAbsMasked(u, uMask);
    const maxV = maxAbsMasked(v, vMask);
    const maxW = maxAbsMasked(w, wMask);
    const cflSum = ((maxU + maxV + maxW + this.maxPortSpeed()) * dt) / h;
    const diffNum = (opts.alpha * dt) / (h * h);
    const sub = Math.max(1, Math.ceil(cflSum / opts.tempCflMax + diffNum / 0.15));
    const tdt = dt / sub;
    const ka = tdt / h;
    const kd = (opts.alpha * tdt) / (h * h);
    const comp = this.pressure.comp;
    const tOut = this.outdoorTemp;
    const hasLeak = this.regionLeak.some((q) => q !== 0);

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

      for (const p of this.ports) {
        if (!p.enabled || p.flow === 0 || p.area === 0) continue;
        const vin = p.flow / p.area; // inward speed, m/s
        for (let m = 0; m < p.cells.length; m++) {
          const c = p.cells[m];
          tAcc[c] += ka * vin * (vin > 0 ? p.temp : T[c]);
        }
      }

      if (hasLeak) {
        for (let c = 0; c < this.n; c++) {
          if (!fluid[c]) continue;
          const q = this.regionLeak[comp[c]];
          if (q !== 0) tAcc[c] += q * tdt * (q > 0 ? tOut : T[c]);
        }
      }

      for (let c = 0; c < this.n; c++) T[c] = this.open[c] ? tOut : tAcc[c];
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

  private maxPortSpeed(): number {
    let mx = 0;
    for (const p of this.ports) if (p.enabled && p.area > 0) mx = Math.max(mx, Math.abs(p.flow / p.area));
    return mx;
  }

  private maxFanSpeed(): number {
    let mx = 0;
    for (const f of this.fans) if (f.enabled) mx = Math.max(mx, Math.abs(f.speed));
    return mx;
  }

  /** Divergence per cell (1/s), zero outside fluid. Includes leakage of sealed regions. */
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

  /** Divergence with each sealed region's uniform leakage subtracted: the projection error, 1/s. */
  divergenceError(out: Float32Array = new Float32Array(this.n)): Float32Array {
    this.divergence(out);
    const comp = this.pressure.comp;
    for (let c = 0; c < this.n; c++) if (this.fluid[c]) out[c] -= this.regionLeak[comp[c]];
    return out;
  }

  maxDivergence(): number {
    const d = this.divergenceError();
    let mx = 0;
    for (let c = 0; c < this.n; c++) if (this.fluid[c] && Math.abs(d[c]) > mx) mx = Math.abs(d[c]);
    return mx;
  }

  /** Net leakage of all sealed regions, m³/s (positive = outdoor air entering). */
  leakFlow(): number {
    let s = 0;
    const h3 = this.h ** 3;
    for (let id = 0; id < this.regionLeak.length; id++) s += this.regionLeak[id] * this.pressure.compSize[id] * h3;
    return s;
  }

  /** Volumetric flow entering the room through open cells, m³/s (outflow not counted). */
  openInflow(): number {
    let s = 0;
    const a = this.h * this.h;
    for (const o of this.openFaces) {
      const vin = this.velFor(o.axis)[o.face] * o.inward;
      if (vin > 0) s += vin * a;
    }
    return s;
  }

  /** Net volumetric flow into the room through open cells, m³/s (negative = net outflow). */
  openNetInflow(): number {
    let s = 0;
    const a = this.h * this.h;
    for (const o of this.openFaces) s += this.velFor(o.axis)[o.face] * o.inward * a;
    return s;
  }

  /** Physical pressure (Pa) relative to the mean of each sealed region (absolute for open regions). */
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
      leakFlow: this.leakFlow(),
      openInflow: this.openInflow(),
    };
  }

  deviceReport(): DeviceReport {
    return {
      acUnits: this.acUnits.map((ac) => {
        const sup = this.port(ac.supplyPort)!;
        const returnT = this.acState.get(ac.id)?.returnT ?? this.portAirTemp(this.port(ac.returnPort)!);
        const supplyT = ac.enabled ? sup.temp : returnT;
        return {
          id: ac.id,
          enabled: ac.enabled,
          supplyT,
          returnT,
          coolingW: ac.enabled ? RHO * CP * sup.flow * (returnT - supplyT) : 0,
          flow: ac.enabled ? sup.flow : 0,
        };
      }),
      ports: this.ports.map((p) => ({ id: p.id, flow: p.enabled ? p.flow : 0, temp: p.temp })),
      fans: this.fans.map((f) => {
        const d = this.fanDir(f);
        const a0 = Math.atan2(f.dir[0], f.dir[1]);
        const a1 = Math.atan2(d[0], d[1]);
        return {
          id: f.id,
          headingOffsetDeg: ((a1 - a0) * 180) / Math.PI,
          delivered: f.enabled && f.speed ? this.fanDelivered(f) / f.speed : 0,
        };
      }),
    };
  }

  // ---------------------------------------------------------------- live edits

  /**
   * Continue the flow from another solver on the same grid (used when the
   * scene is edited while running). Temperature carries over where the cell is
   * still fluid; new fluid cells start at the old mean. Velocity carries over
   * on faces that are still pressure-solved; the next projection cleans up.
   */
  transferStateFrom(old: FluidSolver): void {
    if (old.nx !== this.nx || old.ny !== this.ny || old.nz !== this.nz) {
      throw new Error('transferStateFrom needs grids of the same size');
    }
    const mean = old.meanTemperature();
    for (let c = 0; c < this.n; c++) {
      if (this.fluid[c]) this.T[c] = old.fluid[c] ? old.T[c] : mean;
    }
    const copy = (dst: Float32Array, src: Float32Array, mask: Uint8Array) => {
      for (let f = 0; f < dst.length; f++) dst[f] = mask[f] ? src[f] : 0;
    };
    copy(this.u, old.u, this.uMask);
    copy(this.v, old.v, this.vMask);
    copy(this.w, old.w, this.wMask);
    this.time = old.time;
    this.steps = old.steps;
    for (const [id, g] of old.fanGain) if (this.fans.some((f) => f.id === id)) this.fanGain.set(id, g);
  }

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
    tf = LL >= 0 && fluid[LL] ? TL + 0.5 * minmod(TR - TL, TL - T[LL]) : TL;
  } else {
    const RR = R + stride;
    tf = RR < T.length && fluid[RR] ? TR - 0.5 * minmod(TR - TL, T[RR] - TR) : TR;
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
  const n = src.length;
  for (let f = 0; f < n; f++) {
    if (!mask[f]) {
      dst[f] = 0;
      continue;
    }
    const c = src[f];
    let lap = (f >= normal ? src[f - normal] : 0) + (f + normal < n ? src[f + normal] : 0) - 2 * c;
    if (f >= t1 && mask[f - t1]) lap += src[f - t1] - c;
    if (f + t1 < n && mask[f + t1]) lap += src[f + t1] - c;
    if (f >= t2 && mask[f - t2]) lap += src[f - t2] - c;
    if (f + t2 < n && mask[f + t2]) lap += src[f + t2] - c;
    dst[f] = c + kd * lap;
  }
}
