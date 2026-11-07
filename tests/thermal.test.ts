import { describe, expect, it } from 'vitest';
import { FT, newSpace, placeTool, rectOutline } from '../src/scene/defaults';
import { dragHandle, handlesFor, sunlightId } from '../src/scene/editing';
import { FAN_MOTOR_W, predictRoom } from '../src/scene/predict';
import { sunPatches } from '../src/scene/solar';
import type { Device, SceneV1 } from '../src/scene/types';
import { voxelize } from '../src/scene/voxelize';
import { CP, FluidSolver, RHO } from '../src/solver';
import { build, roomScene, run, window } from './sceneHelpers';

const sum = (a?: Float32Array) => (a ? a.reduce((s, v) => s + v, 0) : 0);

describe('envelope: walls, glass and air leaks', () => {
  it('wall and glass conductance add up to U x area', () => {
    const base = roomScene({ openings: [window('w', 0, 1.0, 1.0, 0.9, 1.2, 'closed')] }); // 3 x 3 x 2.4 m
    const { voxels } = voxelize({ ...base, envelope: { wallU: 0.5, ach: 0 } });
    expect(sum(voxels.wallUA)).toBeCloseTo(0.5 * (4 * 3 * 2.4 - 1.2), 4);
    expect(sum(voxels.glassUA)).toBeCloseTo(2.8 * 1.2, 4);
    // only the south wall faces outdoors
    const one = voxelize({ ...base, envelope: { wallU: 0.5, ach: 0, exteriorEdges: [0] } }).voxels;
    expect(sum(one.wallUA)).toBeCloseTo(0.5 * (3 * 2.4 - 1.2), 4);
  });

  it('files without insulation settings stay adiabatic and say so', () => {
    const { voxels, warnings } = voxelize(roomScene({ openings: [window('w', 0, 1.0, 1.0, 0.9, 1.2, 'closed')] }));
    expect(voxels.wallUA).toBeUndefined();
    expect(warnings.some((w) => w.includes('perfect insulators'))).toBe(true);
  });
});

// SPEC phase 3 "done when": energy balance closes.
describe('energy balance', () => {
  it('closes with walls, glass, leaks, people, sun and a cycling AC', () => {
    let scene: SceneV1 = {
      ...roomScene({ temp: 25, outdoorTemp: 33, openings: [window('w', 0, 1.0, 1.0, 0.9, 1.2, 'closed')] }),
      envelope: { wallU: 0.6, ach: 0.5 },
    };
    scene.devices.push(
      { id: 'ac', type: 'window_ac', mountedIn: 'w', capacityBtuh: 8000, airflowCfm: 220, shr: 0.7, setpoint: 24, enabled: true },
      { id: 'person', type: 'heat_source', pos: [1.5, 2, 0], size: [0.4, 0.3, 1.7], watts: 100, enabled: true },
    );
    const r = placeTool(scene, 'sun', 1.5, -1);
    if ('error' in r) throw new Error(r.error);
    scene = r.scene;
    const { solver } = build(scene);
    run(solver, 60);
    solver.energyReport(); // drop the start-up window
    run(solver, 60);
    const e = solver.energyReport();
    expect(e.walls).toBeGreaterThan(0); // hot outside: walls leak heat in
    expect(e.glass).toBeGreaterThan(0);
    expect(e.infiltration).toBeGreaterThan(0);
    expect(e.sources).toBeCloseTo(100, 3); // the person
    expect(e.sun).toBeGreaterThan(0); // sun on the floor
    expect(e.ac).toBeLessThan(0);
    const scale = Math.abs(e.walls) + Math.abs(e.glass) + Math.abs(e.infiltration) + Math.abs(e.sources) + Math.abs(e.sun) + Math.abs(e.ac);
    expect(Math.abs(e.storage - e.net) / scale).toBeLessThan(1e-3);
  });

  it('closes with open windows and wind', () => {
    const scene: SceneV1 = {
      ...roomScene({ temp: 28, outdoorTemp: 22, windSpeed: 3, windFrom: 270, openings: [window('west', 3, 1, 1, 0.9, 1.2), window('east', 1, 1, 1, 0.9, 1.2)] }),
      envelope: { wallU: 0.6, ach: 0.5 },
    };
    const { solver } = build(scene);
    run(solver, 40);
    solver.energyReport();
    run(solver, 40);
    const e = solver.energyReport();
    expect(e.openWindows).toBeLessThan(-100); // cooler outdoor air flushes heat out
    const scale = Math.abs(e.walls) + Math.abs(e.infiltration) + Math.abs(e.openWindows);
    expect(Math.abs(e.storage - e.net) / scale).toBeLessThan(1e-3);
  });
});

// The prediction counts fan motor heat, so the simulation has to as well.
describe('fan motor heat', () => {
  it('a running box fan heats a sealed, insulated room by its motor watts', () => {
    const r = placeTool(roomScene({ temp: 25 }), 'box_fan', 1.5, 1.5);
    if ('error' in r) throw new Error(r.error);
    const { solver } = build(r.scene);
    run(solver, 5);
    solver.energyReport();
    run(solver, 10);
    const e = solver.energyReport();
    expect(e.fans).toBeCloseTo(FAN_MOTOR_W.box_fan, 3);
    expect(e.storage).toBeCloseTo(FAN_MOTOR_W.box_fan, 0);
  });
});

describe('thermostat', () => {
  it('switches the compressor off once the room is cooled to the setpoint', () => {
    const scene = roomScene({
      w: 2,
      d: 2,
      height: 2,
      temp: 25,
      openings: [window('w', 0, 0.5, 1.0, 0.9, 1.2, 'closed')],
      devices: [{ id: 'ac', type: 'window_ac', mountedIn: 'w', capacityBtuh: 12000, airflowCfm: 330, shr: 0.7, setpoint: 24, enabled: true }],
    });
    const { solver } = build(scene);
    let sawOff = false;
    for (let s = 0; s < 400 && !sawOff; s++) {
      solver.step();
      sawOff = !solver.deviceReport().acUnits[0].compressorOn;
    }
    expect(sawOff).toBe(true);
    const ac = solver.deviceReport().acUnits[0];
    expect(ac.coolingW).toBe(0); // fan only
    expect(ac.duty).toBeLessThan(1);
  });
});

describe('predicted room temperature', () => {
  const box = (devices: Device[], envelope = { wallU: 0.5, ach: 0 }): SceneV1 => ({ ...roomScene({ temp: 26, outdoorTemp: 32, devices }), envelope });
  const UA = 0.5 * 4 * 3 * 2.4; // W/K of the 3 x 3 x 2.4 m box

  it('heater only: settles at outdoor + Q / UA', () => {
    const p = predictRoom(box([{ id: 'h', type: 'heat_source', pos: [1, 1, 0], size: [0.3, 0.3, 0.5], watts: 500, enabled: true }]));
    expect(p.settleT).toBeCloseTo(32 + 500 / UA, 6);
    expect(p.ac).toBe('none');
    expect(p.hours).toBeGreaterThan(0.1);
    const net = p.breakdown.reduce((s, b) => s + b.watts, 0);
    expect(Math.abs(net)).toBeLessThan(1e-6); // balanced at the settled temperature
  });

  it('leaks add rho cp V ACH / 3600 of conductance', () => {
    const p = predictRoom(box([], { wallU: 0.5, ach: 1 }));
    expect(p.settleT).toBeCloseTo(32, 6); // nothing inside: it just goes to outdoor temperature
    const G = UA + (RHO * CP * 3 * 3 * 2.4) / 3600;
    const p2 = predictRoom(box([{ id: 'h', type: 'heat_source', pos: [1, 1, 0], size: [0.3, 0.3, 0.5], watts: 300, enabled: true }], { wallU: 0.5, ach: 1 }));
    expect(p2.settleT).toBeCloseTo(32 + 300 / G, 6);
  });

  it('a big enough AC holds the setpoint and cycles; a small one runs flat out above it', () => {
    const scene = (btuh: number) =>
      ({
        ...box([]),
        openings: [window('w', 0, 1, 1, 0.9, 1.2, 'closed')],
        devices: [{ id: 'ac', type: 'window_ac', mountedIn: 'w', capacityBtuh: btuh, airflowCfm: btuh * 0.0275, shr: 0.7, setpoint: 22, enabled: true }],
      }) as SceneV1;
    const big = predictRoom(scene(8000));
    expect(big.ac).toBe('cycling');
    expect(big.settleT).toBe(22);
    expect(big.acDuty).toBeGreaterThan(0);
    expect(big.acDuty).toBeLessThan(1);
    expect(big.acDuty * big.acCapacityW).toBeCloseTo(big.neededCoolingW, 6);
    const small = predictRoom(scene(300));
    expect(small.ac).toBe('maxed');
    expect(small.settleT).toBeGreaterThan(22);
    expect(small.neededCoolingW).toBeGreaterThan(small.acCapacityW);
  });

  it('a sealed, perfectly insulated room never settles; it drifts', () => {
    const p = predictRoom({ ...roomScene({ devices: [{ id: 'h', type: 'heat_source', pos: [1, 1, 0], size: [0.3, 0.3, 0.5], watts: 100, enabled: true }] }) });
    expect(Number.isNaN(p.settleT)).toBe(true);
    expect(p.driftPerHour).toBeGreaterThan(0);
  });
});

describe('selecting and resizing the sunlit patch', () => {
  const sunny = () => {
    let s = newSpace({ name: 'B', outline: rectOutline(12 * FT, 12 * FT), height: 8 * FT, roomTemp: 27, outdoorTemp: 32 });
    for (const [k, x, y] of [['window', 1.8, 0.1], ['sun', 1.83, -1]] as const) {
      const r = placeTool(s, k, x, y);
      if ('error' in r) throw new Error(r.error);
      s = r.scene;
    }
    return { scene: s, id: sunlightId('Sun', s.openings[0].id), win: s.openings[0].id };
  };

  it('dragging a side of the patch widens the window that casts it', () => {
    const { scene, id } = sunny();
    const right = handlesFor(scene, id).find((h) => h.id === 'right')!;
    const wider = dragHandle(scene, id, 'right', right.x + 0.5, right.y);
    expect(wider.openings[0].width).toBeCloseTo(scene.openings[0].width + 0.5, 6);
    expect(sunPatches(wider)[0].enteringW).toBeGreaterThan(sunPatches(scene)[0].enteringW);
  });

  it('dragging the far edge deeper lowers the sun', () => {
    const { scene, id } = sunny();
    const reach = handlesFor(scene, id).find((h) => h.id === 'reach')!;
    const deeper = dragHandle(scene, id, 'reach', reach.x, reach.y + 0.6);
    const sun = deeper.devices.find((d) => d.type === 'sun')!;
    expect('elevationDeg' in sun && sun.elevationDeg).toBeLessThan(35);
    // and the patch's far edge really moved to where it was dragged (within rounding to whole degrees)
    const newReach = handlesFor(deeper, id).find((h) => h.id === 'reach')!;
    expect(Math.abs(newReach.y - (reach.y + 0.6))).toBeLessThan(0.1);
  });
});

describe('temperature sensors', () => {
  it('place at seated head height and do not affect the physics', () => {
    const scene = newSpace({ name: 'B', outline: rectOutline(3, 3), height: 2.4, roomTemp: 25, outdoorTemp: 30 });
    const r = placeTool(scene, 'sensor', 1, 1);
    if ('error' in r) throw new Error(r.error);
    expect(r.scene.devices[0]).toMatchObject({ type: 'sensor', pos: [1, 1, 1.1] });
    const a = new FluidSolver(voxelize(scene).voxels);
    const b = new FluidSolver(voxelize(r.scene).voxels);
    expect(voxelize(r.scene).warnings).toEqual(voxelize(scene).warnings);
    run(a, 5);
    run(b, 5);
    expect(Buffer.from(a.T.buffer).equals(Buffer.from(b.T.buffer))).toBe(true);
  });
});
