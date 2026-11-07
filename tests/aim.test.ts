import { describe, expect, it } from 'vitest';
import { FT, newSpace, placeTool, rectOutline, strengthFor, type ToolKind } from '../src/scene/defaults';
import { AIM_ARROW, aimArrow, dragHandle, handlesFor } from '../src/scene/editing';
import type { SceneV1 } from '../src/scene/types';

const bedroom = () => newSpace({ name: 'Bedroom', outline: rectOutline(12 * FT, 12 * FT), height: 8 * FT, roomTemp: 27, outdoorTemp: 32 });

function place(kind: ToolKind, x: number, y: number) {
  const r = placeTool(bedroom(), kind, x, y);
  if ('error' in r) throw new Error(r.error);
  return r;
}
const dev = (s: SceneV1, id: string) => s.devices.find((d) => d.id === id)!;

describe('aim arrows on fans and ACs', () => {
  it('fans, tower fans, portable ACs and mini splits get an aim handle at the arrow tip', () => {
    for (const [kind, x, y] of [
      ['box_fan', 1.8, 1.8],
      ['tower_fan', 1.8, 1.8],
      ['portable_ac', 1.8, 1.8],
      ['mini_split', 0.1, 1.8],
    ] as const) {
      const { scene, id } = place(kind, x, y);
      const arrow = aimArrow(scene, dev(scene, id))!;
      expect(arrow, kind).not.toBeNull();
      const aim = handlesFor(scene, id).find((h) => h.id === 'aim')!;
      expect(aim.x).toBeCloseTo(arrow.to[0], 9);
      expect(aim.y).toBeCloseTo(arrow.to[1], 9);
    }
  });

  it('dragging the tip sets direction and strength; the tip lands where it was dropped', () => {
    const { scene, id } = place('box_fan', 1.8, 1.8);
    const from = aimArrow(scene, dev(scene, id))!.from;
    const st = strengthFor(dev(scene, id))!;
    // drop it 1.0 m due east of the center
    const s2 = dragHandle(scene, id, 'aim', from[0] + 1.0, from[1]);
    const d2 = dev(s2, id) as Extract<SceneV1['devices'][number], { type: 'box_fan' }>;
    expect(d2.heading).toBe(90);
    const frac = (1.0 - AIM_ARROW.min) / (AIM_ARROW.max - AIM_ARROW.min);
    expect(d2.airflowCfm).toBeCloseTo(st.min + frac * (st.max - st.min), -1);
    const tip = aimArrow(s2, d2)!.to;
    expect(tip[0]).toBeCloseTo(from[0] + 1.0, 1);
    expect(tip[1]).toBeCloseTo(from[1], 6);
  });

  it('a short arrow is the weakest setting, a long one the strongest', () => {
    const { scene, id } = place('tower_fan', 1.8, 1.8);
    const st = strengthFor(dev(scene, id))!;
    const from = aimArrow(scene, dev(scene, id))!.from;
    expect(st.get(dev(dragHandle(scene, id, 'aim', from[0], from[1] + 0.1), id))).toBe(st.min);
    expect(st.get(dev(dragHandle(scene, id, 'aim', from[0], from[1] + 5), id))).toBe(st.max);
  });

  it('an AC arrow sets cooling capacity, and its airflow follows', () => {
    const { scene, id } = place('portable_ac', 1.8, 1.8);
    const from = aimArrow(scene, dev(scene, id))!.from;
    const before = dev(scene, id) as Extract<SceneV1['devices'][number], { type: 'portable_ac' }>;
    const after = dev(dragHandle(scene, id, 'aim', from[0] - AIM_ARROW.max, from[1]), id) as typeof before;
    expect(after.heading).toBe(270);
    expect(after.capacityBtuh).toBeGreaterThan(before.capacityBtuh);
    expect(after.airflowCfm).toBeGreaterThan(before.airflowCfm);
  });

  it('ceiling fans and heaters have no aim arrow', () => {
    for (const kind of ['ceiling_fan', 'person'] as const) {
      const { scene, id } = place(kind, 1.8, 1.8);
      expect(aimArrow(scene, dev(scene, id))).toBeNull();
      expect(handlesFor(scene, id).some((h) => h.id === 'aim')).toBe(false);
    }
  });
});
