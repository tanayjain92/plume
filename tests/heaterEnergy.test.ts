import { describe, expect, it } from 'vitest';
import { addHeatBox, CP, createBoxScene, FluidSolver, RHO } from '../src/solver';

// SPEC validation: "Heater energy balance — sealed adiabatic 4 x 4 x 2.7 m box
// with a 100 W heater — mean temp rises about 6.9°C per hour (100 W / ρ·cp·V),
// within 2%".
describe('heater energy balance', () => {
  it('a 100 W heater warms a sealed 4 x 4 x 2.7 m room at 100 W / (ρ·cp·V)', () => {
    const scene = createBoxScene({ size: [4, 4, 2.7], h: 0.1, temp: 24 });
    // 0.4 x 0.4 x 0.3 m heater on the floor in the middle of the room
    addHeatBox(scene, 'heater', [19, 19, 1], [23, 23, 4], 100);
    const solver = new FluidSolver(scene);

    const volume = 4 * 4 * 2.7;
    const expectedPerHour = (100 / (RHO * CP * volume)) * 3600;
    expect(expectedPerHour).toBeCloseTo(6.9, 1);

    const t0 = solver.meanTemperature();
    const steps = 200; // 10 s of room time; the plume is well developed and moving
    for (let s = 0; s < steps; s++) solver.step();
    const t1 = solver.meanTemperature();

    expect(solver.maxFaceSpeed()).toBeGreaterThan(0.05);
    const measuredPerHour = ((t1 - t0) / solver.time) * 3600;
    expect(Math.abs(measuredPerHour - expectedPerHour) / expectedPerHour).toBeLessThan(0.02);
  });
});
