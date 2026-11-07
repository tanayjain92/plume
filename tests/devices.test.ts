import { describe, expect, it } from 'vitest';
import { CFM_TO_M3S } from '../src/scene/geometry';
import { CP, RHO } from '../src/solver';
import { maxWallFaceVelocity } from './helpers';
import { boxMean, build, roomScene, run, window } from './sceneHelpers';

const toF = (dc: number) => (dc * 9) / 5;

describe('fans', () => {
  it('a box fan moves air along its heading without adding or removing any', () => {
    const { solver } = build(
      roomScene({ devices: [{ id: 'fan', type: 'box_fan', pos: [0.8, 1.5, 0], heading: 90, diameter: 0.5, airflowCfm: 1000, enabled: true }] }),
    );
    run(solver, 60);
    const [ux] = solver.cellVelocity();
    // 0.3–0.9 m downstream of the fan, around hub height (0.3 m)
    expect(boxMean(solver, ux, [1.1, 1.3, 0.1], [1.7, 1.7, 0.5])).toBeGreaterThan(0.3);
    expect(solver.leakFlow()).toBe(0);
    expect(maxWallFaceVelocity(solver)).toBe(0);
    expect(solver.maxDivergence()).toBeLessThan(1e-4);
  });

  it('a ceiling fan blows down, and up when reversed', () => {
    const mk = (reverse: boolean) =>
      build(roomScene({ devices: [{ id: 'cf', type: 'ceiling_fan', pos: [1.5, 1.5, 2.2], diameter: 1.2, airflowCfm: 3000, reverse, enabled: true }] })).solver;
    const down = mk(false);
    const up = mk(true);
    run(down, 60);
    run(up, 60);
    const wDown = boxMean(down, down.cellVelocity()[2], [1.2, 1.2, 1.2], [1.8, 1.8, 1.9]);
    const wUp = boxMean(up, up.cellVelocity()[2], [1.2, 1.2, 1.2], [1.8, 1.8, 1.9]);
    expect(wDown).toBeLessThan(-0.2);
    expect(wUp).toBeGreaterThan(0.2);
  });

  it('every fan type delivers its rated airflow once its controller settles', () => {
    const fans = [
      { id: 'box', type: 'box_fan', pos: [0.8, 1.5, 0], heading: 90, diameter: 0.5, airflowCfm: 1000, enabled: true },
      { id: 'ceiling', type: 'ceiling_fan', pos: [1.5, 1.5, 2.2], diameter: 1.2, airflowCfm: 3000, reverse: false, enabled: true },
      { id: 'tower', type: 'tower_fan', pos: [1.5, 0.4, 0], heading: 0, slotHeight: 0.8, airflowCfm: 300, oscillateDeg: 70, periodSec: 8, enabled: true },
    ] as const;
    for (const dev of fans) {
      const { solver, log } = build(roomScene({ devices: [dev as never] }));
      run(solver, 200); // 10 s
      expect(Math.abs(solver.deviceReport().fans[0].delivered - 1), dev.id).toBeLessThan(0.05);
      expect(log, dev.id).toEqual([]);
    }
  });

  it('a tower fan sweeps its jet side to side', () => {
    const { solver } = build(
      roomScene({
        devices: [
          { id: 'tf', type: 'tower_fan', pos: [1.5, 0.4, 0], heading: 0, slotHeight: 0.8, airflowCfm: 300, oscillateDeg: 90, periodSec: 8, enabled: true },
        ],
      }),
    );
    // Just in front of the fan. The jet trails the louvers by ~1 s (air takes time to travel),
    // so sample 1 s after each extreme of the sweep.
    const region = [[1.2, 0.5, 0.2], [1.8, 0.9, 0.9]];
    run(solver, 60); // t = 3 s: louvers swinging back from +45° (toward +x)
    expect(solver.deviceReport().fans[0].headingOffsetDeg).toBeGreaterThan(25);
    const uxRight = boxMean(solver, solver.cellVelocity()[0], region[0], region[1]);
    run(solver, 80); // t = 7 s: swinging back from −45° (toward −x)
    expect(solver.deviceReport().fans[0].headingOffsetDeg).toBeLessThan(-25);
    const uxLeft = boxMean(solver, solver.cellVelocity()[0], region[0], region[1]);
    expect(uxRight).toBeGreaterThan(0.05);
    expect(uxLeft).toBeLessThan(-0.05);
  });
});

// SPEC validation: "Buoyancy direction — cold inlet at the ceiling — cold air falls".
describe('cold inlet', () => {
  it('cold air from a high wall inlet sinks and pools on the floor', () => {
    const { solver } = build(
      roomScene({
        devices: [
          { id: 'sup', type: 'supply_vent', pos: [0, 1.5, 2.2], size: [0.4, 0.2], airflowCfm: 60, supplyTemp: 14, direction: [1, 0, 0], enabled: true },
          { id: 'ret', type: 'return_vent', pos: [3, 1.5, 2.2], size: [0.4, 0.2], airflowCfm: 60, enabled: true },
        ],
      }),
    );
    run(solver, 400); // 20 s: cold air needs ~15 s to reach and spread over the floor
    const s = solver.stats();
    expect(s.floorT).toBeLessThan(s.ceilingT - 0.3);
    // in front of the inlet the jet is heading downward
    expect(boxMean(solver, solver.cellVelocity()[2], [0.2, 1.2, 1.0], [1.0, 1.8, 2.0])).toBeLessThan(0);
  });
});

describe('air conditioners', () => {
  // SPEC validation: "AC sizing — 8,000 BTU/h window AC at 220 CFM, SHR 0.7 —
  // supply to return difference settles near 24°F".
  it('window AC: 8,000 BTU/h at 220 CFM and SHR 0.7 runs about 24°F colder than its return air', () => {
    const { solver, warnings } = build(
      roomScene({
        w: 4,
        d: 3.6,
        height: 2.7,
        temp: 28,
        openings: [window('win1', 0, 1.2, 1.0, 0.9, 1.2, 'closed')],
        devices: [{ id: 'ac', type: 'window_ac', mountedIn: 'win1', capacityBtuh: 8000, airflowCfm: 220, shr: 0.7, setpoint: 22, enabled: true }],
      }),
    );
    expect(warnings.some((w) => w.includes('ignored'))).toBe(false);
    run(solver, 100);
    const ac = solver.deviceReport().acUnits[0];
    const expectedF = (8000 * 0.7) / (1.08 * 220); // 23.6°F from SPEC's sensible heat formula
    expect(Math.abs(toF(ac.returnT - ac.supplyT) - expectedF)).toBeLessThan(0.5);
    expect(Math.abs(toF(ac.returnT - ac.supplyT) - 24)).toBeLessThan(1);
    expect(Math.abs(solver.leakFlow())).toBeLessThan(1e-9); // supply and return balance
  });

  it('window AC removes exactly its sensible capacity from a sealed room', () => {
    const { solver } = build(
      roomScene({
        temp: 28,
        openings: [window('win1', 0, 1.0, 1.0, 0.9, 1.2, 'closed')],
        devices: [{ id: 'ac', type: 'window_ac', mountedIn: 'win1', capacityBtuh: 8000, airflowCfm: 220, shr: 0.7, setpoint: 22, enabled: true }],
      }),
    );
    const t0 = solver.meanTemperature();
    run(solver, 100);
    const fluidVolume = solver.stats().fluidCells * solver.h ** 3;
    const removedW = ((t0 - solver.meanTemperature()) * RHO * CP * fluidVolume) / solver.time;
    const sensibleW = 8000 * 0.7 * 0.29307107;
    expect(Math.abs(removedW - sensibleW) / sensibleW).toBeLessThan(0.02);
  });

  it('portable AC exhaust depressurizes the room so outdoor air leaks in', () => {
    const { solver, log } = build(
      roomScene({
        outdoorTemp: 32,
        devices: [
          { id: 'pac', type: 'portable_ac', pos: [1.5, 0.6, 0], heading: 0, capacityBtuh: 8000, airflowCfm: 200, exhaustCfm: 80, shr: 0.7, setpoint: 22, enabled: true },
        ],
      }),
    );
    run(solver, 40);
    expect(solver.leakFlow()).toBeCloseTo(80 * CFM_TO_M3S, 6);
    expect(log.some((m) => m.includes('into the room'))).toBe(true);
    const ac = solver.deviceReport().acUnits[0];
    expect(ac.coolingW).toBeGreaterThan(1000);
    expect(solver.maxDivergence()).toBeLessThan(1e-4);
  });

  it('mini split blows cold air out of its head and cools the room', () => {
    const { solver, warnings } = build(
      roomScene({
        devices: [
          { id: 'ms', type: 'mini_split', pos: [1.5, 0.15, 2.0], heading: 0, capacityBtuh: 9000, airflowCfm: 300, louverDeg: 30, setpoint: 22, enabled: true },
        ],
      }),
    );
    expect(warnings.some((w) => w.includes('ignored'))).toBe(false);
    const t0 = solver.meanTemperature();
    run(solver, 60);
    const ac = solver.deviceReport().acUnits[0];
    expect(ac.supplyT).toBeLessThan(ac.returnT - 5);
    expect(solver.meanTemperature()).toBeLessThan(t0);
    expect(Math.abs(solver.leakFlow())).toBeLessThan(1e-9);
    expect(maxWallFaceVelocity(solver)).toBe(0);
  });

  it('switching an AC off stops its airflow', () => {
    const { solver } = build(
      roomScene({
        openings: [window('win1', 0, 1.0, 1.0, 0.9, 1.2, 'closed')],
        devices: [{ id: 'ac', type: 'window_ac', mountedIn: 'win1', capacityBtuh: 8000, airflowCfm: 220, shr: 0.7, setpoint: 22, enabled: false }],
      }),
    );
    run(solver, 20);
    expect(solver.deviceReport().acUnits[0].coolingW).toBe(0);
    expect(solver.maxFaceSpeed()).toBeLessThan(1e-6);
  });
});

describe('live edits and determinism with devices', () => {
  it('transferring state to a re-voxelized scene keeps the temperature field', () => {
    const scene = roomScene({
      devices: [{ id: 'heater', type: 'heat_source', pos: [1.5, 1.5, 0], size: [0.4, 0.4, 0.2], watts: 500, enabled: true }],
    });
    const a = build(scene).solver;
    run(a, 30);
    const b = build({ ...scene, devices: [...scene.devices, { id: 'fan', type: 'box_fan', pos: [0.5, 0.5, 0], heading: 45, diameter: 0.4, airflowCfm: 600, enabled: true }] }).solver;
    b.transferStateFrom(a);
    expect(b.time).toBe(a.time);
    expect(b.meanTemperature()).toBeCloseTo(a.meanTemperature(), 5);
    b.step();
    expect(b.maxDivergence()).toBeLessThan(1e-4);
  });

  it('a scene with an oscillating fan and an AC is bit-for-bit deterministic', () => {
    const scene = roomScene({
      openings: [window('win1', 0, 1.0, 1.0, 0.9, 1.2, 'closed')],
      devices: [
        { id: 'ac', type: 'window_ac', mountedIn: 'win1', capacityBtuh: 8000, airflowCfm: 220, shr: 0.7, setpoint: 22, enabled: true },
        { id: 'tf', type: 'tower_fan', pos: [2.5, 2.5, 0], heading: 225, slotHeight: 0.8, airflowCfm: 300, oscillateDeg: 70, periodSec: 6, enabled: true },
      ],
    });
    const a = build(scene).solver;
    const b = build(scene).solver;
    run(a, 30);
    run(b, 30);
    expect(Buffer.from(a.T.buffer).equals(Buffer.from(b.T.buffer))).toBe(true);
    expect(Buffer.from(a.u.buffer).equals(Buffer.from(b.u.buffer))).toBe(true);
  });
});
