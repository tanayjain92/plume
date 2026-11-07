/** Display-unit conversion. The solver and scene JSON stay SI; only the UI converts. */
export type UnitSystem = 'imperial' | 'metric';

export const cToF = (c: number) => (c * 9) / 5 + 32;
export const fToC = (f: number) => ((f - 32) * 5) / 9;

export function fmtTemp(c: number, u: UnitSystem, digits = 1): string {
  if (!Number.isFinite(c)) return '–';
  return u === 'imperial' ? `${cToF(c).toFixed(digits)}°F` : `${c.toFixed(digits)}°C`;
}

/** A temperature difference (no 32° offset). */
export function fmtTempDelta(dc: number, u: UnitSystem, digits = 1): string {
  if (!Number.isFinite(dc)) return '–';
  return u === 'imperial' ? `${((dc * 9) / 5).toFixed(digits)}°F` : `${dc.toFixed(digits)}°C`;
}

export function fmtLength(m: number, u: UnitSystem, digits = 1): string {
  return u === 'imperial' ? `${(m * 3.28084).toFixed(digits)} ft` : `${m.toFixed(digits === 1 ? 2 : digits)} m`;
}

export function fmtSpeed(ms: number, u: UnitSystem): string {
  return u === 'imperial' ? `${(ms * 196.85).toFixed(0)} fpm` : `${ms.toFixed(2)} m/s`;
}

export function fmtPower(w: number, u: UnitSystem): string {
  return u === 'imperial' ? `${(w * 3.41214).toFixed(0)} BTU/h` : `${w.toFixed(0)} W`;
}

export function fmtDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}:${String(sec).padStart(2, '0')}`;
}

const M3S_PER_CFM = 0.000471947;
const M3H_PER_CFM = M3S_PER_CFM * 3600;
const W_PER_BTUH = 0.29307107;

/** A volumetric flow given in m³/s, shown as CFM or m³/h. */
export function fmtFlow(m3s: number, u: UnitSystem): string {
  return u === 'imperial' ? `${(m3s / M3S_PER_CFM).toFixed(0)} CFM` : `${(m3s * 3600).toFixed(0)} m³/h`;
}

/**
 * Editable quantities and their display conversions. The scene stores
 * device airflow in CFM and capacity in BTU/h (as products are labeled);
 * everything else is SI.
 */
export type Quantity = 'len' | 'temp' | 'cfm' | 'btuh' | 'watts' | 'deg' | 'num' | 'sec' | 'wind';

export const quantity: Record<Quantity, { unit: (u: UnitSystem) => string; to: (v: number, u: UnitSystem) => number; from: (v: number, u: UnitSystem) => number; digits: number }> = {
  len: { unit: (u) => (u === 'imperial' ? 'ft' : 'm'), to: (v, u) => (u === 'imperial' ? v * 3.28084 : v), from: (v, u) => (u === 'imperial' ? v / 3.28084 : v), digits: 2 },
  temp: { unit: (u) => (u === 'imperial' ? '°F' : '°C'), to: tempToDisplayImpl, from: tempFromDisplayImpl, digits: 1 },
  cfm: { unit: (u) => (u === 'imperial' ? 'CFM' : 'm³/h'), to: (v, u) => (u === 'imperial' ? v : v * M3H_PER_CFM), from: (v, u) => (u === 'imperial' ? v : v / M3H_PER_CFM), digits: 0 },
  btuh: { unit: (u) => (u === 'imperial' ? 'BTU/h' : 'W'), to: (v, u) => (u === 'imperial' ? v : v * W_PER_BTUH), from: (v, u) => (u === 'imperial' ? v : v / W_PER_BTUH), digits: 0 },
  watts: { unit: () => 'W', to: (v) => v, from: (v) => v, digits: 0 },
  deg: { unit: () => '°', to: (v) => v, from: (v) => v, digits: 0 },
  num: { unit: () => '', to: (v) => v, from: (v) => v, digits: 2 },
  sec: { unit: () => 's', to: (v) => v, from: (v) => v, digits: 1 },
  wind: { unit: (u) => (u === 'imperial' ? 'mph' : 'm/s'), to: (v, u) => (u === 'imperial' ? v * 2.23694 : v), from: (v, u) => (u === 'imperial' ? v / 2.23694 : v), digits: 1 },
};

function tempToDisplayImpl(c: number, u: UnitSystem): number {
  return u === 'imperial' ? cToF(c) : c;
}
function tempFromDisplayImpl(v: number, u: UnitSystem): number {
  return u === 'imperial' ? fToC(v) : v;
}

/** Temperature in display units -> °C, and back, for number inputs. */
export const tempToDisplay = (c: number, u: UnitSystem) => (u === 'imperial' ? cToF(c) : c);
export const tempFromDisplay = (v: number, u: UnitSystem) => (u === 'imperial' ? fToC(v) : v);
export const deltaToDisplay = (dc: number, u: UnitSystem) => (u === 'imperial' ? (dc * 9) / 5 : dc);
export const deltaFromDisplay = (v: number, u: UnitSystem) => (u === 'imperial' ? (v * 5) / 9 : v);
