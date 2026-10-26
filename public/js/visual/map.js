/**
 * The Texas map layer.
 *
 * Draws, bottom to top:
 *   1. the temperature field, shaded between two operator-chosen colours and
 *      clipped to the state silhouette;
 *   2. a texture pattern (newsprint, halftone, contour plate, or an uploaded
 *      image) multiplied over the land;
 *   3. county lines;
 *   4. the state outline, with an optional glow.
 *
 * Paths are rebuilt only on resize — rebuilding 254 county paths every frame
 * is the difference between 60fps and 12.
 */
import { texturePattern } from './textures.js';

export class TexasMap {
  constructor({ geo, view }) {
    this.geo = geo;
    this.view = view;
    this.paths = null;
    this.fieldCanvas = document.createElement('canvas');

    // The map is static between data refreshes, so it is rendered once into
    // this layer and blitted thereafter. Measured on the headless software
    // rasteriser at 1080p: drawing the map costs ~65ms (the outline's
    // shadowBlur alone is ~19ms, the land gradient ~13ms), while blitting a
    // cached layer costs ~12ms. That difference is the whole frame budget.
    this.layer = document.createElement('canvas');
    this.dirty = true;

    this.rebuild();
  }

  rebuild() {
    const v = this.view;
    this.paths = {
      outline: v.path(this.geo.outline),
      counties: this.geo.counties.map((c) => v.path(c.geometry)),
    };
    if (this.layer.width !== v.width || this.layer.height !== v.height) {
      this.layer.width = v.width;
      this.layer.height = v.height;
    }
    this.dirty = true;
    return this;
  }

  /** Mark the cached map layer as needing a repaint. */
  invalidate() {
    this.dirty = true;
    return this;
  }

  /** The silhouette, for clipping other layers to the state. */
  get clipPath() {
    return this.paths.outline;
  }

  /**
   * Render the temperature field into a small offscreen canvas, one pixel per
   * grid cell, then let the GPU smooth it on the way up to full size.
   */
  _paintField(blender, show) {
    const cur = blender.current;
    if (!cur) return null;
    const { cols, rows } = cur;
    const c = this.fieldCanvas;
    if (c.width !== cols || c.height !== rows) {
      c.width = cols;
      c.height = rows;
    }
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(cols, rows);

    const cold = hexToRgb(show.map.tempCold);
    const hot = hexToRgb(show.map.tempHot);
    const [w, s, e, n] = cur.bbox;

    for (let row = 0; row < rows; row++) {
      const lat = n - ((row + 0.5) / rows) * (n - s);
      for (let col = 0; col < cols; col++) {
        const lon = w + ((col + 0.5) / cols) * (e - w);
        const t = blender.sample('temp', lon, lat, { drift: false });
        // -5C..40C spans the range Texas actually lives in; outside that the
        // shading saturates rather than washing out the whole state.
        const k = clamp01((t + 5) / 45);
        const i = (row * cols + col) * 4;
        img.data[i] = cold.r + (hot.r - cold.r) * k;
        img.data[i + 1] = cold.g + (hot.g - cold.g) * k;
        img.data[i + 2] = cold.b + (hot.b - cold.b) * k;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /**
   * Blit the cached map, repainting it first if anything it depends on moved.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} show        show configuration
   * @param {object} blender     FieldBlender (may be empty on first frames)
   * @param {object} [opts]
   * @param {CanvasImageSource} [opts.textureImage] tile for texture type 'image'
   */
  draw(ctx, show, blender, opts = {}) {
    if (this.dirty) {
      const lctx = this.layer.getContext('2d');
      lctx.clearRect(0, 0, this.layer.width, this.layer.height);
      this._paint(lctx, show, blender, opts);
      this.dirty = false;
    }
    const prevOp = ctx.globalCompositeOperation;
    const prevAlpha = ctx.globalAlpha;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(this.layer, 0, 0);
    ctx.globalCompositeOperation = prevOp;
    ctx.globalAlpha = prevAlpha;
  }

  /** Paint the map into a context. Expensive; only called when dirty. */
  _paint(ctx, show, blender, { textureImage = null } = {}) {
    const { width, height } = this.view;
    const m = show.map;

    ctx.save();

    // --- land base -------------------------------------------------------
    ctx.save();
    ctx.clip(this.paths.outline);

    ctx.fillStyle = m.land;
    ctx.fillRect(0, 0, width, height);

    // Temperature shading over the flat land colour.
    const field = m.tempShading > 0 ? this._paintField(blender, show) : null;
    if (field) {
      ctx.save();
      ctx.globalAlpha = clamp01(m.tempShading);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(field, 0, 0, width, height);
      ctx.restore();
    }

    // A second land tone low in the south-east gives the fill some depth.
    const grad = ctx.createLinearGradient(0, 0, width * 0.6, height);
    grad.addColorStop(0, hexToRgba(m.landAlt, 0.0));
    grad.addColorStop(1, hexToRgba(m.landAlt, 0.55));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // --- texture ---------------------------------------------------------
    const pattern = texturePattern(ctx, m.texture, textureImage);
    if (pattern && (m.texture.strength ?? 0) > 0) {
      ctx.save();
      ctx.globalAlpha = clamp01(m.texture.strength);
      // 'overlay' keeps the palette and only modulates light and dark.
      ctx.globalCompositeOperation = m.texture.type === 'image' ? 'soft-light' : 'overlay';
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }

    // --- county lines ----------------------------------------------------
    if (m.countyLines) {
      ctx.save();
      ctx.strokeStyle = m.counties;
      ctx.lineWidth = Math.max(0.25, m.countyLineWidth);
      ctx.globalAlpha = 0.75;
      for (const p of this.paths.counties) ctx.stroke(p);
      ctx.restore();
    }

    ctx.restore(); // end land clip

    // --- outline + glow --------------------------------------------------
    if (m.glowStrength > 0) {
      ctx.save();
      ctx.shadowColor = m.glow;
      ctx.shadowBlur = 26 * m.glowStrength;
      ctx.strokeStyle = hexToRgba(m.glow, 0.55 * m.glowStrength);
      ctx.lineWidth = m.outlineWidth * 1.6;
      ctx.stroke(this.paths.outline);
      ctx.restore();
    }

    ctx.save();
    ctx.strokeStyle = m.outline;
    ctx.lineWidth = m.outlineWidth;
    ctx.lineJoin = 'round';
    ctx.stroke(this.paths.outline);
    ctx.restore();

    ctx.restore();
  }

  /** Vignette and film grain, drawn last over everything. */
  drawFinish(ctx, show) {
    const { width, height } = this.view;
    const m = show.map;
    if (m.vignette > 0) {
      const g = ctx.createRadialGradient(
        width / 2,
        height / 2,
        Math.min(width, height) * 0.25,
        width / 2,
        height / 2,
        Math.max(width, height) * 0.75
      );
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(0,0,0,${clamp01(m.vignette)})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, width, height);
    }
  }
}

/* ---------- colour helpers ------------------------------------------------ */

export function hexToRgb(hex) {
  const h = String(hex || '#000').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full.slice(0, 6), 16);
  return Number.isFinite(n)
    ? { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
    : { r: 0, g: 0, b: 0 };
}

export function hexToRgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
