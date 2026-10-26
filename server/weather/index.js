/**
 * WeatherService — owns the polling loop and publishes WeatherFrames.
 *
 * Source modes:
 *   'nws'       strictly live NOAA. If it fails, the last good frame is held
 *               and marked stale; nothing is invented.
 *   'auto'      live NOAA, falling back to the synthetic model when NOAA is
 *               unreachable. Fallback frames carry source:'synthetic' and a
 *               note, and the UI badges them SIMULATED.
 *   'synthetic' rehearsal mode. Always the model, always badged.
 */
import { EventEmitter } from 'node:events';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { discoverStations, fetchObservations, fetchAlerts, FALLBACK_STATIONS } from './nws.js';
import { fetchRadarGrid } from './radar.js';
import { buildFrame, GRID_COLS, GRID_ROWS } from './field.js';
import { syntheticObservations, syntheticRadar, syntheticAlerts } from './synthetic.js';

/** Texas, with a little margin so the coastline isn't flush with the edge. */
export const TEXAS_BBOX = [-106.95, 25.6, -93.3, 36.75];

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export class WeatherService extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = opts.mode || process.env.WEATHER_SOURCE || 'auto';
    this.bbox = opts.bbox || TEXAS_BBOX;
    this.cols = opts.cols || GRID_COLS;
    this.rows = opts.rows || GRID_ROWS;
    this.observationIntervalMs = num(opts.observationIntervalMs ?? process.env.OBS_INTERVAL_MS, 150000);
    this.radarIntervalMs = num(opts.radarIntervalMs ?? process.env.RADAR_INTERVAL_MS, 120000);
    this.stationCachePath = opts.stationCachePath || join(process.cwd(), 'data/stations.cache.json');
    this.radarEnabled = opts.radarEnabled ?? process.env.RADAR_ENABLED !== '0';

    this.stations = FALLBACK_STATIONS;
    this.stationsFrom = 'fallback-roster';
    this.frame = null;
    this.radar = null;
    this.health = {
      lastObsOk: null,
      lastObsError: null,
      lastRadarOk: null,
      lastRadarError: null,
      lastAlertsOk: null,
      lastAlertsError: null,
      consecutiveFailures: 0,
    };
    this._timers = [];
    this._started = false;
  }

  get syntheticAllowed() {
    return this.mode === 'auto' || this.mode === 'synthetic';
  }

  async start() {
    if (this._started) return this.frame;
    this._started = true;

    if (this.mode !== 'synthetic') await this._loadStations();

    // First frame immediately so the page never opens onto nothing.
    await this.refresh();

    this._timers.push(setInterval(() => this.refresh().catch(() => {}), this.observationIntervalMs));
    if (this.radarEnabled && this.mode !== 'synthetic') {
      this._timers.push(
        setInterval(() => this._refreshRadar().catch(() => {}), this.radarIntervalMs)
      );
    }
    for (const t of this._timers) t.unref?.();
    return this.frame;
  }

  stop() {
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
    this._started = false;
  }

  async setMode(mode) {
    if (!['auto', 'nws', 'synthetic'].includes(mode)) throw new Error(`unknown source mode ${mode}`);
    this.mode = mode;
    this.radar = null;
    if (mode !== 'synthetic' && this.stationsFrom === 'fallback-roster') {
      await this._loadStations().catch(() => {});
    }
    return this.refresh();
  }

  /* ---------- station roster ---------- */

  async _loadStations() {
    // Disk cache first: NWS station metadata changes on the order of months.
    try {
      const cached = JSON.parse(await readFile(this.stationCachePath, 'utf8'));
      if (Array.isArray(cached?.stations) && cached.stations.length >= 12) {
        this.stations = cached.stations;
        this.stationsFrom = `nws-cache (${cached.fetchedAt})`;
      }
    } catch {
      /* no cache yet */
    }
    try {
      const fresh = await discoverStations({ cap: num(process.env.STATION_CAP, 48) });
      this.stations = fresh;
      this.stationsFrom = 'nws-discovery';
      await mkdir(dirname(this.stationCachePath), { recursive: true });
      await writeFile(
        this.stationCachePath,
        JSON.stringify({ fetchedAt: new Date().toISOString(), stations: fresh }, null, 2)
      );
    } catch (err) {
      this.health.lastObsError = `station discovery failed: ${err?.message || err}`;
    }
    return this.stations;
  }

  /* ---------- polling ---------- */

  async _refreshRadar() {
    if (!this.radarEnabled) return null;
    try {
      this.radar = await fetchRadarGrid({
        bbox: this.bbox,
        cols: this.cols,
        rows: this.rows,
      });
      this.health.lastRadarOk = new Date().toISOString();
      this.health.lastRadarError = null;
    } catch (err) {
      this.health.lastRadarError = err?.message || String(err);
      // Keep a recent grid for a while; radar every 5 min means a 2-frame gap
      // is normal. Drop it once it is clearly stale.
      if (this.radar && Date.now() - this.radar.fetchedAt > 20 * 60000) this.radar = null;
    }
    return this.radar;
  }

  async refresh() {
    const t = Date.now();

    if (this.mode === 'synthetic') {
      return this._publish(this._buildSynthetic(t, ['rehearsal mode: synthetic weather model']));
    }

    const notes = [];
    let observations = [];
    let alerts = [];
    let obsError = null;

    const [obsResult, alertResult] = await Promise.allSettled([
      fetchObservations(this.stations),
      fetchAlerts(),
    ]);

    if (obsResult.status === 'fulfilled' && obsResult.value.observations.length >= 5) {
      observations = obsResult.value.observations;
      this.health.lastObsOk = new Date().toISOString();
      this.health.lastObsError = null;
      this.health.consecutiveFailures = 0;
      if (obsResult.value.errors.length) {
        notes.push(`${obsResult.value.errors.length} station(s) did not report`);
      }
    } else {
      obsError =
        obsResult.status === 'rejected'
          ? obsResult.reason?.message || String(obsResult.reason)
          : `only ${obsResult.value.observations.length} station(s) reported`;
      this.health.lastObsError = obsError;
      this.health.consecutiveFailures++;
    }

    if (alertResult.status === 'fulfilled') {
      alerts = alertResult.value;
      this.health.lastAlertsOk = new Date().toISOString();
      this.health.lastAlertsError = null;
    } else {
      this.health.lastAlertsError = alertResult.reason?.message || String(alertResult.reason);
      notes.push('NWS alerts unavailable');
    }

    if (observations.length) {
      if (this.radarEnabled && !this.radar) await this._refreshRadar();
      if (!this.radar) {
        notes.push(
          this.health.lastRadarError
            ? `radar unavailable (${this.health.lastRadarError}); precipitation from station reports`
            : 'radar not yet loaded; precipitation from station reports'
        );
      }
      return this._publish(
        buildFrame({
          observations,
          alerts,
          radar: this.radar,
          bbox: this.bbox,
          source: 'nws',
          cols: this.cols,
          rows: this.rows,
          notes,
        })
      );
    }

    // Live data failed.
    if (this.syntheticAllowed) {
      return this._publish(
        this._buildSynthetic(t, [
          `NOAA unreachable (${obsError}) — showing the synthetic model, not observations`,
          ...notes,
        ])
      );
    }

    // Strict mode: hold the last good frame, flagged stale. Invent nothing.
    if (this.frame) {
      const held = {
        ...this.frame,
        stale: true,
        staleSince: this.frame.t,
        notes: [...(this.frame.notes || []), `live refresh failed: ${obsError}`],
      };
      return this._publish(held, { keepTimestamp: true });
    }
    throw new Error(`no weather available: ${obsError}`);
  }

  _buildSynthetic(t, notes) {
    const radar = syntheticRadar(t, { bbox: this.bbox, cols: this.cols, rows: this.rows });
    return buildFrame({
      observations: syntheticObservations(t),
      alerts: syntheticAlerts(t),
      radar,
      bbox: this.bbox,
      source: 'synthetic',
      cols: this.cols,
      rows: this.rows,
      notes,
    });
  }

  _publish(frame, { keepTimestamp = false } = {}) {
    if (!keepTimestamp) frame.publishedAt = Date.now();
    frame.stations_from = this.stationsFrom;
    this.frame = frame;
    this.emit('frame', frame);
    return frame;
  }

  status() {
    return {
      mode: this.mode,
      bbox: this.bbox,
      grid: { cols: this.cols, rows: this.rows },
      stationCount: this.stations.length,
      stationsFrom: this.stationsFrom,
      radarEnabled: this.radarEnabled,
      intervals: {
        observationMs: this.observationIntervalMs,
        radarMs: this.radarIntervalMs,
      },
      health: this.health,
      frame: this.frame
        ? {
            t: this.frame.t,
            source: this.frame.source,
            stale: !!this.frame.stale,
            notes: this.frame.notes,
            summary: this.frame.summary,
          }
        : null,
    };
  }
}
