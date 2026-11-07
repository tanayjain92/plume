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
 * Returns the largest |velocity| on any face that touches a solid cell (or the
 * domain boundary), excluding faces that belong to a flow port (vents, AC
 * grilles). Must be exactly 0 for a leak-free solver.
 */
export function maxWallFaceVelocity(solver: FluidSolver): number {
  const { nx, ny, nz, u, v, w, fluid, open } = solver;
  const nxy = nx * ny;
  const portFaces = [new Set<number>(), new Set<number>(), new Set<number>()];
  for (const p of solver.ports) for (let m = 0; m < p.faces.length; m++) portFaces[p.axes[m]].add(p.faces[m]);
  let mx = 0;
  let axis = 0;
  let face = 0;
  const check = (val: number, a: number, b: number) => {
    const ok = (c: number) => c >= 0 && c < fluid.length && (fluid[c] === 1 || open[c] === 1);
    const passable = ok(a) && ok(b) && (fluid[a] === 1 || fluid[b] === 1);
    if (!passable && !portFaces[axis].has(face)) mx = Math.max(mx, Math.abs(val));
  };
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i <= nx; i++) {
        const c = i + nx * (j + ny * k);
        axis = 0;
        face = i + (nx + 1) * (j + ny * k);
        check(u[face], i > 0 ? c - 1 : -1, i < nx ? c : -1);
      }
  for (let k = 0; k < nz; k++)
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = i + nx * (j + ny * k);
        axis = 1;
        face = i + nx * (j + (ny + 1) * k);
        check(v[face], j > 0 ? c - nx : -1, j < ny ? c : -1);
      }
  for (let k = 0; k <= nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = i + nx * (j + ny * k);
        axis = 2;
        face = c;
        check(w[c], k > 0 ? c - nxy : -1, k < nz ? c : -1);
      }
  return mx;
}
