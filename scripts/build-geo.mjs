/**
 * Extracts Texas geometry from us-atlas (US Census Bureau TIGER/Line, 1:10,000,000)
 * into a single GeoJSON-ish bundle the visual engine loads at runtime.
 *
 *   node scripts/build-geo.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { feature, merge } from 'topojson-client';
import { presimplify, simplify, quantile } from 'topojson-simplify';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const TX_FIPS = '48';

const topo = JSON.parse(
  readFileSync(join(root, 'node_modules/us-atlas/counties-10m.json'), 'utf8')
);

// Simplify just enough to shed vertex noise while keeping the coastline and
// the Rio Grande reading as themselves.
const pre = presimplify(topo);
const thinned = simplify(pre, quantile(pre, 0.82));

const countyGeoms = thinned.objects.counties.geometries.filter((g) =>
  String(g.id).startsWith(TX_FIPS)
);
if (countyGeoms.length !== 254) {
  throw new Error(`expected 254 Texas counties, got ${countyGeoms.length}`);
}

// One dissolved outline for the state silhouette / clip mask.
const outline = merge(thinned, countyGeoms);

const counties = countyGeoms.map((g) => {
  const f = feature(thinned, g);
  return {
    id: String(g.id),
    name: f.properties?.name ?? null,
    geometry: f.geometry,
  };
});

const bbox = [Infinity, Infinity, -Infinity, -Infinity];
const walk = (coords) => {
  if (typeof coords[0] === 'number') {
    bbox[0] = Math.min(bbox[0], coords[0]);
    bbox[1] = Math.min(bbox[1], coords[1]);
    bbox[2] = Math.max(bbox[2], coords[0]);
    bbox[3] = Math.max(bbox[3], coords[1]);
    return;
  }
  for (const c of coords) walk(c);
};
walk(outline.coordinates);

const bundle = {
  generated: new Date().toISOString(),
  source:
    'us-atlas 3.x counties-10m (US Census Bureau TIGER/Line, 1:10,000,000), dissolved to Texas',
  bbox,
  outline,
  counties,
};

const out = join(root, 'data/texas.geo.json');
writeFileSync(out, JSON.stringify(bundle));
const kb = (Buffer.byteLength(JSON.stringify(bundle)) / 1024).toFixed(0);
console.log(`wrote ${out}`);
console.log(`  counties: ${counties.length}`);
console.log(`  bbox:     ${bbox.map((n) => n.toFixed(3)).join(', ')}`);
console.log(`  size:     ${kb} KB`);
