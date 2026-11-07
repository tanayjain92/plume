import { describe, expect, it } from 'vitest';
import { addHeatBox, addSolidBox, createBoxScene, FluidSolver } from '../src/solver';
import { maxWallFaceVelocity, randomizeVelocity } from './helpers';

// SPEC validation: "Mass conservation — any scene, after projection — max cell
// divergence below a small tolerance, for example 1e-4 1/s".
const DIV_TOL = 1e-4;

describe('mass conservation', () => {
  it('projects a random velocity field in an empty box to divergence-free', () => {
    const scene = createBoxScene({ size: [2, 2, 2], h: 0.1, temp: 25 });
    const solver = new FluidSolver(scene, { buoyancy: false });
    randomizeVelocity(solver, 1.0, 7);
    expect(solver.maxDivergence()).toBeGreaterThan(1); // starts very divergent
    solver.step();
    expect(solver.lastPressure.converged).toBe(true);
    expect(solver.maxDivergence()).toBeLessThan(DIV_TOL);
    expect(maxWallFaceVelocity(solver)).toBe(0);
  });

  it('handles interior obstacles and two sealed rooms separated by a wall', () => {
    const scene = createBoxScene({ size: [3, 2, 2.4], h: 0.1, temp: 25 });
    // full-height wall at x = 1.5 m splits the box into two sealed regions
    addSolidBox(scene, [16, 0, 0], [17, scene.ny, scene.nz]);
    // a "bed" and a "desk"
    addSolidBox(scene, [3, 3, 1], [12, 12, 6]);
    addSolidBox(scene, [20, 5, 1], [26, 9, 8]);
    const solver = new FluidSolver(scene, { buoyancy: false });
    randomizeVelocity(solver, 1.0, 11);
    solver.step();
    expect(solver.lastPressure.converged).toBe(true);
    expect(solver.maxDivergence()).toBeLessThan(DIV_TOL);
    expect(maxWallFaceVelocity(solver)).toBe(0);
  });

  it('stays divergence-free every step of a buoyant plume', () => {
    const scene = createBoxScene({ size: [2, 2, 2], h: 0.1, temp: 25 });
    addHeatBox(scene, 'patch', [8, 8, 1], [14, 14, 2], 300);
    const solver = new FluidSolver(scene);
    let worst = 0;
    for (let s = 0; s < 60; s++) {
      solver.step();
      worst = Math.max(worst, solver.maxDivergence());
    }
    expect(solver.maxFaceSpeed()).toBeGreaterThan(0.01); // the plume actually moves
    expect(worst).toBeLessThan(DIV_TOL);
  });
});
