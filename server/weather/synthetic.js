/**
 * Synthetic Texas weather — a physically-plausible stand-in, NOT observations.
 *
 * Two legitimate uses:
 *   1. Rehearsal. You can build a show, tune the palette and audition media
 *      against a guaranteed-interesting sky (a squall line crossing the state)
 *      instead of waiting for real weather to cooperate.
 *   2. Degraded operation. If api.weather.gov is unreachable, the broadcast
 *      keeps running rather than freezing — but every frame is stamped
 *      source:'synthetic' and the UI shows a SIMULATED badge. It is never
 *      presented as a real observation.
 *
 * The model: a cold front marching west-to-east with a convective line along
 * it, Gulf moisture ahead, drier/cooler northwesterly flow behind, plus a
 * diurnal temperature cycle. Deterministic for a given (seed, time).
 */
import { FALLBACK_STATIONS } from './stations.js';
import { dbzToIntensity } from './radar.js';

/* deterministic value noise -------------------------------------------------*/

function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t) => t * t * (3 - 2 * t);

/** 2-D value noise in [0,1]. */
function noise2(x, y, seed = 1) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = fade(x - xi);
  const yf = fade(y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return (a * (1 - xf) + b * xf) * (1 - yf) + (c * (1 - xf) + d * xf) * yf;
}

function fbm(x, y, seed = 1, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise2(x * freq, y * freq, seed + o * 101);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clamp01 = (v) => clamp(v, 0, 1);

/* the model -----------------------------------------------------------------*/

const WEST = -106.65;
const EAST = -93.52;

/**
 * Front longitude at a given time. Crosses the state over `periodMin`
 * then wraps round to the west again.
 */
function frontLon(t, periodMin) {
  const phase = ((t / 60000) % periodMin) / periodMin;
  // Start a little west of the state and end a little east of it.
  return WEST - 3 + phase * (EAST - WEST + 6);
}

/** Diurnal factor: coolest ~6am, warmest ~4pm local (CST ~ UTC-6). */
function diurnal(t) {
  const hoursUtc = (t / 3600000) % 24;
  const local = (hoursUtc - 6 + 24) % 24;
  return Math.cos(((local - 16) / 24) * 2 * Math.PI);
}

export function syntheticState(t = Date.now(), { seed = 7, periodMin = 150 } = {}) {
  return { t, seed, periodMin, frontLon: frontLon(t, periodMin), diurnal: diurnal(t) };
}

/** Station-style observations sampled from the model. */
export function syntheticObservations(t = Date.now(), opts = {}) {
  const st = syntheticState(t, opts);
  const { seed } = st;

  return FALLBACK_STATIONS.map((s) => {
    const { lat, lon } = s;
    // Distance ahead (+) or behind (-) the front, in degrees of longitude.
    const d = lon - st.frontLon;
    const ahead = d > 0;
    const prox = Math.exp(-((d / 1.6) ** 2)); // 1 at the front, decaying away

    // Base temperature: warmer south and east, cooler on the Llano Estacado.
    // Tuned so the Rio Grande Valley sits near 30 C on a warm afternoon and
    // the Panhandle runs 10-15 C cooler, with a sharp post-frontal drop.
    const latPart = (34.5 - lat) * 1.3;
    const elevPart = lon < -101 ? -3.2 : 0;
    const diurnalPart = st.diurnal * 6.5;
    const airmass = ahead ? 3.0 : -6.0;
    const wobble = (fbm(lon * 0.6, lat * 0.6, seed, 3) - 0.5) * 4;
    const tempC = clamp(10 + latPart + elevPart + diurnalPart + airmass + wobble, -18, 47);

    // Gulf moisture ahead of the front, dry slot behind it.
    const gulf = clamp01(1 - Math.abs(lon + 95) / 11) * clamp01((32.5 - lat) / 6 + 0.55);
    const dewBase = ahead ? tempC - 3 - (1 - gulf) * 9 : tempC - 13 - (1 - gulf) * 7;
    const dewC = clamp(Math.min(dewBase, tempC - 0.4), -30, 26);

    // Wind: southerly ahead, northwesterly behind, strongest at the line.
    const dirDeg = ahead ? 160 + (fbm(lon, lat, seed + 5, 2) - 0.5) * 50 : 310 + (fbm(lon, lat, seed + 9, 2) - 0.5) * 50;
    const windKt = clamp(7 + prox * 22 + fbm(lon * 1.3, lat * 1.3, seed + 3, 3) * 11, 0, 55);
    const gustKt = windKt > 12 ? windKt * (1.35 + prox * 0.5) : null;

    // Cloud and precipitation concentrate on the line.
    const cellNoise = fbm(lon * 2.2 + st.t / 900000, lat * 2.2, seed + 17, 4);
    const convective = prox * (0.45 + cellNoise * 0.75);
    const skyCover = clamp01(convective * 1.2 + (ahead ? 0.28 : 0.1) + cellNoise * 0.25);
    const rate = convective > 0.55 ? (convective - 0.5) * 26 : 0;
    const thunder = convective > 0.78;

    const pressureHpa =
      1013 + (ahead ? -4.5 : 3.0) - prox * 5.5 + (fbm(lon * 0.4, lat * 0.4, seed + 21, 2) - 0.5) * 3;

    const rh = clamp(
      100 *
        (Math.exp((17.67 * dewC) / (dewC + 243.5)) / Math.exp((17.67 * tempC) / (tempC + 243.5))),
      3,
      100
    );

    return {
      id: s.id,
      name: s.name,
      lat,
      lon,
      observedAt: new Date(t).toISOString(),
      tempC: Number(tempC.toFixed(1)),
      dewC: Number(dewC.toFixed(1)),
      rh: Number(rh.toFixed(0)),
      windKt: Number(windKt.toFixed(1)),
      gustKt: gustKt === null ? null : Number(gustKt.toFixed(1)),
      windDirDeg: Number((((dirDeg % 360) + 360) % 360).toFixed(0)),
      pressureHpa: Number(pressureHpa.toFixed(1)),
      visibilityM: rate > 6 ? 3000 : rate > 1 ? 9000 : 16000,
      skyCover: Number(skyCover.toFixed(2)),
      ceilingM: skyCover > 0.7 ? 900 : null,
      wxText: thunder
        ? 'Thunderstorm (simulated)'
        : rate > 6 ? 'Heavy Rain (simulated)'
        : rate > 0.5 ? 'Light Rain (simulated)'
        : skyCover > 0.75 ? 'Cloudy (simulated)'
        : skyCover > 0.4 ? 'Partly Cloudy (simulated)'
        : 'Clear (simulated)',
      precipMmHr: Number(rate.toFixed(2)),
      thunder,
    };
  });
}

/**
 * A radar-shaped grid from the same model, so the visual engine exercises the
 * identical code path it uses for real NEXRAD.
 */
export function syntheticRadar(t = Date.now(), { bbox, cols, rows, ...opts } = {}) {
  const st = syntheticState(t, opts);
  const [w, s, e, n] = bbox;
  const dbz = new Float32Array(cols * rows);
  const peak = new Float32Array(cols * rows);
  const intensity = new Float32Array(cols * rows);

  let maxDbz = 0;
  let echo = 0;

  for (let row = 0; row < rows; row++) {
    const lat = n - ((row + 0.5) / rows) * (n - s);
    for (let col = 0; col < cols; col++) {
      const lon = w + ((col + 0.5) / cols) * (e - w);
      // The line bows eastward in the middle of the state, like a real bow echo.
      const bow = Math.cos(((lat - 31) / 6) * Math.PI) * 0.8;
      const d = lon - (st.frontLon + bow);
      const prox = Math.exp(-((d / 0.55) ** 2));
      const cells = fbm(lon * 3.1 + st.t / 600000, lat * 3.1, st.seed + 31, 4);
      const supercell = Math.pow(fbm(lon * 1.1, lat * 1.1 + st.t / 1800000, st.seed + 47, 3), 3);
      const raw = prox * (0.35 + cells * 0.9) + supercell * 0.55 * prox;
      // Scattered trailing stratiform behind the line.
      const trail = clamp01(-d / 4) * cells * 0.22;
      const v = clamp01(raw + trail);
      const z = v > 0.08 ? 10 + v * 62 : 0;
      const i = row * cols + col;
      dbz[i] = z;
      peak[i] = z;
      intensity[i] = dbzToIntensity(z);
      if (z > 5) echo++;
      if (z > maxDbz) maxDbz = z;
    }
  }

  // Count convective maxima the same way radar.js does.
  let stormCells = 0;
  for (let y = 1; y < rows - 1; y++) {
    for (let x = 1; x < cols - 1; x++) {
      const v = peak[y * cols + x];
      if (v < 45) continue;
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          if (peak[(y + dy) * cols + (x + dx)] > v) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) stormCells++;
    }
  }

  return {
    cols,
    rows,
    bbox,
    rowOrder: 'north-to-south',
    dbz,
    peakDbz: peak,
    intensity,
    stats: { maxDbz, coverage: echo / (cols * rows), stormCells },
    fetchedAt: t,
    synthetic: true,
  };
}

/** A plausible severe-weather alert on the line, clearly marked simulated. */
export function syntheticAlerts(t = Date.now(), opts = {}) {
  const st = syntheticState(t, opts);
  if (st.frontLon < WEST || st.frontLon > EAST) return [];
  const lon = st.frontLon;
  const lat = 31.2 + Math.sin(t / 2400000) * 2.4;
  const box = [
    [lon - 0.75, lat - 1.1],
    [lon + 0.95, lat - 1.1],
    [lon + 0.95, lat + 1.1],
    [lon - 0.75, lat + 1.1],
    [lon - 0.75, lat - 1.1],
  ];
  return [
    {
      id: `synthetic-svr-${Math.floor(t / 600000)}`,
      event: 'Severe Thunderstorm Warning (simulated)',
      severity: 'Severe',
      urgency: 'Immediate',
      certainty: 'Observed',
      headline: 'SIMULATED severe thunderstorm warning along the modelled squall line',
      areaDesc: 'Simulated warning polygon — not a National Weather Service product',
      sent: new Date(t).toISOString(),
      expires: new Date(t + 2700000).toISOString(),
      geometry: { type: 'Polygon', coordinates: [box] },
      synthetic: true,
    },
  ];
}
