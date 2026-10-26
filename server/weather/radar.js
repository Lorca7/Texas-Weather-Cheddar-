/**
 * NEXRAD composite reflectivity, via the Iowa Environmental Mesonet's WMS
 * mirror of the NOAA/NWS radar mosaic (product N0Q, 0.5-degree base
 * reflectivity composite, refreshed roughly every 5 minutes).
 *
 *   https://mesonet.agron.iastate.edu/ogc/
 *
 * This is the only feed that gives us real *shape*: where precipitation
 * actually is, right now, at a few-kilometre resolution. Station observations
 * tell us what the air is doing at 40 points; radar tells us what the storm
 * looks like. The visual engine spawns its media clusters from this grid, so
 * uploaded faces/tacos travel along the real echo.
 *
 * The PNG comes back palettised to the standard NWS reflectivity ramp, so
 * decoding is a nearest-colour lookup against that ramp.
 */
import { PNG } from 'pngjs';
import { fetchBuffer } from '../lib/http.js';

const WMS = process.env.RADAR_WMS || 'https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q.cgi';

/**
 * Standard NWS/NEXRAD level-3 base-reflectivity colour ramp.
 * Anchors are the published ramp steps in dBZ; intermediate pixels resolve to
 * the nearest anchor, which is what the palettised source emits anyway.
 */
const RAMP = [
  [0x04, 0xe9, 0xe7, 5],
  [0x01, 0x9f, 0xf4, 10],
  [0x03, 0x00, 0xf4, 15],
  [0x02, 0xfd, 0x02, 20],
  [0x01, 0xc5, 0x01, 25],
  [0x00, 0x8e, 0x00, 30],
  [0xfd, 0xf8, 0x02, 35],
  [0xe5, 0xbc, 0x00, 40],
  [0xfd, 0x95, 0x00, 45],
  [0xfd, 0x00, 0x00, 50],
  [0xd4, 0x00, 0x00, 55],
  [0xbc, 0x00, 0x00, 60],
  [0xf8, 0x00, 0xfd, 65],
  [0x98, 0x54, 0xc6, 70],
  [0xfd, 0xfd, 0xfd, 75],
];

/** Nearest ramp entry in RGB space -> dBZ, or 0 for "no echo". */
export function dbzFromRgb(r, g, b, a) {
  if (a < 24) return 0;
  let bestD = Infinity;
  let bestZ = 0;
  for (const [rr, gg, bb, z] of RAMP) {
    const d = (r - rr) ** 2 + (g - gg) ** 2 + (b - bb) ** 2;
    if (d < bestD) {
      bestD = d;
      bestZ = z;
    }
  }
  // Far from every ramp colour: basemap bleed, a county line or a text label,
  // not weather. Squared-RGB distance; anti-aliased blends between two
  // neighbouring ramp steps stay well inside this, arbitrary greys do not.
  if (bestD > 3000) return 0;
  return bestZ;
}

/** dBZ -> 0..1 intensity. 15 dBZ is barely-there drizzle, 65+ is a hailstorm. */
export const dbzToIntensity = (dbz) =>
  dbz <= 5 ? 0 : Math.max(0, Math.min(1, (dbz - 5) / 60));

/** dBZ -> mm/h via the Marshall-Palmer relation Z = 200 R^1.6. */
export function dbzToRainfallMmHr(dbz) {
  if (dbz <= 5) return 0;
  const z = 10 ** (dbz / 10);
  return (z / 200) ** (1 / 1.6);
}

/**
 * Fetch the Texas radar mosaic and reduce it to a coarse dBZ grid.
 * Returns null-ish failure as a thrown error; the caller treats radar as
 * optional and degrades to station-derived precipitation.
 *
 * @param {[number,number,number,number]} bbox  [west, south, east, north]
 */
export async function fetchRadarGrid({
  bbox,
  cols = 112,
  rows = 96,
  // Request at a few times grid resolution so each cell averages real pixels
  // instead of point-sampling a single one.
  sampleW = 560,
  sampleH = 480,
  timeoutMs = 20000,
} = {}) {
  if (!bbox) throw new Error('fetchRadarGrid requires a bbox');
  const url =
    `${WMS}?service=WMS&version=1.1.1&request=GetMap` +
    `&layers=nexrad-n0q&styles=&srs=EPSG:4326` +
    `&bbox=${bbox.join(',')}` +
    `&width=${sampleW}&height=${sampleH}` +
    `&format=image/png&transparent=true`;

  const buf = await fetchBuffer(url, { timeoutMs, retries: 1 });
  const png = PNG.sync.read(buf);
  return reduceToGrid(png, { cols, rows, bbox });
}

/** Average a decoded PNG into a cols x rows dBZ/intensity grid. */
export function reduceToGrid(png, { cols, rows, bbox }) {
  const { width, height, data } = png;
  const dbz = new Float32Array(cols * rows);
  const peak = new Float32Array(cols * rows);
  const counts = new Uint32Array(cols * rows);

  for (let y = 0; y < height; y++) {
    const gy = Math.min(rows - 1, Math.floor((y / height) * rows));
    for (let x = 0; x < width; x++) {
      const gx = Math.min(cols - 1, Math.floor((x / width) * cols));
      const i = (y * width + x) * 4;
      const z = dbzFromRgb(data[i], data[i + 1], data[i + 2], data[i + 3]);
      const gi = gy * cols + gx;
      dbz[gi] += z;
      if (z > peak[gi]) peak[gi] = z;
      counts[gi]++;
    }
  }

  let maxDbz = 0;
  let echoCells = 0;
  const intensity = new Float32Array(cols * rows);
  for (let i = 0; i < dbz.length; i++) {
    if (counts[i]) dbz[i] /= counts[i];
    intensity[i] = dbzToIntensity(dbz[i]);
    if (dbz[i] > 5) echoCells++;
    if (peak[i] > maxDbz) maxDbz = peak[i];
  }

  return {
    cols,
    rows,
    bbox,
    // PNG row 0 is the north edge; keep that convention and document it.
    rowOrder: 'north-to-south',
    dbz,
    peakDbz: peak,
    intensity,
    stats: {
      maxDbz,
      coverage: echoCells / (cols * rows),
      // Convective-looking cells: the ones that make thunder in the score.
      stormCells: countStormCells(peak, cols, rows, 45),
    },
    fetchedAt: Date.now(),
  };
}

/** Count local maxima above a dBZ threshold — a cheap "how many storms" proxy. */
function countStormCells(peak, cols, rows, threshold) {
  let n = 0;
  for (let y = 1; y < rows - 1; y++) {
    for (let x = 1; x < cols - 1; x++) {
      const v = peak[y * cols + x];
      if (v < threshold) continue;
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (peak[(y + dy) * cols + (x + dx)] > v) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) n++;
    }
  }
  return n;
}
