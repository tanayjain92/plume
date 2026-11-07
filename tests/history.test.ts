import { describe, expect, it } from 'vitest';
import type { EnergyReport } from '../src/solver/solver';
import { EnergyWindow, MAX_SAMPLES, TempHistory } from '../src/ui/history';

const sample = (t: number, mean = 25) => ({ t, mean, floor: mean - 1, ceiling: mean + 1, outdoor: 30 });

const report = (seconds: number, watts: number): EnergyReport => ({
  seconds,
  sources: watts,
  sun: 0,
  fans: 0,
  walls: 0,
  glass: 0,
  infiltration: 0,
  ac: 0,
  vents: 0,
  leakage: 0,
  openWindows: 0,
  net: watts,
  storage: watts,
});

describe('temperature history', () => {
  it('starts over when room time goes backwards (Reset)', () => {
    const h = new TempHistory();
    for (let t = 0; t < 10; t++) h.push(sample(t));
    h.push(sample(0));
    expect(h.samples.map((s) => s.t)).toEqual([0]);
  });

  it('stays bounded and keeps the whole run on a long simulation', () => {
    const h = new TempHistory();
    for (let t = 0; t <= 10 * 3600; t += 0.5) h.push(sample(t));
    expect(h.samples.length).toBeLessThanOrEqual(MAX_SAMPLES);
    expect(h.samples.length).toBeGreaterThan(MAX_SAMPLES / 2);
    expect(h.samples[0].t).toBe(0);
    expect(h.samples[h.samples.length - 1].t).toBeGreaterThan(10 * 3600 - 120);
  });
});

describe('energy balance averaging', () => {
  it('weights each report by the room time it covers', () => {
    const e = new EnergyWindow(60);
    e.push(10, report(10, 100));
    e.push(40, report(30, 200));
    const a = e.average()!;
    expect(a.seconds).toBe(40);
    expect(a.sources).toBeCloseTo((10 * 100 + 30 * 200) / 40, 9);
    expect(a.net).toBeCloseTo(a.storage, 9);
  });

  it('only covers the recent window and starts over on Reset', () => {
    const e = new EnergyWindow(60);
    for (let t = 1; t <= 300; t++) e.push(t, report(1, t < 200 ? 0 : 50));
    expect(e.average()!.seconds).toBeLessThanOrEqual(61);
    expect(e.average()!.sources).toBeCloseTo(50, 9);
    e.push(1, report(1, 7));
    expect(e.average()!.sources).toBe(7);
  });
});
