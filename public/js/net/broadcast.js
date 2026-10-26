/**
 * Encoder client.
 *
 * Combines the rendered canvas with the score's audio into one MediaStream,
 * encodes it with MediaRecorder, and ships the chunks to the server over a
 * WebSocket, where ffmpeg transcodes to RTMP.
 *
 * The same code runs in the operator's browser and in the server's headless
 * Chromium — the only difference is who opened the page.
 */

const MIME_PREFERENCES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=h264,opus',
  'video/webm',
];

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of MIME_PREFERENCES) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

export class EncoderClient extends EventTarget {
  constructor({ engine, audio, token, fps = 30, videoBitsPerSecond = 6_000_000 }) {
    super();
    this.engine = engine;
    this.audio = audio;
    this.token = token;
    this.fps = fps;
    this.videoBitsPerSecond = videoBitsPerSecond;
    this.ws = null;
    this.recorder = null;
    this.stream = null;
    this.bytesSent = 0;
    this.chunksSent = 0;
    this.state = 'idle';
  }

  async start() {
    if (this.state !== 'idle') throw new Error('encoder already running');
    const mime = pickMime();
    if (!mime) throw new Error('this browser cannot record WebM with MediaRecorder');

    // --- build the combined stream ---------------------------------------
    const video = this.engine.captureStream(this.fps);
    const videoTrack = video.getVideoTracks()[0];
    if (!videoTrack) throw new Error('canvas capture produced no video track');

    const combined = new MediaStream([videoTrack]);

    let hasAudio = false;
    try {
      await this.audio?.resume?.();
      const audioStream = this.audio?.stream;
      const audioTrack = audioStream?.getAudioTracks?.()[0];
      if (audioTrack) {
        combined.addTrack(audioTrack);
        hasAudio = true;
      }
    } catch (err) {
      console.warn('audio capture unavailable; streaming video with silence', err);
    }

    this.stream = combined;
    this.state = 'connecting';

    // --- connect ----------------------------------------------------------
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/encoder?token=${encodeURIComponent(this.token)}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('encoder socket timed out')), 12000);
      ws.addEventListener('open', () => {
        clearTimeout(to);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(to);
        reject(new Error('encoder socket failed to connect'));
      });
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }
      if (msg?.type === 'stop') this.stop('server asked to stop');
    });

    ws.addEventListener('close', () => {
      if (this.state === 'recording') this.stop('socket closed');
    });

    // Tell the server what it is about to receive so it can configure ffmpeg.
    ws.send(
      JSON.stringify({
        type: 'hello',
        mime,
        hasAudio,
        width: this.engine.canvas.width,
        height: this.engine.canvas.height,
        fps: this.fps,
      })
    );

    // --- record -----------------------------------------------------------
    const recorder = new MediaRecorder(combined, {
      mimeType: mime,
      videoBitsPerSecond: this.videoBitsPerSecond,
      audioBitsPerSecond: 160_000,
    });
    this.recorder = recorder;

    recorder.ondataavailable = (ev) => {
      if (!ev.data || ev.data.size === 0) return;
      if (ws.readyState !== WebSocket.OPEN) return;
      // Backpressure: if the socket is congested, drop rather than balloon
      // memory. A dropped 250ms chunk is better than an OOM mid-broadcast.
      if (ws.bufferedAmount > 8 * 1024 * 1024) {
        this.dispatchEvent(new CustomEvent('congestion', { detail: { buffered: ws.bufferedAmount } }));
        return;
      }
      ev.data.arrayBuffer().then((buf) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(buf);
          this.bytesSent += buf.byteLength;
          this.chunksSent++;
        }
      });
    };

    recorder.onerror = (ev) => {
      const message = ev?.error?.message || 'recorder error';
      try {
        ws.send(JSON.stringify({ type: 'error', message }));
      } catch {
        /* ignore */
      }
      this.dispatchEvent(new CustomEvent('error', { detail: { message } }));
      this.stop(message);
    };

    recorder.start(250);
    this.state = 'recording';
    this.hasAudio = hasAudio;
    this.mime = mime;
    this.dispatchEvent(new CustomEvent('started', { detail: { mime, hasAudio } }));

    this._statsTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'stats',
            bytesSent: this.bytesSent,
            chunks: this.chunksSent,
            fps: this.engine.fps,
            sprites: this.engine.particles?.stats?.total ?? 0,
          })
        );
      }
    }, 5000);

    return this;
  }

  stop(reason = 'stopped') {
    if (this._statsTimer) clearInterval(this._statsTimer);
    this._statsTimer = null;
    try {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    } catch {
      /* ignore */
    }
    try {
      this.ws?.close(1000, 'encoder stopping');
    } catch {
      /* ignore */
    }
    this.state = 'idle';
    this.dispatchEvent(new CustomEvent('stopped', { detail: { reason } }));
    return this;
  }

  stats() {
    return {
      state: this.state,
      mime: this.mime ?? null,
      hasAudio: !!this.hasAudio,
      bytesSent: this.bytesSent,
      chunks: this.chunksSent,
      buffered: this.ws?.bufferedAmount ?? 0,
    };
  }
}
