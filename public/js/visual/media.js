/**
 * The media pool: everything that can stand in for a weather symbol.
 *
 * Four kinds of source, all reduced to "something drawable this instant":
 *   - uploaded stills            (<img>)
 *   - uploaded clips             (<video>, muted, looping)
 *   - remote URLs                (re-fetched on an interval through the
 *                                 server's guarded proxy, so a traffic cam or
 *                                 a satellite still can feed the map live)
 *   - live device capture        (webcam / screen share, browser-side only)
 *
 * Stills are pre-masked once into an offscreen "stamp" so per-sprite drawing
 * is a single drawImage. Moving sources are masked through a scratch canvas,
 * which costs one extra blit per sprite but keeps video live.
 */
import { softMask, blobMask } from './textures.js';

const STAMP_SIZE = 256;

export class MediaPool extends EventTarget {
  constructor() {
    super();
    this.items = [];
    this.byId = new Map();
    this.entries = new Map(); // id -> { item, el, ready, stamp, maskKey, error }
    this.scratch = document.createElement('canvas');
    this.scratchCtx = this.scratch.getContext('2d');
    this.liveSources = []; // client-only capture sources
    this._timers = new Map();
  }

  /** Items usable for a channel, with their relative weights. */
  forChannel(channel) {
    const out = [];
    for (const e of this.entries.values()) {
      if (!e.ready) continue;
      if (!e.item.channels?.includes(channel)) continue;
      out.push(e);
    }
    return out;
  }

  get readyCount() {
    let n = 0;
    for (const e of this.entries.values()) if (e.ready) n++;
    return n;
  }

  /** Weighted pick. `r` is a 0..1 random so callers can stay deterministic. */
  pick(channel, r = Math.random()) {
    const pool = this.forChannel(channel);
    if (!pool.length) return null;
    let total = 0;
    for (const e of pool) total += Math.max(0.0001, e.item.render?.weight ?? 1);
    let x = r * total;
    for (const e of pool) {
      x -= Math.max(0.0001, e.item.render?.weight ?? 1);
      if (x <= 0) return e;
    }
    return pool[pool.length - 1];
  }

  /* ---------- library sync ---------- */

  async load() {
    const res = await fetch('/api/media');
    if (!res.ok) throw new Error(`media library: HTTP ${res.status}`);
    const { items } = await res.json();
    this.sync(items);
    return this.items;
  }

  /** Reconcile the pool with a fresh library listing. */
  sync(items) {
    const seen = new Set();
    for (const item of items) {
      seen.add(item.id);
      const existing = this.entries.get(item.id);
      if (!existing) {
        this._add(item);
      } else {
        const sourceChanged =
          existing.item.source !== item.source || existing.item.file !== item.file;
        existing.item = item;
        if (sourceChanged) this._add(item);
        else this._invalidateStamp(existing);
      }
    }
    // Drop anything that left the library (but keep client-only live sources).
    for (const [id, e] of [...this.entries]) {
      if (seen.has(id) || e.item.kind === 'live') continue;
      this._teardown(id);
    }
    this.items = [...this.entries.values()].map((e) => e.item);
    this.byId = new Map(this.items.map((i) => [i.id, i]));
    this.dispatchEvent(new CustomEvent('change', { detail: { items: this.items } }));
    return this.items;
  }

  _add(item) {
    this._teardown(item.id, { keepItem: true });
    const entry = { item, el: null, ready: false, stamp: null, maskKey: null, error: null };
    this.entries.set(item.id, entry);

    const isVideo = item.kind === 'video' || (item.kind === 'remote' && item.mediaKind === 'video');

    if (isVideo) {
      const v = document.createElement('video');
      v.muted = true; // the score is the audio; clips are silent by design
      v.loop = true;
      v.playsInline = true;
      v.autoplay = true;
      v.crossOrigin = 'anonymous';
      v.preload = 'auto';
      v.src = item.kind === 'remote' ? proxied(item.source) : item.url;
      v.addEventListener('loadeddata', () => {
        entry.ready = true;
        entry.w = v.videoWidth || 640;
        entry.h = v.videoHeight || 360;
        v.playbackRate = item.render?.playbackRate ?? 1;
        v.play().catch(() => {
          /* a paused clip still yields its first frame */
        });
        this.dispatchEvent(new CustomEvent('ready', { detail: { id: item.id } }));
      });
      v.addEventListener('error', () => {
        entry.error = `could not load clip: ${item.label}`;
        this.dispatchEvent(new CustomEvent('mediaerror', { detail: { id: item.id, error: entry.error } }));
      });
      entry.el = v;
      return entry;
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    const url = item.kind === 'remote' ? proxied(item.source) : item.url;
    img.onload = () => {
      entry.ready = true;
      entry.w = img.naturalWidth;
      entry.h = img.naturalHeight;
      entry.stamp = null;
      this.dispatchEvent(new CustomEvent('ready', { detail: { id: item.id } }));
    };
    img.onerror = () => {
      entry.error = `could not load image: ${item.label}`;
      this.dispatchEvent(new CustomEvent('mediaerror', { detail: { id: item.id, error: entry.error } }));
    };
    img.src = url;
    entry.el = img;

    // Remote stills refresh on their own cadence.
    if (item.kind === 'remote' && item.mediaKind !== 'video') {
      const ms = Math.max(2000, item.refreshMs || 15000);
      const timer = setInterval(() => {
        const next = new Image();
        next.crossOrigin = 'anonymous';
        next.onload = () => {
          entry.el = next;
          entry.w = next.naturalWidth;
          entry.h = next.naturalHeight;
          entry.stamp = null;
          entry.ready = true;
        };
        next.onerror = () => {
          /* keep showing the previous frame */
        };
        next.src = `${proxied(item.source)}${proxied(item.source).includes('?') ? '&' : '?'}_t=${Date.now()}`;
      }, ms);
      this._timers.set(item.id, timer);
    }
    return entry;
  }

  _teardown(id, { keepItem = false } = {}) {
    const t = this._timers.get(id);
    if (t) {
      clearInterval(t);
      this._timers.delete(id);
    }
    const e = this.entries.get(id);
    if (e) {
      if (e.el instanceof HTMLVideoElement) {
        try {
          e.el.pause();
          e.el.srcObject = null;
          e.el.removeAttribute('src');
          e.el.load();
        } catch {
          /* ignore */
        }
      }
      if (!keepItem) this.entries.delete(id);
    }
  }

  _invalidateStamp(entry) {
    const want = entry.item.render?.mask || 'none';
    if (entry.maskKey !== want) entry.stamp = null;
  }

  /* ---------- live device capture ---------- */

  /** Add the operator's webcam or screen as a live visual source. */
  async addLiveSource({ type = 'camera', channels = ['cloud'], label } = {}) {
    const stream =
      type === 'screen'
        ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
        : await navigator.mediaDevices.getUserMedia({ video: true, audio: false });

    const id = `live-${type}-${Date.now()}`;
    const item = {
      id,
      kind: 'live',
      mediaKind: 'video',
      label: label || (type === 'screen' ? 'Live screen' : 'Live camera'),
      channels,
      render: { scale: 1, opacity: 1, rotate: 'drift', blend: 'source-over', mask: 'soft', weight: 1 },
      addedAt: new Date().toISOString(),
    };

    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.autoplay = true;
    v.srcObject = stream;
    await v.play().catch(() => {});

    const entry = { item, el: v, ready: true, stamp: null, maskKey: null, stream, error: null };
    entry.w = v.videoWidth || 1280;
    entry.h = v.videoHeight || 720;
    this.entries.set(id, entry);
    this.liveSources.push(id);
    stream.getVideoTracks()[0]?.addEventListener('ended', () => this.removeLiveSource(id));

    this.items = [...this.entries.values()].map((e) => e.item);
    this.dispatchEvent(new CustomEvent('change', { detail: { items: this.items } }));
    return item;
  }

  removeLiveSource(id) {
    const e = this.entries.get(id);
    if (!e) return;
    e.stream?.getTracks?.().forEach((t) => t.stop());
    this.entries.delete(id);
    this.liveSources = this.liveSources.filter((x) => x !== id);
    this.items = [...this.entries.values()].map((x) => x.item);
    this.dispatchEvent(new CustomEvent('change', { detail: { items: this.items } }));
  }

  /** Apply a local render-setting change without a server round trip. */
  applyRender(id, patch) {
    const e = this.entries.get(id);
    if (!e) return null;
    e.item.render = { ...e.item.render, ...patch };
    if (e.el instanceof HTMLVideoElement && patch.playbackRate) {
      e.el.playbackRate = patch.playbackRate;
    }
    this._invalidateStamp(e);
    return e.item;
  }

  setChannels(id, channels) {
    const e = this.entries.get(id);
    if (!e) return null;
    e.item.channels = channels;
    return e.item;
  }

  /* ---------- drawing ---------- */

  /** Pre-render a still into a masked stamp. */
  _buildStamp(entry) {
    const mask = entry.item.render?.mask || 'none';
    const c = document.createElement('canvas');
    c.width = STAMP_SIZE;
    c.height = STAMP_SIZE;
    const ctx = c.getContext('2d');

    // Cover-fit so non-square art is not distorted.
    const { w = 1, h = 1 } = entry;
    const s = Math.max(STAMP_SIZE / w, STAMP_SIZE / h);
    const dw = w * s;
    const dh = h * s;
    ctx.drawImage(entry.el, (STAMP_SIZE - dw) / 2, (STAMP_SIZE - dh) / 2, dw, dh);

    if (mask !== 'none') {
      ctx.globalCompositeOperation = 'destination-in';
      if (mask === 'circle') {
        ctx.beginPath();
        ctx.arc(STAMP_SIZE / 2, STAMP_SIZE / 2, STAMP_SIZE / 2, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
      } else {
        ctx.drawImage(mask === 'blob' ? blobMask(STAMP_SIZE, hashId(entry.item.id)) : softMask(STAMP_SIZE), 0, 0);
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    entry.stamp = c;
    entry.maskKey = mask;
    return c;
  }

  /**
   * Draw one sprite.
   *
   * Performance contract: the CALLER owns globalCompositeOperation (sprites are
   * batched by blend mode) and this method owns the transform and alpha. It
   * deliberately avoids ctx.save()/restore() — profiling the headless encoder
   * showed save/restore/rotate costing ~57ms per 900 sprites, four times the
   * cost of the drawImage calls themselves.
   *
   * Returns false if the source had nothing to show, so the particle system
   * can retire that sprite.
   */
  drawSprite(ctx, entry, { x, y, size, rotation = 0, alpha = 1 }) {
    if (!entry?.ready || !entry.el) return false;
    const item = entry.item;
    const isVideo = entry.el instanceof HTMLVideoElement;
    if (isVideo && entry.el.readyState < 2) return false;

    const opacity = alpha * (item.render?.opacity ?? 1);
    if (opacity <= 0.002 || size < 0.5) return false;

    ctx.globalAlpha = opacity > 1 ? 1 : opacity;
    const mask = item.render?.mask || 'none';
    const half = size / 2;

    // Only pay for a transform when the sprite is actually rotated.
    const rotated = Math.abs(rotation) > 0.001;
    if (rotated) {
      const c = Math.cos(rotation);
      const sn = Math.sin(rotation);
      ctx.setTransform(c, sn, -sn, c, x, y);
    }
    const dx = rotated ? -half : x - half;
    const dy = rotated ? -half : y - half;

    if (!isVideo) {
      const stamp = entry.stamp && entry.maskKey === mask ? entry.stamp : this._buildStamp(entry);
      ctx.drawImage(stamp, dx, dy, size, size);
    } else if (mask === 'none') {
      const { w = 16, h = 9 } = entry;
      const sc = Math.max(size / w, size / h);
      const dw = w * sc;
      const dh = h * sc;
      ctx.drawImage(entry.el, dx + (size - dw) / 2, dy + (size - dh) / 2, dw, dh);
    } else {
      ctx.drawImage(this._maskedVideoFrame(entry, size, mask), dx, dy, size, size);
    }

    if (rotated) ctx.setTransform(1, 0, 0, 1, 0, 0);
    return true;
  }

  /** Compose a masked frame of a moving source at sprite resolution. */
  _maskedVideoFrame(entry, size, mask) {
    const item = entry.item;
    const px = Math.max(8, Math.min(512, Math.ceil(size)));
    if (this.scratch.width !== px || this.scratch.height !== px) {
      this.scratch.width = px;
      this.scratch.height = px;
    }
    const sc = this.scratchCtx;
    sc.clearRect(0, 0, px, px);
    const { w = 16, h = 9 } = entry;
    const f = Math.max(px / w, px / h);
    sc.globalCompositeOperation = 'source-over';
    sc.drawImage(entry.el, (px - w * f) / 2, (px - h * f) / 2, w * f, h * f);
    sc.globalCompositeOperation = 'destination-in';
    if (mask === 'circle') {
      sc.beginPath();
      sc.arc(px / 2, px / 2, px / 2, 0, Math.PI * 2);
      sc.fillStyle = '#fff';
      sc.fill();
    } else {
      sc.drawImage(mask === 'blob' ? blobMask(256, hashId(item.id)) : softMask(256), 0, 0, px, px);
    }
    sc.globalCompositeOperation = 'source-over';
    return this.scratch;
  }

  destroy() {
    for (const id of [...this.entries.keys()]) this._teardown(id);
    for (const id of this.liveSources) this.removeLiveSource(id);
  }
}

const proxied = (url) => `/api/media/proxy?url=${encodeURIComponent(url)}`;

function hashId(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 997;
}
