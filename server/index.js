/**
 * Texas Weather Cheddar — server.
 *
 * Serves the broadcast page, polls NOAA, owns the media library and the show
 * configuration, and drives the RTMP pipeline.
 */
import express from 'express';
import multer from 'multer';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { WeatherService, TEXAS_BBOX } from './weather/index.js';
import { MediaLibrary, CHANNELS, kindForExt, safeName } from './lib/mediaLibrary.js';
import { ShowStore, DEFAULT_SHOW } from './lib/showConfig.js';
import { Broadcaster, STREAM_PRESETS } from './stream/broadcast.js';
import { assertPublicUrl, fetchWithRetry } from './lib/http.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 256;

const app = express();
const httpServer = createServer(app);

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

/* ---------- services ------------------------------------------------------ */

const weather = new WeatherService({ bbox: TEXAS_BBOX });
const media = new MediaLibrary({ root: join(ROOT, 'media') });
const show = new ShowStore(join(ROOT, 'data/show.json'));
const broadcaster = new Broadcaster({ publicUrl: `http://127.0.0.1:${PORT}` });

/* ---------- static -------------------------------------------------------- */

app.use(
  express.static(join(ROOT, 'public'), {
    setHeaders(res, path) {
      if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
    },
  })
);
app.use('/data', express.static(join(ROOT, 'data'), { maxAge: '1h' }));
app.use(
  '/media/uploads',
  express.static(join(ROOT, 'media/uploads'), {
    maxAge: '7d',
    // Uploaded files are operator-supplied; never let the browser sniff them
    // into something executable in our origin.
    setHeaders(res) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'");
    },
  })
);

/* ---------- weather API --------------------------------------------------- */

app.get('/api/weather/frame', (req, res) => {
  if (!weather.frame) return res.status(503).json({ error: 'no weather frame yet' });
  res.json(weather.frame);
});

app.get('/api/weather/status', (req, res) => res.json(weather.status()));

app.post('/api/weather/source', async (req, res) => {
  try {
    const frame = await weather.setMode(String(req.body?.mode || ''));
    res.json({ mode: weather.mode, frame: { t: frame.t, source: frame.source, notes: frame.notes } });
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
});

app.post('/api/weather/refresh', async (req, res) => {
  try {
    const frame = await weather.refresh();
    res.json({ t: frame.t, source: frame.source, notes: frame.notes });
  } catch (err) {
    res.status(502).json({ error: err?.message || String(err) });
  }
});

/** Server-sent events: the live weather feed the page renders from. */
app.get('/api/weather/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const send = (frame) => {
    res.write(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`);
  };
  if (weather.frame) send(weather.frame);

  const onFrame = (f) => send(f);
  weather.on('frame', onFrame);

  // Comment lines keep proxies from timing the connection out.
  const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 20000);

  req.on('close', () => {
    clearInterval(ping);
    weather.off('frame', onFrame);
  });
});

/* ---------- media API ----------------------------------------------------- */

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, media.uploadDir),
    filename: (req, file, cb) => {
      const ext = extname(file.originalname || '').toLowerCase();
      cb(null, `${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 40 },
  fileFilter: (req, file, cb) => {
    const ext = extname(file.originalname || '').toLowerCase();
    if (!kindForExt(ext)) return cb(new Error(`unsupported file type: ${ext || 'unknown'}`));
    cb(null, true);
  },
});

app.get('/api/media', (req, res) => res.json({ channels: CHANNELS, items: media.list() }));

app.post('/api/media/upload', (req, res) => {
  upload.array('files', 40)(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'no files received' });
    const channels = req.body?.channels;
    try {
      const added = [];
      for (const f of files) {
        added.push(
          await media.addUpload({
            file: f.filename,
            originalName: f.originalname,
            channels,
            label: files.length === 1 ? req.body?.label : undefined,
          })
        );
      }
      res.json({ added });
    } catch (e) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });
});

app.post('/api/media/remote', async (req, res) => {
  const { source, mediaKind, refreshMs, channels, label } = req.body || {};
  try {
    await assertPublicUrl(source);
  } catch (err) {
    return res.status(400).json({ error: `remote source rejected: ${err?.message || err}` });
  }
  try {
    res.json({ added: await media.addRemote({ source, mediaKind, refreshMs, channels, label }) });
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
});

app.patch('/api/media/:id', async (req, res) => {
  try {
    res.json({ item: await media.update(req.params.id, req.body || {}) });
  } catch (err) {
    res.status(404).json({ error: err?.message || String(err) });
  }
});

app.delete('/api/media/:id', async (req, res) => {
  try {
    await media.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err?.message || String(err) });
  }
});

/**
 * Proxy for remote visual sources.
 *
 * Needed because most third-party image hosts send no CORS headers, and the
 * visual engine has to read pixels. Guarded: http(s) only, public addresses
 * only (see assertPublicUrl), image/video content types only, size-capped.
 */
app.get('/api/media/proxy', async (req, res) => {
  const raw = String(req.query.url || '');
  let url;
  try {
    url = await assertPublicUrl(raw);
  } catch (err) {
    return res.status(400).json({ error: `rejected: ${err?.message || err}` });
  }
  try {
    const upstream = await fetchWithRetry(url.toString(), {
      timeoutMs: 15000,
      retries: 1,
      accept: 'image/*,video/*;q=0.8',
    });
    const type = upstream.headers.get('content-type') || 'application/octet-stream';
    if (!/^(image|video)\//i.test(type)) {
      return res.status(415).json({ error: `upstream content-type is ${type}, not image or video` });
    }
    const len = Number(upstream.headers.get('content-length') || 0);
    const capBytes = 64 * 1024 * 1024;
    if (len && len > capBytes) {
      return res.status(413).json({ error: 'upstream asset is larger than 64 MB' });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > capBytes) return res.status(413).json({ error: 'upstream asset too large' });
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(buf);
  } catch (err) {
    res.status(502).json({ error: `upstream fetch failed: ${err?.message || err}` });
  }
});

/* ---------- show API ------------------------------------------------------ */

app.get('/api/show', (req, res) => res.json({ show: show.show, defaults: DEFAULT_SHOW }));

app.patch('/api/show', async (req, res) => {
  try {
    res.json({ show: await show.patch(req.body || {}) });
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
});

app.post('/api/show/reset', async (req, res) => res.json({ show: await show.reset() }));

/* ---------- stream API ---------------------------------------------------- */

app.get('/api/stream/status', (req, res) => {
  const st = broadcaster.status();
  if (st.running && broadcaster.session?.encoder === 'external') {
    st.encoderUrl = broadcaster.encoderUrl();
  }
  res.json(st);
});

app.post('/api/stream/start', async (req, res) => {
  try {
    await broadcaster.start(req.body || {});
    const st = broadcaster.status();
    if (broadcaster.session?.encoder === 'external') st.encoderUrl = broadcaster.encoderUrl();
    res.json(st);
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
});

app.post('/api/stream/stop', async (req, res) => {
  try {
    res.json(await broadcaster.stop(String(req.body?.reason || 'stopped by operator')));
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/* ---------- health -------------------------------------------------------- */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    weather: {
      mode: weather.mode,
      hasFrame: !!weather.frame,
      source: weather.frame?.source ?? null,
      frameAgeSec: weather.frame ? Math.round((Date.now() - weather.frame.t) / 1000) : null,
      health: weather.health,
    },
    media: { items: media.items.length },
    broadcast: { running: broadcaster.running, presets: STREAM_PRESETS },
  });
});

/* ---------- encoder websocket -------------------------------------------- */

const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });

httpServer.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== '/ws/encoder') {
    socket.destroy();
    return;
  }
  const token = url.searchParams.get('token') || '';
  if (!broadcaster.session || token !== broadcaster.session.token) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => broadcaster.attachEncoder(ws, token));
});

/* ---------- error handling ----------------------------------------------- */

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err?.status || (err instanceof multer.MulterError ? 400 : 500);
  res.status(status).json({ error: err?.message || 'internal error' });
});

/* ---------- boot ---------------------------------------------------------- */

async function main() {
  await media.init();
  await show.init();

  httpServer.listen(PORT, HOST, () => {
    console.log(`\n  TEXAS WEATHER CHEDDAR`);
    console.log(`  stage      http://localhost:${PORT}/`);
    console.log(`  console    http://localhost:${PORT}/?panel=1`);
    console.log(`  source     ${weather.mode}`);
    console.log(`  media      ${media.items.length} item(s)\n`);
  });

  try {
    const frame = await weather.start();
    console.log(
      `  weather    first frame from "${frame.source}"` +
        (frame.notes?.length ? ` — ${frame.notes.join('; ')}` : '')
    );
  } catch (err) {
    console.error(`  weather    FAILED to produce a frame: ${err?.message || err}`);
    console.error(`             the page will keep retrying; check /api/weather/status`);
  }
}

const shutdown = async (sig) => {
  console.log(`\n${sig} — shutting down`);
  try {
    if (broadcaster.running) await broadcaster.stop('server shutting down');
  } catch {
    /* ignore */
  }
  weather.stop();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});

export { app, httpServer, weather, media, show, broadcaster };
