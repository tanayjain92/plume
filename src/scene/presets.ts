import type { SceneV1 } from './types';

const bedroomBase = (): Omit<SceneV1, 'devices' | 'name'> => ({
  version: 1,
  grid: { cellSize: 0.1 },
  outdoor: { temp: 31, windSpeed: 2.0, windFrom: 270, solar: 500 },
  rooms: [{ id: 'bedroom', outline: [[0, 0], [4, 0], [4, 3.6], [0, 3.6]], height: 2.7, initialTemp: 28 }],
  walls: [],
  openings: [],
});

export interface Preset {
  id: string;
  label: string;
  description: string;
  scene: SceneV1;
}

export const PRESETS: Preset[] = [
  {
    id: 'floor-patch',
    label: 'Heated floor patch',
    description: 'Phase 1 check: a 300 W patch on the floor should send a plume up that spreads along the ceiling.',
    scene: {
      ...bedroomBase(),
      name: 'Heated floor patch',
      devices: [
        { id: 'floor patch', type: 'heat_source', pos: [2.0, 1.8, 0], size: [0.6, 0.6, 0.1], watts: 300, enabled: true },
      ],
    },
  },
  {
    id: 'cold-ceiling',
    label: 'Cold ceiling patch',
    description: 'A heat sink at the ceiling (negative watts) stands in for a cold inlet: chilled air should fall and pool on the floor.',
    scene: {
      ...bedroomBase(),
      name: 'Cold ceiling patch',
      devices: [
        { id: 'chilled panel', type: 'heat_source', pos: [2.0, 1.8, 2.6], size: [0.6, 0.6, 0.1], watts: -400, enabled: true },
      ],
    },
  },
  {
    id: 'spec-bedroom',
    label: 'Spec sample bedroom',
    description: 'The sample scene from SPEC.md. Only the person heat source is simulated in phase 1; the AC and tower fan arrive in phase 2.',
    scene: {
      ...bedroomBase(),
      name: 'Spec sample bedroom',
      walls: [
        { room: 'bedroom', edge: 0, exterior: true, uValue: 0.6 },
        { room: 'bedroom', edge: 1, exterior: false },
      ],
      openings: [
        {
          id: 'win1', type: 'window', room: 'bedroom', edge: 0,
          offset: 1.2, width: 1.0, sill: 0.9, height: 1.2, state: 'closed', glazingU: 2.8,
        },
      ],
      devices: [
        { id: 'ac1', type: 'window_ac', mountedIn: 'win1', capacityBtuh: 8000, airflowCfm: 220, shr: 0.7, setpoint: 22, enabled: true },
        {
          id: 'fan1', type: 'tower_fan', pos: [3.4, 0.4, 0], heading: 315,
          slotHeight: 0.8, airflowCfm: 300, oscillateDeg: 70, periodSec: 12, enabled: true,
        },
        { id: 'person', type: 'heat_source', pos: [2.0, 2.5, 0.6], size: [0.5, 1.8, 0.3], watts: 100, enabled: true },
        { id: 'desktop', type: 'heat_source', pos: [0.5, 0.5, 0.7], size: [0.2, 0.4, 0.4], watts: 200, enabled: true },
      ],
    },
  },
];
