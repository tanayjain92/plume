# Plume

Room airflow and heat simulator, targeting a **Windows desktop app** (web app wrapped in Electron or Tauri; shell not chosen yet, decide by phase 4). The build spec is `SPEC.md`: read it before starting a phase. Repo: https://github.com/tanayjain92/plume (branch `main`).

The project rules live in AGENTS.md so every coding agent reads the same file. They are imported here:

@AGENTS.md

## Current state (as of 2026-11-07)

**Phase 1 (solver core) is done**: its done-when check passes. Phase 2 (single room editor) is next.

What exists:

- **Solver** (`src/solver/`): staggered MAC grid; semi-Lagrangian RK2 velocity advection; explicit viscosity; Boussinesq buoyancy with T_ref = mean room temperature; pressure projection with MIC(0)-preconditioned CG (Float64 internally, warm-started, 4–9 iterations per step on the bedroom grid); conservative MUSCL/minmod temperature transport, sub-stepped. Heat sources (`HeatSource`, negative watts = sink) and box body forces (`MomentumSource`, the basis for phase 2 fans). Walls are free-slip, adiabatic and sealed.
- **Scene** (`src/scene/`): full v1 scene JSON types for every device in SPEC; voxelizer (rooms + heat sources only, one-cell solid shell, reports every unsupported feature in `warnings`); presets: heated floor patch, cold ceiling patch, SPEC sample bedroom.
- **Worker** (`src/worker/`): runs the solver loop, posts cell-centered T/velocity/divergence/pressure frames, forwards `solverWarn` messages to the UI.
- **UI** (`src/ui/`): floor plan slice (default 1.1 m) + draggable vertical section (along x or y); fields: temperature (diverging, centered on a settable temperature), air speed, divergence and pressure debug views; overlays: quiver arrows, particle tracers, draft zones; live heat-source sliders; stats row; °F/ft ↔ °C/m switch.
- **Tests** (`tests/`): 22 passing. Mass conservation, heater energy balance, wall leak, buoyancy direction + plume spreads along ceiling, symmetry, determinism, voxelizer, solver purity. `tests/later.test.ts` holds todos for AC sizing (phase 3), true cold inlet (phase 2) and GPU parity (phase 4).

Verified in headless Chrome: the floor patch plume rises and spreads along the ceiling; max divergence stays around 1e-5 1/s.

## Known gaps and caveats

- **Performance:** ~45 ms/step on the 40 × 36 × 27 bedroom (~1× realtime). Velocity advection is ~2/3 of the cost. The phase 4 target (30 min in under a minute) is ~30× away.
- **Heater energy test passes by construction** (transport is exactly conservative) and runs only 10 s of room time; it checks bookkeeping more than physics.
- **Symmetry tolerance is 1e-4 relative**, chosen without measuring the actual error; looser than SPEC's "within float error". Measure and tighten.
- **Particles are 2D**: advected only by in-plane velocity of the slice, so they bunch up or vanish where flow crosses the slice. Phase 2's done-when check relies on the particle view, so consider 3D particles there.
- **Slice snapping:** slices snap to cell centers, so the slider label (e.g. 3.6 ft) and view title (3.8 ft) can disagree.
- **Cold-air buoyancy test** uses a negative heat source, not a real inlet.

## Next: phase 2 notes

- Inlets, outlets and open windows break the sealed-room assumption: `PressureSolver` currently removes the mean per component (pure Neumann). Open/outlet cells need Dirichlet pressure, and inlet faces need prescribed velocities that projection does not overwrite.
- Fans: build actuator disks / tower fan slots on top of `MomentumSource`; convert CFM once in the voxelizer.
- Window AC: supply jet + return intake on the same unit, supply temperature drop capped by sensible capacity (SPEC "AC math").
- Phase 4 caveat: MIC(0) is sequential and the pressure solve is Float64; the WebGPU port needs a parallel preconditioner/multigrid and a deliberate Float32 parity tolerance.

## Workflow

- Commit after every green `npm test` + `npm run typecheck`, then `git push`.
- Git identity is set repo-locally (Tanay Jain).
- To check the UI: `npm run dev`. Headless checks were driven with `playwright-core` using the system Chrome (`channel: 'chrome'`); it is not a project dependency.
