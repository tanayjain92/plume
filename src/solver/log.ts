/**
 * Solver warnings. Every clamp of a physical quantity, every failed pressure
 * solve and every other "the physics went sideways" event must go through
 * here so it is never silent. The worker redirects this to the UI.
 */
export type SolverLogger = (message: string) => void;

let logger: SolverLogger = (message) => console.warn(`[solver] ${message}`);

export function setSolverLogger(next: SolverLogger): void {
  logger = next;
}

export function solverWarn(message: string): void {
  logger(message);
}
