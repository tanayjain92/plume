import { describe, expect, it } from 'vitest';
import { FT, newSpace, placeTool, rectOutline, type ToolKind } from '../src/scene/defaults';
import { copyItem, moveItem, NUDGE, pasteItem } from '../src/scene/editing';
import type { SceneV1 } from '../src/scene/types';

const posOf = (s: SceneV1, i = 0) => (s.devices[i] as { pos: number[] }).pos;
const bedroom = () => newSpace({ name: 'Bedroom', outline: rectOutline(12 * FT, 12 * FT), height: 8 * FT, roomTemp: 27, outdoorTemp: 32 });
function place(scene: SceneV1, kind: ToolKind, x: number, y: number) {
  const r = placeTool(scene, kind, x, y);
  if ('error' in r) throw new Error(r.error);
  return r;
}

describe('moving objects (drag and arrow keys)', () => {
  it('arrow steps move a device in the plan: right is +x, up is +y', () => {
    const { scene, id } = place(bedroom(), 'person', 1.8, 1.8);
    const p0 = posOf(scene);
    const right = moveItem(scene, id, NUDGE.step, 0)!;
    expect(posOf(right)).toEqual([p0[0] + 0.1, p0[1], p0[2]].map((v) => Math.round(v * 20) / 20));
    const up = moveItem(scene, id, 0, NUDGE.big)!;
    expect(posOf(up)[1]).toBeCloseTo(p0[1] + 0.5, 9);
  });

  it('refuses to push a device out of the room, or the sun into it', () => {
    const { scene, id } = place(bedroom(), 'person', 0.1, 1.8);
    expect(moveItem(scene, id, -0.5, 0)).toBeNull();
    const sun = place(bedroom(), 'sun', 1.8, -0.3);
    expect(moveItem(sun.scene, sun.id, 0, 1.0)).toBeNull();
    expect(moveItem(sun.scene, sun.id, 0.5, 0)).not.toBeNull();
  });

  it('windows slide along their wall and stop at its ends', () => {
    const { scene, id } = place(bedroom(), 'window', 1.8, 0.05); // south wall, runs along x
    const op = scene.openings[0];
    expect(moveItem(scene, id, 0.3, 0)!.openings[0].offset).toBeCloseTo(op.offset + 0.3, 9);
    expect(moveItem(scene, id, 0, 0.3)!.openings[0].offset).toBe(op.offset); // across the wall: no change
    expect(moveItem(scene, id, -50, 0)!.openings[0].offset).toBe(0);
  });

  it('a window AC moves with its window', () => {
    const { scene, id } = place(bedroom(), 'window_ac', 1.8, 0.05);
    const ac = scene.devices.find((d) => d.id === id)!;
    if (ac.type !== 'window_ac') throw new Error();
    const moved = moveItem(scene, id, 0.4, 0)!;
    const before = scene.openings.find((o) => o.id === ac.mountedIn)!.offset;
    expect(moved.openings.find((o) => o.id === ac.mountedIn)!.offset).toBeCloseTo(before + 0.4, 9);
  });
});

describe('copy and paste (Ctrl+C, Ctrl+V)', () => {
  it('pastes a device beside the original with the next free name, keeping its settings and color', () => {
    const { scene, id } = place(bedroom(), 'box_fan', 1.8, 1.8);
    const colored = { ...scene, devices: scene.devices.map((d) => ({ ...d, color: '#8e24aa' })) };
    const r = pasteItem(colored, copyItem(colored, id)!);
    if ('error' in r) throw new Error(r.error);
    expect(r.id).toBe('Box fan 2');
    const [a, b] = r.scene.devices;
    expect(b).toMatchObject({ type: 'box_fan', airflowCfm: (a as { airflowCfm: number }).airflowCfm, color: '#8e24aa' });
    expect(posOf(r.scene, 1)).not.toEqual(posOf(r.scene, 0));
  });

  it('pasting again from the copy keeps stepping instead of stacking', () => {
    const { scene, id } = place(bedroom(), 'person', 1.0, 2.5);
    const r1 = pasteItem(scene, copyItem(scene, id)!);
    if ('error' in r1) throw new Error(r1.error);
    const r2 = pasteItem(r1.scene, copyItem(r1.scene, r1.id)!);
    if ('error' in r2) throw new Error(r2.error);
    const ps = r2.scene.devices.map((_, i) => posOf(r2.scene, i).join());
    expect(new Set(ps).size).toBe(3);
  });

  it('a window copy goes beside the original on the same wall, never overlapping', () => {
    const { scene, id } = place(bedroom(), 'window', 1.0, 0.05);
    const r = pasteItem(scene, copyItem(scene, id)!);
    if ('error' in r) throw new Error(r.error);
    const [w1, w2] = r.scene.openings;
    expect(w2.edge).toBe(w1.edge);
    expect(w2.offset >= w1.offset + w1.width || w2.offset + w2.width <= w1.offset).toBe(true);
  });

  it('a window AC copy brings its own window', () => {
    const { scene, id } = place(bedroom(), 'window_ac', 1.0, 0.05);
    const r = pasteItem(scene, copyItem(scene, id)!);
    if ('error' in r) throw new Error(r.error);
    expect(r.scene.openings).toHaveLength(2);
    const ac = r.scene.devices.find((d) => d.id === r.id)!;
    expect(ac.type === 'window_ac' && ac.mountedIn).toBe(r.scene.openings[1].id);
  });

  it('there is only one sun', () => {
    const { scene, id } = place(bedroom(), 'sun', 1.8, -0.3);
    expect(pasteItem(scene, copyItem(scene, id)!)).toEqual({ error: 'There is only one sun.' });
  });
});
