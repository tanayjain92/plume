import { describe, expect, it } from 'vitest';
import { CFM_TO_M3S } from '../src/scene/geometry';
import { maxWallFaceVelocity } from './helpers';
import { build, flowX, roomScene, run, window } from './sceneHelpers';

// Phase 2: open windows are fixed-pressure boundaries (wind + stack effect),
// vents are prescribed-velocity faces. Mass must still balance exactly.
describe('open windows and vents', () => {
  it('air pushed in by a supply vent leaves through an open window, divergence-free', () => {
    const { solver } = build(
      roomScene({
        openings: [window('w', 1, 1.0, 1.0, 0.9, 1.2)],
        devices: [{ id: 'sup', type: 'supply_vent', pos: [1, 1.5, 2.4], size: [0.3, 0.3], airflowCfm: 150, supplyTemp: 25, direction: [0, 0, -1], enabled: true }],
      }),
    );
    run(solver, 40);
    const supply = 150 * CFM_TO_M3S;
    expect(solver.maxDivergence()).toBeLessThan(1e-4);
    expect(Math.abs(solver.leakFlow())).toBeLessThan(1e-9); // the window region is open, so no leakage
    expect(solver.openNetInflow()).toBeCloseTo(-supply, 6); // everything supplied leaves by the window
    expect(maxWallFaceVelocity(solver)).toBe(0);
  });

  it('wind from the west drives cross-ventilation from the west window to the east window', () => {
    const { solver } = build(
      roomScene({
        windSpeed: 3,
        windFrom: 270,
        openings: [window('west', 3, 1.0, 1.0, 0.9, 1.2), window('east', 1, 1.0, 1.0, 0.9, 1.2)],
      }),
    );
    run(solver, 60);
    const inWest = flowX(solver, 1); // u faces between the west wall column and the room
    const outEast = flowX(solver, solver.nx - 1);
    expect(inWest).toBeGreaterThan(0.05);
    expect(outEast).toBeCloseTo(inWest, 6);
    expect(solver.maxDivergence()).toBeLessThan(1e-4);
  });

  it('stack effect: cold outdoor air enters low and warm room air leaves high through one tall window', () => {
    const { solver } = build(
      roomScene({ temp: 25, outdoorTemp: 10, openings: [window('tall', 1, 1.0, 0.8, 0.2, 2.0)] }),
    );
    run(solver, 60);
    const i = solver.nx - 1; // east wall: +x is outward
    const low = flowX(solver, i, 0.2, 1.2);
    const high = flowX(solver, i, 1.2, 2.2);
    expect(low).toBeLessThan(-0.005); // flowing in (−x)
    expect(high).toBeGreaterThan(0.005); // flowing out (+x)
    expect(solver.stats().floorT).toBeLessThan(25);
  });

  it('an unbalanced supply in a sealed room is reported and handled as envelope leakage', () => {
    const { solver, log } = build(
      roomScene({
        devices: [{ id: 'sup', type: 'supply_vent', pos: [1.5, 1.5, 2.4], size: [0.3, 0.3], airflowCfm: 100, supplyTemp: 15, direction: [0, 0, -1], enabled: true }],
      }),
    );
    const t0 = solver.meanTemperature();
    run(solver, 40);
    expect(log.some((m) => m.includes('unbalanced'))).toBe(true);
    expect(solver.leakFlow()).toBeCloseTo(-100 * CFM_TO_M3S, 6); // the supply leaks back out
    expect(solver.maxDivergence()).toBeLessThan(1e-4); // after the leakage term
    expect(solver.meanTemperature()).toBeLessThan(t0); // 15°C air replaces 25°C air
  });

  it('a balanced supply and return leave no leakage', () => {
    const { solver, log } = build(
      roomScene({
        devices: [
          { id: 'sup', type: 'supply_vent', pos: [0.6, 1.5, 2.4], size: [0.3, 0.3], airflowCfm: 120, supplyTemp: 16, direction: [0, 0, -1], enabled: true },
          { id: 'ret', type: 'return_vent', pos: [3, 1.5, 0.3], size: [0.4, 0.3], airflowCfm: 120, enabled: true },
        ],
      }),
    );
    run(solver, 40);
    expect(Math.abs(solver.leakFlow())).toBeLessThan(1e-9);
    expect(log.some((m) => m.includes('unbalanced'))).toBe(false);
    expect(solver.maxDivergence()).toBeLessThan(1e-4);
    expect(maxWallFaceVelocity(solver)).toBe(0);
  });
});
