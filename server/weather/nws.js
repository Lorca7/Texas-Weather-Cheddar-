/**
 * National Weather Service (NOAA) client — api.weather.gov.
 *
 * Public, keyless, and authoritative for US surface observations and warnings.
 * NWS asks for a identifying User-Agent (see server/lib/http.js) and for
 * polite polling; observations only refresh every 20-60 minutes, so there is
 * nothing to gain from hammering it.
 *
 * Docs: https://www.weather.gov/documentation/services-web-api
 */
import { fetchJson } from '../lib/http.js';
import { FALLBACK_STATIONS, thinByGrid, inTexasBox } from './stations.js';

const BASE = process.env.NWS_BASE || 'https://api.weather.gov';

/** Run an async mapper over items with bounded concurrency. */
async function pooled(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (err) {
        out[idx] = { __error: err?.message || String(err) };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/* ---------- unit normalisation ------------------------------------------- */

const unitOf = (q) => String(q?.unitCode || '').replace(/^wmoUnit:/, '').replace(/^unit:/, '');

/** NWS quantities arrive as {value, unitCode, qualityControl}. */
function num(q) {
  const v = q?.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function toCelsius(q) {
  const v = num(q);
  if (v === null) return null;
  const u = unitOf(q);
  if (u === 'degF') return (v - 32) / 1.8;
  if (u === 'K') return v - 273.15;
  return v; // degC
}

export function toKnots(q) {
  const v = num(q);
  if (v === null) return null;
  switch (unitOf(q)) {
    case 'km_h-1':
      return v / 1.852;
    case 'm_s-1':
      return v * 1.943844;
    case 'mi_h-1':
      return v * 0.868976;
    case '[kn_i]':
    case 'kn':
      return v;
    default:
      return v / 1.852; // NWS default for wind is km/h
  }
}

export function toHectopascals(q) {
  const v = num(q);
  if (v === null) return null;
  const u = unitOf(q);
  if (u === 'Pa') return v / 100;
  if (u === 'kPa') return v * 10;
  return v; // hPa / mbar
}

export function toMillimetres(q) {
  const v = num(q);
  if (v === null) return null;
  const u = unitOf(q);
  if (u === 'm') return v * 1000;
  if (u === 'cm') return v * 10;
  if (u === '[in_i]') return v * 25.4;
  return v; // mm
}

export function toMetres(q) {
  const v = num(q);
  if (v === null) return null;
  const u = unitOf(q);
  if (u === 'km') return v * 1000;
  if (u === '[mi_i]') return v * 1609.344;
  return v;
}

/** METAR sky-cover codes -> 0..1 opacity. */
const SKY = { CLR: 0, SKC: 0, NCD: 0, NSC: 0, FEW: 0.2, SCT: 0.45, BKN: 0.75, OVC: 1, VV: 1 };

export function skyCoverFromLayers(layers) {
  if (!Array.isArray(layers) || layers.length === 0) return null;
  let max = 0;
  for (const l of layers) {
    const amt = SKY[String(l?.amount || '').toUpperCase()];
    if (typeof amt === 'number') max = Math.max(max, amt);
  }
  return max;
}

/** Ceiling in metres, or null for no ceiling (BKN/OVC layers only). */
export function ceilingFromLayers(layers) {
  if (!Array.isArray(layers)) return null;
  let lowest = null;
  for (const l of layers) {
    const amt = String(l?.amount || '').toUpperCase();
    if (amt !== 'BKN' && amt !== 'OVC' && amt !== 'VV') continue;
    const base = toMetres(l?.base);
    if (base !== null && (lowest === null || base < lowest)) lowest = base;
  }
  return lowest;
}

/**
 * Rough precipitation-rate proxy (mm/h) from the METAR text description, used
 * when the station reports no measured hourly total. Present-weather wording
 * is the only intensity signal many stations give.
 */
export function precipFromText(text) {
  if (!text) return 0;
  const t = String(text).toLowerCase();
  let base = 0;
  if (/thunderstorm|t-?storm/.test(t)) base = 7;
  else if (/\brain\b|showers?|drizzle/.test(t)) base = 2;
  else if (/snow|sleet|ice pellets|freezing/.test(t)) base = 1.5;
  else if (/mist|fog|haze/.test(t)) base = 0.1;
  if (base === 0) return 0;
  if (/heavy/.test(t)) base *= 2.5;
  else if (/light/.test(t)) base *= 0.4;
  if (/\bvicinity|\bvc/.test(t)) base *= 0.3;
  return base;
}

const isThundery = (text) => /thunder|t-?storm|squall|hail/i.test(String(text || ''));

/* ---------- endpoints ----------------------------------------------------- */

/** Discover Texas stations with authoritative NWS coordinates. */
export async function discoverStations({ cap = 60 } = {}) {
  const json = await fetchJson(`${BASE}/stations?state=TX&limit=500`, { timeoutMs: 20000 });
  const raw = (json?.features || [])
    .map((f) => ({
      id: f?.properties?.stationIdentifier,
      name: f?.properties?.name,
      lon: f?.geometry?.coordinates?.[0],
      lat: f?.geometry?.coordinates?.[1],
      elevationM: num(f?.properties?.elevation),
    }))
    .filter((s) => s.id && inTexasBox(s.lon, s.lat));
  if (raw.length === 0) throw new Error('NWS returned no usable Texas stations');
  return thinByGrid(raw, 9, 8, cap);
}

/** Latest surface observation for one station, normalised to our units. */
export async function fetchObservation(station) {
  const json = await fetchJson(`${BASE}/stations/${encodeURIComponent(station.id)}/observations/latest`, {
    timeoutMs: 15000,
    retries: 1,
  });
  const p = json?.properties;
  if (!p) throw new Error(`no observation payload for ${station.id}`);

  const tempC = toCelsius(p.temperature);
  const dewC = toCelsius(p.dewpoint);
  const rhDirect = num(p.relativeHumidity);
  const measured = toMillimetres(p.precipitationLastHour);
  const text = p.textDescription || null;

  return {
    id: station.id,
    name: station.name || station.id,
    lat: station.lat,
    lon: station.lon,
    observedAt: p.timestamp || null,
    tempC,
    dewC,
    rh: rhDirect ?? relativeHumidity(tempC, dewC),
    windKt: toKnots(p.windSpeed) ?? 0,
    gustKt: toKnots(p.windGust),
    windDirDeg: num(p.windDirection),
    pressureHpa: toHectopascals(p.seaLevelPressure) ?? toHectopascals(p.barometricPressure),
    visibilityM: toMetres(p.visibility),
    skyCover: skyCoverFromLayers(p.cloudLayers),
    ceilingM: ceilingFromLayers(p.cloudLayers),
    wxText: text,
    precipMmHr: measured !== null && measured > 0 ? measured : precipFromText(text),
    thunder: isThundery(text),
  };
}

/** Observations for the whole roster, politely pooled. Partial results are fine. */
export async function fetchObservations(stations, { concurrency = 6 } = {}) {
  const results = await pooled(stations, concurrency, (st) => fetchObservation(st));
  const ok = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r && !r.__error && r.tempC !== null) ok.push(r);
    else errors.push({ station: stations[i]?.id, error: r?.__error || 'no temperature' });
  });
  return { observations: ok, errors };
}

/** Active NWS watches, warnings and advisories for Texas. */
export async function fetchAlerts() {
  const json = await fetchJson(`${BASE}/alerts/active?area=TX`, { timeoutMs: 20000, retries: 1 });
  return (json?.features || [])
    .map((f) => {
      const p = f?.properties || {};
      return {
        id: p.id || f.id,
        event: p.event || 'Alert',
        severity: p.severity || 'Unknown',
        urgency: p.urgency || 'Unknown',
        certainty: p.certainty || 'Unknown',
        headline: p.headline || null,
        areaDesc: p.areaDesc || null,
        sent: p.sent || null,
        expires: p.expires || null,
        geometry: f?.geometry || null,
      };
    })
    .filter((a) => a.id);
}

/** Magnus-formula RH fallback when a station omits relativeHumidity. */
export function relativeHumidity(tempC, dewC) {
  if (tempC === null || dewC === null) return null;
  const es = 6.112 * Math.exp((17.67 * tempC) / (tempC + 243.5));
  const e = 6.112 * Math.exp((17.67 * dewC) / (dewC + 243.5));
  return Math.max(0, Math.min(100, (e / es) * 100));
}

export { FALLBACK_STATIONS };
