import type { GridInfo } from '../worker/protocol';

/** Which axis the slice is perpendicular to. 'z' = floor plan, 'x'/'y' = vertical sections. */
export type SliceAxis = 'x' | 'y' | 'z';

export interface SliceGeometry {
  /** Width and height of the slice in cells (horizontal axis a, vertical axis b; b points up). */
  W: number;
  H: number;
  /** Flat 3D cell index of slice cell (a, b). */
  cell: (a: number, b: number) => number;
  /** In-plane velocity components: which of ux/uy/uz map to a and b. */
  velA: 'ux' | 'uy';
  velB: 'uy' | 'uz';
  /** World-axis names for labels. */
  axisA: 'x' | 'y';
  axisB: 'y' | 'z';
}

export function sliceGeometry(grid: GridInfo, axis: SliceAxis, index: number): SliceGeometry {
  const { nx, ny, nz } = grid;
  switch (axis) {
    case 'z':
      return { W: nx, H: ny, cell: (a, b) => a + nx * (b + ny * index), velA: 'ux', velB: 'uy', axisA: 'x', axisB: 'y' };
    case 'y':
      return { W: nx, H: nz, cell: (a, b) => a + nx * (index + ny * b), velA: 'ux', velB: 'uz', axisA: 'x', axisB: 'z' };
    case 'x':
      return { W: ny, H: nz, cell: (a, b) => index + nx * (a + ny * b), velA: 'uy', velB: 'uz', axisA: 'y', axisB: 'z' };
  }
}

/** Number of cells along a world axis. */
export function axisCells(grid: GridInfo, axis: SliceAxis): number {
  return axis === 'x' ? grid.nx : axis === 'y' ? grid.ny : grid.nz;
}

/** World coordinate (m) of the center of cell `i` along an axis. */
export function cellCenter(grid: GridInfo, axis: SliceAxis, i: number): number {
  const o = axis === 'x' ? grid.origin[0] : axis === 'y' ? grid.origin[1] : grid.origin[2];
  return o + (i + 0.5) * grid.h;
}

/** Cell index containing world coordinate `m` along an axis, restricted to the interior. */
export function cellAt(grid: GridInfo, axis: SliceAxis, m: number): number {
  const o = axis === 'x' ? grid.origin[0] : axis === 'y' ? grid.origin[1] : grid.origin[2];
  const n = axisCells(grid, axis);
  return Math.max(1, Math.min(n - 2, Math.floor((m - o) / grid.h)));
}
