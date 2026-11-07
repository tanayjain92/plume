/**
 * Scene JSON, version 1 (SPEC.md "Scene data model").
 * SI units throughout: meters, °C, watts, m/s. Device airflow stays in CFM and
 * capacity in BTU/h because that is how products are labeled; the voxelizer
 * converts them once. Positions are [x, y, z] with z up from the floor;
 * headings are degrees clockwise from +y.
 */
export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export interface SceneV1 {
  version: 1;
  name?: string;
  grid: { cellSize: number };
  outdoor: { temp: number; windSpeed: number; windFrom: number; solar: number };
  rooms: Room[];
  walls: Wall[];
  openings: Opening[];
  devices: Device[];
  doors?: Door[];
}

export interface Room {
  id: string;
  /** Polygon in plan, meters, counter-clockwise. Edge e runs outline[e] -> outline[e+1]. */
  outline: Vec2[];
  height: number;
  initialTemp: number;
}

export interface Wall {
  room: string;
  edge: number;
  exterior: boolean;
  uValue?: number;
}

export interface Opening {
  id: string;
  type: 'window';
  room: string;
  edge: number;
  /** Distance along the edge from its first point, m. */
  offset: number;
  width: number;
  sill: number;
  height: number;
  state: 'open' | 'closed';
  glazingU?: number;
}

export interface Door {
  id: string;
  rooms: [string, string];
  edge: number;
  offset: number;
  width: number;
  state: 'open' | 'closed' | 'cracked';
  undercut?: number;
}

interface DeviceBase {
  id: string;
  enabled: boolean;
}

/** Volumetric heat in an axis-aligned box. pos = center of the box's bottom face. */
export interface HeatSourceDevice extends DeviceBase {
  type: 'heat_source';
  pos: Vec3;
  size: Vec3;
  watts: number;
}

export interface WindowAcDevice extends DeviceBase {
  type: 'window_ac';
  mountedIn: string;
  capacityBtuh: number;
  airflowCfm: number;
  shr: number;
  setpoint: number;
}

export interface PortableAcDevice extends DeviceBase {
  type: 'portable_ac';
  pos: Vec3;
  heading: number;
  capacityBtuh: number;
  airflowCfm: number;
  exhaustCfm: number;
  shr: number;
  setpoint: number;
}

export interface MiniSplitDevice extends DeviceBase {
  type: 'mini_split';
  pos: Vec3;
  heading: number;
  capacityBtuh: number;
  airflowCfm: number;
  louverDeg: number;
  setpoint: number;
}

export interface SupplyVentDevice extends DeviceBase {
  type: 'supply_vent';
  pos: Vec3;
  size: Vec2;
  airflowCfm: number;
  supplyTemp: number;
  direction: Vec3;
}

export interface ReturnVentDevice extends DeviceBase {
  type: 'return_vent';
  pos: Vec3;
  size: Vec2;
  airflowCfm: number;
}

export interface BoxFanDevice extends DeviceBase {
  type: 'box_fan';
  pos: Vec3;
  heading: number;
  diameter: number;
  airflowCfm: number;
}

export interface CeilingFanDevice extends DeviceBase {
  type: 'ceiling_fan';
  pos: Vec3;
  diameter: number;
  airflowCfm: number;
  reverse: boolean;
}

export interface TowerFanDevice extends DeviceBase {
  type: 'tower_fan';
  pos: Vec3;
  heading: number;
  slotHeight: number;
  airflowCfm: number;
  oscillateDeg: number;
  periodSec: number;
}

/**
 * Sunlit patch of floor: solar gain absorbed by the floor and passed to the
 * air above it. pos = center of the patch on the floor; size = [x, y] extent.
 * Phase 3 will derive patches from windows and sun angle.
 */
export interface SunPatchDevice extends DeviceBase {
  type: 'sun_patch';
  pos: Vec3;
  size: Vec2;
  /** Absorbed solar flux, W/m² (strong summer sun through glass ≈ 300–500). */
  wm2: number;
}

/**
 * The sun, outside the room. Sunlight travels along `heading` (degrees
 * clockwise from +y, the direction the light goes) and down at
 * `elevationDeg` above the horizon. It enters through windows that face it
 * and lands on the floor as sunlit patches. pos is only where the sun icon is
 * drawn (outside the room).
 */
export interface SunDevice extends DeviceBase {
  type: 'sun';
  pos: Vec3;
  heading: number;
  elevationDeg: number;
  /** Direct sunlight on a surface facing the sun, W/m² (clear sky ≈ 800–900). */
  wm2: number;
}

export type Device =
  | HeatSourceDevice
  | SunDevice
  | SunPatchDevice
  | WindowAcDevice
  | PortableAcDevice
  | MiniSplitDevice
  | SupplyVentDevice
  | ReturnVentDevice
  | BoxFanDevice
  | CeilingFanDevice
  | TowerFanDevice;
