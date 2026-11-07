import { describe, expect, it } from 'vitest';
import { addHeatBox, createBoxScene, FluidSolver, type VoxelScene } from '../src/solver';

function symmetricScene(): VoxelScene {
  // 2 x 2 x 2 m box; 20 interior cells per side, heater centered over cells 8..11.
  const scene = createBoxScene({ size: [2, 2, 2], h: 0.1, temp: 25 });
  addHeatBox(scene, 'hot', [9, 9, 1], [13, 13, 2], 300);
  return scene;
}

// SPEC validation: "Symmetry — mirror-symmetric room and devices — fields stay
// symmetric within float error".
describe('symmetry', () => {
  it('a centered plume stays mirror-symmetric in x and y', () => {
    const solver = new FluidSolver(symmetricScene());
    for (let s = 0; s < 100; s++) solver.step();
    const { nx, ny, nz, T } = solver;
    const [ux, uy, uz] = solver.cellVelocity();

    let tErr = 0;
    let vErr = 0;
    let maxT = 0;
    let maxV = 0;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const c = i + nx * (j + ny * k);
          const mx = nx - 1 - i + nx * (j + ny * k); // mirror in x
          const my = i + nx * (ny - 1 - j + ny * k); // mirror in y
          maxT = Math.max(maxT, Math.abs(T[c] - 25));
          maxV = Math.max(maxV, Math.abs(uz[c]));
          tErr = Math.max(tErr, Math.abs(T[c] - T[mx]), Math.abs(T[c] - T[my]));
          vErr = Math.max(
            vErr,
            Math.abs(ux[c] + ux[mx]), // x-velocity flips sign under x-mirror
            Math.abs(uy[c] - uy[mx]),
            Math.abs(uz[c] - uz[mx]),
            Math.abs(uy[c] + uy[my]),
            Math.abs(ux[c] - ux[my]),
            Math.abs(uz[c] - uz[my]),
          );
        }
    expect(maxT).toBeGreaterThan(1); // something actually happened
    expect(maxV).toBeGreaterThan(0.05);
    // Float32 storage + an iterative pressure solve (tolerance 1e-5 1/s) bound
    // the asymmetry; these are ~1e-5 relative to the field magnitudes.
    expect(tErr / maxT).toBeLessThan(1e-4);
    expect(vErr / maxV).toBeLessThan(1e-4);
  });
});

// SPEC validation: "Determinism — same scene run twice — identical output with
// a fixed timestep".
describe('determinism', () => {
  it('two runs of the same scene are bit-identical', () => {
    const a = new FluidSolver(symmetricScene());
    const b = new FluidSolver(symmetricScene());
    for (let s = 0; s < 40; s++) {
      a.step();
      b.step();
    }
    expect(Buffer.from(a.T.buffer).equals(Buffer.from(b.T.buffer))).toBe(true);
    expect(Buffer.from(a.u.buffer).equals(Buffer.from(b.u.buffer))).toBe(true);
    expect(Buffer.from(a.v.buffer).equals(Buffer.from(b.v.buffer))).toBe(true);
    expect(Buffer.from(a.w.buffer).equals(Buffer.from(b.w.buffer))).toBe(true);
  });
});
