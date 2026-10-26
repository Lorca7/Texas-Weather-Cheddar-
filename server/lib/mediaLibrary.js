/**
 * The media library: the pool of visual content the engine renders *instead of*
 * conventional weather symbols. Stills, video clips, and live remote sources.
 *
 * Each item is assigned to one or more weather "channels" (rain, clouds,
 * storm, heat, wind, cold), and the visual engine draws that item wherever
 * the corresponding field is active.
 */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink, stat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';

export const CHANNELS = ['cloud', 'rain', 'storm', 'heat', 'cold', 'wind', 'calm'];

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.svg']);
export const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv']);

export function kindForExt(ext) {
  const e = String(ext).toLowerCase();
  if (IMAGE_EXT.has(e)) return 'image';
  if (VIDEO_EXT.has(e)) return 'video';
  return null;
}

/** Strip anything that could escape the uploads directory. */
export function safeName(name) {
  return basename(String(name || 'untitled'))
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 120);
}

export class MediaLibrary {
  constructor({ root }) {
    this.root = root;
    this.uploadDir = join(root, 'uploads');
    this.indexPath = join(root, 'library.json');
    this.items = [];
  }

  async init() {
    await mkdir(this.uploadDir, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(this.indexPath, 'utf8'));
      this.items = Array.isArray(raw?.items) ? raw.items : [];
    } catch {
      this.items = [];
    }
    // Drop records whose file vanished (someone cleaned out uploads/).
    const alive = [];
    for (const it of this.items) {
      if (it.kind === 'remote') {
        alive.push(it);
        continue;
      }
      try {
        await stat(join(this.uploadDir, it.file));
        alive.push(it);
      } catch {
        /* file gone */
      }
    }
    if (alive.length !== this.items.length) {
      this.items = alive;
      await this.save();
    }
    return this.items;
  }

  async save() {
    await writeFile(
      this.indexPath,
      JSON.stringify({ updatedAt: new Date().toISOString(), items: this.items }, null, 2)
    );
  }

  list() {
    return this.items.map((it) => ({ ...it, url: this.urlFor(it) }));
  }

  urlFor(it) {
    if (it.kind === 'remote') return it.source;
    return `/media/uploads/${encodeURIComponent(it.file)}`;
  }

  get(id) {
    return this.items.find((it) => it.id === id) || null;
  }

  /** Register an uploaded file that multer has already written to disk. */
  async addUpload({ file, originalName, channels, label }) {
    const ext = extname(file).toLowerCase();
    const kind = kindForExt(ext);
    if (!kind) throw new Error(`unsupported media type: ${ext || 'no extension'}`);
    const st = await stat(join(this.uploadDir, file));
    const item = {
      id: randomUUID(),
      kind,
      file,
      label: label || safeName(originalName) || file,
      originalName: safeName(originalName),
      bytes: st.size,
      channels: normaliseChannels(channels, ['cloud']),
      addedAt: new Date().toISOString(),
      // Per-item render hints the operator can tune in the panel.
      render: defaultRender(kind),
    };
    this.items.push(item);
    await this.save();
    return { ...item, url: this.urlFor(item) };
  }

  /**
   * Register a live external source: a still image URL re-fetched on an
   * interval (traffic cams, satellite stills, a partner's render) or a video
   * URL the browser can play directly (mp4 / webm / HLS).
   */
  async addRemote({ source, kind = 'remote', mediaKind = 'image', refreshMs = 15000, channels, label }) {
    const item = {
      id: randomUUID(),
      kind: 'remote',
      mediaKind: mediaKind === 'video' ? 'video' : 'image',
      source,
      label: label || source.slice(0, 80),
      refreshMs: Math.max(2000, Math.min(600000, Number(refreshMs) || 15000)),
      channels: normaliseChannels(channels, ['cloud']),
      addedAt: new Date().toISOString(),
      render: defaultRender(mediaKind === 'video' ? 'video' : 'image'),
    };
    this.items.push(item);
    await this.save();
    return { ...item, url: this.urlFor(item) };
  }

  async update(id, patch) {
    const it = this.get(id);
    if (!it) throw new Error('no such media item');
    if (patch.channels) it.channels = normaliseChannels(patch.channels, it.channels);
    if (typeof patch.label === 'string') it.label = patch.label.slice(0, 160);
    if (patch.render && typeof patch.render === 'object') {
      it.render = { ...it.render, ...sanitiseRender(patch.render) };
    }
    if (patch.refreshMs && it.kind === 'remote') {
      it.refreshMs = Math.max(2000, Math.min(600000, Number(patch.refreshMs)));
    }
    await this.save();
    return { ...it, url: this.urlFor(it) };
  }

  async remove(id) {
    const idx = this.items.findIndex((it) => it.id === id);
    if (idx === -1) throw new Error('no such media item');
    const [it] = this.items.splice(idx, 1);
    if (it.kind !== 'remote') {
      await unlink(join(this.uploadDir, it.file)).catch(() => {});
    }
    await this.save();
    return it;
  }
}

function normaliseChannels(input, fallback) {
  const list = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(',')
      : null;
  if (!list) return fallback;
  const out = [...new Set(list.map((c) => String(c).trim().toLowerCase()).filter((c) => CHANNELS.includes(c)))];
  return out.length ? out : fallback;
}

function defaultRender(kind) {
  return {
    scale: 1,
    opacity: 1,
    rotate: 'drift', // 'none' | 'drift' | 'spin' | 'align-wind'
    blend: 'source-over',
    // Soft by default: hard-edged tiles pile into a solid wall where a field
    // is dense, whereas feathered ones read as a cloud mass. Per-item
    // override in the console for art that wants a crisp edge.
    mask: 'soft', // 'none' | 'circle' | 'soft' | 'blob'
    weight: 1, // relative likelihood of being picked for a cluster
    playbackRate: kind === 'video' ? 1 : undefined,
  };
}

function sanitiseRender(r) {
  const out = {};
  const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v)));
  if (r.scale !== undefined && Number.isFinite(Number(r.scale))) out.scale = clampNum(r.scale, 0.05, 12);
  if (r.opacity !== undefined && Number.isFinite(Number(r.opacity))) out.opacity = clampNum(r.opacity, 0, 1);
  if (r.weight !== undefined && Number.isFinite(Number(r.weight))) out.weight = clampNum(r.weight, 0, 20);
  if (r.playbackRate !== undefined && Number.isFinite(Number(r.playbackRate))) {
    out.playbackRate = clampNum(r.playbackRate, 0.1, 4);
  }
  if (['none', 'drift', 'spin', 'align-wind'].includes(r.rotate)) out.rotate = r.rotate;
  if (['none', 'circle', 'soft', 'blob'].includes(r.mask)) out.mask = r.mask;
  if (
    [
      'source-over',
      'screen',
      'lighter',
      'multiply',
      'overlay',
      'soft-light',
      'hard-light',
      'difference',
      'exclusion',
      'hue',
      'luminosity',
    ].includes(r.blend)
  ) {
    out.blend = r.blend;
  }
  return out;
}
