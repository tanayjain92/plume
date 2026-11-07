import type { Device, Opening, SceneV1 } from './types';

export type AddableKind = Device['type'] | 'window';

export const DEVICE_LABELS: Record<AddableKind, string> = {
  window: 'Window',
  heat_source: 'Heat source',
  window_ac: 'Window AC',
  portable_ac: 'Portable AC',
  mini_split: 'Mini split',
  supply_vent: 'Supply vent',
  return_vent: 'Return vent',
  box_fan: 'Box fan',
  ceiling_fan: 'Ceiling fan',
  tower_fan: 'Tower fan',
};

function uniqueId(scene: SceneV1, base: string): string {
  const taken = new Set([...scene.devices.map((d) => d.id), ...scene.openings.map((o) => o.id)]);
  for (let n = 1; ; n++) if (!taken.has(`${base}${n}`)) return `${base}${n}`;
}

function roomCenter(scene: SceneV1): { x: number; y: number; height: number } {
  const r = scene.rooms[0];
  const xs = r.outline.map((p) => p[0]);
  const ys = r.outline.map((p) => p[1]);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2, height: r.height };
}

/** A new window on the first edge, centered. */
export function newWindow(scene: SceneV1): Opening {
  const r = scene.rooms[0];
  const [a, b] = [r.outline[0], r.outline[1]];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return { id: uniqueId(scene, 'window'), type: 'window', room: r.id, edge: 0, offset: Math.max(0, len / 2 - 0.5), width: 1.0, sill: 0.9, height: 1.2, state: 'closed', glazingU: 2.8 };
}

/** A new device of the given type with typical product values, placed in the room. Returns null if it needs a window first. */
export function newDevice(scene: SceneV1, type: Device['type']): Device | null {
  const { x, y, height } = roomCenter(scene);
  const id = uniqueId(scene, type.replace(/_.*/, ''));
  switch (type) {
    case 'heat_source':
      return { id, type, pos: [x, y, 0], size: [0.4, 0.4, 1.2], watts: 100, enabled: true };
    case 'window_ac': {
      const win = scene.openings.find((o) => !scene.devices.some((d) => d.type === 'window_ac' && d.mountedIn === o.id));
      if (!win) return null;
      return { id, type, mountedIn: win.id, capacityBtuh: 8000, airflowCfm: 220, shr: 0.7, setpoint: 22, enabled: true };
    }
    case 'portable_ac':
      return { id, type, pos: [x, y, 0], heading: 0, capacityBtuh: 8000, airflowCfm: 200, exhaustCfm: 80, shr: 0.7, setpoint: 22, enabled: true };
    case 'mini_split':
      return { id, type, pos: [x, 0.2, Math.max(0.5, height - 0.6)], heading: 0, capacityBtuh: 9000, airflowCfm: 300, louverDeg: 30, setpoint: 22, enabled: true };
    case 'supply_vent':
      return { id, type, pos: [x, y, height], size: [0.3, 0.3], airflowCfm: 100, supplyTemp: 16, direction: [0, 0, -1], enabled: true };
    case 'return_vent':
      return { id, type, pos: [x, y, height], size: [0.4, 0.4], airflowCfm: 100, enabled: true };
    case 'box_fan':
      return { id, type, pos: [x, y, 0], heading: 0, diameter: 0.5, airflowCfm: 1500, enabled: true };
    case 'ceiling_fan':
      return { id, type, pos: [x, y, Math.max(0.5, height - 0.4)], diameter: 1.3, airflowCfm: 4000, reverse: false, enabled: true };
    case 'tower_fan':
      return { id, type, pos: [x, y, 0], heading: 0, slotHeight: 0.8, airflowCfm: 300, oscillateDeg: 70, periodSec: 12, enabled: true };
  }
}
