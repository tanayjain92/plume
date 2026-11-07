import type { EnergyReport } from '../solver/solver';

/** One point on the temperature chart, °C at room time t (s). */
export interface TempSample {
  t: number;
  mean: number;
  floor: number;
  ceiling: number;
  outdoor: number;
  /** AC setpoint, if there is an AC. */
  setpoint?: number;
}

/** Most points kept; past this, every other point is dropped so the whole run still fits. */
export const MAX_SAMPLES = 1200;

/**
 * Room temperature over time for the chart. Starts over when room time goes
 * backwards (Reset, new scene). Points closer together than `minGap` seconds
 * are skipped; the gap doubles each time the history is thinned, so a long
 * run keeps an even spread from start to now.
 */
export class TempHistory {
  samples: TempSample[] = [];
  private minGap = 1;

  push(s: TempSample): void {
    const last = this.samples[this.samples.length - 1];
    if (last && s.t < last.t) this.clear();
    else if (last && s.t - last.t < this.minGap) return;
    this.samples.push(s);
    if (this.samples.length > MAX_SAMPLES) {
      this.samples = this.samples.filter((_, i) => i % 2 === 0 || i === this.samples.length - 1);
      this.minGap *= 2;
    }
  }

  clear(): void {
    this.samples = [];
    this.minGap = 1;
  }
}

/** Heat-flow keys in an EnergyReport, in display order. */
export const ENERGY_KEYS = ['ac', 'sun', 'sources', 'fans', 'walls', 'glass', 'infiltration', 'leakage', 'openWindows', 'vents'] as const;
export type EnergyKey = (typeof ENERGY_KEYS)[number];

export interface EnergyAverage extends Record<EnergyKey, number> {
  /** Room time covered, s. */
  seconds: number;
  net: number;
  storage: number;
}

/**
 * Averages the per-frame energy reports over the last `window` seconds of
 * room time, weighting each report by the time it covers. Starts over when
 * room time goes backwards.
 */
export class EnergyWindow {
  private reports: { end: number; r: EnergyReport }[] = [];
  constructor(readonly window = 60) {}

  push(end: number, r: EnergyReport): void {
    const last = this.reports[this.reports.length - 1];
    if (last && end < last.end) this.reports = [];
    if (r.seconds <= 0) return;
    this.reports.push({ end, r });
    while (this.reports.length > 1 && end - this.reports[1].end >= this.window) this.reports.shift();
  }

  clear(): void {
    this.reports = [];
  }

  average(): EnergyAverage | null {
    if (!this.reports.length) return null;
    const out = { seconds: 0, net: 0, storage: 0 } as EnergyAverage;
    for (const k of ENERGY_KEYS) out[k] = 0;
    for (const { r } of this.reports) {
      out.seconds += r.seconds;
      out.net += r.net * r.seconds;
      out.storage += r.storage * r.seconds;
      for (const k of ENERGY_KEYS) out[k] += r[k] * r.seconds;
    }
    out.net /= out.seconds;
    out.storage /= out.seconds;
    for (const k of ENERGY_KEYS) out[k] /= out.seconds;
    return out;
  }
}
