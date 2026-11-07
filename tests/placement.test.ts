import { describe, expect, it } from 'vitest';
import { FT, newSpace, placeTool, rectOutline, strengthFor, TOOLS, type ToolKind } from '../src/scene/defaults';
import { isSimplePolygon, polygonArea } from '../src/scene/geometry';
import type { SceneV1, Vec2 } from '../src/scene/types';
import { voxelize } from '../src/scene/voxelize';
import { CellType, FluidSolver } from '../src/solver';

const bedroom = () => newSpace({ name: 'Bedroom', outline: rectOutline(12 * FT, 12 * FT), height: 8 * FT, roomTemp: 27, outdoorTemp: 32 });

function place(scene: SceneV1, kind: ToolKind, x: number, y: number): { scene: SceneV1; id: string } {
  const r = placeTool(scene, kind, x, y);
  if ('error' in r) throw new Error(r.error);
  return r;
}

describe('click-to-place tools', () => {
  it('every tool lands somewhere the voxelizer can build, and the room still simulates', () => {
    let scene = bedroom();
    const spots: Record<ToolKind, Vec2> = {
      window: [3.6, 1.0], // near the east wall
      window_ac: [1.0, 0.1], // near the south wall
      mini_split: [0.1, 2.5], // near the west wall
      portable_ac: [2.8, 2.8],
      supply_vent: [1.0, 1.8],
      return_vent: [3.0, 1.0],
      ceiling_fan: [1.8, 1.8],
      tower_fan: [0.5, 3.2],
      box_fan: [3.2, 0.6],
      sun: [1.8, -0.8], // outside, south of the room
      person: [2.0, 2.4],
      heater: [0.5, 0.5],
      computer: [3.2, 3.2],
    };
    for (const t of TOOLS) scene = place(scene, t.kind, ...spots[t.kind]).scene;
    const { voxels, warnings } = voxelize(scene);
    expect(warnings.filter((w) => w.includes('ignored') || w.includes('outside'))).toEqual([]);
    expect(voxels.acUnits.length).toBe(3);
    expect(voxels.fans.length).toBe(3);
    const solver = new FluidSolver(voxels);
    for (let s = 0; s < 10; s++) solver.step();
    expect(solver.maxDivergence()).toBeLessThan(1e-4);
  });

  it('wall tools snap to the nearest wall', () => {
    const scene = bedroom();
    const east = place(scene, 'window', 3.5, 1.5).scene.openings[0];
    expect(east.edge).toBe(1);
    const north = place(scene, 'window', 1.5, 3.4).scene.openings[0];
    expect(north.edge).toBe(2);
    const ac = place(scene, 'window_ac', 0.2, 2.0).scene;
    expect(ac.openings[0].edge).toBe(3);
    expect(ac.devices[0]).toMatchObject({ type: 'window_ac', mountedIn: ac.openings[0].id });
  });

  it('floor tools refuse clicks outside the room, and fans aim at its middle', () => {
    expect('error' in placeTool(bedroom(), 'tower_fan', -1, 1)).toBe(true);
    const fan = place(bedroom(), 'box_fan', 0.4, 1.83).scene.devices[0];
    expect(fan).toMatchObject({ type: 'box_fan', heading: 90 }); // west side of the room -> points east
  });

  it('strength controls change the device and keep AC airflow in proportion', () => {
    const { scene, id } = place(bedroom(), 'window_ac', 1, 0.1);
    const ac = scene.devices.find((d) => d.id === id)!;
    const s = strengthFor(ac)!;
    const big = s.set(ac, 12000);
    expect(big).toMatchObject({ capacityBtuh: 12000, airflowCfm: 330 });
    expect(s.get(big)).toBe(12000);
  });
});

describe('free-form spaces', () => {
  it('rejects self-crossing outlines and accepts an L-shaped room', () => {
    expect(isSimplePolygon([[0, 0], [2, 2], [2, 0], [0, 2]])).toBe(false);
    expect(isSimplePolygon([[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]])).toBe(true);
  });

  it('an L-shaped room voxelizes to its area and simulates with devices', () => {
    const outline: Vec2[] = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]];
    let scene = newSpace({ name: 'L', outline, height: 2.5, roomTemp: 27, outdoorTemp: 32 });
    scene = place(scene, 'window', 3, 0.1).scene;
    scene = place(scene, 'tower_fan', 1, 3).scene;
    scene = place(scene, 'person', 1, 1).scene;
    const { voxels, warnings } = voxelize(scene);
    expect(warnings.filter((w) => w.includes('ignored'))).toEqual([]);
    let fluid = 0;
    for (const t of voxels.cellType) if (t === CellType.Fluid) fluid++;
    expect(fluid).toBe(Math.round((polygonArea(outline) / 0.01) * 25)); // 12 m² x 2.5 m at 10 cm
    const solver = new FluidSolver(voxels);
    for (let s = 0; s < 20; s++) solver.step();
    expect(solver.maxDivergence()).toBeLessThan(1e-4);
  });
});

describe('sun patch (hand-placed floor heat)', () => {
  it('a sun patch puts wm2 x its floor area into the lowest air layer', () => {
    const scene = bedroom();
    scene.devices.push({ id: 'patch', type: 'sun_patch', pos: [1.8, 1.8, 0], size: [1.0, 1.2], wm2: 300, enabled: true });
    const { voxels } = voxelize(scene);
    const sun = voxels.heatSources[0];
    expect(sun.cells.length).toBe(10 * 12); // 1.0 x 1.2 m
    expect(sun.watts).toBeCloseTo(300 * 1.2, 6);
    const { nx, ny } = voxels;
    for (const c of sun.cells) expect(Math.floor(c / (nx * ny))).toBe(1);
  });
});
