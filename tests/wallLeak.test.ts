import { describe, expect, it } from 'vitest';
import { addMomentumBox, addSolidBox, createBoxScene, FluidSolver } from '../src/solver';
import { maxWallFaceVelocity } from './helpers';

// SPEC validation: "Wall leak check — fans running inside a sealed room —
// total air mass stays constant and no velocity crosses solid cells".
describe('wall leak check', () => {
  it('fans blowing at walls and furniture never push air through solids', () => {
    const scene = createBoxScene({ size: [3, 2.4, 2.4], h: 0.1, temp: 25 });
    addSolidBox(scene, [5, 5, 1], [14, 12, 6]); // bed
    addSolidBox(scene, [21, 1, 1], [29, 6, 8]); // desk against a wall
    // a fan blowing straight into the bed, and one blowing into the +x wall
    addMomentumBox(scene, 'fanA', [16, 8, 3], [18, 10, 6], [-3, 0, 0]);
    addMomentumBox(scene, 'fanB', [24, 15, 10], [26, 18, 13], [4, 0, 1]);
    const solver = new FluidSolver(scene);

    const cellVolume = solver.h ** 3;
    let maxNetVolumeRate = 0;
    let worstWall = 0;
    for (let s = 0; s < 80; s++) {
      solver.step();
      worstWall = Math.max(worstWall, maxWallFaceVelocity(solver));
      // Net volume (= mass, ρ constant) created per second across all fluid cells.
      const div = solver.divergence();
      let net = 0;
      for (let c = 0; c < solver.n; c++) if (solver.fluid[c]) net += div[c] * cellVolume;
      maxNetVolumeRate = Math.max(maxNetVolumeRate, Math.abs(net));
    }

    expect(solver.maxFaceSpeed()).toBeGreaterThan(0.2); // fans really move air
    expect(worstWall).toBe(0);
    expect(maxNetVolumeRate).toBeLessThan(1e-9);
    expect(solver.maxDivergence()).toBeLessThan(1e-4);
  });
});
