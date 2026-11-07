import { describe, expect, it } from 'vitest';
import { FT, newSpace, placeTool, rectOutline } from '../src/scene/defaults';
import { dragHandle, handlesFor, MIN_WINDOW, removeItem, resizeWindow, toggleWindow } from '../src/scene/editing';
import type { SceneV1 } from '../src/scene/types';
import { voxelize } from '../src/scene/voxelize';
import { CellType } from '../src/solver';

const room = () => newSpace({ name: 'Bedroom', outline: rectOutline(12 * FT, 12 * FT), height: 8 * FT, roomTemp: 27, outdoorTemp: 32 });

function placed(scene: SceneV1, kind: Parameters<typeof placeTool>[1], x: number, y: number) {
  const r = placeTool(scene, kind, x, y);
  if ('error' in r) throw new Error(r.error);
  return r;
}

const openCells = (s: SceneV1) => voxelize(s).voxels.cellType.filter((t) => t === CellType.Open).length;

describe('editing a selected window', () => {
  it('drag handles sit at the window ends and change its width along the wall', () => {
    const { scene, id } = placed(room(), 'window', 1.8, 0.1); // south wall, 0.9 m wide, centered at 1.8
    const [start, end] = handlesFor(scene, id);
    expect(start).toMatchObject({ x: expect.closeTo(1.35, 6), y: 0 });
    expect(end).toMatchObject({ x: expect.closeTo(2.25, 6), y: 0 });

    const wider = dragHandle(scene, id, 'end', 2.85, 0.3); // drag the right end 0.6 m further
    expect(wider.openings[0]).toMatchObject({ offset: 1.35, width: 1.5 });
    const narrower = dragHandle(wider, id, 'start', 2.0, -0.2); // drag the left end in
    expect(narrower.openings[0]).toMatchObject({ offset: 2.0, width: 0.85 });
    // it can't shrink below the minimum or run off the wall
    expect(dragHandle(scene, id, 'end', 0, 0).openings[0].width).toBe(MIN_WINDOW);
    expect(dragHandle(scene, id, 'end', 99, 0).openings[0].offset + dragHandle(scene, id, 'end', 99, 0).openings[0].width).toBeCloseTo(12 * FT, 1);
  });

  it('bigger open windows really open more of the wall', () => {
    const { scene, id } = placed(room(), 'window', 1.8, 0.1);
    const small = openCells(scene);
    const big = openCells(resizeWindow(scene, id, 0.6));
    expect(small).toBe(9 * 12); // 0.9 m x 1.2 m
    expect(big).toBe(15 * 12); // 1.5 m x 1.2 m
    expect(resizeWindow(scene, id, 0.6).openings[0].offset + 0.75).toBeCloseTo(1.8, 6); // still centered
  });

  it('open/close toggles, and closing a window turns its open cells back into wall', () => {
    const { scene, id } = placed(room(), 'window', 1.8, 0.1);
    expect(scene.openings[0].state).toBe('open');
    const closed = toggleWindow(scene, id);
    expect(closed.openings[0].state).toBe('closed');
    expect(openCells(closed)).toBe(0);
    expect(toggleWindow(closed, id).openings[0].state).toBe('open');
  });

  it('removing a window takes its window AC with it', () => {
    const { scene } = placed(room(), 'window_ac', 1.8, 0.1);
    const win = scene.openings[0].id;
    expect(removeItem(scene, win).devices).toEqual([]);
  });
});

describe('editing other objects', () => {
  it('corner handles resize a sun patch with the opposite corner fixed', () => {
    const scene = room();
    const id = 'patch';
    scene.devices.push({ id, type: 'sun_patch', pos: [1.5, 1.5, 0], size: [1.0, 1.2], wm2: 300, enabled: true });
    expect(handlesFor(scene, id).map((h) => h.id)).toEqual(['sw', 'se', 'ne', 'nw']);
    const next = dragHandle(scene, id, 'ne', 2.5, 2.6).devices[0];
    expect(next).toMatchObject({ pos: [1.75, 1.75, 0], size: [1.5, 1.7] }); // sw corner stayed at (1.0, 0.9)
  });

  it('the radius handle sets a ceiling fan diameter', () => {
    const { scene, id } = placed(room(), 'ceiling_fan', 1.8, 1.8);
    const next = dragHandle(scene, id, 'radius', 1.8 + 0.7, 1.8).devices[0];
    expect(next).toMatchObject({ diameter: 1.4 });
  });

  it('objects without a size have no handles', () => {
    const { scene, id } = placed(room(), 'tower_fan', 1, 1);
    expect(handlesFor(scene, id)).toEqual([]);
  });
});
