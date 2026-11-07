type Stop = [number, string];

/** Diverging blue–white–red (ColorBrewer RdBu), centered on the setpoint. */
const DIVERGING: Stop[] = [
  [0, '#2166ac'],
  [0.25, '#67a9cf'],
  [0.5, '#f7f7f7'],
  [0.75, '#ef8a62'],
  [1, '#b2182b'],
];

/** Sequential (viridis-like) for speed. */
const SEQUENTIAL: Stop[] = [
  [0, '#30123b'],
  [0.25, '#3b528b'],
  [0.5, '#21918c'],
  [0.75, '#5ec962'],
  [1, '#fde725'],
];

function hex(c: string): [number, number, number] {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}

function buildLut(stops: Stop[], size = 256): Uint8Array {
  const lut = new Uint8Array(size * 3);
  const cols = stops.map(([t, c]) => [t, ...hex(c)] as const);
  for (let i = 0; i < size; i++) {
    const t = i / (size - 1);
    let s = 0;
    while (s < cols.length - 2 && t > cols[s + 1][0]) s++;
    const [t0, r0, g0, b0] = cols[s];
    const [t1, r1, g1, b1] = cols[s + 1];
    const f = (t - t0) / (t1 - t0);
    lut[i * 3] = Math.round(r0 + f * (r1 - r0));
    lut[i * 3 + 1] = Math.round(g0 + f * (g1 - g0));
    lut[i * 3 + 2] = Math.round(b0 + f * (b1 - b0));
  }
  return lut;
}

export const LUT_DIVERGING = buildLut(DIVERGING);
export const LUT_SEQUENTIAL = buildLut(SEQUENTIAL);

export function lutCss(lut: Uint8Array, t: number): string {
  const i = Math.max(0, Math.min(255, Math.round(t * 255))) * 3;
  return `rgb(${lut[i]},${lut[i + 1]},${lut[i + 2]})`;
}

export function lutGradient(lut: Uint8Array): string {
  const stops: string[] = [];
  for (let s = 0; s <= 8; s++) stops.push(`${lutCss(lut, s / 8)} ${(s / 8) * 100}%`);
  return `linear-gradient(to right, ${stops.join(', ')})`;
}
