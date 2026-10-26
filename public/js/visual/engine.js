/**
 * The visual engine: owns the canvas and the render loop, and composites
 *
 *     background -> map -> media particles -> bloom -> finish -> overlay
 *
 * It is resolution-independent: the same scene renders at 854x480 for a
 * preview or 1920x1080 for a broadcast, because everything is positioned in
 * lon/lat and scaled from the shorter canvas edge.
 */
import { MapView } from './projection.js';
import { TexasMap, hexToRgba } from './map.js';
import { ParticleField, CHANNEL_LIST } from './particles.js';
import { Overlay } from './overlay.js';

export class VisualEngine {
  constructor({ canvas, geo, blender, pool, show }) {
    this.canvas = canvas;
    this.geo = geo;
    this.blender = blender;
    this.pool = pool;
    this.show = show;

    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.view = new MapView({ geo, width: canvas.width, height: canvas.height });
    this.map = new TexasMap({ geo, view: this.view });
    this.particles = new ParticleField({ bbox: geo.bbox });
    this.overlay = new Overlay({ view: this.view });

    // Separate 1x1 context purely for point-in-path tests.
    this.hit = document.createElement('canvas');
    this.hit.width = this.hit.height = 1;
    this.hitCtx = this.hit.getContext('2d');

    this.bloomCanvas = document.createElement('canvas');

    this.running = false;
    this.lastT = 0;
    this.fps = 0;
    this._fpsAcc = [];
    this.frameCount = 0;

    // Adaptive quality. Sprite fill is the dominant cost and it is the one
    // thing that can be traded smoothly, so when the measured frame rate
    // falls short of the target the sprite budget is thinned until it holds.
    // A broadcast that quietly drops to 18fps looks worse than one carrying
    // fewer tacos.
    this.targetFps = 30;
    this.quality = 1;
    this._qualityAcc = [];
    this._lastFieldT = 0;
    this._fieldRepaintAt = 0;
    this.extra = {};
    this._inState = (lon, lat) => {
      const [x, y] = this.view.toScreen(lon, lat);
      return this.hitCtx.isPointInPath(this.map.clipPath, x, y);
    };
  }

  setShow(show) {
    this.show = show;
    // Colours, texture, outline weight and shading all live in the cached
    // map layer, so any show change has to repaint it.
    this.map.invalidate();
    return this;
  }

  resize(width, height) {
    const w = Math.max(160, Math.round(width));
    const h = Math.max(120, Math.round(height));
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.view.resize(w, h);
    this.map.rebuild();
    this.quality = 1;
    this._qualityAcc = [];
    // The hit context must share the view's transform space.
    this.hit.width = w;
    this.hit.height = h;
    this.hitCtx = this.hit.getContext('2d');
  }

  start() {
    if (this.running) return this;
    this.running = true;
    this.lastT = performance.now();
    const tick = (t) => {
      if (!this.running) return;
      const dt = Math.min(0.25, Math.max(0, (t - this.lastT) / 1000));
      this.lastT = t;
      try {
        this.renderFrame(dt);
      } catch (err) {
        console.error('render error', err);
      }
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
    return this;
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    return this;
  }

  /** One composited frame. */
  renderFrame(dt) {
    const { ctx, show, view } = this;
    const b = this.blender;

    // Mean wind drives the whole-field drift between data updates.
    const s = b.summary || {};
    const meanKt = s.windKt?.mean ?? 0;
    const mean = this._meanWindVector();
    b.advance(dt, mean[0], mean[1], show.motion.windGain ?? 1);

    // --- background / trails ---------------------------------------------
    const trails = Math.max(0, Math.min(0.97, show.motion.trails ?? 0));
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = trails > 0 ? hexToRgba(show.map.background, 1 - trails) : show.map.background;
    ctx.fillRect(0, 0, view.width, view.height);
    ctx.restore();

    if (!b.ready) {
      this._placeholder(ctx);
      return;
    }

    // --- map --------------------------------------------------------------
    // The cached layer holds the temperature shading, so it has to be
    // repainted when a new frame lands and, more gently, while the crossfade
    // between two frames is still running.
    const curT = b.current?.t ?? 0;
    const nowMs = performance.now();
    if (curT !== this._lastFieldT) {
      this._lastFieldT = curT;
      this.map.invalidate();
      this._fieldRepaintAt = nowMs;
    } else if (b.mix < 1 && nowMs - this._fieldRepaintAt > 220) {
      this.map.invalidate();
      this._fieldRepaintAt = nowMs;
    }
    this.map.draw(ctx, show, b, { textureImage: this._textureImage() });

    // --- media particles --------------------------------------------------
    this.particles.maxOverride = Math.max(
      24,
      Math.round((show.motion.maxSprites || 520) * this.quality)
    );
    this.particles.update(dt, b, show, this.pool, this._inState);
    if (this._needsWindAlign()) this.particles.alignToWind(b, view);

    ctx.save();
    if (show.motion.clipToState) ctx.clip(this.map.clipPath);
    this.particles.draw(ctx, view, show, this.pool);
    ctx.restore();

    // --- bloom ------------------------------------------------------------
    if ((show.map.bloom ?? 0) > 0.01) this._bloom(ctx, show.map.bloom);

    // --- finish + overlay -------------------------------------------------
    this.map.drawFinish(ctx, show);
    if (show.map.grain > 0) this._grain(ctx, show.map.grain);
    this.overlay.draw(ctx, show, b, {
      ...this.extra,
      channelLabels: this._channelLabels(),
    });

    // --- metering ---------------------------------------------------------
    this.frameCount++;
    this._fpsAcc.push(dt);
    if (this._fpsAcc.length > 45) this._fpsAcc.shift();
    const sum = this._fpsAcc.reduce((a, c) => a + c, 0);
    this.fps = sum > 0 ? this._fpsAcc.length / sum : 0;
    this.meanWindKt = meanKt;
    this._govern(dt);
  }

  /**
   * Hold the frame rate by trading sprite count.
   *
   * Re-evaluated every 45 frames so one slow frame (a texture rebuild, a
   * garbage collection) does not swing the quality around.
   */
  _govern(dt) {
    this._qualityAcc.push(dt);
    // Shorter window when the frame rate is far off, so a badly overloaded
    // scene converges in a second or two instead of a minute.
    const window = this.quality < 0.95 ? 20 : 45;
    if (this._qualityAcc.length < window) return;
    const total = this._qualityAcc.reduce((a, c) => a + c, 0);
    const fps = total > 0 ? this._qualityAcc.length / total : this.targetFps;
    this._qualityAcc = [];

    const target = this.targetFps;
    const ratio = fps / target;
    if (ratio < 0.9) {
      // Proportional correction, floored so one terrible frame cannot
      // collapse the scene to nothing.
      this.quality = Math.max(0.1, this.quality * Math.max(0.5, ratio * 0.95));
    } else if (ratio > 1.06 && this.quality < 1) {
      this.quality = Math.min(1, this.quality * 1.15);
    }
  }

  /** Mean wind over the state, from the station reports (cheap and stable). */
  _meanWindVector() {
    const stations = this.blender.stations;
    if (!stations?.length) return [0, 0];
    let u = 0;
    let v = 0;
    let n = 0;
    for (const st of stations) {
      if (!Number.isFinite(st.windKt) || !Number.isFinite(st.windDirDeg)) continue;
      const rad = (st.windDirDeg * Math.PI) / 180;
      u += -st.windKt * Math.sin(rad);
      v += -st.windKt * Math.cos(rad);
      n++;
    }
    return n ? [u / n, v / n] : [0, 0];
  }

  _needsWindAlign() {
    for (const e of this.pool.entries.values()) {
      if (e.item.render?.rotate === 'align-wind') return true;
    }
    return false;
  }

  _textureImage() {
    const id = this.show.map.texture?.imageId;
    if (!id) return null;
    const e = this.pool.entries.get(id);
    return e?.ready ? e.el : null;
  }

  /** What each channel is currently standing in for, for the legend. */
  _channelLabels() {
    const out = {};
    for (const ch of CHANNEL_LIST) {
      const pool = this.pool.forChannel(ch);
      if (!pool.length) continue;
      out[ch] =
        pool.length === 1 ? pool[0].item.label : `${pool[0].item.label} +${pool.length - 1}`;
    }
    return out;
  }

  /**
   * Additive bloom via a downsampled blurred copy.
   *
   * The blur runs on the small canvas, not on the full-size upscale: a
   * ctx.filter blur applied while drawing 1600x900 measured 81ms, the same
   * blur at quarter size 37ms. The upscale itself then needs no filter,
   * because bilinear magnification is already a blur.
   */
  _bloom(ctx, strength) {
    const { width, height } = this.view;
    const bw = Math.max(32, Math.round(width / 5));
    const bh = Math.max(24, Math.round(height / 5));
    const bc = this.bloomCanvas;
    if (bc.width !== bw || bc.height !== bh) {
      bc.width = bw;
      bc.height = bh;
    }
    const bctx = bc.getContext('2d');
    bctx.clearRect(0, 0, bw, bh);
    bctx.filter = 'blur(2px)';
    bctx.drawImage(this.canvas, 0, 0, bw, bh);
    bctx.filter = 'none';

    const prevOp = ctx.globalCompositeOperation;
    const prevAlpha = ctx.globalAlpha;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(0.8, strength * 0.5);
    ctx.drawImage(bc, 0, 0, width, height);
    ctx.globalCompositeOperation = prevOp;
    ctx.globalAlpha = prevAlpha;
  }

  /** Animated film grain. Regenerated on a cadence rather than every frame. */
  _grain(ctx, strength) {
    const { width, height } = this.view;
    if (!this._grainCanvas || this.frameCount % 3 === 0) {
      const size = 192;
      if (!this._grainCanvas) {
        this._grainCanvas = document.createElement('canvas');
        this._grainCanvas.width = this._grainCanvas.height = size;
      }
      const g = this._grainCanvas.getContext('2d');
      const img = g.createImageData(size, size);
      for (let i = 0; i < size * size; i++) {
        const v = Math.random() * 255;
        img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
        img.data[i * 4 + 3] = 255;
      }
      g.putImageData(img, 0, 0);
    }
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = Math.min(0.6, strength);
    const pattern = ctx.createPattern(this._grainCanvas, 'repeat');
    if (pattern) {
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.restore();
  }

  _placeholder(ctx) {
    const { width, height } = this.view;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '500 20px system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('waiting for weather…', width / 2, height / 2);
    ctx.restore();
  }

  /** MediaStream of the rendered canvas, for recording or WebRTC. */
  captureStream(fps = 30) {
    return this.canvas.captureStream(fps);
  }

  stats() {
    return {
      fps: Number(this.fps.toFixed(1)),
      frames: this.frameCount,
      sprites: this.particles.stats.total,
      drawn: this.particles.stats.drawn ?? 0,
      byChannel: this.particles.stats.byChannel,
      mediaReady: this.pool.readyCount,
      source: this.blender.current?.source ?? null,
      frameAgeSec: this.blender.current ? Math.round((Date.now() - this.blender.current.t) / 1000) : null,
      meanWindKt: Number((this.meanWindKt ?? 0).toFixed(1)),
      quality: Number(this.quality.toFixed(2)),
      targetFps: this.targetFps,
      drift: [Number(this.blender.driftCol.toFixed(2)), Number(this.blender.driftRow.toFixed(2))],
    };
  }
}
