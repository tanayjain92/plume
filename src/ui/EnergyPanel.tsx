import { CP, RHO } from '../solver/constants';
import { ENERGY_KEYS, type EnergyAverage, type EnergyKey } from './history';
import { fmtPower, fmtTempDelta, type UnitSystem } from './units';

const LABELS: Record<EnergyKey, string> = {
  ac: 'AC',
  sun: 'Sun',
  sources: 'People & devices',
  fans: 'Fan motors',
  walls: 'Walls',
  glass: 'Window glass',
  infiltration: 'Air leaks',
  leakage: 'Unbalanced air',
  openWindows: 'Open windows',
  vents: 'Vents',
};

/**
 * Measured heat flows into the room air, averaged over the last minute of room
 * time. Their sum should equal the rate the room air is gaining heat, and at
 * steady state both go to about zero.
 */
export function EnergyPanel(props: { energy: EnergyAverage | null; airVolume: number; units: UnitSystem }) {
  const { energy: e, units } = props;
  if (!e) {
    return (
      <section className="panel energy">
        <h3>Energy balance</h3>
        <p className="muted small">Run the simulation to measure where heat comes from and goes.</p>
      </section>
    );
  }
  const rows = ENERGY_KEYS.map((k) => ({ k, w: e[k] })).filter((r) => Math.abs(r.w) >= 0.5);
  const maxW = Math.max(1, ...rows.map((r) => Math.abs(r.w)));
  const scale = rows.reduce((s, r) => s + Math.abs(r.w), 0);
  const perHour = props.airVolume > 0 ? (e.storage * 3600) / (RHO * CP * props.airVolume) : 0;
  const mismatch = scale > 0 ? Math.abs(e.storage - e.net) / scale : 0;
  const steady = scale > 0 && Math.abs(e.net) < 0.05 * scale;
  return (
    <section className="panel energy">
      <h3>Energy balance</h3>
      <div className="flows">
        <div className="stat-label">Heat into the room air, last {Math.round(e.seconds)} s of room time</div>
        {rows.length === 0 && <p className="muted small">No heat is moving in or out.</p>}
        {rows.map((r) => (
          <div key={r.k} className="flow-row">
            <span className="flow-label">{LABELS[r.k]}</span>
            <span className="flow-bar">
              <span className={r.w >= 0 ? 'in' : 'out'} style={{ width: `${(100 * Math.abs(r.w)) / maxW}%` }} />
            </span>
            <span className="flow-val">
              {r.w >= 0 ? '+' : '−'}
              {fmtPower(Math.abs(r.w), units)}
            </span>
          </div>
        ))}
        <div className="flow-row net">
          <span className="flow-label">Net</span>
          <span className="muted small">
            {steady ? 'about balanced: room is steady' : `air ${e.net > 0 ? 'warming' : 'cooling'} ${Math.abs(perHour) >= 60 ? `${fmtTempDelta(Math.abs(perHour) / 60, units, 1)}/min` : `${fmtTempDelta(Math.abs(perHour), units, 1)}/h`}`}
          </span>
          <span className="flow-val">
            {e.net >= 0 ? '+' : '−'}
            {fmtPower(Math.abs(e.net), units)}
          </span>
        </div>
      </div>
      <p className={`small ${mismatch < 0.01 ? 'muted' : 'warn-text'}`}>
        Bookkeeping check: the sum matches the heat the air actually gained{mismatch < 0.01 ? '' : ` only within ${(mismatch * 100).toFixed(1)}%`}.
      </p>
    </section>
  );
}
