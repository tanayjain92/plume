# Plume

Room airflow and heat simulator, targeting a **Windows desktop app** (web app wrapped in Electron or Tauri; shell not chosen yet, decide by phase 4). The build spec is `SPEC.md`: read it before starting a phase. Repo: https://github.com/tanayjain92/plume (branch `main`).

The project rules live in AGENTS.md so every coding agent reads the same file. They are imported here:

@AGENTS.md

## Current state (as of 2026-11-07)

**Phases 1 and 2 are done**: both done-when checks pass. Phase 3 (thermal and controls) is next.

What exists:

- **Solver** (`src/solver/`): staggered MAC grid; semi-Lagrangian RK2 velocity advection; explicit viscosity; Boussinesq buoyancy (T_ref = mean room temperature); MIC(0)-PCG pressure projection (Float64, warm-started); conservative MUSCL/minmod temperature transport. Boundary primitives: open cells (wind + stack-effect pressure), flow ports (vents, AC grilles, with inflow jets), fan regions with a rated-airflow controller, AC units, heat sources, box momentum sources. Unbalanced sealed rooms become logged envelope leakage. `transferStateFrom` carries the flow over when the scene is edited live.
- **Scene** (`src/scene/`): v1 scene JSON types; voxelizer for rooms, windows (open/closed), window AC, portable AC (single hose), mini split, supply/return vents (auto-mounted on the nearest wall, floor or ceiling), box/ceiling/tower fans, heat sources; shared geometry (`geometry.ts`, also used for editor glyphs); device defaults; presets (spec bedroom, cross ventilation, ceiling supply + return, heated floor patch, cold ceiling patch).
- **Worker** (`src/worker/`): runs the loop; coalesces rapid scene edits; posts fields, stats and a per-device report (AC supply/return/cooling, fan delivered airflow, vent flows).
- **UI** (`src/ui/`): plan + draggable section; temperature (centered on the AC setpoint), speed, divergence and pressure views; arrows, 3D particle tracers in a slab around each slice, draft zones; room editor (size, temps, wind); add/select/delete/toggle devices; per-type inspector in display units; drag devices on the plan (windows slide along their wall); live device readout; open/save `.plume.json`; °F/ft ↔ °C/m.
- **Tests** (`tests/`): 40 passing, ~80 s. Phase 1 suite plus open boundaries (supply out a window, cross-ventilation, stack effect, leakage), fans (direction, rated airflow, oscillation), cold inlet sinking, AC sizing (23.6 °F, SPEC's 24 °F check), AC energy removal, portable AC infiltration, mini split, live-edit transfer, determinism with devices. GPU parity is the only todo.

Verified in headless Chrome: every device type changes the flow visibly; window AC reads Δ 23.6 °F / 5,600 BTU/h sensible; fans hold ~100% of rated airflow.

## Known gaps and caveats

- **Performance:** ~45 ms/step on an empty bedroom, slower with fast jets (more CFL sub-steps): 0.4–1× realtime. The phase 4 target (30 min in under a minute) is 30–75× away.
- **Fan model is calibrated, not derived:** a controller scales each fan's forcing until the measured velocity through it equals its rating. Fans take a few seconds to spin up (ceiling fans ~6–8 s). A blocked fan caps its gain and logs a warning.
- **Open windows have no discharge coefficient:** cross-ventilation flow is an upper bound (about 1.6× a real window's).
- **AC runs continuously:** setpoint is stored but thermostat cycling is phase 3. Mini split SHR is fixed at 0.7 (the scene format has no field).
- **Leaks:** door undercuts and AC gap leak faces (sqrt-pressure law) are not built yet (phase 5).
- **Heater energy test passes by construction** and runs only 10 s; **symmetry tolerance** (1e-4 relative) was never measured and tightened.
- **Slice snapping:** slices snap to cell centers.
- Fixed device sizes (window AC 0.6 × 0.4 m, mini split head, portable AC body, tower fan slot) live in `DIMS` in `src/scene/geometry.ts`.

## Next: phase 3 notes

- Wall and window conduction: solid shell cells get U-values; exchange heat with the adjacent fluid cell (`walls[]`, `glazingU`, outdoor temp). Solar gain on closed windows (`outdoor.solar`).
- Infiltration (ACH): reuse the leakage machinery (outdoor air in at outdoor temp, spread over exterior walls).
- Thermostat: AC compressor on/off around the setpoint with a deadband; fan keeps running. `AcUnit` already exposes return temperature.
- Energy balance panel: per-source watts (AC, sun, walls, people, windows, leakage) should net to ~0 at steady state; test it.
- Stats panel + uPlot temperature chart.

## Workflow

- Commit after every green `npm test` + `npm run typecheck`, then `git push`.
- Git identity is set repo-locally (Tanay Jain).
- To check the UI: `npm run dev`. Headless checks were driven with `playwright-core` using the system Chrome (`channel: 'chrome'`); it is not a project dependency.
