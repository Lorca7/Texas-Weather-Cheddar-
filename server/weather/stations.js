/**
 * Texas observing-station roster.
 *
 * The authoritative list (and authoritative coordinates) come from the National
 * Weather Service at runtime via /stations?state=TX. This committed roster is a
 * cold-start fallback so the broadcast can come up before — or without — a
 * successful discovery call. Coordinates here are approximate airport positions
 * and are overwritten by NWS metadata as soon as discovery succeeds.
 */
export const FALLBACK_STATIONS = [
  { id: 'KAMA', name: 'Amarillo',          lat: 35.22,  lon: -101.72 },
  { id: 'KDHT', name: 'Dalhart',           lat: 36.02,  lon: -102.55 },
  { id: 'KLBB', name: 'Lubbock',           lat: 33.66,  lon: -101.82 },
  { id: 'KCDS', name: 'Childress',         lat: 34.43,  lon: -100.28 },
  { id: 'KSPS', name: 'Wichita Falls',     lat: 33.99,  lon:  -98.49 },
  { id: 'KPRX', name: 'Paris',             lat: 33.64,  lon:  -95.45 },
  { id: 'KDFW', name: 'Dallas-Fort Worth', lat: 32.90,  lon:  -97.04 },
  { id: 'KDAL', name: 'Dallas Love',       lat: 32.85,  lon:  -96.85 },
  { id: 'KGGG', name: 'Longview',          lat: 32.38,  lon:  -94.71 },
  { id: 'KTYR', name: 'Tyler',             lat: 32.35,  lon:  -95.40 },
  { id: 'KABI', name: 'Abilene',           lat: 32.41,  lon:  -99.68 },
  { id: 'KBWD', name: 'Brownwood',         lat: 31.79,  lon:  -98.96 },
  { id: 'KACT', name: 'Waco',              lat: 31.61,  lon:  -97.23 },
  { id: 'KGRK', name: 'Killeen',           lat: 31.07,  lon:  -97.83 },
  { id: 'KCLL', name: 'College Station',   lat: 30.59,  lon:  -96.36 },
  { id: 'KLFK', name: 'Lufkin',            lat: 31.23,  lon:  -94.75 },
  { id: 'KBPT', name: 'Beaumont',          lat: 29.95,  lon:  -94.02 },
  { id: 'KIAH', name: 'Houston Intercontinental', lat: 29.98, lon: -95.34 },
  { id: 'KHOU', name: 'Houston Hobby',     lat: 29.65,  lon:  -95.28 },
  { id: 'KGLS', name: 'Galveston',         lat: 29.27,  lon:  -94.86 },
  { id: 'KPSX', name: 'Palacios',          lat: 28.73,  lon:  -96.25 },
  { id: 'KVCT', name: 'Victoria',          lat: 28.86,  lon:  -96.93 },
  { id: 'KAUS', name: 'Austin',            lat: 30.18,  lon:  -97.68 },
  { id: 'KSAT', name: 'San Antonio',       lat: 29.53,  lon:  -98.47 },
  { id: 'KHDO', name: 'Hondo',             lat: 29.36,  lon:  -99.17 },
  { id: 'KSJT', name: 'San Angelo',        lat: 31.35,  lon: -100.49 },
  { id: 'KJCT', name: 'Junction',          lat: 30.51,  lon:  -99.77 },
  { id: 'KDRT', name: 'Del Rio',           lat: 29.37,  lon: -100.92 },
  { id: 'KCOT', name: 'Cotulla',           lat: 28.46,  lon:  -99.22 },
  { id: 'KLRD', name: 'Laredo',            lat: 27.54,  lon:  -99.46 },
  { id: 'KALI', name: 'Alice',             lat: 27.74,  lon:  -98.03 },
  { id: 'KCRP', name: 'Corpus Christi',    lat: 27.77,  lon:  -97.50 },
  { id: 'KMFE', name: 'McAllen',           lat: 26.18,  lon:  -98.24 },
  { id: 'KHRL', name: 'Harlingen',         lat: 26.23,  lon:  -97.65 },
  { id: 'KBRO', name: 'Brownsville',       lat: 25.91,  lon:  -97.43 },
  { id: 'KMAF', name: 'Midland',           lat: 31.94,  lon: -102.20 },
  { id: 'KINK', name: 'Wink',              lat: 31.78,  lon: -103.20 },
  { id: 'KPEQ', name: 'Pecos',             lat: 31.38,  lon: -103.51 },
  { id: 'KFST', name: 'Fort Stockton',     lat: 30.91,  lon: -102.92 },
  { id: 'KMRF', name: 'Marfa',             lat: 30.37,  lon: -104.02 },
  { id: 'KELP', name: 'El Paso',           lat: 31.81,  lon: -106.38 },
];

/** Stations outside this box are discarded even if NWS files them under TX. */
export const TEXAS_BBOX = [-107.0, 25.5, -93.2, 36.8];

export function inTexasBox(lon, lat) {
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    lon >= TEXAS_BBOX[0] &&
    lon <= TEXAS_BBOX[2] &&
    lat >= TEXAS_BBOX[1] &&
    lat <= TEXAS_BBOX[3]
  );
}

/**
 * Thin a dense station list down to a roster that covers the state evenly.
 * NWS returns several hundred TX stations; polling all of them every minute is
 * rude and the extra density buys nothing once the field is interpolated.
 * One station per cell of a coarse lon/lat grid, preferring real ASOS-style
 * 4-letter K-identifiers.
 */
export function thinByGrid(stations, cols = 9, rows = 8, cap = 60) {
  const [w, s, e, n] = TEXAS_BBOX;
  const best = new Map();
  for (const st of stations) {
    if (!inTexasBox(st.lon, st.lat)) continue;
    const cx = Math.min(cols - 1, Math.floor(((st.lon - w) / (e - w)) * cols));
    const cy = Math.min(rows - 1, Math.floor(((st.lat - s) / (n - s)) * rows));
    const key = `${cx},${cy}`;
    const score = (/^K[A-Z]{3}$/.test(st.id) ? 2 : 0) + (st.name ? 1 : 0);
    const prev = best.get(key);
    if (!prev || score > prev.score) best.set(key, { ...st, score });
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, cap)
    .map(({ score, ...st }) => st);
}
