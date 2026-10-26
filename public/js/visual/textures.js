/**
 * Procedural textures for the land fill.
 *
 * Each generator returns a tileable offscreen canvas used as a CanvasPattern,
 * so the map can read as newsprint, woven cloth, an engraved contour plate or
 * a CRT, independent of the colour palette.
 */

const cache = new Map();

function makeTile(size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

/** Deterministic hash noise so a texture looks identical every render. */
function rand(i) {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const GENERATORS = {
  none: () => null,

  grain: (size = 256) => {
    const c = makeTile(size);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let i = 0; i < size * size; i++) {
      const v = 128 + (rand(i) - 0.5) * 255;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  },

  paper: (size = 256) => {
    const c = makeTile(size);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    // Clumped noise: low-frequency blotches plus fine fibre.
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const blot =
          rand(Math.floor(x / 16) * 991 + Math.floor(y / 16) * 7) * 0.55 +
          rand(Math.floor(x / 5) * 131 + Math.floor(y / 5) * 17) * 0.25;
        const fibre = rand(i) * 0.2;
        const v = 110 + (blot + fibre) * 110;
        img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
        img.data[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  },

  scanlines: (size = 8) => {
    const c = makeTile(size);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, size, Math.max(1, size / 2));
    return c;
  },

  halftone: (size = 12) => {
    const c = makeTile(size);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#ffffff';
    // Offset rows give the classic 45-degree dot screen.
    for (const [cx, cy] of [
      [size * 0.25, size * 0.25],
      [size * 0.75, size * 0.75],
    ]) {
      ctx.beginPath();
      ctx.arc(cx, cy, size * 0.22, 0, Math.PI * 2);
      ctx.fill();
    }
    return c;
  },

  weave: (size = 16) => {
    const c = makeTile(size);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size / 2, size / 2);
    ctx.fillRect(size / 2, size / 2, size / 2, size / 2);
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(size / 2, 0, size / 2, size / 2);
    ctx.fillRect(0, size / 2, size / 2, size / 2);
    return c;
  },

  topo: (size = 256) => {
    const c = makeTile(size);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    // Banded value noise reads as contour lines.
    const smooth = (x, y) => {
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      const fx = x - xi;
      const fy = y - yi;
      const f = (t) => t * t * (3 - 2 * t);
      const h = (a, b) => rand(((a % 64) + 64) * 613 + ((b % 64) + 64) * 1097);
      const a = h(xi, yi);
      const b = h(xi + 1, yi);
      const d = h(xi, yi + 1);
      const e = h(xi + 1, yi + 1);
      return (a * (1 - f(fx)) + b * f(fx)) * (1 - f(fy)) + (d * (1 - f(fx)) + e * f(fx)) * f(fy);
    };
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const n = smooth(x / 28, y / 28) + smooth(x / 11, y / 11) * 0.4;
        const band = Math.abs(((n * 7) % 1) - 0.5) * 2;
        const v = band > 0.82 ? 240 : 96;
        img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
        img.data[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  },
};

export const TEXTURE_TYPES = Object.keys(GENERATORS);

/** Get (and memoise) a texture tile canvas. */
export function textureTile(type) {
  if (!GENERATORS[type]) return null;
  if (!cache.has(type)) cache.set(type, GENERATORS[type]());
  return cache.get(type);
}

/**
 * Build a CanvasPattern for the given texture settings.
 * `imageSource` supplies the tile when type === 'image'.
 */
export function texturePattern(ctx, settings, imageSource = null) {
  const type = settings?.type || 'none';
  if (type === 'none') return null;
  const tile = type === 'image' ? imageSource : textureTile(type);
  if (!tile) return null;
  let pattern;
  try {
    pattern = ctx.createPattern(tile, 'repeat');
  } catch {
    return null;
  }
  if (!pattern) return null;
  const scale = Math.max(0.05, settings.scale ?? 1);
  const rot = ((settings.rotate ?? 0) * Math.PI) / 180;
  if (pattern.setTransform) {
    const m = new DOMMatrix();
    m.rotateSelf((rot * 180) / Math.PI);
    m.scaleSelf(scale, scale);
    pattern.setTransform(m);
  }
  return pattern;
}

/** Soft radial mask used to feather sprites. Cached by size bucket. */
export function softMask(size) {
  const key = `mask${size}`;
  if (cache.has(key)) return cache.get(key);
  const c = makeTile(size);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.92)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  cache.set(key, c);
  return c;
}

/** An irregular blob mask — organic edges rather than a perfect circle. */
export function blobMask(size, seed = 1) {
  const key = `blob${size}:${seed}`;
  if (cache.has(key)) return cache.get(key);
  const c = makeTile(size);
  const ctx = c.getContext('2d');
  const r = size * 0.42;
  ctx.beginPath();
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const wobble = 0.72 + rand(seed * 977 + i * 31) * 0.45;
    const x = size / 2 + Math.cos(a) * r * wobble;
    const y = size / 2 + Math.sin(a) * r * wobble;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = '#fff';
  ctx.filter = 'blur(6px)';
  ctx.fill();
  cache.set(key, c);
  return c;
}

export function clearTextureCache() {
  cache.clear();
}
