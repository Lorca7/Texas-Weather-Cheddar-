/**
 * Self-check: `npm run check`
 *
 * Exercises the parts that are easy to break silently — unit conversion,
 * radar palette decoding, field interpolation, frame encoding, the degraded
 * modes — without needing the network. Add to it when you add a mapping.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let passed = 0;
let failed = 0;
const fails = [];

function check(name, got, want, tolerance = 0) {
  const ok =
    typeof want === 'number' && typeof got === 'number'
      ? Math.abs(got - want) <= tolerance
      : JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    passed++;
  } else {
    failed++;
    fails.push(`${name}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}${tolerance ? ` (±${tolerance})` : ''}`);
  }
}

function ok(name, condition, detail = '') {
  if (condition) passed++;
  else {
    failed++;
    fails.push(`${name}${detail ? `\n     ${detail}` : ''}`);
  }
}

console.log('texas-weather-cheddar self-check\n');

/* ---------- geometry ---------- */
const geoPath = join(root, 'data/texas.geo.json');
ok('data/texas.geo.json exists (run "npm run build:geo" if not)', existsSync(geoPath));
if (existsSync(geoPath)) {
  const geo = JSON.parse(readFileSync(geoPath, 'utf8'));
  check('texas geometry: county count', geo.counties.length, 254);
  const [w, s, e, n] = geo.bbox;
  check('texas bbox west', w, -106.65, 0.2);
  check('texas bbox south', s, 25.84, 0.2);
  check('texas bbox east', e, -93.51, 0.2);
  check('texas bbox north', n, 36.5, 0.2);
}

/* ---------- projection ---------- */
const { Albers, MapView } = await import('../public/js/visual/projection.js');
const albers = new Albers();
for (const [name, lon, lat] of [['Austin', -97.74, 30.27], ['Amarillo', -101.83, 35.22]]) {
  const [x, y] = albers.project(lon, lat);
  const [lo, la] = albers.invert(x, y);
  check(`projection round-trips ${name} lon`, lo, lon, 1e-9);
  check(`projection round-trips ${name} lat`, la, lat, 1e-9);
}
if (existsSync(geoPath)) {
  const geo = JSON.parse(readFileSync(geoPath, 'utf8'));
  const view = new MapView({ geo, width: 1920, height: 1080 });
  const [, northY] = view.toScreen(-99, 36.4);
  const [, southY] = view.toScreen(-99, 26.0);
  ok('map is not upside down (north above south)', northY < southY, `north y=${northY.toFixed(0)} south y=${southY.toFixed(0)}`);
  const [westX] = view.toScreen(-106.5, 31.8);
  const [eastX] = view.toScreen(-94, 31.8);
  ok('map is not mirrored (west left of east)', westX < eastX, `west x=${westX.toFixed(0)} east x=${eastX.toFixed(0)}`);
}

/* ---------- NWS unit conversion ---------- */
const nws = await import('../server/weather/nws.js');
const q = (value, unitCode) => ({ value, unitCode });
check('degF -> degC', nws.toCelsius(q(212, 'wmoUnit:degF')), 100, 1e-9);
check('K -> degC', nws.toCelsius(q(273.15, 'wmoUnit:K')), 0, 1e-9);
check('km/h -> kt', nws.toKnots(q(18.52, 'wmoUnit:km_h-1')), 10, 1e-6);
check('m/s -> kt', nws.toKnots(q(10, 'wmoUnit:m_s-1')), 19.43844, 1e-4);
check('Pa -> hPa', nws.toHectopascals(q(101325, 'wmoUnit:Pa')), 1013.25, 1e-9);
check('inches -> mm', nws.toMillimetres(q(1, 'unit:[in_i]')), 25.4, 1e-9);
check('OVC sky cover', nws.skyCoverFromLayers([{ amount: 'FEW' }, { amount: 'OVC' }]), 1);
check('CLR sky cover', nws.skyCoverFromLayers([{ amount: 'CLR' }]), 0);
check('no layers -> unknown', nws.skyCoverFromLayers([]), null);
check('ceiling ignores FEW/SCT', nws.ceilingFromLayers([
  { amount: 'FEW', base: q(300, 'wmoUnit:m') },
  { amount: 'BKN', base: q(1200, 'wmoUnit:m') },
]), 1200);
check('RH at T=Td is 100%', Math.round(nws.relativeHumidity(20, 20)), 100);
ok('heavy thunderstorm implies more rain than light rain',
  nws.precipFromText('Heavy Thunderstorm Rain') > nws.precipFromText('Light Rain'));

/* ---------- radar palette ---------- */
const radar = await import('../server/weather/radar.js');
check('N0Q cyan -> 5 dBZ', radar.dbzFromRgb(0x04, 0xe9, 0xe7, 255), 5);
check('N0Q red -> 50 dBZ', radar.dbzFromRgb(0xfd, 0x00, 0x00, 255), 50);
check('N0Q magenta -> 65 dBZ', radar.dbzFromRgb(0xf8, 0x00, 0xfd, 255), 65);
check('transparent pixel -> no echo', radar.dbzFromRgb(0xfd, 0, 0, 0), 0);
check('basemap grey -> no echo', radar.dbzFromRgb(0x77, 0x77, 0x77, 255), 0);
check('Marshall-Palmer 50 dBZ mm/h', radar.dbzToRainfallMmHr(50), 48.6, 0.5);
check('Marshall-Palmer 20 dBZ mm/h', radar.dbzToRainfallMmHr(20), 0.65, 0.05);

/* ---------- field maths ---------- */
const field = await import('../server/weather/field.js');
check('wind FROM west blows east (u>0)', field.windComponent({ windKt: 20, windDirDeg: 270 }, 'u'), 20, 1e-9);
check('wind FROM west has no v', field.windComponent({ windKt: 20, windDirDeg: 270 }, 'v'), 0, 1e-9);
check('wind FROM south blows north (v>0)', field.windComponent({ windKt: 20, windDirDeg: 180 }, 'v'), 20, 1e-9);
check('calm/variable wind is zero', field.windComponent({ windKt: 20, windDirDeg: null }, 'u'), 0);
const geoGrid = field.gridGeo([-100, 30, -98, 32], 3, 3);
const interp = field.idw([
  { lon: -100, lat: 32, value: 0 },
  { lon: -98, lat: 30, value: 100 },
], geoGrid);
check('IDW midpoint between two stations', interp[4], 50, 1);
check('channel encode: range floor', Buffer.from(field.encodeChannel(new Float32Array([-25]), [-25, 50]), 'base64')[0], 0);
check('channel encode: range ceiling', Buffer.from(field.encodeChannel(new Float32Array([50]), [-25, 50]), 'base64')[0], 255);

/* ---------- show config safety ---------- */
const show = await import('../server/lib/showConfig.js');
const merged = show.mergeShow(structuredClone(show.DEFAULT_SHOW), {
  map: { land: '#ff0000' },
  audio: { master: '0.25' },
  __proto__hack: { x: 1 },
  bogusKey: true,
});
check('show merge applies known keys', merged.map.land, '#ff0000');
check('show merge coerces numeric strings', merged.audio.master, 0.25);
ok('show merge drops unknown keys', !('bogusKey' in merged));
check('show merge leaves untouched defaults', merged.map.outline, show.DEFAULT_SHOW.map.outline);

/* ---------- media library safety ---------- */
const media = await import('../server/lib/mediaLibrary.js');
check('upload name cannot traverse directories', media.safeName('../../etc/passwd'), 'passwd');
check('upload name keeps a sane basename', media.safeName('my photo.PNG'), 'my photo.PNG');
check('executable uploads rejected', media.kindForExt('.exe'), null);
check('mp4 recognised as video', media.kindForExt('.mp4'), 'video');

/* ---------- SSRF guard ---------- */
const http = await import('../server/lib/http.js');
for (const [label, url] of [
  ['loopback', 'http://127.0.0.1/x.png'],
  ['link-local cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
  ['private 10/8', 'http://10.1.2.3/x.png'],
  ['private 192.168/16', 'http://192.168.1.1/x.png'],
  ['non-http scheme', 'file:///etc/passwd'],
]) {
  let rejected = false;
  try {
    await http.assertPublicUrl(url);
  } catch {
    rejected = true;
  }
  ok(`remote-source guard rejects ${label}`, rejected, url);
}

/* ---------- a full synthetic frame ---------- */
const { WeatherService } = await import('../server/weather/index.js');
const svc = new WeatherService({ mode: 'synthetic' });
const frame = await svc.start();
svc.stop();
check('synthetic frame is labelled synthetic', frame.source, 'synthetic');
ok('synthetic frame carries a disclosure note', (frame.notes || []).length > 0, JSON.stringify(frame.notes));
ok('frame has stations', frame.stations.length > 10, `${frame.stations.length}`);
check('frame grid columns', frame.grid.cols, field.GRID_COLS);
const channels = Object.keys(frame.grid.channels);
for (const c of ['temp', 'cloud', 'precip', 'windU', 'windV', 'alert']) {
  ok(`frame carries channel "${c}"`, channels.includes(c));
}
ok('frame temperatures are plausible for Texas',
  frame.summary.tempC.min > -25 && frame.summary.tempC.max < 50,
  `${frame.summary.tempC.min}..${frame.summary.tempC.max} C`);

/* ---------- client decodes what the server encodes ---------- */
const { FrameView } = await import('../public/js/net/feed.js');
const view = new FrameView(frame);
const sample = frame.stations[0];
const gridTemp = view.sampleAt('temp', sample.lon, sample.lat);
ok('grid temperature matches the station under it',
  Math.abs(gridTemp - sample.tempC) < 4,
  `station ${sample.id} ${sample.tempC}C vs grid ${gridTemp.toFixed(1)}C`);

/* ---------- weather -> music ---------- */
const scales = await import('../public/js/audio/scales.js');
const cold = scales.weatherToMusic(
  { tempC: { mean: -2, spread: 6 }, windKt: { mean: 3 }, cloudMean: 0.05, pressureHpa: { mean: 1028 }, rh: { mean: 35 } },
  { scaleMode: 'auto', rootMode: 'auto', tempoBias: 1 }
);
const hot = scales.weatherToMusic(
  { tempC: { mean: 36, spread: 7 }, windKt: { mean: 8 }, cloudMean: 0.1, pressureHpa: { mean: 1009 }, rh: { mean: 28 } },
  { scaleMode: 'auto', rootMode: 'auto', tempoBias: 1 }
);
const storm = scales.weatherToMusic(
  { tempC: { mean: 24, spread: 22 }, windKt: { mean: 28 }, gustKt: { max: 52 }, cloudMean: 0.92,
    pressureHpa: { mean: 996 }, rh: { mean: 78 }, precipCoverage: 0.42, precipMax: 1,
    stormCells: 18, frontalGradient: 0.9, alertLevel: 0.8 },
  { scaleMode: 'auto', rootMode: 'auto', tempoBias: 1 }
);
ok('cold weather is darker than hot', cold.warmth < hot.warmth, `${cold.warmth} vs ${hot.warmth}`);
ok('overcast is less bright than clear', storm.brightness < hot.brightness, `${storm.brightness} vs ${hot.brightness}`);
ok('a front raises musical tension', storm.tension > cold.tension, `${storm.tension} vs ${cold.tension}`);
ok('wind quickens the pulse', storm.eventIntervalSec < cold.eventIntervalSec, `${storm.eventIntervalSec}s vs ${cold.eventIntervalSec}s`);
ok('storms drive the thunder voice', storm.drive.thunder > 0.3, `${storm.drive.thunder}`);
ok('dry clear weather silences the rain voice', hot.drive.rain === 0, `${hot.drive.rain}`);

/* ---------- report ---------- */
console.log(`${passed} passed, ${failed} failed\n`);
if (failed) {
  console.log('FAILURES:');
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('all checks passed');
