import type { FluidSolver } from '../src/solver';

/** Small deterministic PRNG (mulberry32) for reproducible test fields. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fill every active face with a random velocity in [-amp, amp]. */
export function randomizeVelocity(solver: FluidSolver, amp: number, seed = 1): void {
  const r = rng(seed);
  const fill = (a: Float32Array, mask: Uint8Array) => {
    for (let f = 0; f < a.length; f++) a[f] = mask[f] ? (2 * r() - 1) * amp : 0;
  };
  fill(solver.u, solver.uMask);
  fill(solver.v, solver.vMask);
  fill(solver.w, solver.wMask);
}

/**
 * Returns the largest |velocity| on any face that touches a non-fluid cell
 * (or the domain boundary). Must be exactly 0 for a leak-free solver.
 */
export function maxWallFaceVelocity(solver: FluidSolver): number {
  const { nx, ny, nz, u, v, w, fluid } = solver;
  const nxy = nx * ny;
  let mx = 0;
  const check = (val: number, a: number, b: number) => {
    const aFluid = a >= 0 && a < fluid.length && fluid[a] === 1;
    const bFluid = b >= 0 && b < fluid.length && fluid[b] === 1;
    if (!(aFluid && bFluid)) mx = Math.max(mx, Math.abs(val));
  };
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i <= nx; i++) {
        const c = i + nx * (j + ny * k);
        check(u[i + (nx + 1) * (j + ny * k)], i > 0 ? c - 1 : -1, i < nx ? c : -1);
      }
  for (let k = 0; k < nz; k++)
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = i + nx * (j + ny * k);
        check(v[i + nx * (j + (ny + 1) * k)], j > 0 ? c - nx : -1, j < ny ? c : -1);
      }
  for (let k = 0; k <= nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = i + nx * (j + ny * k);
        check(w[c], k > 0 ? c - nxy : -1, k < nz ? c : -1);
      }
  return mx;
}
