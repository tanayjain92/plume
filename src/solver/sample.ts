/**
 * Trilinear sample of a 3D array of size sx*sy*sz at fractional grid
 * coordinates (gx, gy, gz), where integer coordinates hit array entries.
 *
 * The sample *position* is clamped to the array bounds. That is geometry
 * (a backtrace that leaves the domain reads the boundary), not a clamp of a
 * physical value, so it does not log.
 */
export function sampleGrid(
  a: ArrayLike<number>,
  sx: number,
  sy: number,
  sz: number,
  gx: number,
  gy: number,
  gz: number,
): number {
  if (gx < 0) gx = 0;
  else if (gx > sx - 1) gx = sx - 1;
  if (gy < 0) gy = 0;
  else if (gy > sy - 1) gy = sy - 1;
  if (gz < 0) gz = 0;
  else if (gz > sz - 1) gz = sz - 1;

  // Coordinates are >= 0 here, so truncation equals floor.
  let i0 = gx | 0;
  let j0 = gy | 0;
  let k0 = gz | 0;
  if (i0 > sx - 2) i0 = sx - 2;
  if (j0 > sy - 2) j0 = sy - 2;
  if (k0 > sz - 2) k0 = sz - 2;
  const fx = gx - i0;
  const fy = gy - j0;
  const fz = gz - k0;

  const sxy = sx * sy;
  const b = i0 + sx * (j0 + sy * k0);
  const c000 = a[b];
  const c100 = a[b + 1];
  const c010 = a[b + sx];
  const c110 = a[b + sx + 1];
  const c001 = a[b + sxy];
  const c101 = a[b + sxy + 1];
  const c011 = a[b + sxy + sx];
  const c111 = a[b + sxy + sx + 1];

  const x00 = c000 + fx * (c100 - c000);
  const x10 = c010 + fx * (c110 - c010);
  const x01 = c001 + fx * (c101 - c001);
  const x11 = c011 + fx * (c111 - c011);
  const y0 = x00 + fy * (x10 - x00);
  const y1 = x01 + fy * (x11 - x01);
  return y0 + fz * (y1 - y0);
}
