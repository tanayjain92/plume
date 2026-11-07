import type { Device, Opening, SceneV1 } from './types';

function bedroom(name: string, openings: Opening[], devices: Device[], opts: { initialTemp?: number; outdoor?: SceneV1['outdoor'] } = {}): SceneV1 {
  return {
    version: 1,
    name,
    grid: { cellSize: 0.1 },
    outdoor: opts.outdoor ?? { temp: 31, windSpeed: 2.0, windFrom: 270, solar: 500 },
    rooms: [{ id: 'bedroom', outline: [[0, 0], [4, 0], [4, 3.6], [0, 3.6]], height: 2.7, initialTemp: opts.initialTemp ?? 28 }],
    walls: [],
    openings,
    devices,
    envelope: { wallU: 0.6, ach: 0.5 },
  };
}

const win = (id: string, edge: number, offset: number, state: 'open' | 'closed', width = 1.0, sill = 0.9, height = 1.2): Opening => ({
  id,
  type: 'window',
  room: 'bedroom',
  edge,
  offset,
  width,
  sill,
  height,
  state,
  glazingU: 2.8,
});

export interface Preset {
  id: string;
  label: string;
  description: string;
  scene: SceneV1;
}

export const PRESETS: Preset[] = [
  {
    id: 'spec-bedroom',
    label: 'Spec sample bedroom',
    description: 'The sample scene from SPEC.md: a window AC, an oscillating tower fan, a person in bed and a desktop PC.',
    scene: {
      ...bedroom(
        'Spec sample bedroom',
        [win('win1', 0, 1.2, 'closed')],
        [
          { id: 'ac1', type: 'window_ac', mountedIn: 'win1', capacityBtuh: 8000, airflowCfm: 220, shr: 0.7, setpoint: 22, enabled: true },
          { id: 'fan1', type: 'tower_fan', pos: [3.4, 0.4, 0], heading: 315, slotHeight: 0.8, airflowCfm: 300, oscillateDeg: 70, periodSec: 12, enabled: true },
          { id: 'person', type: 'heat_source', pos: [2.0, 2.5, 0.6], size: [0.5, 1.8, 0.3], watts: 100, enabled: true },
          { id: 'desktop', type: 'heat_source', pos: [0.5, 0.5, 0.7], size: [0.2, 0.4, 0.4], watts: 200, enabled: true },
        ],
      ),
      walls: [
        { room: 'bedroom', edge: 0, exterior: true, uValue: 0.6 },
        { room: 'bedroom', edge: 1, exterior: false },
      ],
    },
  },
  {
    id: 'cross-vent',
    label: 'Cross ventilation',
    description: 'Wind from the west through two open windows. Cooler outdoor air sweeps across the room.',
    scene: bedroom('Cross ventilation', [win('west', 3, 1.3, 'open'), win('east', 1, 1.3, 'open')], [
      { id: 'person', type: 'heat_source', pos: [2.0, 2.5, 0.6], size: [0.5, 1.8, 0.3], watts: 100, enabled: true },
    ], { initialTemp: 28, outdoor: { temp: 24, windSpeed: 3, windFrom: 270, solar: 0 } }),
  },
  {
    id: 'ceiling-hvac',
    label: 'Ceiling supply + return',
    description: 'Central air: a ceiling diffuser blowing 16 °C air at 120 CFM, a high return grille on the far wall, and a ceiling fan to toggle.',
    scene: bedroom('Ceiling supply + return', [], [
      { id: 'supply', type: 'supply_vent', pos: [1.0, 1.8, 2.7], size: [0.3, 0.3], airflowCfm: 120, supplyTemp: 16, direction: [0, 0, -1], enabled: true },
      { id: 'return', type: 'return_vent', pos: [4.0, 1.8, 2.3], size: [0.5, 0.3], airflowCfm: 120, enabled: true },
      { id: 'ceilingfan', type: 'ceiling_fan', pos: [2.0, 1.8, 2.3], diameter: 1.3, airflowCfm: 4000, reverse: false, enabled: false },
      { id: 'person', type: 'heat_source', pos: [2.6, 2.5, 0.6], size: [0.5, 1.8, 0.3], watts: 100, enabled: true },
    ]),
  },
  {
    id: 'floor-patch',
    label: 'Heated floor patch',
    description: 'Phase 1 check: a 300 W patch on the floor should send a plume up that spreads along the ceiling.',
    scene: bedroom('Heated floor patch', [], [
      { id: 'floor patch', type: 'heat_source', pos: [2.0, 1.8, 0], size: [0.6, 0.6, 0.1], watts: 300, enabled: true },
    ]),
  },
  {
    id: 'cold-ceiling',
    label: 'Cold ceiling patch',
    description: 'A heat sink at the ceiling (negative watts): chilled air falls and pools on the floor.',
    scene: bedroom('Cold ceiling patch', [], [
      { id: 'chilled panel', type: 'heat_source', pos: [2.0, 1.8, 2.6], size: [0.6, 0.6, 0.1], watts: -400, enabled: true },
    ]),
  },
];
