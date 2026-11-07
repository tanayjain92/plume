import type { Prediction } from '../scene/predict';
import { fmtPower, fmtTemp, fmtTempDelta, type UnitSystem } from './units';

function fmtHours(h: number): string {
  if (!Number.isFinite(h)) return '';
  if (h < 1 / 60) return 'already there';
  if (h < 1) return `in about ${Math.max(1, Math.round(h * 60))} min`;
  if (h < 10) return `in about ${h.toFixed(1)} h`;
  return `in about ${Math.round(h)} h`;
}

/** "Where this room is heading": the whole-room energy balance for the current settings. */
export function PredictionCard(props: { prediction: Prediction; currentT?: number; units: UnitSystem; hasEnvelope: boolean; onAddInsulation: () => void }) {
  const { prediction: p, units } = props;
  const settles = Number.isFinite(p.settleT);
  let acLine = '';
  let tone: 'ok' | 'warn' | '' = '';
  switch (p.ac) {
    case 'cycling':
      acLine = `AC holds ${fmtTemp(p.setpoint!, units, 0)}, running about ${Math.round(p.acDuty * 100)}% of the time.`;
      tone = 'ok';
      break;
    case 'maxed':
      acLine = `AC is too small: it runs nonstop and the room stays above ${fmtTemp(p.setpoint!, units, 0)}. Holding the setpoint needs ${fmtPower(p.neededCoolingW, units)}; it has ${fmtPower(p.acCapacityW, units)}.`;
      tone = 'warn';
      break;
    case 'idle':
      acLine = `AC barely needs to run: the room stays under its ${fmtTemp(p.setpoint!, units, 0)} setpoint on its own.`;
      tone = 'ok';
      break;
    case 'off':
      acLine = 'The AC is switched off.';
      break;
    case 'none':
      acLine = p.neededCoolingW > 0 ? `To hold ${fmtTemp(24, units, 0)} you'd need about ${fmtPower(p.neededCoolingW, units)} of cooling.` : '';
      break;
  }

  const rows = [...p.breakdown].sort((a, b) => Math.abs(b.watts) - Math.abs(a.watts)).slice(0, 7);
  const maxW = Math.max(1, ...rows.map((r) => Math.abs(r.watts)));

  return (
    <section className="panel predict">
      <div className="predict-main">
        <div>
          <div className="stat-label">Where this room is heading</div>
          {settles ? (
            <div className="predict-temp">
              Settles at <b>{fmtTemp(p.settleT, units, 1)}</b> <span className="muted">{fmtHours(p.hours)}</span>
            </div>
          ) : (
            <div className="predict-temp">
              Never settles: keeps {p.driftPerHour > 0 ? 'warming' : 'cooling'} about <b>{fmtTempDelta(Math.abs(p.driftPerHour), units, 1)}</b> per hour
            </div>
          )}
          {props.currentT !== undefined && settles && (
            <div className="muted small">
              Now {fmtTemp(props.currentT, units, 1)} on average ({p.settleT > props.currentT + 0.05 ? 'warming' : p.settleT < props.currentT - 0.05 ? 'cooling' : 'steady'}).
            </div>
          )}
          {acLine && <div className={`predict-ac ${tone}`}>{acLine}</div>}
          {!props.hasEnvelope && (
            <div className="predict-ac warn">
              This space has no insulation settings, so walls don't let heat through.{' '}
              <button className="link" onClick={props.onAddInsulation}>
                Add average insulation
              </button>
            </div>
          )}
        </div>
        {rows.length > 0 && (
          <div className="flows">
            <div className="stat-label">Heat flows once settled</div>
            {rows.map((r) => (
              <div key={r.label} className="flow-row">
                <span className="flow-label">{r.label}</span>
                <span className="flow-bar">
                  <span className={r.watts >= 0 ? 'in' : 'out'} style={{ width: `${(100 * Math.abs(r.watts)) / maxW}%` }} />
                </span>
                <span className="flow-val">
                  {r.watts >= 0 ? '+' : '−'}
                  {fmtPower(Math.abs(r.watts), units)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="muted small">
        Whole-room estimate from the current settings, treating the room as one temperature. The view above shows how that temperature is spread around the room right now.
      </p>
    </section>
  );
}
