/**
 * Broadcast pipeline.
 *
 *   browser canvas + Web Audio graph
 *        -> MediaStream (captureStream + MediaStreamDestination)
 *        -> MediaRecorder (WebM / VP8+Opus)
 *        -> WebSocket  /ws/encoder
 *        -> ffmpeg (transcode to H.264 + AAC, FLV)
 *        -> rtmp://a.rtmp.youtube.com/live2/<stream-key>
 *
 * Two encoder sources:
 *   'headless'  the server drives its own Chromium via Playwright, so the
 *               broadcast keeps running with no operator window open.
 *   'external'  the operator's own browser is the encoder (useful when the
 *               machine running the server has no GPU, or for monitoring
 *               exactly what goes out).
 *
 * Targets: a real RTMP endpoint, or a local file — the file target exists so
 * the whole chain can be smoke-tested without pushing to a live platform.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const PRESETS = {
  '1080p30': { width: 1920, height: 1080, fps: 30, videoBitrate: 6000, audioBitrate: 160 },
  '1080p60': { width: 1920, height: 1080, fps: 60, videoBitrate: 9000, audioBitrate: 160 },
  '720p30': { width: 1280, height: 720, fps: 30, videoBitrate: 3500, audioBitrate: 128 },
  '720p60': { width: 1280, height: 720, fps: 60, videoBitrate: 5000, audioBitrate: 128 },
  '480p30': { width: 854, height: 480, fps: 30, videoBitrate: 1500, audioBitrate: 96 },
};

export const STREAM_PRESETS = Object.keys(PRESETS);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Broadcaster extends EventEmitter {
  constructor({ publicUrl, ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg' } = {}) {
    super();
    this.publicUrl = publicUrl;
    this.ffmpegPath = ffmpegPath;
    this.session = null;
    this.logTail = [];
  }

  get running() {
    return !!this.session;
  }

  status() {
    const s = this.session;
    if (!s) return { running: false, presets: STREAM_PRESETS, logTail: this.logTail.slice(-25) };
    return {
      running: true,
      state: s.state,
      encoder: s.encoder,
      target: s.targetLabel,
      settings: s.settings,
      startedAt: s.startedAt,
      uptimeSec: Math.round((Date.now() - s.startedAt) / 1000),
      bytesIn: s.bytesIn,
      chunks: s.chunks,
      hasAudio: s.hasAudio,
      encoderConnected: !!s.ws,
      presets: STREAM_PRESETS,
      logTail: this.logTail.slice(-25),
    };
  }

  /**
   * @param {object} opts
   * @param {'rtmp'|'file'} opts.targetType
   * @param {string} [opts.rtmpUrl]   e.g. rtmp://a.rtmp.youtube.com/live2
   * @param {string} [opts.streamKey] YouTube stream key (never logged)
   * @param {string} [opts.filePath]  for targetType 'file'
   * @param {'headless'|'external'} [opts.encoder]
   * @param {string} [opts.preset]
   */
  async start(opts = {}) {
    if (this.session) throw new Error('a broadcast is already running');

    // 720p30 is the default because it is what a CPU-only encoder actually
    // sustains; 1080p needs GPU-accelerated canvas rendering. See README.
    const preset = PRESETS[opts.preset] || PRESETS['720p30'];
    const settings = {
      width: clampInt(opts.width ?? preset.width, 320, 3840),
      height: clampInt(opts.height ?? preset.height, 240, 2160),
      fps: clampInt(opts.fps ?? preset.fps, 10, 60),
      videoBitrate: clampInt(opts.videoBitrate ?? preset.videoBitrate, 300, 25000),
      audioBitrate: clampInt(opts.audioBitrate ?? preset.audioBitrate, 48, 320),
      preset: opts.preset || '720p30',
    };

    const target = await this._resolveTarget(opts);
    const encoder = opts.encoder === 'external' ? 'external' : 'headless';

    this.session = {
      id: randomBytes(8).toString('hex'),
      token: randomBytes(24).toString('base64url'),
      state: 'awaiting-encoder',
      encoder,
      settings,
      target,
      targetLabel: target.label,
      startedAt: Date.now(),
      bytesIn: 0,
      chunks: 0,
      hasAudio: null,
      ws: null,
      ffmpeg: null,
      browser: null,
      stopping: false,
    };

    this._log(`broadcast ${this.session.id} starting -> ${target.label} (${settings.preset}, ${encoder} encoder)`);

    if (encoder === 'headless') {
      try {
        await this._launchHeadlessEncoder();
      } catch (err) {
        const msg = err?.message || String(err);
        this._log(`headless encoder failed: ${msg}`);
        await this.stop(`headless encoder failed: ${msg}`);
        throw new Error(`could not start headless encoder: ${msg}`);
      }
    }

    this.emit('started', this.status());
    return this.status();
  }

  /** The URL the operator's browser should open to act as an external encoder. */
  encoderUrl() {
    const s = this.session;
    if (!s) return null;
    const q = new URLSearchParams({
      broadcast: '1',
      token: s.token,
      w: String(s.settings.width),
      h: String(s.settings.height),
      fps: String(s.settings.fps),
    });
    return `/?${q}`;
  }

  async _resolveTarget(opts) {
    if (opts.targetType === 'file') {
      const path = resolve(opts.filePath || `recordings/texas-${Date.now()}.flv`);
      await mkdir(dirname(path), { recursive: true });
      return { type: 'file', path, label: `file:${path}` };
    }
    const base = String(opts.rtmpUrl || 'rtmp://a.rtmp.youtube.com/live2').trim().replace(/\/+$/, '');
    if (!/^rtmps?:\/\//i.test(base)) {
      throw new Error('rtmpUrl must start with rtmp:// or rtmps://');
    }
    const key = String(opts.streamKey || '').trim();
    if (!key) throw new Error('a stream key is required for an RTMP target');
    if (/[\s"']/.test(key)) throw new Error('stream key contains invalid characters');
    return {
      type: 'rtmp',
      url: `${base}/${key}`,
      // Never surface or log the key.
      label: `${base}/${maskKey(key)}`,
    };
  }

  /* ---------- encoder websocket ---------- */

  /**
   * Attach an encoder socket. Called by the server's WS upgrade handler after
   * the token matches.
   */
  attachEncoder(ws, token) {
    const s = this.session;
    if (!s) {
      ws.close(1011, 'no broadcast running');
      return false;
    }
    if (token !== s.token) {
      ws.close(1008, 'bad token');
      return false;
    }
    if (s.ws) {
      ws.close(1008, 'encoder already attached');
      return false;
    }

    s.ws = ws;
    s.state = 'encoder-connected';
    this._log('encoder connected');

    ws.on('message', (data, isBinary) => {
      if (!this.session || this.session !== s) return;
      if (!isBinary) {
        this._handleEncoderMessage(s, data.toString());
        return;
      }
      if (!s.ffmpeg) return; // chunks before hello: drop, we have no muxer yet
      s.bytesIn += data.length;
      s.chunks++;
      if (s.ffmpeg.stdin.writable) {
        const ok = s.ffmpeg.stdin.write(data);
        if (!ok) s.backpressure = (s.backpressure || 0) + 1;
      }
    });

    ws.on('close', () => {
      if (this.session !== s) return;
      s.ws = null;
      this._log('encoder disconnected');
      if (!s.stopping) {
        s.state = 'encoder-lost';
        // Flush what we have; an encoder that vanished mid-broadcast should
        // not leave ffmpeg hanging on a stdin that will never close.
        this.stop('encoder disconnected').catch(() => {});
      }
    });

    ws.on('error', (err) => this._log(`encoder socket error: ${err?.message || err}`));
    return true;
  }

  _handleEncoderMessage(s, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      s.hasAudio = !!msg.hasAudio;
      s.mime = msg.mime || 'video/webm';
      this._log(`encoder hello: ${s.mime} audio=${s.hasAudio} ${msg.width}x${msg.height}@${msg.fps}`);
      try {
        this._spawnFfmpeg(s);
        s.state = 'live';
        s.ws?.send(JSON.stringify({ type: 'go' }));
      } catch (err) {
        this._log(`ffmpeg spawn failed: ${err?.message || err}`);
        this.stop('ffmpeg spawn failed').catch(() => {});
      }
    } else if (msg.type === 'error') {
      this._log(`encoder reported error: ${msg.message}`);
      this.stop(`encoder error: ${msg.message}`).catch(() => {});
    } else if (msg.type === 'stats') {
      s.encoderStats = msg;
    }
  }

  /* ---------- ffmpeg ---------- */

  _spawnFfmpeg(s) {
    const { width, height, fps, videoBitrate, audioBitrate } = s.settings;
    const args = ['-hide_banner', '-loglevel', 'warning', '-thread_queue_size', '512'];

    // The WebM stream from MediaRecorder is live: no seeking, no duration.
    args.push('-fflags', '+genpts', '-f', 'webm', '-i', 'pipe:0');

    // YouTube rejects a video-only stream, so synthesise silence when the
    // encoder could not give us an audio track.
    if (!s.hasAudio) {
      args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    }

    args.push(
      '-map', '0:v:0',
      '-map', s.hasAudio ? '0:a:0' : '1:a:0',
      // Video: constant frame rate and a fixed 2-second GOP, which is what
      // YouTube's ingest expects.
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'zerolatency',
      '-profile:v', 'high',
      '-pix_fmt', 'yuv420p',
      '-r', String(fps),
      '-vsync', 'cfr',
      '-g', String(fps * 2),
      '-keyint_min', String(fps * 2),
      '-sc_threshold', '0',
      '-b:v', `${videoBitrate}k`,
      '-maxrate', `${Math.round(videoBitrate * 1.1)}k`,
      '-bufsize', `${videoBitrate * 2}k`,
      '-s', `${width}x${height}`,
      '-c:a', 'aac',
      '-b:a', `${audioBitrate}k`,
      '-ar', '48000',
      '-ac', '2'
    );

    if (!s.hasAudio) args.push('-shortest');

    if (s.target.type === 'rtmp') {
      args.push('-f', 'flv', '-flvflags', 'no_duration_filesize', s.target.url);
    } else {
      args.push('-f', 'flv', '-y', s.target.path);
    }

    const proc = spawn(this.ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    s.ffmpeg = proc;

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        const t = line.trim();
        if (t) this._log(`ffmpeg: ${redact(t, s.target)}`);
      }
    });
    proc.stdin.on('error', (err) => {
      // EPIPE when ffmpeg exits first: not worth surfacing as a crash.
      if (err?.code !== 'EPIPE') this._log(`ffmpeg stdin: ${err?.message || err}`);
    });
    proc.on('exit', (code, signal) => {
      this._log(`ffmpeg exited code=${code} signal=${signal || 'none'}`);
      if (this.session === s && !s.stopping) {
        this.stop(`ffmpeg exited (code ${code})`).catch(() => {});
      }
    });
    proc.on('error', (err) => {
      this._log(`ffmpeg could not start: ${err?.message || err}`);
      if (this.session === s && !s.stopping) this.stop('ffmpeg could not start').catch(() => {});
    });

    this._log(`ffmpeg running: ${width}x${height}@${fps} ${videoBitrate}kbps -> ${s.targetLabel}`);
    return proc;
  }

  /* ---------- headless encoder ---------- */

  async _launchHeadlessEncoder() {
    const s = this.session;
    const { chromium } = await loadPlaywright();
    const { width, height, fps } = s.settings;

    const browser = await chromium.launch({
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--disable-gpu-vsync',
        '--disable-features=IsolateOrigins,site-per-process',
        '--enable-features=SharedArrayBuffer',
        '--no-sandbox',
      ],
    });
    s.browser = browser;

    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      // The encoder page records the canvas, so it needs no real devices,
      // but granting these keeps getUserMedia-based live sources working.
      permissions: [],
    });
    const page = await context.newPage();
    s.page = page;

    page.on('console', (m) => {
      if (['error', 'warning'].includes(m.type())) this._log(`encoder page [${m.type()}]: ${m.text()}`);
    });
    page.on('pageerror', (err) => this._log(`encoder page error: ${err?.message || err}`));

    const url = `${this.publicUrl}${this.encoderUrl()}`;
    this._log(`headless encoder navigating to ${url.replace(s.token, maskKey(s.token))}`);
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });

    // The page signals readiness once its canvas and audio graph are live.
    await page.waitForFunction(() => window.__twcBroadcastReady === true, null, { timeout: 45000 });
    this._log('headless encoder page ready');
  }

  /* ---------- teardown ---------- */

  async stop(reason = 'stopped by operator') {
    const s = this.session;
    if (!s) return { running: false };
    if (s.stopping) return this.status();
    s.stopping = true;
    s.state = 'stopping';
    this._log(`stopping broadcast: ${reason}`);

    // Ask the page to finish its MediaRecorder so the final cluster is flushed.
    try {
      if (s.ws && s.ws.readyState === 1) {
        s.ws.send(JSON.stringify({ type: 'stop' }));
        await sleep(400);
      }
    } catch {
      /* best effort */
    }

    try {
      if (s.ffmpeg?.stdin?.writable) s.ffmpeg.stdin.end();
    } catch {
      /* ignore */
    }

    // Give ffmpeg a moment to write its trailer, then insist.
    if (s.ffmpeg && s.ffmpeg.exitCode === null) {
      const exited = await Promise.race([
        new Promise((r) => s.ffmpeg.once('exit', () => r(true))),
        sleep(4000).then(() => false),
      ]);
      if (!exited) {
        this._log('ffmpeg did not exit in time; sending SIGKILL');
        try {
          s.ffmpeg.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }

    try {
      s.ws?.close(1000, 'broadcast stopped');
    } catch {
      /* ignore */
    }
    try {
      await s.browser?.close();
    } catch (err) {
      this._log(`browser close: ${err?.message || err}`);
    }

    const final = {
      running: false,
      stoppedAt: Date.now(),
      reason,
      bytesIn: s.bytesIn,
      chunks: s.chunks,
      durationSec: Math.round((Date.now() - s.startedAt) / 1000),
      target: s.targetLabel,
    };
    this.session = null;
    this.emit('stopped', final);
    this._log(
      `broadcast ended after ${final.durationSec}s, ${(final.bytesIn / 1048576).toFixed(2)} MB from encoder`
    );
    return final;
  }

  _log(line) {
    const entry = `${new Date().toISOString()} ${line}`;
    this.logTail.push(entry);
    if (this.logTail.length > 200) this.logTail.shift();
    this.emit('log', entry);
    if (process.env.BROADCAST_QUIET !== '1') console.log(`[broadcast] ${line}`);
  }
}

/**
 * Load Playwright, whether it is a dependency of this project or installed
 * globally.
 *
 * ESM `import('playwright')` only searches node_modules up from this file, so
 * it misses a global or image-preinstalled copy. CJS resolution honours the
 * wider set of paths, so that is the fallback.
 */
async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (esmErr) {
    try {
      return createRequire(import.meta.url)('playwright');
    } catch {
      throw new Error(
        'playwright is not installed. Install it with "npm install playwright" ' +
          'and "npx playwright install chromium", or start the broadcast with ' +
          'encoder "external" to use your own browser as the encoder ' +
          `(resolution error: ${esmErr?.message?.split('\n')[0]})`
      );
    }
  }
}

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || lo)));
const maskKey = (k) => (k.length <= 6 ? '***' : `${k.slice(0, 3)}***${k.slice(-2)}`);

/** Keep the stream key out of logs even when ffmpeg echoes the full URL. */
function redact(line, target) {
  if (target?.type !== 'rtmp' || !target.url) return line;
  return line.split(target.url).join(target.label);
}
