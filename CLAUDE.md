# Plume

Room airflow and heat simulator, targeting a **Windows desktop app** (web app wrapped in Tauri, chosen 2026-11-07) plus the same app on GitHub Pages. The build spec is `SPEC.md`: read it before starting a phase. Repo: https://github.com/tanayjain92/plume (branch `main`).

The project rules live in AGENTS.md so every coding agent reads the same file. They are imported here:

@AGENTS.md

## Current state (as of 2026-11-07)

**Phases 1–3 are done**: all done-when checks pass. Phase 4 (performance: WebGPU port) is next.

Phase 3 added: `envelope` in the scene (wall U, ACH, which walls face outdoors; missing = adiabatic), glass conduction, infiltration, fan motor heat (`FAN_MOTOR_W`), thermostat with a ±0.55 °C deadband on return air, a per-source `EnergyReport` from the solver (people, sun, fans, walls, glass, leaks, AC, vents, open windows; net equals stored heat), the Energy balance panel and uPlot temperature chart (`src/ui/history.ts`, `EnergyPanel.tsx`, `TempChart.tsx`), the whole-room settling prediction (`src/scene/predict.ts`), temperature sensors, undo (Ctrl+Z), and aim arrows on fans and ACs (drag the tip: direction + strength, `aimArrow` in `src/scene/editing.ts`).

What exists:

- **Solver** (`src/solver/`): staggered MAC grid; semi-Lagrangian RK2 velocity advection; explicit viscosity; Boussinesq buoyancy (T_ref = mean room temperature); MIC(0)-PCG pressure projection (Float64, warm-started); conservative MUSCL/minmod temperature transport. Boundary primitives: open cells (wind + stack-effect pressure), flow ports (vents, AC grilles, with inflow jets), fan regions with a rated-airflow controller, AC units, heat sources, box momentum sources. Unbalanced sealed rooms become logged envelope leakage. `transferStateFrom` carries the flow over when the scene is edited live.
- **Scene** (`src/scene/`): v1 scene JSON types; voxelizer for rooms, windows (open/closed), window AC, portable AC (single hose), mini split, supply/return vents (auto-mounted on the nearest wall, floor or ceiling), box/ceiling/tower fans, heat sources; shared geometry (`geometry.ts`, also used for editor glyphs); device defaults; presets (spec bedroom, cross ventilation, ceiling supply + return, heated floor patch, cold ceiling patch).
- **Worker** (`src/worker/`): runs the loop; coalesces rapid scene edits; posts fields, stats and a per-device report (AC supply/return/cooling, fan delivered airflow, vent flows).
- **UI flow (user-directed, 2026-11-07):** the app opens on a "Define your space" screen (`SetupScreen.tsx`: standard sizes, custom size, or free-form drawing with grid and 45° snapping). The editor then shows **one view** with a Top/Side switch (the user asked for a single view; the side cut is how stratification stays visible), and a right-hand **Controls** panel (`Controls.tsx`): pick a tool, click in the room to place it (wall tools snap to the nearest wall, fans aim at the room center), then set strength with chips + slider. Placement and strength logic is pure, in `src/scene/defaults.ts` (`placeTool`, `strengthFor`). A **Select** tool (default mode) selects objects: resize handles in the top view (window ends, corner handles, fan diameter, the sun aim arrow; pure logic in `src/scene/editing.ts`), a floating action bar (window Open/Closed and narrower/wider, device On/Off and rotate, Remove), double-click toggles a window. **Sunshine** is a `sun` device placed *outside* the room (the top view has an outdoor margin): heading + elevation; `src/scene/solar.ts` projects each sun-facing window onto the floor (glass transmits 0.7, open 1.0) and the voxelizer turns those patches into floor heat. Light that hits a wall instead of the floor is not counted yet (the panel says how much); wall heating is phase 3. The hand-placed `sun_patch` device still works but is not in the palette.
- **UI** (`src/ui/`): temperature (centered on the AC setpoint), speed, divergence and pressure views; arrows, 3D particle tracers in a slab around each slice, draft zones; room editor (size, temps, wind); add/select/delete/toggle devices; per-type inspector in display units; drag devices on the plan (windows slide along their wall); live device readout; open/save `.plume.json`; °F/ft ↔ °C/m.
- **Tests** (`tests/`): 83 passing, ~95 s (phase 3 adds `thermal`, `history`, `aim`). Includes click-to-place for every tool, free-form (L-shaped) rooms and sun patches. Phase 1 suite plus open boundaries (supply out a window, cross-ventilation, stack effect, leakage), fans (direction, rated airflow, oscillation), cold inlet sinking, AC sizing (23.6 °F, SPEC's 24 °F check), AC energy removal, portable AC infiltration, mini split, live-edit transfer, determinism with devices. GPU parity is the only todo.

Verified in headless Chrome: every device type changes the flow visibly; window AC reads Δ 23.6 °F / 5,600 BTU/h sensible; fans hold ~100% of rated airflow.

## Known gaps and caveats

- **Performance:** ~45 ms/step on an empty bedroom, slower with fast jets (more CFL sub-steps): 0.4–1× realtime. The phase 4 target (30 min in under a minute) is 30–75× away.
- **Fan model is calibrated, not derived:** a controller scales each fan's forcing until the measured velocity through it equals its rating. Fans take a few seconds to spin up (ceiling fans ~6–8 s). A blocked fan caps its gain and logs a warning.
- **Open windows have no discharge coefficient:** cross-ventilation flow is an upper bound (about 1.6× a real window's).
- **Thermostat** reads the AC's own return air, so a unit whose cold supply short-circuits into its return can cycle off early. Mini split SHR is fixed at 0.7 (the scene format has no field).
- **Leaks:** door undercuts and AC gap leak faces (sqrt-pressure law) are not built yet (phase 5).
- **Heater energy test passes by construction** and runs only 10 s; **symmetry tolerance** (1e-4 relative) was never measured and tightened.
- **Slice snapping:** slices snap to cell centers.
- Fixed device sizes (window AC 0.6 × 0.4 m, mini split head, portable AC body, tower fan slot) live in `DIMS` in `src/scene/geometry.ts`.

## Since phase 3 (user requests, 2026-11-07)

- **Object colors:** optional `color` (#rrggbb) on devices and openings, editor only; swatch menu in the action bar shades the glyph solid.
- **Auto fields:** `src/scene/weather.ts` (pure: NOAA sun position, Open-Meteo URL building and parsing, `applyWeather`, `autoRoomTemp` = predicted settled temperature) and `src/ui/openMeteo.ts` (fetch + cache). Scene `site` = {name, lat, lon, when?}; top of plan = north. Auto on room temp restarts the run (keepState false). Needs internet; Tauri will need a CSP/allowlist entry for `*.open-meteo.com`.
- **GitHub Pages:** one-time manual step: repo Settings → Pages → Source: GitHub Actions.

## Phase 3 leftovers

- Per-wall heat-flux bars on the plan (SPEC visualization) are not built.
- The simulated air has no furniture/wall heat capacity, so it warms and cools much faster than the prediction card (which includes it).

## Old phase 3 notes (done)

- Wall and window conduction: solid shell cells get U-values; exchange heat with the adjacent fluid cell (`walls[]`, `glazingU`, outdoor temp). Solar gain on closed windows (`outdoor.solar`).
- Infiltration (ACH): reuse the leakage machinery (outdoor air in at outdoor temp, spread over exterior walls).
- Thermostat: AC compressor on/off around the setpoint with a deadband; fan keeps running. `AcUnit` already exposes return temperature.
- Energy balance panel: per-source watts (AC, sun, walls, people, windows, leakage) should net to ~0 at steady state; test it.
- Stats panel + uPlot temperature chart.

## Workflow

- The project lives in OneDrive: Vite's file watcher has missed saves at least once (stale module served). If the UI doesn't reflect an edit, restart `npm run dev`.

- Commit after every green `npm test` + `npm run typecheck`, then `git push`.
- Git identity is set repo-locally (Tanay Jain).
- To check the UI: `npm run dev`. Headless checks were driven with `playwright-core` using the system Chrome (`channel: 'chrome'`); it is not a project dependency.
