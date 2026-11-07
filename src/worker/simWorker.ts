/// <reference lib="webworker" />
import { FluidSolver } from '../solver/solver';
import { setSolverLogger } from '../solver/log';
import { voxelize } from '../scene/voxelize';
import type { SceneV1 } from '../scene/types';
import type { FromWorker, ToWorker } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const CHUNK_MS = 30; // wall time spent stepping before posting a frame

let scene: SceneV1 | null = null;
let solver: FluidSolver | null = null;
let pending: { scene: SceneV1; keepState: boolean } | null = null;
let applyTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let speed = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let simDebt = 0; // sim seconds owed when running at a fixed speed
let lastTick = 0;

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

setSolverLogger((message) => post({ type: 'warn', message }));

/** Voxelize the latest pending scene and swap in a new solver, carrying the flow over when possible. */
function applyPending(): void {
  applyTimer = null;
  if (!pending) return;
  const next = pending;
  pending = null;
  try {
    const { voxels, warnings } = voxelize(next.scene);
    const fresh = new FluidSolver(voxels);
    const sameGrid = solver && solver.nx === voxels.nx && solver.ny === voxels.ny && solver.nz === voxels.nz;
    const keep = Boolean(next.keepState && solver && sameGrid);
    if (keep) fresh.transferStateFrom(solver!);
    solver = fresh;
    scene = next.scene;
    post({
      type: 'ready',
      grid: { nx: voxels.nx, ny: voxels.ny, nz: voxels.nz, h: voxels.h, origin: voxels.origin, cellType: voxels.cellType.slice() },
      warnings,
      restarted: !keep,
    });
    postFrame(0, 0);
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

function postFrame(stepsPerSec: number, realtimeFactor: number): void {
  if (!solver) return;
  const [ux, uy, uz] = solver.cellVelocity();
  const T = solver.T.slice();
  const div = solver.divergenceError();
  const p = solver.pressurePa();
  post(
    {
      type: 'frame',
      stats: { ...solver.stats(), stepsPerSec, realtimeFactor },
      devices: solver.deviceReport(),
      T,
      ux,
      uy,
      uz,
      div,
      p,
    },
    [T.buffer, ux.buffer, uy.buffer, uz.buffer, div.buffer, p.buffer],
  );
}

function tick(): void {
  timer = null;
  if (pending) applyPending();
  if (!running || !solver) return;
  const now = performance.now();
  if (speed > 0) simDebt = Math.min(simDebt + ((now - lastTick) / 1000) * speed, 2 * speed); // cap backlog to 2 s
  lastTick = now;

  const dt = solver.opts.dt;
  const t0 = performance.now();
  const sim0 = solver.time;
  let steps = 0;
  while (performance.now() - t0 < CHUNK_MS) {
    if (speed > 0 && simDebt < dt) break;
    solver.step();
    steps++;
    if (speed > 0) simDebt -= dt;
  }
  const wall = (performance.now() - t0) / 1000;
  if (steps > 0) postFrame(wall > 0 ? steps / wall : 0, wall > 0 ? (solver.time - sim0) / wall : 0);
  timer = setTimeout(tick, steps > 0 ? 0 : 8);
}

function setRunning(next: boolean): void {
  running = next;
  if (running && timer === null) {
    lastTick = performance.now();
    simDebt = 0;
    timer = setTimeout(tick, 0);
  }
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'scene':
        pending = { scene: msg.scene, keepState: msg.keepState };
        // While running, the next tick applies it; otherwise apply soon (coalescing bursts).
        if (!running && applyTimer === null) applyTimer = setTimeout(applyPending, 0);
        break;
      case 'reset':
        if (scene) {
          solver = null;
          pending = { scene, keepState: false };
          applyPending();
        }
        break;
      case 'run':
        setRunning(msg.running);
        break;
      case 'speed':
        speed = msg.speed;
        simDebt = 0;
        break;
      case 'step':
        if (pending) applyPending();
        if (solver) {
          solver.step();
          postFrame(0, 0);
        }
        break;
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
