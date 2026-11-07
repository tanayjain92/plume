import type { DeviceReport, EnergyReport, SolverStats } from '../solver/solver';
import type { SceneV1 } from '../scene/types';

export type ToWorker =
  /**
   * Load or update the scene. With keepState, the running flow carries over
   * when the grid size is unchanged (live edits); otherwise the sim restarts.
   * Rapid updates (dragging) are coalesced: only the latest is applied.
   */
  | { type: 'scene'; scene: SceneV1; keepState: boolean }
  | { type: 'run'; running: boolean }
  /** Target sim seconds per wall second; 0 = as fast as possible. */
  | { type: 'speed'; speed: number }
  | { type: 'reset' }
  | { type: 'step' };

export interface GridInfo {
  nx: number;
  ny: number;
  nz: number;
  h: number;
  origin: [number, number, number];
  cellType: Uint8Array;
}

export interface FrameStats extends SolverStats {
  /** Solver steps per wall-clock second over the last chunk. */
  stepsPerSec: number;
  /** Sim seconds per wall-clock second. */
  realtimeFactor: number;
}

export interface Frame {
  stats: FrameStats;
  devices: DeviceReport;
  /** Heat flows into the room air averaged since the previous frame, W. */
  energy: EnergyReport;
  /** Cell-centered fields, flat index i + nx*(j + ny*k). */
  T: Float32Array;
  ux: Float32Array;
  uy: Float32Array;
  uz: Float32Array;
  div: Float32Array;
  p: Float32Array;
}

export type FromWorker =
  | { type: 'ready'; grid: GridInfo; warnings: string[]; restarted: boolean }
  | ({ type: 'frame' } & Frame)
  | { type: 'warn'; message: string }
  | { type: 'error'; message: string };
