import { parsePlaces, parseWeather, placeSearchUrl, weatherUrl, type PlaceResult, type Site, type Weather } from '../scene/weather';

/**
 * Network side of the Auto buttons: Open-Meteo (free, no account or key).
 * Sends only the place name typed in, or the chosen coordinates and date.
 */

const cache = new Map<string, unknown>();

async function getJson(url: string): Promise<unknown> {
  if (cache.has(url)) return cache.get(url);
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error("Couldn't reach the weather service. Check your internet connection.");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { reason?: string } | null;
    throw new Error(body?.reason ? `Weather service: ${body.reason}` : `Weather service error ${res.status}`);
  }
  const json = await res.json();
  cache.set(url, json);
  return json;
}

export async function searchPlaces(query: string): Promise<PlaceResult[]> {
  if (query.trim().length < 2) return [];
  return parsePlaces(await getJson(placeSearchUrl(query.trim())));
}

const hourString = (ms: number) => new Date(ms).toISOString().slice(0, 13) + ':00';

/**
 * Weather at `when` (local time at the site, "YYYY-MM-DDTHH:00"), or the
 * current hour there when `when` is missing.
 */
export async function fetchWeather(site: Site, when?: string): Promise<Weather> {
  if (when) return parseWeather(await getJson(weatherUrl(site, when.slice(0, 10), Date.now())), when);
  // "Now": the site's UTC offset comes with the answer, so ask for today in UTC first.
  const now = Date.now();
  let date = new Date(now).toISOString().slice(0, 10);
  let json = (await getJson(weatherUrl(site, date, now))) as { utc_offset_seconds?: number };
  const local = hourString(now + (json.utc_offset_seconds ?? 0) * 1000);
  if (local.slice(0, 10) !== date) {
    date = local.slice(0, 10);
    json = (await getJson(weatherUrl(site, date, now))) as { utc_offset_seconds?: number };
  }
  return parseWeather(json, local);
}
