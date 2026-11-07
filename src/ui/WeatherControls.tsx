import { useEffect, useRef, useState } from 'react';
import type { SceneV1 } from '../scene/types';
import { applyWeather, type PlaceResult, type WeatherField } from '../scene/weather';
import { fetchWeather, searchPlaces } from './openMeteo';
import { fmtTemp, quantity, type UnitSystem } from './units';

export interface AutoWeather {
  /** Fill these fields from the weather at the scene's site and time. */
  fill: (fields: WeatherField[]) => void;
  busy: boolean;
  status: { text: string; tone: 'muted' | 'ok' | 'warn' } | null;
}

/** Shared state for the Auto buttons: fetch, apply to the latest scene, report what happened. */
export function useAutoWeather(scene: SceneV1, onChange: (s: SceneV1) => void, units: UnitSystem): AutoWeather {
  const latest = useRef(scene);
  latest.current = scene;
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<AutoWeather['status']>(null);

  const fill = (fields: WeatherField[]) => {
    const site = latest.current.site;
    if (!site) {
      setStatus({ text: 'Pick a location first (below), so Auto knows whose weather to use.', tone: 'warn' });
      return;
    }
    setBusy(true);
    setStatus({ text: 'Getting the weather…', tone: 'muted' });
    fetchWeather(site, site.when)
      .then((w) => {
        const s = latest.current;
        const hasSun = s.devices.some((d) => d.type === 'sun');
        const next = applyWeather(s, site, w, fields.filter((f) => f !== 'sun' || hasSun));
        onChange(next);
        const sun = next.devices.find((d) => d.type === 'sun');
        const sunNote =
          fields.includes('sun') && sun && sun.type === 'sun'
            ? sun.wm2 === 0
              ? ' The sun is down, so it gives no light.'
              : ` Sun ${sun.elevationDeg}° up, ${sun.wm2} W/m².`
            : fields.includes('sun') && !hasSun
              ? ' Add Sunshine to get sunlight too.'
              : '';
        setStatus({
          text: `${site.name.split(',')[0]}, ${w.time.replace('T', ' ')}: ${fmtTemp(w.temp, units, 0)}, wind ${quantity.wind.to(w.windSpeed, units).toFixed(0)} ${quantity.wind.unit(units)} from ${compass(w.windFrom)}.${sunNote}`,
          tone: 'ok',
        });
      })
      .catch((e: unknown) => setStatus({ text: e instanceof Error ? e.message : String(e), tone: 'warn' }))
      .finally(() => setBusy(false));
  };
  return { fill, busy, status };
}

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compass = (deg: number) => POINTS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

/** Location search and time picker for the Auto buttons. */
export function SiteBox(props: { scene: SceneV1; onChange: (s: SceneV1) => void; auto: AutoWeather }) {
  const { scene, auto } = props;
  const site = scene.site;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlaceResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Search as you type, after a short pause.
  useEffect(() => {
    if (query.trim().length < 2) {
      setResults(null);
      return;
    }
    const t = setTimeout(() => {
      setSearching(true);
      setError(null);
      searchPlaces(query)
        .then(setResults)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setSearching(false));
    }, 350);
    return () => clearTimeout(t);
  }, [query]);

  const choose = (p: PlaceResult) => {
    props.onChange({ ...scene, site: { name: p.name, lat: p.lat, lon: p.lon, when: site?.when } });
    setQuery('');
    setResults(null);
  };

  return (
    <div className="site-box">
      <span className="group-label">Location for Auto</span>
      {site && (
        <div className="site-current">
          <b>{site.name}</b>
          <span className="muted small">
            {site.lat.toFixed(2)}, {site.lon.toFixed(2)} · top of the plan is north
          </span>
        </div>
      )}
      <input type="search" placeholder={site ? 'Change location…' : 'Search a city or town…'} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search location" />
      {searching && <span className="muted small">Searching…</span>}
      {error && <span className="warn-text small">{error}</span>}
      {results && !searching && (
        <ul className="site-results">
          {results.length === 0 && <li className="muted small">No places found.</li>}
          {results.map((p) => (
            <li key={p.id}>
              <button className="link" onClick={() => choose(p)}>
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {site && (
        <>
          <span className="group-label">When</span>
          <div className="chips">
            <button className={!site.when ? 'on' : ''} onClick={() => props.onChange({ ...scene, site: { ...site, when: undefined } })}>
              Now
            </button>
            <input
              type="datetime-local"
              step={3600}
              value={site.when ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                props.onChange({ ...scene, site: { ...site, when: v ? `${v.slice(0, 13)}:00` : undefined } });
              }}
              aria-label="Date and hour at that place"
              title="Local time at that place"
            />
          </div>
          <button className="primary" disabled={auto.busy} onClick={() => auto.fill(['temp', 'windSpeed', 'windFrom', 'sun'])}>
            {auto.busy ? 'Getting weather…' : 'Auto-fill weather and sun'}
          </button>
        </>
      )}
      {auto.status && <p className={`small ${auto.status.tone === 'ok' ? 'ok-text' : auto.status.tone === 'warn' ? 'warn-text' : 'muted'}`}>{auto.status.text}</p>}
      <p className="muted small">Weather from Open-Meteo (free, no account). Only the place you search for and its coordinates are sent.</p>
    </div>
  );
}
