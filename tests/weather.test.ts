import { describe, expect, it } from 'vitest';
import { FT, newSpace, placeTool, rectOutline } from '../src/scene/defaults';
import { predictRoom } from '../src/scene/predict';
import { roomScene } from './sceneHelpers';
import { applyWeather, autoRoomTemp, parsePlaces, parseWeather, sunPosition, weatherUrl, type Weather } from '../src/scene/weather';

const bedroom = () => newSpace({ name: 'Bedroom', outline: rectOutline(12 * FT, 12 * FT), height: 8 * FT, roomTemp: 27, outdoorTemp: 32 });

describe('sun position', () => {
  it('London, winter solstice, solar noon: due south, about 15° up', () => {
    const s = sunPosition(51.5, 0, Date.parse('2024-12-21T11:58:00Z'));
    expect(s.azimuthDeg).toBeCloseTo(180, 0);
    expect(s.elevationDeg).toBeGreaterThan(14.5);
    expect(s.elevationDeg).toBeLessThan(15.6);
  });

  it('New York, summer solstice, solar noon: due south, about 73° up', () => {
    const s = sunPosition(40.71, -74.01, Date.parse('2024-06-21T16:57:30Z'));
    expect(Math.abs(s.azimuthDeg - 180)).toBeLessThan(3);
    expect(s.elevationDeg).toBeCloseTo(72.7, 0);
  });

  it('morning sun is in the east, evening sun in the west, midnight below the horizon', () => {
    const am = sunPosition(40.71, -74.01, Date.parse('2024-06-21T11:00:00Z')); // 7 am EDT
    const pm = sunPosition(40.71, -74.01, Date.parse('2024-06-21T23:00:00Z')); // 7 pm EDT
    const night = sunPosition(40.71, -74.01, Date.parse('2024-06-22T04:00:00Z'));
    expect(am.azimuthDeg).toBeGreaterThan(45);
    expect(am.azimuthDeg).toBeLessThan(110);
    expect(pm.azimuthDeg).toBeGreaterThan(250);
    expect(pm.azimuthDeg).toBeLessThan(315);
    expect(night.elevationDeg).toBeLessThan(0);
  });
});

describe('Open-Meteo answers', () => {
  const response = {
    utc_offset_seconds: -7 * 3600,
    hourly: {
      time: ['2026-07-15T13:00', '2026-07-15T14:00'],
      temperature_2m: [40.1, 41.3],
      wind_speed_10m: [3.2, 4.0],
      wind_direction_10m: [200, 225],
      direct_normal_irradiance: [880, 860],
    },
  };

  it('picks the requested local hour and converts it to UTC', () => {
    const w = parseWeather(response, '2026-07-15T14:00');
    expect(w).toMatchObject({ temp: 41.3, windSpeed: 4.0, windFrom: 225, dni: 860 });
    expect(new Date(w.utcMs).toISOString()).toBe('2026-07-15T21:00:00.000Z');
  });

  it('says so when the hour is missing', () => {
    expect(() => parseWeather(response, '2026-07-16T14:00')).toThrow(/no weather/);
  });

  it('uses the archive for old dates and the forecast otherwise', () => {
    const site = { name: 'x', lat: 33.45, lon: -112.07 };
    const today = Date.parse('2026-11-07T00:00:00Z');
    expect(weatherUrl(site, '2026-11-01', today)).toContain('api.open-meteo.com/v1/forecast');
    expect(weatherUrl(site, '2025-07-15', today)).toContain('archive-api.open-meteo.com');
    expect(weatherUrl(site, '2026-11-01', today)).toContain('wind_speed_unit=ms');
  });

  it('labels places with region and country, without repeats', () => {
    const places = parsePlaces({ results: [{ id: 1, name: 'Singapore', latitude: 1.29, longitude: 103.85, admin1: 'Singapore', country: 'Singapore' }] });
    expect(places[0].name).toBe('Singapore');
  });
});

describe('applying weather to the room', () => {
  const site = { name: 'Phoenix', lat: 33.45, lon: -112.07 };
  // 3 pm local (UTC-7) on 15 July: sun in the south-west, high up.
  const w: Weather = { time: '2026-07-15T15:00', utcMs: Date.parse('2026-07-15T22:00:00Z'), temp: 41.3, windSpeed: 4.04, windFrom: 225.4, dni: 864 };

  it('fills only the fields asked for', () => {
    const s = bedroom();
    const t = applyWeather(s, site, w, ['temp']);
    expect(t.outdoor.temp).toBe(41.3);
    expect(t.outdoor.windSpeed).toBe(s.outdoor.windSpeed);
    const all = applyWeather(s, site, w, ['temp', 'windSpeed', 'windFrom']);
    expect(all.outdoor).toMatchObject({ temp: 41.3, windSpeed: 4, windFrom: 225 });
  });

  it('moves the sun to the side it shines from and aims it into the room', () => {
    const r = placeTool(bedroom(), 'sun', 1.8, -0.5);
    if ('error' in r) throw new Error(r.error);
    const t = applyWeather(r.scene, site, w, ['sun']);
    const sun = t.devices.find((d) => d.type === 'sun')!;
    if (sun.type !== 'sun') throw new Error();
    const pos = sunPosition(site.lat, site.lon, w.utcMs);
    expect(sun.heading).toBe(Math.round((pos.azimuthDeg + 180) % 360));
    expect(sun.elevationDeg).toBe(Math.round(pos.elevationDeg));
    expect(sun.wm2).toBe(860);
    // west-south-west of a room spanning 0..3.66 m: just left of it, along the sun's bearing from the center
    expect(sun.pos[0]).toBeLessThan(0);
    const c = (12 * FT) / 2;
    const bearing = ((Math.atan2(sun.pos[0] - c, sun.pos[1] - c) * 180) / Math.PI + 360) % 360;
    expect(Math.abs(bearing - pos.azimuthDeg)).toBeLessThan(2);
  });

  it('a sun below the horizon gives no light', () => {
    const r = placeTool(bedroom(), 'sun', 1.8, -0.5);
    if ('error' in r) throw new Error(r.error);
    const night = { ...w, utcMs: Date.parse('2026-07-15T10:00:00Z'), dni: 0 }; // 3 am local
    const sun = applyWeather(r.scene, site, night, ['sun']).devices.find((d) => d.type === 'sun')!;
    expect(sun.type === 'sun' && sun.wm2).toBe(0);
  });
});

describe('automatic starting temperature', () => {
  it('starts the room where it would settle', () => {
    const s = { ...bedroom(), envelope: { wallU: 0.6, ach: 0.5 } };
    expect(autoRoomTemp(s)).toBeCloseTo(predictRoom(s).settleT, 1);
  });

  it('a sealed, perfectly insulated room falls back to the outdoor temperature', () => {
    // no envelope and a heater inside: it warms forever
    const s = roomScene({ outdoorTemp: 30, devices: [{ id: 'h', type: 'heat_source', pos: [1, 1, 0], size: [0.3, 0.3, 0.5], watts: 100, enabled: true }] });
    expect(Number.isFinite(predictRoom(s).settleT)).toBe(false);
    expect(autoRoomTemp(s)).toBe(s.outdoor.temp);
  });
});
