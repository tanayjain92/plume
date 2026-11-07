import type { SolverStats } from '../solver/solver';
import type { SceneV1 } from '../scene/types';

export type ToWorker =
  | { type: 'load'; scene: SceneV1 }
  | { type: 'run'; running: boolean }
  /** Target sim seconds per wall second; 0 = as fast as possible. */
  | { type: 'speed'; speed: number }
  | { type: 'heat'; id: string; watts?: number; enabled?: boolean }
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

export interface SourceInfo {
  id: string;
  watts: number;
  enabled: boolean;
}

export interface FrameStats extends SolverStats {
  /** Solver steps per wall-clock second over the last chunk. */
  stepsPerSec: number;
  /** Sim seconds per wall-clock second. */
  realtimeFactor: number;
}

export interface Frame {
  stats: FrameStats;
  /** Cell-centered fields, flat index i + nx*(j + ny*k). */
  T: Float32Array;
  ux: Float32Array;
  uy: Float32Array;
  uz: Float32Array;
  div: Float32Array;
  p: Float32Array;
}

export type FromWorker =
  | { type: 'ready'; grid: GridInfo; sources: SourceInfo[]; warnings: string[] }
  | ({ type: 'frame' } & Frame)
  | { type: 'warn'; message: string }
  | { type: 'error'; message: string };
