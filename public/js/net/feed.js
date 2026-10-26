/**
 * Weather feed: the SSE client plus the frame decoder.
 *
 * Frames arrive every couple of minutes. The visual engine runs at 60fps, so
 * this module does two things beyond decoding:
 *   - cross-fades between the previous and current frame so values glide
 *     instead of stepping;
 *   - advects the field itself by the accumulated wind between updates, so a
 *     rain mass visibly travels across Texas rather than sitting still until
 *     the next radar sweep lands.
 */

const b64ToBytes = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** One decoded frame: byte planes plus the metadata needed to read them. */
export class FrameView {
  constructor(frame) {
    this.raw = frame;
    this.t = frame.t;
    this.source = frame.source;
    this.cols = frame.grid.cols;
    this.rows = frame.grid.rows;
    this.bbox = frame.bbox;
    this.ranges = frame.grid.ranges;
    this.planes = {};
    for (const [name, b64] of Object.entries(frame.grid.channels)) {
      this.planes[name] = b64ToBytes(b64);
    }
    this.stations = frame.stations || [];
    this.alerts = frame.alerts || [];
    this.alertShapes = frame.alertShapes || [];
    this.summary = frame.summary || {};
    this.notes = frame.notes || [];
  }

  /** Decode a byte back to its real-world value. */
  decode(channel, byte) {
    const r = this.ranges[channel];
    if (!r) return byte / 255;
    return r[0] + (byte / 255) * (r[1] - r[0]);
  }

  /**
   * Bilinear sample in grid space. col/row may be fractional and out of
   * range; edges clamp. Returns the real-world value.
   */
  sampleGrid(channel, col, row) {
    const p = this.planes[channel];
    if (!p) return 0;
    const { cols, rows } = this;
    const c = Math.max(0, Math.min(cols - 1, col));
    const r = Math.max(0, Math.min(rows - 1, row));
    const c0 = Math.floor(c);
    const r0 = Math.floor(r);
    const c1 = Math.min(cols - 1, c0 + 1);
    const r1 = Math.min(rows - 1, r0 + 1);
    const fc = c - c0;
    const fr = r - r0;
    const v =
      p[r0 * cols + c0] * (1 - fc) * (1 - fr) +
      p[r0 * cols + c1] * fc * (1 - fr) +
      p[r1 * cols + c0] * (1 - fc) * fr +
      p[r1 * cols + c1] * fc * fr;
    return this.decode(channel, v);
  }

  /** Grid coordinates for a lon/lat. Row 0 is the north edge. */
  gridAt(lon, lat) {
    const [w, s, e, n] = this.bbox;
    return [((lon - w) / (e - w)) * this.cols - 0.5, ((n - lat) / (n - s)) * this.rows - 0.5];
  }

  sampleAt(channel, lon, lat) {
    const [c, r] = this.gridAt(lon, lat);
    return this.sampleGrid(channel, c, r);
  }
}

/**
 * Holds two frames and presents a single continuously-varying field.
 *
 * `drift` is the accumulated wind displacement in grid cells, applied when
 * sampling so precipitation and cloud appear to travel. It decays toward zero
 * as a new frame settles in, because the new frame already contains the real
 * new position.
 */
export class FieldBlender {
  constructor({ crossfadeMs = 9000 } = {}) {
    this.current = null;
    this.previous = null;
    this.swappedAt = 0;
    this.crossfadeMs = crossfadeMs;
    this.driftCol = 0;
    this.driftRow = 0;
  }

  push(frame) {
    const view = new FrameView(frame);
    if (this.current) {
      this.previous = this.current;
      this.swappedAt = performance.now();
      // The new frame supersedes our guesswork; let the drift unwind.
      this.driftDecayFrom = { col: this.driftCol, row: this.driftRow };
    }
    this.current = view;
    return view;
  }

  get ready() {
    return !!this.current;
  }

  /** 0 while a new frame is still blending in, 1 once it has fully arrived. */
  get mix() {
    if (!this.previous) return 1;
    const k = (performance.now() - this.swappedAt) / this.crossfadeMs;
    return k >= 1 ? 1 : k < 0 ? 0 : k * k * (3 - 2 * k);
  }

  /**
   * Advance the field drift. Called once per rendered frame with the mean
   * wind so the whole field creeps downwind between updates.
   */
  advance(dtSec, meanU, meanV, gain = 1, maxCells = 2.5) {
    if (!this.current) return;
    const f = this.current;
    const [w, s, e, n] = f.bbox;
    // knots -> degrees/second -> grid cells/second
    const degPerSec = 1 / 60 / 3600;
    const colsPerDeg = f.cols / (e - w);
    const rowsPerDeg = f.rows / (n - s);

    // Field drift is a weaker effect than sprite drift on purpose. A sprite is
    // decorative and may be time-lapsed freely; the precipitation field is a
    // claim about where rain actually is, so its apparent travel is scaled
    // down and then hard-clamped to a couple of grid cells (~30 km). Anything
    // more would be inventing a position the radar never reported.
    const fieldGain = gain / 8;
    this.driftCol += meanU * degPerSec * dtSec * colsPerDeg * fieldGain;
    this.driftRow -= meanV * degPerSec * dtSec * rowsPerDeg * fieldGain;

    const decay = Math.exp(-dtSec / 25);
    this.driftCol *= decay;
    this.driftRow *= decay;

    const mag = Math.hypot(this.driftCol, this.driftRow);
    if (mag > maxCells) {
      this.driftCol = (this.driftCol / mag) * maxCells;
      this.driftRow = (this.driftRow / mag) * maxCells;
    }
  }

  /** Sample a channel at lon/lat with blending and drift applied. */
  sample(channel, lon, lat, { drift = true } = {}) {
    const cur = this.current;
    if (!cur) return 0;
    let [c, r] = cur.gridAt(lon, lat);
    if (drift) {
      c -= this.driftCol;
      r -= this.driftRow;
    }
    const a = cur.sampleGrid(channel, c, r);
    const m = this.mix;
    if (m >= 1 || !this.previous) return a;
    const [pc, pr] = this.previous.gridAt(lon, lat);
    const b = this.previous.sampleGrid(channel, drift ? pc - this.driftCol : pc, drift ? pr - this.driftRow : pr);
    return b + (a - b) * m;
  }

  /** Wind vector in knots at a point. */
  wind(lon, lat) {
    return [this.sample('windU', lon, lat, { drift: false }), this.sample('windV', lon, lat, { drift: false })];
  }

  get summary() {
    return this.current?.summary || {};
  }

  get stations() {
    return this.current?.stations || [];
  }
}

/** SSE connection with automatic reconnection. */
export class WeatherFeed extends EventTarget {
  constructor({ url = '/api/weather/stream' } = {}) {
    super();
    this.url = url;
    this.source = null;
    this.connected = false;
    this.lastFrameAt = 0;
    this.frameCount = 0;
  }

  connect() {
    this.disconnect();
    const es = new EventSource(this.url);
    this.source = es;

    es.addEventListener('open', () => {
      this.connected = true;
      this.dispatchEvent(new CustomEvent('status', { detail: { connected: true } }));
    });

    es.addEventListener('frame', (ev) => {
      try {
        const frame = JSON.parse(ev.data);
        this.lastFrameAt = Date.now();
        this.frameCount++;
        this.dispatchEvent(new CustomEvent('frame', { detail: frame }));
      } catch (err) {
        console.error('bad weather frame', err);
      }
    });

    es.addEventListener('error', () => {
      this.connected = false;
      this.dispatchEvent(new CustomEvent('status', { detail: { connected: false } }));
      // EventSource reconnects on its own; nothing to do but report it.
    });
    return this;
  }

  disconnect() {
    this.source?.close();
    this.source = null;
    this.connected = false;
  }
}
