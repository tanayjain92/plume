import { edgeFrame, headingDir, pointInPolygon, polygonArea } from './geometry';
import type { SceneV1, SunDevice, Vec2, Vec3 } from './types';

/** Fraction of direct sunlight that gets through: clear double glazing vs an open window. */
export const GLASS_TRANSMITTANCE = 0.7;
export const OPEN_TRANSMITTANCE = 1.0;

/** Unit vector the sunlight travels along (pointing down into the room). */
export function sunDirection(sun: Pick<SunDevice, 'heading' | 'elevationDeg'>): Vec3 {
  const h = headingDir(sun.heading);
  const e = (Math.max(1, Math.min(89, sun.elevationDeg)) * Math.PI) / 180;
  return [h[0] * Math.cos(e), h[1] * Math.cos(e), -Math.sin(e)];
}

export interface SunPatch {
  sunId: string;
  windowId: string;
  /** Sunlit area on the floor (plan polygon, m), before clipping to the room. */
  quad: Vec2[];
  /** Heat on the floor per m² of sunlit floor, W/m². */
  floorWm2: number;
  /** Sunlight entering through the window, W (some may land on walls instead of the floor). */
  enteringW: number;
}

/**
 * Where the sun shines through each window onto the floor. A window gets a
 * patch only if it faces the sun. The window rectangle is projected along the
 * sun direction onto the floor (z = 0); heat per floor area is
 * transmittance × wm2 × sin(elevation).
 */
export function sunPatches(scene: SceneV1): SunPatch[] {
  const out: SunPatch[] = [];
  for (const sun of scene.devices) {
    if (sun.type !== 'sun' || !sun.enabled) continue;
    const d = sunDirection(sun);
    for (const op of scene.openings) {
      const room = scene.rooms.find((r) => r.id === op.room);
      if (!room) continue;
      const f = edgeFrame(room, op.edge);
      // Light must travel inward: against the wall's outward normal.
      const cosIn = -(d[0] * f.n[0] + d[1] * f.n[1]);
      if (cosIn <= 0.01) continue;
      const hasAc = scene.devices.some((x) => x.type === 'window_ac' && x.mountedIn === op.id && x.enabled);
      const tau = op.state === 'open' && !hasAc ? OPEN_TRANSMITTANCE : GLASS_TRANSMITTANCE;
      const corner = (s: number, z: number): Vec2 => {
        const x = f.p0[0] + f.t[0] * s;
        const y = f.p0[1] + f.t[1] * s;
        const t = z / -d[2]; // distance along the beam down to the floor
        return [x + d[0] * t, y + d[1] * t];
      };
      const s0 = op.offset;
      const s1 = op.offset + op.width;
      const z0 = op.sill;
      const z1 = op.sill + op.height;
      const quad = [corner(s0, z0), corner(s1, z0), corner(s1, z1), corner(s0, z1)];
      const floorWm2 = tau * sun.wm2 * -d[2];
      out.push({ sunId: sun.id, windowId: op.id, quad, floorWm2, enteringW: tau * sun.wm2 * cosIn * op.width * op.height });
    }
  }
  return out;
}

/**
 * Fraction of a patch that lands on this room's floor (the rest would hit a
 * wall first). Sampled on a 5 cm grid. Light that hits walls isn't turned into
 * heat until wall heating arrives in phase 3.
 */
export function floorFraction(p: SunPatch, outline: Vec2[]): number {
  const xs = p.quad.map((q) => q[0]);
  const ys = p.quad.map((q) => q[1]);
  const step = 0.05;
  let inPatch = 0;
  let onFloor = 0;
  for (let x = Math.min(...xs) + step / 2; x < Math.max(...xs); x += step)
    for (let y = Math.min(...ys) + step / 2; y < Math.max(...ys); y += step) {
      if (!pointInPolygon(x, y, p.quad)) continue;
      inPatch++;
      if (pointInPolygon(x, y, outline)) onFloor++;
    }
  return inPatch ? onFloor / inPatch : 0;
}

/** Total sunlit floor area of a patch polygon (unclipped), m². */
export function patchArea(p: SunPatch): number {
  return polygonArea(p.quad);
}
