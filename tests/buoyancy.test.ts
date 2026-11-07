import { describe, expect, it } from 'vitest';
import { addHeatBox, createBoxScene, FluidSolver } from '../src/solver';

// SPEC validation: "Buoyancy direction — hot patch on the floor, then cold
// inlet at the ceiling — plume rises in the first case, cold air falls in the
// second". Phase 1 has no inlets yet, so the cold case uses a heat sink
// (negative watts) at the ceiling; phase 2 adds the true cold-inlet case.

/** Mean w over the faces of a vertical column of cells [i0,i1) x [j0,j1) at face level k. */
function meanW(solver: FluidSolver, i0: number, i1: number, j0: number, j1: number, k: number): number {
  const { nx, ny } = solver;
  let s = 0;
  let n = 0;
  for (let j = j0; j < j1; j++)
    for (let i = i0; i < i1; i++) {
      s += solver.w[i + nx * (j + ny * k)];
      n++;
    }
  return s / n;
}

describe('buoyancy direction', () => {
  it('a hot floor patch makes a rising plume', () => {
    const scene = createBoxScene({ size: [2, 2, 2], h: 0.1, temp: 25 });
    addHeatBox(scene, 'hot', [9, 9, 1], [13, 13, 2], 300);
    const solver = new FluidSolver(scene);
    for (let s = 0; s < 60; s++) solver.step();
    expect(meanW(solver, 9, 13, 9, 13, 6)).toBeGreaterThan(0.01);
  });

  it('a cold ceiling patch makes air fall', () => {
    const scene = createBoxScene({ size: [2, 2, 2], h: 0.1, temp: 25 });
    const top = scene.nz - 2;
    addHeatBox(scene, 'cold', [9, 9, top], [13, 13, top + 1], -300);
    const solver = new FluidSolver(scene);
    for (let s = 0; s < 60; s++) solver.step();
    expect(meanW(solver, 9, 13, 9, 13, top - 5)).toBeLessThan(-0.01);
  });

  // SPEC phase 1 "done when": a heated floor patch makes a plume that rises
  // and spreads along the ceiling.
  it('the plume reaches the ceiling, spreads outward along it, and stratifies the room', () => {
    const scene = createBoxScene({ size: [2.4, 2.4, 2.4], h: 0.1, temp: 25 });
    addHeatBox(scene, 'hot', [11, 11, 1], [15, 15, 2], 300);
    const solver = new FluidSolver(scene);
    for (let s = 0; s < 400; s++) solver.step(); // 20 s
    const { nx, ny, nz } = solver;
    const kTop = nz - 3; // one cell below the ceiling layer
    const mid = nx / 2; // plume axis at x = 13 cells (cell-face 13 is the center)

    // Under the ceiling, horizontal flow points away from the plume axis.
    const [ux, uy] = solver.cellVelocity();
    let outward = 0;
    let count = 0;
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const dx = i + 0.5 - mid;
        const dy = j + 0.5 - mid;
        const r = Math.hypot(dx, dy);
        if (r < 3 || r > 9) continue;
        const c = i + nx * (j + ny * kTop);
        outward += (ux[c] * dx + uy[c] * dy) / r;
        count++;
      }
    expect(outward / count).toBeGreaterThan(0.02);

    // Warm air collects at the top.
    const s = solver.stats();
    expect(s.ceilingT - s.floorT).toBeGreaterThan(0.2);
  });
});
