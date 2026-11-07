# Plume: agent instructions

Plume is a room airflow and heat simulator. **`SPEC.md` is the source of truth**: read it before changing anything.

**Target: Windows desktop app.** The code stays a TypeScript web app (it runs in `npm run dev` in Chrome/Edge), later wrapped in a desktop shell (Electron or Tauri, not yet chosen). Don't add browser-only assumptions that a desktop shell would break, and don't add the shell until that decision is made.

## Status

| Phase | State |
|---|---|
| 1. Solver core | Done. CPU solver, MIC(0)-PCG pressure projection, buoyancy, conservative temperature transport, plan and section slice views |
| 2. Single room editor | Done. Open windows (wind + stack effect), vents, window/portable AC, mini split, box/ceiling/tower fans, room editor with drag and live edits |
| 3. Thermal and controls | Done. Wall/glass conduction, infiltration, solar gain, fan motor heat, thermostat cycling, live energy balance, temperature chart, predicted settling temperature |
| 4. Performance | Next |
| 5–6 | Not started |

## How to work

- **One phase per session.** Plan the phase first, then write the tests from the validation table in `SPEC.md`, then the code.
- **Don't start a phase until the previous one passes its checks** (`npm test` green, `npm run typecheck` clean).
- **Commit after every green test run** so a bad session can be rolled back cleanly.

## Hard rules

1. **Keep the solver pure.** Nothing under `src/solver/` may import React, touch the DOM (`window`, `document`, canvas), or use worker globals (`self`, `postMessage`). It takes a `VoxelScene`, steps it, and hands back typed arrays. `tests/purity.test.ts` enforces this.
2. **Ban silent clamping.** Never clamp velocity, temperature or pressure to hide instability. Any clamp of a physical quantity must call `solverWarn(...)` from `src/solver/log.ts`. (Clamping a semi-Lagrangian *sample position* to the domain is geometry, not physics, and is allowed.)
3. **SI inside, display units at the edge.** The solver and scene JSON use meters, °C, watts, m/s. CFM and BTU/h on devices are converted once by the voxelizer. Imperial/metric conversion happens only in `src/ui/units.ts`.
4. **Watch the walls.** Faces touching a solid cell have zero velocity, always. The divergence and pressure debug fields in the UI exist to catch leaks; use them.
5. **Determinism.** Same scene and options must give bit-identical output. No `Math.random()` or wall-clock time inside the solver.
6. Fluid cells must never touch the grid boundary. The voxelizer adds a one-cell solid shell, and the solver throws if this is violated.

## Layout

```
src/solver/   pure CPU reference solver (MAC grid, PCG, advection). No UI imports.
src/scene/    scene JSON types (SPEC "Scene data model"), presets, voxelizer
src/worker/   Web Worker wrapping the solver + message protocol
src/ui/       React app, canvas slice renderers, colormaps, units
tests/        Vitest validation suite (mirrors SPEC "Validation tests")
```

## Solver notes

- Grid indexing: cell `(i,j,k)` is `i + nx*(j + ny*k)`. `u` faces: `(nx+1)*ny*nz`, `v`: `nx*(ny+1)*nz`, `w`: `nx*ny*(nz+1)`. A `w` face `(i,j,k)` has the same flat index as cell `(i,j,k)` (the cell above it).
- Pressure is solved in velocity units (`p̃ = dt·p/(ρ·h)`), so a face correction is `u -= p̃[R] - p̃[L]` and the CG residual equals `-h · divergence`.
- Temperature uses a conservative finite-volume MUSCL/minmod scheme with sub-stepping, so sealed adiabatic rooms conserve energy exactly (the heater energy-balance test depends on this). Velocity uses semi-Lagrangian RK2 backtracing.
- Walls are free-slip for tangential velocity and no-penetration for normal velocity.
- Boundary primitives (all in `src/solver/grid.ts`): **open cells** (`CellType.Open`, Dirichlet pressure = wind + stack effect, outdoor temperature), **flow ports** (fixed normal velocity on fluid/solid faces: vents and AC grilles), **fan regions** (velocity relaxation plus a rated-airflow controller), **AC units** (supply temp = return temp − sensible capacity / ρ·cp·V̇).
- A sealed region whose ports don't balance can't be divergence free. The solver treats the imbalance as uniform envelope leakage (outdoor air in, or room air out), logs a warning, and `maxDivergence()` measures error relative to that leakage. Never "fix" an imbalance silently.

## Commands

```
npm run dev        # Vite dev server
npm test           # Vitest validation suite
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + production build
```
