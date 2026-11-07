import { solverWarn } from './log';

export interface PressureResult {
  iterations: number;
  /** Max-norm of the final residual (velocity units, m/s). Divergence = residual / h. */
  residual: number;
  converged: boolean;
}

const MIC_TAU = 0.97;
const MIC_SIGMA = 0.25;

/**
 * Pressure Poisson solver on the fluid cells of a MAC grid.
 *
 * Solves A p = b where A is the 7-point negative Laplacian restricted to
 * fluid cells (Neumann at solid faces: a solid neighbor simply drops out of
 * the stencil). p is in velocity units, so the face update is
 * u -= p[R] - p[L].
 *
 * Method: conjugate gradient with a Modified Incomplete Cholesky MIC(0)
 * preconditioner (Bridson, "Fluid Simulation for Computer Graphics"), warm
 * started from the previous solution. Internal vectors are Float64 so the
 * tight divergence tolerance is reachable. Each sealed fluid region is a
 * separate pure-Neumann problem, so the right-hand side is made compatible
 * by removing its mean per connected component.
 */
export class PressureSolver {
  readonly n: number;
  readonly fluidList: Int32Array;
  /** Solution, kept between solves for warm starting. */
  readonly p: Float64Array;

  private readonly nx: number;
  private readonly nxy: number;
  private readonly diag: Float64Array;
  private readonly ax: Float64Array; // coefficient to +x neighbor (-1 or 0)
  private readonly ay: Float64Array;
  private readonly az: Float64Array;
  private readonly precon: Float64Array;
  private readonly r: Float64Array;
  private readonly z: Float64Array;
  private readonly s: Float64Array;
  private readonly q: Float64Array;
  private readonly comp: Int32Array;
  private readonly compSize: Float64Array;
  private readonly compSum: Float64Array;

  constructor(nx: number, ny: number, nz: number, fluid: Uint8Array) {
    const n = nx * ny * nz;
    const nxy = nx * ny;
    this.n = n;
    this.nx = nx;
    this.nxy = nxy;
    this.p = new Float64Array(n);
    this.diag = new Float64Array(n);
    this.ax = new Float64Array(n);
    this.ay = new Float64Array(n);
    this.az = new Float64Array(n);
    this.precon = new Float64Array(n);
    this.r = new Float64Array(n);
    this.z = new Float64Array(n);
    this.s = new Float64Array(n);
    this.q = new Float64Array(n);

    const list: number[] = [];
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = i + nx * (j + ny * k);
          if (!fluid[c]) continue;
          if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) {
            throw new Error(`fluid cell (${i},${j},${k}) touches the grid boundary; wrap the domain in solid cells`);
          }
          list.push(c);
          let d = 0;
          if (fluid[c - 1]) d++;
          if (fluid[c + 1]) d++;
          if (fluid[c - nx]) d++;
          if (fluid[c + nx]) d++;
          if (fluid[c - nxy]) d++;
          if (fluid[c + nxy]) d++;
          this.diag[c] = d;
          if (fluid[c + 1]) this.ax[c] = -1;
          if (fluid[c + nx]) this.ay[c] = -1;
          if (fluid[c + nxy]) this.az[c] = -1;
        }
    this.fluidList = Int32Array.from(list);

    // Connected components of the fluid region (flood fill).
    this.comp = new Int32Array(n).fill(-1);
    const sizes: number[] = [];
    const stack: number[] = [];
    for (const seed of this.fluidList) {
      if (this.comp[seed] !== -1) continue;
      const id = sizes.length;
      let size = 0;
      this.comp[seed] = id;
      stack.push(seed);
      while (stack.length) {
        const c = stack.pop()!;
        size++;
        for (const nb of [c - 1, c + 1, c - nx, c + nx, c - nxy, c + nxy]) {
          if (fluid[nb] && this.comp[nb] === -1) {
            this.comp[nb] = id;
            stack.push(nb);
          }
        }
      }
      sizes.push(size);
    }
    this.compSize = Float64Array.from(sizes);
    this.compSum = new Float64Array(sizes.length);

    this.buildPreconditioner();
  }

  get componentCount(): number {
    return this.compSize.length;
  }

  private buildPreconditioner(): void {
    const { diag, ax, ay, az, precon, nx, nxy } = this;
    for (let m = 0; m < this.fluidList.length; m++) {
      const c = this.fluidList[m];
      if (diag[c] === 0) {
        precon[c] = 0; // isolated cell: nothing to solve
        continue;
      }
      const cx = c - 1;
      const cy = c - nx;
      const cz = c - nxy;
      const px = ax[cx] * precon[cx];
      const py = ay[cy] * precon[cy];
      const pz = az[cz] * precon[cz];
      let e = diag[c] - px * px - py * py - pz * pz;
      e -=
        MIC_TAU *
        (ax[cx] * (ay[cx] + az[cx]) * precon[cx] * precon[cx] +
          ay[cy] * (ax[cy] + az[cy]) * precon[cy] * precon[cy] +
          az[cz] * (ax[cz] + ay[cz]) * precon[cz] * precon[cz]);
      if (e < MIC_SIGMA * diag[c]) e = diag[c];
      precon[c] = 1 / Math.sqrt(e);
    }
  }

  /** out = A x over fluid cells. */
  applyA(x: Float64Array, out: Float64Array): void {
    const { diag, ax, ay, az, nx, nxy, fluidList } = this;
    for (let m = 0; m < fluidList.length; m++) {
      const c = fluidList[m];
      out[c] =
        diag[c] * x[c] +
        ax[c] * x[c + 1] +
        ax[c - 1] * x[c - 1] +
        ay[c] * x[c + nx] +
        ay[c - nx] * x[c - nx] +
        az[c] * x[c + nxy] +
        az[c - nxy] * x[c - nxy];
    }
  }

  private applyPreconditioner(r: Float64Array, z: Float64Array): void {
    const { ax, ay, az, precon, nx, nxy, fluidList, q } = this;
    const nf = fluidList.length;
    for (let m = 0; m < nf; m++) {
      const c = fluidList[m];
      const t =
        r[c] -
        ax[c - 1] * precon[c - 1] * q[c - 1] -
        ay[c - nx] * precon[c - nx] * q[c - nx] -
        az[c - nxy] * precon[c - nxy] * q[c - nxy];
      q[c] = t * precon[c];
    }
    for (let m = nf - 1; m >= 0; m--) {
      const c = fluidList[m];
      const t =
        q[c] - ax[c] * precon[c] * z[c + 1] - ay[c] * precon[c] * z[c + nx] - az[c] * precon[c] * z[c + nxy];
      z[c] = t * precon[c];
    }
  }

  /** Subtract the per-component mean over fluid cells. */
  removeMean(x: Float64Array): void {
    const { comp, compSize, compSum, fluidList } = this;
    compSum.fill(0);
    for (let m = 0; m < fluidList.length; m++) {
      const c = fluidList[m];
      compSum[comp[c]] += x[c];
    }
    for (let m = 0; m < fluidList.length; m++) {
      const c = fluidList[m];
      const id = comp[c];
      x[c] -= compSum[id] / compSize[id];
    }
  }

  private dot(a: Float64Array, b: Float64Array): number {
    const { fluidList } = this;
    let s = 0;
    for (let m = 0; m < fluidList.length; m++) {
      const c = fluidList[m];
      s += a[c] * b[c];
    }
    return s;
  }

  private maxAbs(a: Float64Array): number {
    const { fluidList } = this;
    let mx = 0;
    for (let m = 0; m < fluidList.length; m++) {
      const v = Math.abs(a[fluidList[m]]);
      if (v > mx) mx = v;
    }
    return mx;
  }

  /** Scale the warm-start guess (p scales with dt, so a dt change rescales it). */
  scaleSolution(factor: number): void {
    const { p, fluidList } = this;
    for (let m = 0; m < fluidList.length; m++) p[fluidList[m]] *= factor;
  }

  /**
   * Solve A p = b in place (b is modified: its component means are removed).
   * Converges when the max-norm residual is <= tol.
   */
  solve(b: Float64Array, tol: number, maxIter: number): PressureResult {
    const { p, r, z, s, q, fluidList } = this;
    const nf = fluidList.length;
    this.removeMean(b);

    this.applyA(p, q);
    for (let m = 0; m < nf; m++) {
      const c = fluidList[m];
      r[c] = b[c] - q[c];
    }
    let res = this.maxAbs(r);
    if (res <= tol) return { iterations: 0, residual: res, converged: true };

    this.applyPreconditioner(r, z);
    for (let m = 0; m < nf; m++) s[fluidList[m]] = z[fluidList[m]];
    let sigma = this.dot(z, r);

    for (let it = 1; it <= maxIter; it++) {
      this.applyA(s, q);
      const denom = this.dot(s, q);
      if (!(denom > 0)) {
        solverWarn(`pressure CG breakdown at iteration ${it} (s·As = ${denom}); residual ${res.toExponential(2)}`);
        return { iterations: it, residual: res, converged: false };
      }
      const alpha = sigma / denom;
      for (let m = 0; m < nf; m++) {
        const c = fluidList[m];
        p[c] += alpha * s[c];
        r[c] -= alpha * q[c];
      }
      res = this.maxAbs(r);
      if (res <= tol) {
        this.removeMean(p);
        return { iterations: it, residual: res, converged: true };
      }
      this.applyPreconditioner(r, z);
      const sigmaNew = this.dot(z, r);
      const beta = sigmaNew / sigma;
      sigma = sigmaNew;
      for (let m = 0; m < nf; m++) {
        const c = fluidList[m];
        s[c] = z[c] + beta * s[c];
      }
    }
    this.removeMean(p);
    solverWarn(`pressure solve did not converge in ${maxIter} iterations (residual ${res.toExponential(2)} > ${tol.toExponential(2)})`);
    return { iterations: maxIter, residual: res, converged: false };
  }
}
