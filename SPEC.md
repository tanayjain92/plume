# Room Airflow Simulator: Build Spec

Nov 2, 2026 · Tanay Jain

## Overview

Build a coarse 3D airflow and heat simulator on a voxel grid and show it as 2D slices plus a simple 3D view. Fans, vents, AC and open windows are physical sources in one shared fluid, so their interactions come out of the math instead of being scripted.

One grid covers the whole floor plan. Going from a bedroom to a full apartment means a bigger grid with doors and interior walls, not a rewrite.

**Why 3D and not a flat floor plan:** hot air rises and AC air sinks. Gravity points out of a top-down plan, so pure 2D can't show stratification or cold air pooling on the floor. A 10 cm grid stays cheap: a 4 x 4 x 2.7 m bedroom is about 43,000 cells and a 12 x 10 m apartment is about 324,000.

**Scope:** this is a planning and intuition tool. It answers questions like "where does the AC air actually go" or "which fan spot cools the bed fastest". Treat temperatures as directional, not certified engineering numbers.

## Physics model

Use incompressible Navier-Stokes with the Boussinesq approximation for buoyancy, plus an advection-diffusion equation for temperature. This is the standard "stable fluids" approach used in games and quick CFD, and it is well documented enough that coding agents get it right.

```latex
\frac{\partial \mathbf{u}}{\partial t} + (\mathbf{u}\cdot\nabla)\mathbf{u} = -\frac{\nabla p}{\rho} + \nu_{eff}\nabla^2\mathbf{u} + g\beta(T - T_{ref})\hat{z} + \mathbf{f}_{fans}
```

```latex
\nabla \cdot \mathbf{u} = 0
```

```latex
\frac{\partial T}{\partial t} + \mathbf{u}\cdot\nabla T = \alpha_{eff}\nabla^2 T + \frac{q}{\rho c_p}
```

**Constants:** ρ = 1.2 kg/m³, cp = 1005 J/kg·K, g = 9.81 m/s², β = 1/T in kelvin (about 0.0034 1/K). Real air viscosity is far too small to matter at 10 cm cells. Use a tunable effective value instead, starting around 0.005 m²/s, with α_eff = ν_eff / 0.85.

**Grid:** staggered MAC grid. Velocity components live on cell faces, pressure and temperature at cell centers. Every cell has a type: fluid, solid, inlet, outlet or open boundary.

**One simulation step:**

1. Apply device sources: fan forces, vent and AC velocities, heat from people and electronics.
2. Add buoyancy force from the temperature field.
3. Advect velocity with semi-Lagrangian backtracing (MacCormack later for less smearing).
4. Project: solve the pressure Poisson equation, then subtract the pressure gradient so the flow is divergence free. Start with Jacobi iterations, move to multigrid or PCG once it works.
5. Advect and diffuse temperature.
6. Exchange heat with walls and windows.
7. Update controllers, for example an AC thermostat cycling on and off.

**Timestep:** keep CFL at or below 1. At 10 cm cells and 2 m/s peak speed that is about 0.05 s. Run many steps per frame so 30 minutes of room time plays back in under a minute.

## Objects and boundary conditions

Every object becomes either a boundary condition on grid cells or a source term inside the fluid. Fans move air without adding or removing any, while vents and AC units push air in and pull it out.

| Object | How it is modeled | Key parameters |
|---|---|---|
| Exterior wall | Solid cells that conduct heat to outdoor temp | U-value (W/m²·K), outdoor temp |
| Interior wall | Solid cells, adiabatic at first, later coupled to the next room | U-value |
| Closed window | Solid cells with high U-value plus solar gain | Glazing U-value, sun W/m² |
| Open window | Open pressure boundary at outdoor temp, wind sets pressure on that face | Opening size, wind speed and direction |
| Supply vent | Velocity inlet | Airflow (CFM), supply temp, direction |
| Return vent | Outlet removing the same volume | Airflow (CFM) |
| Window AC | Cold supply jet plus return intake on the same unit, heat rejected outside | Capacity (BTU/h), airflow, setpoint, sensible heat ratio |
| Portable AC (single hose) | Like window AC, but exhaust pulls room air out and outdoor air leaks back in | Same plus exhaust CFM |
| Mini split | Indoor head with supply louver and return grille | Capacity, airflow, louver angle |
| Box or ceiling fan | Actuator disk: momentum source along an axis, zero net mass | Diameter, airflow, direction (ceiling fan can reverse) |
| Tower fan | Tall thin momentum source that sweeps side to side | Slot height, airflow, oscillation angle and period |
| Door | Open cells, closed solid or cracked; undercut handled as a leak face | State, undercut gap |
| Heat source | Volumetric heat in a small box | Watts (person about 100, desktop 100 to 300) |
| Infiltration | Slow leak of outdoor air spread across exterior walls | Air changes per hour |

**AC math:** cap the supply air temperature drop by capacity using the sensible heat formula below. Default sensible heat ratio to 0.7 since part of the capacity goes to dehumidifying.

```latex
Q_{sensible}\ [BTU/h] = 1.08 \times CFM \times \Delta T\ [^{\circ}F]
```

An 8,000 BTU/h unit at 220 CFM gives about 5,600 BTU/h sensible, so the supply runs roughly 24°F colder than the return air.

**Sub-grid details:** a 2 cm door undercut can't be drawn with 10 cm cells. Model it as a leak face where flow scales with the square root of the pressure difference. The same trick works for gaps around window AC units.

## Visualization and outputs

The main view is a floor plan slice at a chosen height, default 1.1 m (seated head height), next to a vertical section you can drag across the room. Every overlay below can be toggled on either slice.

- **Temperature heatmap:** diverging color scale centered on the thermostat setpoint, so warm and cool zones read instantly.
- **Airflow arrows:** a quiver grid where arrow length and opacity scale with speed.
- **Particle tracers:** a few thousand particles carried by the flow. This is what makes direction and strength obvious to a non-engineer.
- **Heat flux:** arrows for heat carried by moving air, plus a colored bar on each wall and window showing watts gained or lost.
- **Draft zones:** shading where air speed passes a threshold, default 0.25 m/s.
- **Room stats panel:** average, min and max temp, floor to ceiling difference, and a live chart of average temp over time.
- **Energy balance:** watts in and out per source (AC, sun, walls, people, open windows). At steady state these should net to about zero.
- **Scenario compare:** run two device setups side by side from the same starting state.

Devices toggle on and off live while the sim runs. The UI shows °F, ft, CFM and BTU/h with a switch to metric. Everything inside the solver stays SI.

## Tech stack and architecture

> **Decision 2026-11-07: Plume ships as a Windows desktop app.** The app stays a TypeScript web app inside, so everything below still applies, and it gets wrapped in a desktop shell (Electron or Tauri). The shell choice is deferred until phase 4 at the latest. Mac support and "no install" are dropped as goals. Phase 6 "save and share" means scene files on disk.

Build it as a browser app in TypeScript. No install, works on Windows and Mac, and WebGPU runs in Chrome and Edge for the heavy lifting later.

- **UI:** Vite, React and TypeScript for the editor and panels.
- **Solver:** a Web Worker using Float32Array. This plain CPU version is the reference implementation and stays in the repo forever.
- **GPU:** WebGPU compute shaders (WGSL) in phase 4, tested against the CPU solver on small grids.
- **Rendering:** Canvas 2D or WebGL for slices and particles. Three.js for the optional 3D view.
- **Charts and tests:** uPlot for time series, Vitest for unit tests.

The UI only edits scene data and reads results back (app architecture: 6 parts, 1 feedback loop):

```
Scene editor (React)    draw rooms, place windows, vents and devices
        |
        v
Scene JSON              plain data in SI units, versioned, saved and shared
        |
        v
Voxelizer               turns the scene into cell types and device masks
        |
        v
Solver (Web Worker,     runs the step loop, owns velocity, pressure, temp   <--+
later WebGPU)                                                                  |
        |                                                                      | sets device state
        +-----------------------------+                                        |
        v                             v                                        |
Renderers                     Stats and controllers  --------------------------+
plan and section slices,      room averages, energy balance, charts;
arrows, particles;            thermostats switch the AC on and off
optional Three.js 3D view
```

The solver has no UI imports. It takes a voxelized scene, steps it and hands back typed arrays, which keeps it testable and easy to port to the GPU.

## Scene data model

A scene is one JSON file in SI units: meters, °C, watts and m/s. The UI converts to imperial for display. Positions are [x, y, z] in meters with z up from the floor, and headings are degrees clockwise from +y.

```json
{
  "version": 1,
  "grid": { "cellSize": 0.1 },
  "outdoor": { "temp": 31, "windSpeed": 2.0, "windFrom": 270, "solar": 500 },
  "rooms": [
    {
      "id": "bedroom",
      "outline": [[0, 0], [4, 0], [4, 3.6], [0, 3.6]],
      "height": 2.7,
      "initialTemp": 28
    }
  ],
  "walls": [
    { "room": "bedroom", "edge": 0, "exterior": true, "uValue": 0.6 },
    { "room": "bedroom", "edge": 1, "exterior": false }
  ],
  "openings": [
    {
      "id": "win1", "type": "window", "room": "bedroom", "edge": 0,
      "offset": 1.2, "width": 1.0, "sill": 0.9, "height": 1.2,
      "state": "closed", "glazingU": 2.8
    }
  ],
  "devices": [
    {
      "id": "ac1", "type": "window_ac", "mountedIn": "win1",
      "capacityBtuh": 8000, "airflowCfm": 220, "shr": 0.7,
      "setpoint": 22, "enabled": true
    },
    {
      "id": "fan1", "type": "tower_fan", "pos": [3.4, 0.4, 0], "heading": 315,
      "slotHeight": 0.8, "airflowCfm": 300, "oscillateDeg": 70, "periodSec": 12,
      "enabled": true
    },
    { "id": "person", "type": "heat_source", "pos": [2.0, 2.5, 0.6], "size": [0.5, 1.8, 0.3], "watts": 100, "enabled": true }
  ]
}
```

Walls point to a room edge by index, so edge 0 runs from the first outline point to the second. Device airflow stays in CFM and capacity in BTU/h because that is how products are labeled. The solver converts them once on load.

For the apartment phase, add a `doors` list where each door joins two rooms on a shared edge with a state of open, closed or cracked.

## Build phases

Ship in six phases, each ending with something you can run and see. Don't start a phase until the previous one passes its checks, because solver bugs get much harder to find once the UI is layered on top.

| Phase | What gets built | Done when |
|---|---|---|
| 1. Solver core | Empty box on the CPU, pressure projection, buoyancy, temperature advection, plan and section slice views | A heated floor patch makes a plume that rises and spreads along the ceiling, and divergence tests pass |
| 2. Single room editor | Draw a rectangular room, place windows, vents, fans, tower fans, AC and heat sources, toggle them live | Every device type changes the flow in a way that looks right on the particle view |
| 3. Thermal and controls | Wall and window conduction, solar gain, infiltration, thermostat cycling, stats panel and temp chart | Energy balance closes and the AC sizing check passes |
| 4. Performance | Port the solver to WebGPU, keep the CPU version as the test oracle | GPU and CPU fields match on a small grid, and 30 min of bedroom time runs in under a minute |
| 5. Apartment | Polygon rooms, doors, hallways, coupled interior walls, per-room stats, airflow through each door in CFM | A cooled bedroom with an open door visibly pulls warm air from the hall at the top of the doorway |
| 6. Planning tools | Scenario compare, fan placement sweep that ranks spots by average temp in a target zone like the bed, save and share | A sweep over 20 fan positions finishes and returns a ranked list |

Phase 5 needs no new physics. It is mostly editor work plus doors and leak faces, which is why the single grid design pays off.

## Validation tests

These run in CI from phase 1 onward. A pretty picture can still be wrong, so the numbers have to check out.

| Test | Setup | Pass condition |
|---|---|---|
| Mass conservation | Any scene, after projection | Max cell divergence below a small tolerance, for example 1e-4 1/s |
| Heater energy balance | Sealed adiabatic 4 x 4 x 2.7 m box with a 100 W heater | Mean temp rises about 6.9°C per hour (100 W / ρ·cp·V), within 2% |
| Wall leak check | Fans running inside a sealed room | Total air mass stays constant and no velocity crosses solid cells |
| AC sizing | 8,000 BTU/h window AC at 220 CFM, SHR 0.7 | Supply to return difference settles near 24°F |
| Buoyancy direction | Hot patch on the floor, then cold inlet at the ceiling | Plume rises in the first case, cold air falls in the second |
| Symmetry | Mirror-symmetric room and devices | Fields stay symmetric within float error |
| Determinism | Same scene run twice | Identical output with a fixed timestep |
| GPU parity | Small grid on CPU and GPU | Fields match within a set tolerance after 1,000 steps |

Optional later: run the solver on a 2D grid and compare it against the classic differentially heated square cavity benchmark from de Vahl Davis (1983).

## Working with coding agents

Export this doc as Markdown and commit it to the repo as `SPEC.md`. Then point each agent at it: `CLAUDE.md` for Claude Code, `AGENTS.md` for Codex, and paste it into Grok directly.

- **One phase per session.** Ask the agent to plan the phase first, then write the tests from the validation table, then the code.
- **Keep the solver pure.** No React or DOM imports anywhere in the solver folder. Put that rule in `CLAUDE.md` and `AGENTS.md` so every agent follows it.
- **Ban silent clamping.** Agents like to "fix" unstable physics by clamping velocity or temperature. Require that any clamp logs a warning so real bugs stay visible.
- **Watch the walls.** The most common solver bug is flow leaking through solid cells during projection. Ask for a debug view of divergence and pressure early.
- **Commit after every green test run** so a bad agent session can be rolled back cleanly.
- **Switching agents mid-project is fine** as long as the spec and tests live in the repo. The tests are what keep a new agent honest.
