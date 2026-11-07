import { describe, expect, it } from 'vitest';
import { PRESETS } from '../src/scene/presets';
import { voxelize } from '../src/scene/voxelize';
import { CellType, FluidSolver } from '../src/solver';

describe('voxelizer', () => {
  it('turns the 4 x 3.6 x 2.7 m bedroom into 40 x 36 x 27 fluid cells inside a solid shell', () => {
    const { voxels } = voxelize(PRESETS.find((p) => p.id === 'floor-patch')!.scene);
    expect([voxels.nx, voxels.ny, voxels.nz]).toEqual([42, 38, 29]);
    let fluid = 0;
    for (const t of voxels.cellType) if (t === CellType.Fluid) fluid++;
    expect(fluid).toBe(40 * 36 * 27);
    expect(voxels.origin).toEqual([-0.1, -0.1, -0.1]);
  });

  it('places heat sources on the right cells', () => {
    const { voxels } = voxelize(PRESETS.find((p) => p.id === 'floor-patch')!.scene);
    const src = voxels.heatSources[0];
    expect(src.watts).toBe(300);
    expect(src.cells.length).toBe(6 * 6 * 1); // 0.6 x 0.6 x 0.1 m at 10 cm
    const { nx, ny } = voxels;
    for (const c of src.cells) expect(Math.floor(c / (nx * ny))).toBe(1); // first fluid layer
  });

  it('builds every device in the SPEC sample bedroom, including its insulation', () => {
    const { voxels, warnings } = voxelize(PRESETS.find((p) => p.id === 'spec-bedroom')!.scene);
    expect(voxels.heatSources.map((s) => s.id)).toEqual(['fan1 motor', 'person', 'desktop']); // fan motors heat the room too
    expect(voxels.acUnits.map((a) => a.id)).toEqual(['ac1']);
    expect(voxels.ports.map((p) => p.id)).toEqual(['ac1:supply', 'ac1:return']);
    // 0.6 m wide x 0.4 m tall unit: 6 x 2 supply faces above 6 x 2 return faces
    expect(voxels.ports.map((p) => p.faces.length)).toEqual([12, 12]);
    expect(voxels.fans.map((f) => f.id)).toEqual(['fan1']);
    expect(warnings.some((w) => w.includes('ignored'))).toBe(false);
    expect(voxels.wallUA!.some((v) => v > 0)).toBe(true);
    expect(voxels.glassUA!.some((v) => v > 0)).toBe(true);
    expect(voxels.infiltrationAch).toBe(0.5);
  });

  it('turns an open window into open cells carrying wind pressure', () => {
    const scene = structuredClone(PRESETS.find((p) => p.id === 'floor-patch')!.scene);
    scene.outdoor = { temp: 30, windSpeed: 4, windFrom: 180, solar: 0 }; // wind from the south hits edge 0 head-on
    scene.openings = [{ id: 'w', type: 'window', room: 'bedroom', edge: 0, offset: 1, width: 1, sill: 0.9, height: 1.2, state: 'open' }];
    const { voxels } = voxelize(scene);
    const open = [...voxels.cellType.keys()].filter((c) => voxels.cellType[c] === CellType.Open);
    expect(open.length).toBe(10 * 12);
    const expectedPa = 0.7 * 0.5 * 1.2 * 4 * 4;
    for (const c of open) expect(voxels.openPressure[c]).toBeCloseTo(expectedPa, 4);
  });

  it('every preset builds a valid solver', () => {
    for (const p of PRESETS) {
      const { voxels } = voxelize(p.scene);
      const solver = new FluidSolver(voxels);
      solver.step();
      expect(solver.maxDivergence()).toBeLessThan(1e-4);
    }
  });
});
