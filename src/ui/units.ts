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

/** Temperature in display units -> °C, and back, for number inputs. */
export const tempToDisplay = (c: number, u: UnitSystem) => (u === 'imperial' ? cToF(c) : c);
export const tempFromDisplay = (v: number, u: UnitSystem) => (u === 'imperial' ? fToC(v) : v);
export const deltaToDisplay = (dc: number, u: UnitSystem) => (u === 'imperial' ? (dc * 9) / 5 : dc);
export const deltaFromDisplay = (v: number, u: UnitSystem) => (u === 'imperial' ? (v * 5) / 9 : v);
