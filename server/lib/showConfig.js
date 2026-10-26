/**
 * The "show": every aesthetic decision the operator makes, persisted so a
 * broadcast survives a restart and so the headless encoder renders exactly
 * what the operator sees in their browser.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DEFAULT_SHOW = {
  map: {
    background: '#07080c',
    land: '#17243a',
    landAlt: '#0e1726',
    outline: '#e8c37a',
    counties: '#243653',
    glow: '#5de3ff',
    ink: '#f3efe4',
    countyLines: true,
    countyLineWidth: 0.6,
    outlineWidth: 2.4,
    glowStrength: 0.45,
    // Land fill is shaded by the temperature field between these two colours.
    tempCold: '#2d4b8f',
    tempHot: '#c4452a',
    tempShading: 0.55,
    texture: {
      type: 'grain', // none | grain | paper | scanlines | halftone | weave | topo | image
      scale: 1.4,
      strength: 0.35,
      rotate: 0,
      imageId: null, // a media-library image used as the land texture
    },
    vignette: 0.35,
    // Film grain and bloom each cost a full-canvas compositing pass (~17ms
    // and ~18ms at 1080p on a software rasteriser). They are off by default
    // so the frame-rate budget goes to the media collage; switch them on if
    // your encoder has headroom.
    grain: 0,
    bloom: 0,
  },
  channels: {
    cloud: { enabled: true, density: 0.6, size: 1, speed: 1, opacity: 0.8, blend: 'screen', threshold: 0.35, jitter: 0.5 },
    rain: { enabled: true, density: 0.8, size: 0.7, speed: 1.3, opacity: 0.9, blend: 'source-over', threshold: 0.12, jitter: 0.7 },
    storm: { enabled: true, density: 0.5, size: 1.1, speed: 1.6, opacity: 1, blend: 'source-over', threshold: 0.6, jitter: 0.9 },
    heat: { enabled: true, density: 0.4, size: 1.2, speed: 0.4, opacity: 0.6, blend: 'overlay', threshold: 0.7, jitter: 0.3 },
    cold: { enabled: true, density: 0.4, size: 1.1, speed: 0.6, opacity: 0.6, blend: 'screen', threshold: 0.3, jitter: 0.3 },
    wind: { enabled: true, density: 0.5, size: 0.7, speed: 2, opacity: 0.7, blend: 'screen', threshold: 0.35, jitter: 0.8 },
    calm: { enabled: false, density: 0.25, size: 1, speed: 0.25, opacity: 0.5, blend: 'source-over', threshold: 0.2, jitter: 0.2 },
  },
  motion: {
    // Time-lapse factor on the measured wind. Direction and relative speeds
    // are real; the rate is multiplied so weather reads as moving on screen.
    // 1 = true real time (effectively still at this map scale).
    windGain: 1800,
    turbulence: 0.5,
    trails: 0.12, // 0 = crisp, 1 = long smears
    clusterCohesion: 0.6,
    // Sprite fill rate is the single biggest cost in the renderer; 520 still
    // reads as dense. Raise it if your encoder has headroom.
    maxSprites: 520,
    // Clipping every sprite to the state silhouette roughly doubles sprite
    // cost. Spawning is already confined to Texas, so leaving this off just
    // lets masses overhang the border softly.
    clipToState: false,
  },
  audio: {
    master: 0.8,
    drone: 0.75,
    pad: 0.6,
    wind: 0.5,
    rain: 0.55,
    thunder: 0.7,
    bells: 0.45,
    reverb: 0.4,
    scaleMode: 'auto', // auto | aeolian | dorian | lydian | pentatonic | phrygian
    rootMode: 'auto', // auto | fixed
    rootNote: 'D',
    tempoBias: 1,
  },
  overlay: {
    title: 'TEXAS WEATHER',
    subtitle: 'live from the National Weather Service',
    showStations: true,
    showReadout: true,
    showAlerts: true,
    showClock: true,
    showLegend: true,
    font: 'condensed',
    accent: '#e8c37a',
  },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Deep merge that only accepts keys present in the default shape. */
export function mergeShow(base, patch) {
  if (!isObj(patch)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in base)) continue; // ignore unknown keys rather than trusting them
    const b = base[k];
    if (isObj(b) && isObj(v)) out[k] = mergeShow(b, v);
    else if (typeof b === 'number' && Number.isFinite(Number(v))) out[k] = Number(v);
    else if (typeof b === 'boolean') out[k] = Boolean(v);
    else if (typeof b === 'string' && typeof v === 'string') out[k] = v.slice(0, 400);
    else if (b === null) out[k] = typeof v === 'string' ? v.slice(0, 200) : v === null ? null : b;
    else out[k] = b;
  }
  return out;
}

export class ShowStore {
  constructor(path) {
    this.path = path;
    this.show = structuredClone(DEFAULT_SHOW);
  }

  async init() {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8'));
      this.show = mergeShow(structuredClone(DEFAULT_SHOW), raw);
    } catch {
      await this.save();
    }
    return this.show;
  }

  async patch(partial) {
    this.show = mergeShow(this.show, partial);
    await this.save();
    return this.show;
  }

  async reset() {
    this.show = structuredClone(DEFAULT_SHOW);
    await this.save();
    return this.show;
  }

  async save() {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.show, null, 2));
  }
}
