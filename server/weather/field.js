/**
 * Turns scattered station observations + a radar mosaic into the single
 * normalised structure everything downstream consumes: the WeatherFrame.
 *
 * Grid convention (shared with radar.js): row 0 is the NORTH edge,
 * column 0 is the WEST edge, index = row * cols + col.
 *
 * Channels are quantised to bytes with an explicit range so the frame stays
 * small enough to push over SSE every couple of minutes, and so the browser
 * and the music engine read exactly the same numbers.
 */
import { dbzToRainfallMmHr } from './radar.js';

export const GRID_COLS = 112;
export const GRID_ROWS = 96;

/** Fixed quantisation ranges — stable colour/音 mapping across frames. */
export const CHANNEL_RANGE = {
  temp: [-25, 50], // degC
  dew: [-30, 32],
  humidity: [0, 100], // %
  cloud: [0, 1],
  precip: [0, 1], // normalised radar intensity
  rainMmHr: [0, 80],
  windU: [-70, 70], // kt, +east
  windV: [-70, 70], // kt, +north
  windSpeed: [0, 90],
  pressure: [960, 1050], // hPa
  alert: [0, 1],
};

export function gridGeo(bbox, cols = GRID_COLS, rows = GRID_ROWS) {
  const [w, s, e, n] = bbox;
  return {
    cols,
    rows,
    bbox,
    lonAt: (col) => w + ((col + 0.5) / cols) * (e - w),
    latAt: (row) => n - ((row + 0.5) / rows) * (n - s),
  };
}

/**
 * Inverse-distance weighting with a soft cutoff.
 *
 * Texas is 1,200 km across with ~40 reporting stations, so the field is always
 * an interpolation — that is honest and it is what every surface analysis does.
 * `power` 2 keeps gradients soft enough to look like air rather than Voronoi
 * cells; `radiusDeg` stops El Paso from colouring Beaumont.
 */
export function idw(points, geo, { power = 2, radiusDeg = 6.5, smoothingDeg = 0.35 } = {}) {
  const { cols, rows } = geo;
  const out = new Float32Array(cols * rows);
  const usable = points.filter((p) => Number.isFinite(p.value));
  if (usable.length === 0) return out.fill(NaN);

  const r2 = radiusDeg * radiusDeg;
  const eps2 = smoothingDeg * smoothingDeg;

  for (let row = 0; row < rows; row++) {
    const lat = geo.latAt(row);
    // Longitude degrees shrink with latitude; weight them so distance is
    // closer to real ground distance than to raw degrees.
    const lonScale = Math.cos((lat * Math.PI) / 180);
    for (let col = 0; col < cols; col++) {
      const lon = geo.lonAt(col);
      let num = 0;
      let den = 0;
      let nearest = Infinity;
      let nearestVal = NaN;
      for (const p of usable) {
        const dx = (p.lon - lon) * lonScale;
        const dy = p.lat - lat;
        const d2 = dx * dx + dy * dy;
        if (d2 < nearest) {
          nearest = d2;
          nearestVal = p.value;
        }
        if (d2 > r2) continue;
        const wgt = 1 / Math.pow(d2 + eps2, power / 2);
        num += wgt * p.value;
        den += wgt;
      }
      out[row * cols + col] = den > 0 ? num / den : nearestVal;
    }
  }
  return out;
}

/** Box-blur a channel in place-ish; returns a new array. Softens IDW cusps. */
export function smooth(arr, cols, rows, passes = 1) {
  let src = arr;
  for (let p = 0; p < passes; p++) {
    const dst = new Float32Array(src.length);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        let sum = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= rows) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= cols) continue;
            const v = src[yy * cols + xx];
            if (!Number.isFinite(v)) continue;
            sum += v;
            n++;
          }
        }
        dst[y * cols + x] = n ? sum / n : src[y * cols + x];
      }
    }
    src = dst;
  }
  return src;
}

/* ---------- alert rasterisation ------------------------------------------ */

const SEVERITY_WEIGHT = { Extreme: 1, Severe: 0.8, Moderate: 0.55, Minor: 0.3, Unknown: 0.2 };

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInGeometry(lon, lat, geom) {
  if (!geom) return false;
  const polys =
    geom.type === 'Polygon' ? [geom.coordinates]
    : geom.type === 'MultiPolygon' ? geom.coordinates
    : [];
  for (const poly of polys) {
    if (!poly?.length) continue;
    if (!pointInRing(lon, lat, poly[0])) continue;
    let inHole = false;
    for (let h = 1; h < poly.length; h++) {
      if (pointInRing(lon, lat, poly[h])) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

/** Severity field from active alert polygons (alerts without geometry are skipped). */
export function rasterizeAlerts(alerts, geo) {
  const { cols, rows } = geo;
  const out = new Float32Array(cols * rows);
  const withGeom = (alerts || []).filter((a) => a.geometry);
  if (withGeom.length === 0) return out;
  for (let row = 0; row < rows; row++) {
    const lat = geo.latAt(row);
    for (let col = 0; col < cols; col++) {
      const lon = geo.lonAt(col);
      let max = 0;
      for (const a of withGeom) {
        const wgt = SEVERITY_WEIGHT[a.severity] ?? 0.2;
        if (wgt <= max) continue;
        if (pointInGeometry(lon, lat, a.geometry)) max = wgt;
      }
      out[row * cols + col] = max;
    }
  }
  return out;
}

/* ---------- quantisation -------------------------------------------------- */

export function encodeChannel(arr, [lo, hi]) {
  const u8 = new Uint8Array(arr.length);
  const span = hi - lo || 1;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (!Number.isFinite(v)) {
      u8[i] = 0;
      continue;
    }
    u8[i] = Math.max(0, Math.min(255, Math.round(((v - lo) / span) * 255)));
  }
  return Buffer.from(u8).toString('base64');
}

/* ---------- statistics ---------------------------------------------------- */

function stats(values) {
  const v = values.filter(Number.isFinite);
  if (!v.length) return { min: null, max: null, mean: null, spread: null };
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const x of v) {
    if (x < min) min = x;
    if (x > max) max = x;
    sum += x;
  }
  return { min, max, mean: sum / v.length, spread: max - min };
}

/** Mean magnitude of the horizontal temperature gradient — "how frontal is it". */
function meanGradient(arr, cols, rows) {
  let sum = 0;
  let n = 0;
  for (let y = 1; y < rows - 1; y++) {
    for (let x = 1; x < cols - 1; x++) {
      const i = y * cols + x;
      const gx = arr[i + 1] - arr[i - 1];
      const gy = arr[i + cols] - arr[i - cols];
      if (!Number.isFinite(gx) || !Number.isFinite(gy)) continue;
      sum += Math.hypot(gx, gy);
      n++;
    }
  }
  return n ? sum / n : 0;
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/* ---------- frame assembly ------------------------------------------------ */

/**
 * Build the WeatherFrame.
 *
 * @param {object}  args
 * @param {Array}   args.observations  normalised station observations
 * @param {Array}   args.alerts        active NWS alerts
 * @param {object}  [args.radar]       grid from radar.js, or null
 * @param {Array}   args.bbox          [w,s,e,n]
 * @param {string}  args.source        'nws' | 'synthetic' | 'replay'
 */
export function buildFrame({
  observations,
  alerts = [],
  radar = null,
  bbox,
  source = 'nws',
  cols = GRID_COLS,
  rows = GRID_ROWS,
  notes = [],
}) {
  const geo = gridGeo(bbox, cols, rows);
  const pt = (key) => observations.map((o) => ({ lon: o.lon, lat: o.lat, value: o[key] }));

  const temp = smooth(idw(pt('tempC'), geo), cols, rows, 1);
  const dew = smooth(idw(pt('dewC'), geo), cols, rows, 1);
  const humidity = smooth(idw(pt('rh'), geo), cols, rows, 1);
  const pressure = smooth(idw(pt('pressureHpa'), geo), cols, rows, 2);
  const cloud = smooth(
    idw(
      observations.map((o) => ({
        lon: o.lon,
        lat: o.lat,
        // Stations that report no cloud layers still imply cloud through
        // humidity; blend so the sky field is never a hole.
        value:
          o.skyCover !== null && o.skyCover !== undefined
            ? o.skyCover
            : clamp01(((o.rh ?? 40) - 45) / 50),
      })),
      geo
    ),
    cols,
    rows,
    1
  );

  // Wind as components so interpolation can't average 350 deg and 10 deg into south.
  const windU = smooth(
    idw(
      observations.map((o) => ({
        lon: o.lon,
        lat: o.lat,
        value: windComponent(o, 'u'),
      })),
      geo
    ),
    cols,
    rows,
    1
  );
  const windV = smooth(
    idw(
      observations.map((o) => ({
        lon: o.lon,
        lat: o.lat,
        value: windComponent(o, 'v'),
      })),
      geo
    ),
    cols,
    rows,
    1
  );


  // Precipitation: radar when we have it, station present-weather when we don't.
  let precip;
  let rainMmHr;
  let radarOk = false;
  if (radar && radar.cols === cols && radar.rows === rows) {
    precip = radar.intensity;
    rainMmHr = new Float32Array(cols * rows);
    for (let i = 0; i < rainMmHr.length; i++) rainMmHr[i] = dbzToRainfallMmHr(radar.dbz[i]);
    radarOk = true;
  } else {
    rainMmHr = smooth(idw(pt('precipMmHr'), geo, { radiusDeg: 3.2 }), cols, rows, 1);
    precip = new Float32Array(cols * rows);
    for (let i = 0; i < precip.length; i++) precip[i] = clamp01(rainMmHr[i] / 12);
    if (radar) notes = [...notes, 'radar grid shape mismatch; using station-derived precipitation'];
  }

  const alertField = rasterizeAlerts(alerts, geo);

  const tempStats = stats(observations.map((o) => o.tempC));
  const windStats = stats(observations.map((o) => o.windKt));
  const gustStats = stats(observations.map((o) => o.gustKt));
  const presStats = stats(observations.map((o) => o.pressureHpa));
  const rhStats = stats(observations.map((o) => o.rh));

  let precipCells = 0;
  let precipSum = 0;
  let precipMax = 0;
  for (let i = 0; i < precip.length; i++) {
    const v = precip[i];
    if (v > 0.03) precipCells++;
    precipSum += v;
    if (v > precipMax) precipMax = v;
  }

  let cloudSum = 0;
  for (let i = 0; i < cloud.length; i++) cloudSum += Number.isFinite(cloud[i]) ? cloud[i] : 0;

  const severities = (alerts || []).map((a) => SEVERITY_WEIGHT[a.severity] ?? 0.2);
  const thunderStations = observations.filter((o) => o.thunder).length;

  return {
    v: 1,
    t: Date.now(),
    source,
    notes,
    bbox,
    grid: {
      cols,
      rows,
      rowOrder: 'north-to-south',
      ranges: CHANNEL_RANGE,
      channels: {
        temp: encodeChannel(temp, CHANNEL_RANGE.temp),
        dew: encodeChannel(dew, CHANNEL_RANGE.dew),
        humidity: encodeChannel(humidity, CHANNEL_RANGE.humidity),
        cloud: encodeChannel(cloud, CHANNEL_RANGE.cloud),
        precip: encodeChannel(precip, CHANNEL_RANGE.precip),
        rainMmHr: encodeChannel(rainMmHr, CHANNEL_RANGE.rainMmHr),
        windU: encodeChannel(windU, CHANNEL_RANGE.windU),
        windV: encodeChannel(windV, CHANNEL_RANGE.windV),
        pressure: encodeChannel(pressure, CHANNEL_RANGE.pressure),
        alert: encodeChannel(alertField, CHANNEL_RANGE.alert),
      },
    },
    stations: observations.map((o) => ({
      id: o.id,
      name: o.name,
      lat: o.lat,
      lon: o.lon,
      tempC: round(o.tempC, 1),
      dewC: round(o.dewC, 1),
      rh: round(o.rh, 0),
      windKt: round(o.windKt, 1),
      gustKt: round(o.gustKt, 1),
      windDirDeg: round(o.windDirDeg, 0),
      pressureHpa: round(o.pressureHpa, 1),
      visibilityM: round(o.visibilityM, 0),
      skyCover: round(o.skyCover, 2),
      wxText: o.wxText,
      precipMmHr: round(o.precipMmHr, 2),
      thunder: !!o.thunder,
      observedAt: o.observedAt,
    })),
    alerts: (alerts || []).map(({ geometry, ...a }) => ({ ...a, hasGeometry: !!geometry })),
    alertShapes: (alerts || [])
      .filter((a) => a.geometry)
      .map((a) => ({ id: a.id, event: a.event, severity: a.severity, geometry: a.geometry })),
    summary: {
      radar: radarOk,
      stationCount: observations.length,
      tempC: roundStats(tempStats),
      windKt: roundStats(windStats),
      gustKt: roundStats(gustStats),
      pressureHpa: roundStats(presStats),
      rh: roundStats(rhStats),
      cloudMean: round(cloudSum / cloud.length, 3),
      precipCoverage: round(precipCells / precip.length, 4),
      precipMean: round(precipSum / precip.length, 4),
      precipMax: round(precipMax, 3),
      maxDbz: radarOk ? round(radar.stats.maxDbz, 0) : null,
      stormCells: radarOk ? radar.stats.stormCells : thunderStations,
      thunderStations,
      // Artistic drivers, computed once here so visuals and score agree.
      frontalGradient: round(meanGradient(temp, cols, rows), 4),
      alertLevel: round(severities.length ? Math.max(...severities) : 0, 2),
      alertCount: (alerts || []).length,
    },
  };
}

/** Meteorological wind direction (degrees FROM) -> u/v components in knots. */
export function windComponent(o, which) {
  const spd = Number.isFinite(o.windKt) ? o.windKt : 0;
  const dir = o.windDirDeg;
  if (!Number.isFinite(dir)) return 0; // calm or variable
  const rad = (dir * Math.PI) / 180;
  // Wind FROM 270 (west) blows TOWARD the east: u = +spd.
  return which === 'u' ? -spd * Math.sin(rad) : -spd * Math.cos(rad);
}

const round = (v, d) =>
  typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(d)) : null;

const roundStats = (s) => ({
  min: round(s.min, 1),
  max: round(s.max, 1),
  mean: round(s.mean, 1),
  spread: round(s.spread, 1),
});
