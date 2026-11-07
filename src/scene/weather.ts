import { predictRoom } from './predict';
import type { SceneV1, SunDevice } from './types';

/**
 * Auto-filled settings: outdoor weather and sun position for a place and
 * time, and a starting room temperature. Pure: the network fetch lives in the
 * UI (`src/ui/openMeteo.ts`); this file only builds URLs and interprets
 * the answers.
 *
 * Convention: the top of the plan is north. Wind "from" and sun headings use
 * the scene's degrees clockwise from +y, so compass bearings carry over as is.
 */

export interface Site {
  /** Place name shown to the user, e.g. "Phoenix, Arizona, United States". */
  name: string;
  lat: number;
  lon: number;
}

/** Weather at one hour, SI. */
export interface Weather {
  /** Local time at the site, "YYYY-MM-DDTHH:00". */
  time: string;
  /** Same instant in UTC, ms since epoch. */
  utcMs: number;
  temp: number;
  /** m/s at 10 m. */
  windSpeed: number;
  /** Compass bearing the wind blows from, degrees. */
  windFrom: number;
  /** Direct normal irradiance, W/m². */
  dni: number;
}

const DAY_MS = 86_400_000;

/** Open-Meteo URL for hourly weather on `date` (YYYY-MM-DD). Recent and near-future dates use the forecast API, older ones the archive. */
export function weatherUrl(site: Site, date: string, todayMs: number): string {
  const ageDays = (todayMs - Date.parse(`${date}T00:00:00Z`)) / DAY_MS;
  const base = ageDays > 85 ? 'https://archive-api.open-meteo.com/v1/archive' : 'https://api.open-meteo.com/v1/forecast';
  const q = new URLSearchParams({
    latitude: site.lat.toFixed(4),
    longitude: site.lon.toFixed(4),
    hourly: 'temperature_2m,wind_speed_10m,wind_direction_10m,direct_normal_irradiance',
    wind_speed_unit: 'ms',
    timezone: 'auto',
    start_date: date,
    end_date: date,
  });
  return `${base}?${q}`;
}

export function placeSearchUrl(query: string): string {
  return `https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name: query, count: '6', language: 'en', format: 'json' })}`;
}

interface OpenMeteoHourly {
  utc_offset_seconds?: number;
  hourly?: {
    time?: string[];
    temperature_2m?: (number | null)[];
    wind_speed_10m?: (number | null)[];
    wind_direction_10m?: (number | null)[];
    direct_normal_irradiance?: (number | null)[];
  };
}

/** Pick the hour `localTime` ("YYYY-MM-DDTHH:00", site local) out of an Open-Meteo hourly response. */
export function parseWeather(json: unknown, localTime: string): Weather {
  const r = json as OpenMeteoHourly;
  const h = r.hourly;
  const i = h?.time?.indexOf(localTime) ?? -1;
  if (!h || i < 0) throw new Error(`no weather for ${localTime.replace('T', ' ')}`);
  const val = (a: (number | null)[] | undefined, what: string) => {
    const v = a?.[i];
    if (v == null || !Number.isFinite(v)) throw new Error(`no ${what} for ${localTime.replace('T', ' ')}`);
    return v;
  };
  const offset = r.utc_offset_seconds ?? 0;
  return {
    time: localTime,
    utcMs: Date.parse(`${localTime}:00Z`) - offset * 1000,
    temp: val(h.temperature_2m, 'temperature'),
    windSpeed: val(h.wind_speed_10m, 'wind speed'),
    windFrom: val(h.wind_direction_10m, 'wind direction'),
    // Night hours can come back null on some models: no sun.
    dni: h.direct_normal_irradiance?.[i] ?? 0,
  };
}

export interface PlaceResult extends Site {
  id: number;
}

export function parsePlaces(json: unknown): PlaceResult[] {
  const r = json as { results?: { id: number; name: string; latitude: number; longitude: number; admin1?: string; country?: string }[] };
  return (r.results ?? []).map((p) => ({
    id: p.id,
    name: [p.name, p.admin1, p.country].filter((s, k, a) => s && a.indexOf(s) === k).join(', '),
    lat: p.latitude,
    lon: p.longitude,
  }));
}

const rad = Math.PI / 180;

/**
 * Sun position (NOAA low-precision algorithm, good to ~0.5°): azimuth is the
 * compass bearing of the sun (0 = north, 90 = east), elevation is above the
 * horizon, both in degrees.
 */
export function sunPosition(lat: number, lon: number, utcMs: number): { azimuthDeg: number; elevationDeg: number } {
  const jd = utcMs / DAY_MS + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + 0.0003032 * T)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(M * rad) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * M * rad) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * rad) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * rad);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * rad);
  const decl = Math.asin(Math.sin(eps * rad) * Math.sin(lambda * rad));
  const y = Math.tan((eps / 2) * rad) ** 2;
  const eqTime =
    (4 / rad) *
    (y * Math.sin(2 * L0 * rad) - 2 * e * Math.sin(M * rad) + 4 * e * y * Math.sin(M * rad) * Math.cos(2 * L0 * rad) - 0.5 * y * y * Math.sin(4 * L0 * rad) - 1.25 * e * e * Math.sin(2 * M * rad)); // minutes
  const minutesUtc = (((utcMs % DAY_MS) + DAY_MS) % DAY_MS) / 60000;
  const trueSolarMin = (((minutesUtc + eqTime + 4 * lon) % 1440) + 1440) % 1440;
  const hourAngle = (trueSolarMin / 4 < 0 ? trueSolarMin / 4 + 180 : trueSolarMin / 4 - 180) * rad;
  const phi = lat * rad;
  const cosZen = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(hourAngle);
  const zen = Math.acos(Math.max(-1, Math.min(1, cosZen)));
  const az = Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) / rad + 180;
  return { azimuthDeg: ((az % 360) + 360) % 360, elevationDeg: 90 - zen / rad };
}

export type WeatherField = 'temp' | 'windSpeed' | 'windFrom' | 'sun';

/**
 * Apply fetched weather to the scene. Only the listed fields change. The sun
 * (if the scene has one) moves to the side of the room it shines from, aims
 * the way its light travels, and takes its strength from the direct
 * irradiance; below the horizon it gives no light.
 */
export function applyWeather(scene: SceneV1, site: Site, w: Weather, fields: WeatherField[]): SceneV1 {
  const outdoor = { ...scene.outdoor };
  if (fields.includes('temp')) outdoor.temp = Math.round(w.temp * 10) / 10;
  if (fields.includes('windSpeed')) outdoor.windSpeed = Math.round(w.windSpeed * 10) / 10;
  if (fields.includes('windFrom')) outdoor.windFrom = Math.round(w.windFrom) % 360;
  let devices = scene.devices;
  if (fields.includes('sun')) {
    const pos = sunPosition(site.lat, site.lon, w.utcMs);
    devices = devices.map((d) => (d.type === 'sun' ? aimSun(scene, d, pos.azimuthDeg, pos.elevationDeg, w.dni) : d));
  }
  return { ...scene, outdoor, devices };
}

/** Margin outside the room's bounding box where the sun marker sits, m. */
const SUN_OFFSET = 0.35;

function aimSun(scene: SceneV1, sun: SunDevice, azimuthDeg: number, elevationDeg: number, dni: number): SunDevice {
  const up = elevationDeg > 0.5;
  const heading = Math.round((azimuthDeg + 180) % 360);
  // Light travels along `heading`; the sun sits on the opposite side, just outside the room.
  const pts = scene.rooms[0].outline;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const toSun = [Math.sin(azimuthDeg * rad), Math.cos(azimuthDeg * rad)];
  const tx = Math.abs(toSun[0]) > 1e-9 ? (x1 - x0) / 2 / Math.abs(toSun[0]) : Infinity;
  const ty = Math.abs(toSun[1]) > 1e-9 ? (y1 - y0) / 2 / Math.abs(toSun[1]) : Infinity;
  const t = Math.min(tx, ty) + SUN_OFFSET;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    ...sun,
    pos: [r2(cx + toSun[0] * t), r2(cy + toSun[1] * t), sun.pos[2]],
    heading,
    elevationDeg: up ? Math.round(Math.max(1, Math.min(89, elevationDeg))) : sun.elevationDeg,
    wm2: up ? Math.round(dni / 10) * 10 : 0,
  };
}

/**
 * Starting room temperature: where the room settles for its current
 * settings (the AC setpoint when an AC holds it). Falls back to outdoors for
 * a sealed, perfectly insulated room, which never settles.
 */
export function autoRoomTemp(scene: SceneV1): number {
  const p = predictRoom(scene);
  const t = Number.isFinite(p.settleT) ? p.settleT : scene.outdoor.temp;
  return Math.round(t * 10) / 10;
}
