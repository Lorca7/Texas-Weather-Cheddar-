/**
 * Bootstrap.
 *
 * Two modes, same scene:
 *   normal     operator view, with the console available at ?panel=1
 *   broadcast  ?broadcast=1&token=… — fixed render size, no UI, starts the
 *              encoder automatically. This is what the headless Chromium
 *              instance loads.
 */
import { WeatherFeed, FieldBlender } from './net/feed.js';
import { MediaPool } from './visual/media.js';
import { VisualEngine } from './visual/engine.js';
import { AmbientEngine } from './audio/engine.js';
import { EncoderClient } from './net/broadcast.js';
import { ControlPanel } from './ui/panel.js';

const params = new URLSearchParams(location.search);
const BROADCAST = params.get('broadcast') === '1';
const TOKEN = params.get('token');

const els = {
  canvas: document.getElementById('stage'),
  audioGate: document.getElementById('audio-gate'),
  audioGateBtn: document.getElementById('audio-gate-btn'),
  panel: document.getElementById('panel'),
  panelToggle: document.getElementById('panel-toggle'),
  banner: document.getElementById('banner'),
  hud: document.getElementById('hud'),
};

const app = {
  show: null,
  geo: null,
  blender: new FieldBlender(),
  pool: new MediaPool(),
  feed: new WeatherFeed(),
  engine: null,
  audio: null,
  encoder: null,
  panel: null,
  broadcast: BROADCAST,
};
window.TWC = app;

/* ---------- helpers ------------------------------------------------------- */

function banner(message, kind = 'info', ttl = 6000) {
  if (!els.banner) return;
  els.banner.textContent = message;
  els.banner.className = `banner banner--${kind} banner--on`;
  clearTimeout(banner._t);
  if (ttl) banner._t = setTimeout(() => els.banner.classList.remove('banner--on'), ttl);
}
app.banner = banner;

async function getJson(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
app.getJson = getJson;

/* ---------- sizing -------------------------------------------------------- */

function fitCanvas() {
  if (BROADCAST) {
    const w = Number(params.get('w')) || 1920;
    const h = Number(params.get('h')) || 1080;
    app.engine.resize(w, h);
    app.engine.targetFps = Number(params.get('fps')) || 30;
    els.canvas.style.width = '100vw';
    els.canvas.style.height = '100vh';
    return;
  }
  // Operator view: render at device pixels, capped so a 4K display does not
  // cost more than it adds.
  const rect = els.canvas.parentElement.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  app.engine.resize(Math.min(2560, rect.width * dpr), Math.min(1440, rect.height * dpr));
  els.canvas.style.width = `${rect.width}px`;
  els.canvas.style.height = `${rect.height}px`;
}

/* ---------- audio gate ---------------------------------------------------- */

async function startAudio({ silent = false } = {}) {
  if (!app.audio) app.audio = new AmbientEngine({ show: app.show });
  try {
    await app.audio.start();
    if (app.audio.ctx?.state === 'running') {
      els.audioGate?.classList.remove('gate--on');
      app.audio.update(app.blender.summary, app.engine?._meanWindVector?.() ?? null);
      return true;
    }
    throw new Error(`audio context is ${app.audio.ctx?.state}`);
  } catch (err) {
    if (!silent) banner(`audio needs a click to start (${err.message})`, 'warn');
    els.audioGate?.classList.add('gate--on');
    return false;
  }
}
app.startAudio = startAudio;

/* ---------- boot ---------------------------------------------------------- */

async function boot() {
  // Geometry and configuration first; nothing can render without them.
  const [geo, showRes] = await Promise.all([
    fetch('/data/texas.geo.json').then((r) => {
      if (!r.ok) throw new Error(`texas.geo.json: HTTP ${r.status} — run "npm run build:geo"`);
      return r.json();
    }),
    getJson('/api/show'),
  ]);
  app.geo = geo;
  app.show = showRes.show;
  app.defaults = showRes.defaults;

  app.engine = new VisualEngine({
    canvas: els.canvas,
    geo,
    blender: app.blender,
    pool: app.pool,
    show: app.show,
  });
  if (BROADCAST) app.engine.extra.watermark = null;
  fitCanvas();
  app.engine.start();

  window.addEventListener('resize', fitCanvas);

  // Media library.
  try {
    await app.pool.load();
  } catch (err) {
    banner(`media library unavailable: ${err.message}`, 'warn');
  }
  app.pool.addEventListener('mediaerror', (ev) => banner(ev.detail.error, 'warn'));

  // Weather feed.
  app.feed.addEventListener('frame', (ev) => {
    const frame = ev.detail;
    app.blender.push(frame);
    app.audio?.update(frame.summary, app.engine._meanWindVector());
    app.panel?.onFrame(frame);
    if (frame.source === 'synthetic') {
      banner(
        frame.notes?.[0] || 'showing the synthetic model, not NWS observations',
        'warn',
        12000
      );
    } else if (frame.stale) {
      banner('NOAA refresh failed — holding the last good observation', 'warn', 12000);
    }
  });
  app.feed.addEventListener('status', (ev) => {
    if (!ev.detail.connected) banner('weather feed disconnected — reconnecting', 'warn', 4000);
  });
  app.feed.connect();

  // Audio. Headless Chromium runs with the autoplay policy relaxed, so in
  // broadcast mode this succeeds without a gesture.
  await startAudio({ silent: true });
  els.audioGateBtn?.addEventListener('click', () => startAudio());

  // Console (operator mode only).
  if (!BROADCAST) {
    app.panel = new ControlPanel({ app, root: els.panel });
    await app.panel.init();
    if (params.get('panel') === '1') app.panel.open();
    els.panelToggle?.addEventListener('click', () => app.panel.toggle());
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'c' && !ev.metaKey && !ev.ctrlKey && ev.target === document.body) {
        app.panel.toggle();
      }
    });
    startHud();
  }

  // Broadcast mode: start the encoder and tell the server we are ready.
  if (BROADCAST) {
    document.body.classList.add('broadcast');
    if (!TOKEN) {
      console.error('broadcast mode requires a token');
    } else {
      await startEncoder();
    }
  }
}

async function startEncoder() {
  const fps = Number(params.get('fps')) || 30;
  app.encoder = new EncoderClient({
    engine: app.engine,
    audio: app.audio,
    token: TOKEN,
    fps,
    videoBitsPerSecond: (Number(params.get('vb')) || 6000) * 1000,
  });

  // Let a few frames render and the first weather frame land before recording,
  // so the stream does not open on an empty canvas.
  await waitFor(() => app.engine.frameCount > 5 && app.blender.ready, 20000).catch(() => {});

  try {
    await app.encoder.start();
    window.__twcBroadcastReady = true;
    console.log('[encoder] recording', app.encoder.mime, 'audio:', app.encoder.hasAudio);
  } catch (err) {
    console.error('[encoder] failed:', err?.message || err);
    window.__twcBroadcastError = String(err?.message || err);
  }
}

function waitFor(predicate, timeoutMs = 10000, intervalMs = 120) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const t = setInterval(() => {
      if (predicate()) {
        clearInterval(t);
        resolve(true);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(t);
        reject(new Error('timed out waiting for the scene'));
      }
    }, intervalMs);
  });
}

/* ---------- small on-screen HUD ------------------------------------------ */

function startHud() {
  if (!els.hud) return;
  setInterval(() => {
    const v = app.engine?.stats();
    const a = app.audio?.started ? app.audio.stats() : null;
    if (!v) return;
    els.hud.textContent = [
      `${v.fps.toFixed?.(0) ?? v.fps} fps`,
      `${v.sprites} sprites`,
      v.quality < 0.995 ? `q${v.quality}` : null,
      `${v.mediaReady} media`,
      v.source ? `src:${v.source}` : null,
      v.frameAgeSec !== null ? `${v.frameAgeSec}s old` : null,
      a ? `${a.key} · ${a.state}` : 'audio off',
    ]
      .filter(Boolean)
      .join('  ·  ');
  }, 500);
}

boot().catch((err) => {
  console.error(err);
  banner(`could not start: ${err.message}`, 'error', 0);
});
