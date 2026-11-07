import { describe, it } from 'vitest';

// Validation rows from SPEC.md that belong to later phases. They stay visible
// here so nobody forgets them.
describe('later phases', () => {
  it.todo('AC sizing: 8,000 BTU/h window AC at 220 CFM, SHR 0.7 settles near a 24°F supply-to-return difference (phase 3)');
  it.todo('Buoyancy direction with a true cold inlet at the ceiling (phase 2)');
  it.todo('GPU parity: CPU and WebGPU fields match after 1,000 steps on a small grid (phase 4)');
});
