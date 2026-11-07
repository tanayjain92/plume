import { RHO, CP, G } from '../solver/constants';
import { BTUH_TO_W, CFM_TO_M3S, edgeFrame, FAN_MOTOR_W, headingDir, polygonArea } from './geometry';
import { sunPatches } from './solar';
import type { SceneV1 } from './types';

/**
 * Whole-room energy balance ("well-mixed" model): where the room temperature
 * settles for the current settings, and roughly how long it takes. This runs
 * instantly, unlike the airflow simulation, which would need hours of
 * simulated time to settle. It treats the room as one temperature; the
 * airflow view shows how that temperature is spread around the room.
 *
 * Every heat path is linear in the room temperature T:
 *   Σ G_i·(T_i − T) + Q_gains − Q_ac = 0
 * where G_i is a conductance (W/K) toward a temperature T_i (outdoors for
 * walls, glass, leaks and open windows; the supply temperature for vents).
 */

export { FAN_MOTOR_W };

/**
 * Heat capacity that has to change temperature with the room, per m² of floor,
 * J/K (furniture, inner wall and floor surfaces). Rough: it only sets how fast
 * the room responds, not where it settles.
 */
export const FURNISHING_C_PER_M2 = 25_000;

export interface HeatPath {
  label: string;
  /** Heat into the room at the settled temperature, W (negative = out). */
  watts: number;
}

export interface Prediction {
  /** Where the room-average temperature settles, °C. NaN if it never does (sealed and adiabatic). */
  settleT: number;
  /** Hours to get within 0.5 °C of settleT (or of the setpoint when the AC takes over). */
  hours: number;
  ac: 'none' | 'off' | 'idle' | 'cycling' | 'maxed';
  /** Fraction of time the AC compressor runs once settled. */
  acDuty: number;
  setpoint?: number;
  /** Sensible cooling needed to hold the setpoint (or 24 °C with no AC), W. 0 if no cooling is needed. */
  neededCoolingW: number;
  /** Total AC sensible capacity, W. */
  acCapacityW: number;
  /** If it never settles: how fast it drifts, °C/hour. */
  driftPerHour: number;
  breakdown: HeatPath[];
}

export interface PredictOptions {
  /** Current room-average temperature, °C (defaults to the room's starting temperature). */
  currentT?: number;
  /** Outdoor air entering through open windows, m³/s, measured by the simulation. Otherwise estimated. */
  openInflow?: number;
}

/** Ventilation through open windows (m³/s) from the standard wind and stack formulas, when no simulation value is available. */
export function estimateOpenWindowFlow(scene: SceneV1, roomT: number): number {
  const room = scene.rooms[0];
  const open = scene.openings.filter((o) => o.state === 'open' && !scene.devices.some((d) => d.type === 'window_ac' && d.mountedIn === o.id && d.enabled));
  if (!open.length) return 0;
  const Cd = 0.6;
  const v = scene.outdoor.windSpeed;
  const from = headingDir(scene.outdoor.windFrom);
  const cp = (e: number) => {
    const n = edgeFrame(room, e).n;
    const c = n[0] * from[0] + n[1] * from[1];
    return c >= 0 ? 0.7 * c : 0.4 * c;
  };
  // Cross ventilation between the most windward and most leeward openings.
  let wind = 0;
  if (open.length >= 2 && v > 0) {
    const sorted = [...open].sort((a, b) => cp(b.edge) - cp(a.edge));
    const hi = sorted[0];
    const lo = sorted[sorted.length - 1];
    const dCp = cp(hi.edge) - cp(lo.edge);
    if (dCp > 0.05) {
      const a1 = hi.width * hi.height;
      const a2 = lo.width * lo.height;
      const aEff = 1 / Math.sqrt(1 / (a1 * a1) + 1 / (a2 * a2));
      wind = Cd * aEff * v * Math.sqrt(dCp);
    }
  }
  // Single-sided wind turbulence and stack effect for each opening.
  const dT = Math.abs(roomT - scene.outdoor.temp);
  let single = 0;
  for (const o of open) {
    const a = o.width * o.height;
    const stack = (Cd / 3) * a * Math.sqrt((G * o.height * dT) / (roomT + 273.15));
    single += Math.hypot(0.025 * a * v, stack);
  }
  return Math.max(wind, single);
}

export function predictRoom(scene: SceneV1, opts: PredictOptions = {}): Prediction {
  const room = scene.rooms[0];
  const floor = polygonArea(room.outline);
  const volume = floor * room.height;
  const T0 = opts.currentT ?? room.initialTemp;
  const tOut = scene.outdoor.temp;
  const env = scene.envelope;
  const rc = RHO * CP;

  // Conductances toward a temperature.
  const paths: { label: string; G: number; T: number }[] = [];
  if (env) {
    const ext = env.exteriorEdges;
    let wallArea = 0;
    let glassUA = 0;
    for (let e = 0; e < room.outline.length; e++) {
      if (ext && !ext.includes(e)) continue;
      wallArea += edgeFrame(room, e).length * room.height;
    }
    for (const o of scene.openings) {
      if (ext && !ext.includes(o.edge)) continue;
      const a = o.width * o.height;
      wallArea -= a;
      const hasAc = scene.devices.some((d) => d.type === 'window_ac' && d.mountedIn === o.id);
      if (o.state !== 'open' || hasAc) glassUA += (o.glazingU ?? 2.8) * a;
    }
    paths.push({ label: 'Walls', G: Math.max(0, wallArea) * env.wallU, T: tOut });
    if (glassUA > 0) paths.push({ label: 'Window glass', G: glassUA, T: tOut });
    if (env.ach > 0) paths.push({ label: 'Air leaks', G: (rc * volume * env.ach) / 3600, T: tOut });
  }
  const openQ = opts.openInflow ?? estimateOpenWindowFlow(scene, T0);
  if (openQ > 0) paths.push({ label: 'Open windows', G: rc * openQ, T: tOut });
  for (const d of scene.devices) {
    if (!d.enabled) continue;
    if (d.type === 'supply_vent') paths.push({ label: `${d.id}`, G: rc * d.airflowCfm * CFM_TO_M3S, T: d.supplyTemp });
    if (d.type === 'portable_ac') paths.push({ label: `${d.id} exhaust (outdoor air drawn in)`, G: rc * d.exhaustCfm * CFM_TO_M3S, T: tOut });
  }

  // Heat gains that don't depend on room temperature.
  const gains: HeatPath[] = [];
  let sourceW = 0;
  for (const d of scene.devices) {
    if (!d.enabled) continue;
    if (d.type === 'heat_source') sourceW += d.watts;
    else if (d.type === 'sun_patch') sourceW += d.wm2 * d.size[0] * d.size[1];
  }
  if (sourceW) gains.push({ label: 'People & equipment', watts: sourceW });
  const sunW = sunPatches(scene).reduce((s, p) => s + p.enteringW, 0);
  if (sunW) gains.push({ label: 'Sunshine', watts: sunW });
  const fanW = scene.devices.reduce((s, d) => s + (d.enabled && d.type in FAN_MOTOR_W ? FAN_MOTOR_W[d.type as keyof typeof FAN_MOTOR_W] : 0), 0);
  if (fanW) gains.push({ label: 'Fan motors', watts: fanW });
  const Q = gains.reduce((s, g) => s + g.watts, 0);

  // Cooling.
  const acs = scene.devices.filter((d) => d.enabled && (d.type === 'window_ac' || d.type === 'portable_ac' || d.type === 'mini_split'));
  const acCapacityW = acs.reduce((s, d) => s + ('capacityBtuh' in d ? d.capacityBtuh * (d.type === 'mini_split' ? 0.7 : 'shr' in d ? d.shr : 0.7) * BTUH_TO_W : 0), 0);
  const setpoint = acs.length ? Math.min(...acs.map((d) => ('setpoint' in d ? d.setpoint : 22))) : undefined;
  const hasAcDevice = scene.devices.some((d) => d.type === 'window_ac' || d.type === 'portable_ac' || d.type === 'mini_split');

  const Gtot = paths.reduce((s, p) => s + p.G, 0);
  const C = rc * volume + FURNISHING_C_PER_M2 * floor;

  const breakdownAt = (T: number, acW: number): HeatPath[] => {
    const out: HeatPath[] = [...gains];
    for (const p of paths) out.push({ label: p.label, watts: p.G * (p.T - T) });
    if (acW) out.push({ label: 'Air conditioning', watts: -acW });
    return out.filter((b) => Math.abs(b.watts) >= 0.5);
  };

  const target = setpoint ?? 24;
  if (Gtot < 1e-9) {
    // Sealed and adiabatic: nothing to settle against.
    const acW = setpoint !== undefined && Q > 0 ? Math.min(Q, acCapacityW) : 0;
    const drift = ((Q - acW) / C) * 3600;
    return {
      settleT: Math.abs(drift) < 1e-9 ? T0 : NaN,
      hours: Infinity,
      ac: !hasAcDevice ? 'none' : !acs.length ? 'off' : acW < acCapacityW ? 'cycling' : 'maxed',
      acDuty: acCapacityW ? acW / acCapacityW : 0,
      setpoint,
      neededCoolingW: Math.max(0, Q),
      acCapacityW,
      driftPerHour: drift,
      breakdown: breakdownAt(T0, acW),
    };
  }

  const tFree = (paths.reduce((s, p) => s + p.G * p.T, 0) + Q) / Gtot;
  const tau = C / Gtot; // s
  const neededCoolingW = Math.max(0, Gtot * (tFree - target));
  const hoursTo = (from: number, toward: number, stopAt: number) => {
    const gap = Math.abs(from - toward);
    const end = Math.abs(stopAt - toward);
    if (gap <= end) return 0;
    return (tau * Math.log(gap / end)) / 3600;
  };

  if (!acs.length || setpoint === undefined || tFree <= setpoint) {
    return {
      settleT: tFree,
      hours: hoursTo(T0, tFree, tFree + 0.5 * Math.sign(T0 - tFree || 1)),
      ac: !hasAcDevice ? 'none' : !acs.length ? 'off' : 'idle',
      acDuty: 0,
      setpoint,
      neededCoolingW,
      acCapacityW,
      driftPerHour: 0,
      breakdown: breakdownAt(tFree, 0),
    };
  }

  const tFull = tFree - acCapacityW / Gtot;
  if (tFull <= setpoint) {
    // The AC can hold the setpoint: it cycles.
    const acW = Gtot * (tFree - setpoint);
    return {
      settleT: setpoint,
      hours: T0 > setpoint ? hoursTo(T0, tFull, setpoint) : hoursTo(T0, tFree, setpoint),
      ac: 'cycling',
      acDuty: acW / acCapacityW,
      setpoint,
      neededCoolingW,
      acCapacityW,
      driftPerHour: 0,
      breakdown: breakdownAt(setpoint, acW),
    };
  }
  // Too small: runs flat out and the room settles above the setpoint.
  return {
    settleT: tFull,
    hours: hoursTo(T0, tFull, tFull + 0.5 * Math.sign(T0 - tFull || 1)),
    ac: 'maxed',
    acDuty: 1,
    setpoint,
    neededCoolingW,
    acCapacityW,
    driftPerHour: 0,
    breakdown: breakdownAt(tFull, acCapacityW),
  };
}
