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

  it('reports devices that are not simulated yet instead of silently dropping them', () => {
    const { voxels, warnings } = voxelize(PRESETS.find((p) => p.id === 'spec-bedroom')!.scene);
    expect(voxels.heatSources.map((s) => s.id)).toEqual(['person', 'desktop']);
    expect(warnings.some((w) => w.includes('window_ac'))).toBe(true);
    expect(warnings.some((w) => w.includes('tower_fan'))).toBe(true);
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
