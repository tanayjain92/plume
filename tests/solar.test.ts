import { describe, expect, it } from 'vitest';
import { FT, newSpace, placeTool, rectOutline } from '../src/scene/defaults';
import { dragHandle, handlesFor } from '../src/scene/editing';
import { floorFraction, GLASS_TRANSMITTANCE, patchArea, sunPatches } from '../src/scene/solar';
import type { SceneV1 } from '../src/scene/types';
import { voxelize } from '../src/scene/voxelize';

const room = () => newSpace({ name: 'Bedroom', outline: rectOutline(12 * FT, 12 * FT), height: 8 * FT, roomTemp: 27, outdoorTemp: 32 });

function place(scene: SceneV1, kind: Parameters<typeof placeTool>[1], x: number, y: number) {
  const r = placeTool(scene, kind, x, y);
  if ('error' in r) throw new Error(r.error);
  return r;
}

/** Room with a closed south window (edge 0) and the sun due south, shining north at 35°. */
function southSun(state: 'open' | 'closed' = 'closed') {
  let { scene } = place(room(), 'window', 1.8, 0.1);
  scene = { ...scene, openings: scene.openings.map((o) => ({ ...o, state })) };
  const sun = place(scene, 'sun', 1.83, -1.0); // outside, south of the room
  return sun;
}

describe('sunshine through windows', () => {
  it('the sun must be outside, and there is only one', () => {
    expect('error' in placeTool(room(), 'sun', 1.8, 1.8)).toBe(true);
    const { scene } = southSun();
    const again = place(scene, 'sun', 5, 6 * FT).scene; // due east of the room's center
    expect(again.devices.filter((d) => d.type === 'sun').length).toBe(1);
    expect(again.devices.find((d) => d.type === 'sun')).toMatchObject({ pos: [5, 1.83, 0], heading: 270 });
  });

  it('a south window lets the sun onto the floor, and the heat matches what comes through the glass', () => {
    const { scene } = southSun();
    const sun = scene.devices.find((d) => d.type === 'sun')!;
    expect(sun).toMatchObject({ heading: 0, elevationDeg: 35, wm2: 800 });
    const [patch] = sunPatches(scene);
    const e = (35 * Math.PI) / 180;
    expect(patch.floorWm2).toBeCloseTo(GLASS_TRANSMITTANCE * 800 * Math.sin(e), 6);
    // energy: the floor patch carries exactly what enters the window
    expect(patch.floorWm2 * patchArea(patch)).toBeCloseTo(patch.enteringW, 6);
    expect(patch.enteringW).toBeCloseTo(GLASS_TRANSMITTANCE * 800 * Math.cos(e) * 0.9 * 1.2, 6);

    // the voxelized floor heat is that same power (to within the 10 cm cell rounding)
    const { voxels, warnings } = voxelize(scene);
    const heat = voxels.heatSources.reduce((s, h) => s + h.watts, 0);
    expect(Math.abs(heat - patch.enteringW) / patch.enteringW).toBeLessThan(0.08);
    expect(warnings.some((w) => w.includes("isn't shining"))).toBe(false);
  });

  it('low sun reaches deeper into the room than high sun', () => {
    const { scene, id } = southSun();
    const withElevation = (deg: number) => ({ ...scene, devices: scene.devices.map((d) => (d.id === id ? { ...d, elevationDeg: deg } : d)) }) as SceneV1;
    const farY = (s: SceneV1) => Math.max(...sunPatches(s)[0].quad.map((p) => p[1]));
    expect(farY(withElevation(15))).toBeGreaterThan(farY(withElevation(60)) + 1);
  });

  it('no sunlight through a window facing away from the sun', () => {
    const { scene, id } = southSun();
    const away = dragHandle(scene, id, 'aim', 1.83, -3); // aim the light south, away from the room
    expect(away.devices.find((d) => d.id === id)).toMatchObject({ heading: 180 });
    expect(sunPatches(away)).toEqual([]);
    const { warnings, voxels } = voxelize(away);
    expect(voxels.heatSources).toEqual([]);
    expect(warnings.some((w) => w.includes("isn't shining"))).toBe(true);
  });

  it('reports how much of the light lands on the floor instead of a wall', () => {
    const { scene, id } = southSun();
    const outline = scene.rooms[0].outline;
    expect(floorFraction(sunPatches(scene)[0], outline)).toBeCloseTo(1, 2); // 35° due north: all on the floor
    const grazing = { ...scene, devices: scene.devices.map((d) => (d.id === id ? { ...d, elevationDeg: 15 } : d)) } as SceneV1;
    const f = floorFraction(sunPatches(grazing)[0], outline);
    expect(f).toBeGreaterThan(0.02); // sill shadow reaches 3.4 m, the room is 3.7 m deep
    expect(f).toBeLessThan(0.2); // most of the low sun runs past the floor into the far wall
  });

  it('an open window lets in more sun than glass', () => {
    const closed = sunPatches(southSun('closed').scene)[0].enteringW;
    const open = sunPatches(southSun('open').scene)[0].enteringW;
    expect(open / closed).toBeCloseTo(1 / GLASS_TRANSMITTANCE, 6);
  });

  it('the aim handle sits at the tip of the sun arrow and turns the light', () => {
    const { scene, id } = southSun();
    const [aim] = handlesFor(scene, id);
    expect(aim.id).toBe('aim');
    expect(aim.y).toBeCloseTo(0, 6); // 1 m north of the sun at y = -1
    const turned = dragHandle(scene, id, 'aim', 2.83, 0); // up and to the right: north-east
    expect(turned.devices.find((d) => d.id === id)).toMatchObject({ heading: 45 });
  });
});
