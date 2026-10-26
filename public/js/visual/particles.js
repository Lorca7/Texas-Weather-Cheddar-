/**
 * The media particle system.
 *
 * This is the substitution at the centre of the piece: where a conventional
 * weather map would draw a cloud mass or a rain shield, this spawns a cluster
 * of whatever the operator uploaded — faces, tacos, family photos, video
 * clips — at that exact place, and lets the real wind field carry it.
 *
 * Each weather "channel" (cloud, rain, storm, heat, cold, wind, calm) is a
 * scalar field derived from the WeatherFrame. A channel's population is
 * proportional to how much of Texas that field currently covers, so a dry
 * clear day is sparse and a squall line is dense and violent.
 *
 * Sprites live in lon/lat, not pixels, so they keep their geographic meaning
 * when the canvas resizes or the stream changes resolution.
 */

export const CHANNEL_LIST = ['cloud', 'rain', 'storm', 'heat', 'cold', 'wind', 'calm'];

/** Field value in 0..1 for a channel at a location. */
export function channelIntensity(channel, blender, lon, lat) {
  const s = (name, drift = true) => blender.sample(name, lon, lat, { drift });
  switch (channel) {
    case 'cloud':
      return clamp01(s('cloud'));
    case 'rain': {
      const p = clamp01(s('precip'));
      // Rain is the broad shield; the violent core belongs to 'storm'.
      return p <= 0 ? 0 : clamp01(p * 1.15);
    }
    case 'storm': {
      const p = clamp01(s('precip'));
      const a = clamp01(s('alert', false));
      return clamp01(Math.max(p * p * 1.4, a * 0.85));
    }
    case 'heat': {
      const t = s('temp', false);
      // Ramps in from 28C and saturates near 42C.
      return clamp01((t - 28) / 14);
    }
    case 'cold': {
      const t = s('temp', false);
      // Ramps in below 10C, saturates near -6C.
      return clamp01((10 - t) / 16);
    }
    case 'wind': {
      const [u, v] = blender.wind(lon, lat);
      return clamp01((Math.hypot(u, v) - 6) / 26);
    }
    case 'calm': {
      const [u, v] = blender.wind(lon, lat);
      const still = clamp01(1 - Math.hypot(u, v) / 12);
      const clear = clamp01(1 - s('cloud'));
      return clamp01(still * clear);
    }
    default:
      return 0;
  }
}

/** Smooth pseudo-curl noise for turbulence, so drift is not a straight line. */
function curl(x, y, t) {
  const a = Math.sin(x * 1.7 + t * 0.21) * Math.cos(y * 1.3 - t * 0.17);
  const b = Math.cos(x * 1.1 - t * 0.13) * Math.sin(y * 1.9 + t * 0.23);
  return [a - b * 0.5, b + a * 0.5];
}

class Sprite {
  constructor(channel, lon, lat, entryId, seed) {
    this.channel = channel;
    this.lon = lon;
    this.lat = lat;
    this.entryId = entryId;
    this.seed = seed;
    this.age = 0;
    // Staggered lifetimes stop the whole population blinking in unison.
    this.life = 9 + (seed % 100) / 100 * 16;
    this.rot = ((seed % 628) / 100) - 3.14;
    this.rotSpeed = (((seed % 37) / 37) - 0.5) * 0.5;
    this.scaleJitter = 0.65 + ((seed % 53) / 53) * 0.8;
    this.phase = (seed % 1000) / 1000;
    this.intensity = 0;
    this.outside = false;
    this.alive = true;
  }

  get fade() {
    // Ease in over the first 1.6s, ease out over the last 2.4s.
    const In = Math.min(1, this.age / 1.6);
    const out = Math.min(1, Math.max(0, (this.life - this.age) / 2.4));
    return In * out;
  }
}

export class ParticleField {
  constructor({ bbox }) {
    this.bbox = bbox;
    this.sprites = [];
    this.clusters = new Map(); // channel -> [{lon,lat,strength}]
    this.rngState = 1234567;
    this.time = 0;
    this.stats = { total: 0, byChannel: {}, spawned: 0, retired: 0 };
    this._spawnAccumulator = new Map();
  }

  /** xorshift so visuals are reproducible for a given seed sequence. */
  rand() {
    let x = this.rngState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x >>> 0;
    return (this.rngState % 100000) / 100000;
  }

  /**
   * Find the cluster anchors for a channel: the places where this field is
   * strongest right now. Sprites are then scattered around these, which is
   * what makes the media arrive in *clusters* rather than an even dusting.
   */
  refreshClusters(blender, channel, { samples = 160, keep = 14, threshold = 0.1 } = {}) {
    const [w, s, e, n] = this.bbox;
    const found = [];
    for (let i = 0; i < samples; i++) {
      const lon = w + this.rand() * (e - w);
      const lat = s + this.rand() * (n - s);
      const v = channelIntensity(channel, blender, lon, lat);
      if (v > threshold) found.push({ lon, lat, strength: v });
    }
    found.sort((a, b) => b.strength - a.strength);
    this.clusters.set(channel, found.slice(0, keep));
    return this.clusters.get(channel);
  }

  /**
   * Advance the simulation.
   *
   * @param {number} dt            seconds since last update
   * @param {object} blender       FieldBlender
   * @param {object} show          show config
   * @param {object} pool          MediaPool
   * @param {(lon:number,lat:number)=>boolean} inState  point-in-Texas test
   */
  update(dt, blender, show, pool, inState) {
    if (!blender.ready) return this.stats;
    this.time += dt;
    this.frame = (this.frame || 0) + 1;

    const motion = show.motion;
    const [w, s, e, n] = this.bbox;
    // The engine's quality governor may lower this below the operator's
    // setting to protect the frame rate.
    const maxTotal = Math.max(24, (this.maxOverride ?? motion.maxSprites) | 0);

    // --- retire and move -------------------------------------------------
    const keep = [];
    for (const sp of this.sprites) {
      sp.age += dt;
      const cfg = show.channels[sp.channel];
      if (!cfg?.enabled || sp.age >= sp.life) {
        this.stats.retired++;
        continue;
      }

      const [u, v] = blender.wind(sp.lon, sp.lat);
      const [cu, cv] = curl(sp.lon * 0.8, sp.lat * 0.8, this.time + sp.phase * 10);
      const turb = motion.turbulence * 6;

      // Honest about the liberty being taken: real air moves about a kilometre
      // in the two and a half minutes between data refreshes, which at this
      // map scale is invisible. `windGain` is therefore a TIME-LAPSE factor —
      // the direction and the relative speeds are the measured wind, the rate
      // is multiplied so a mass crosses the state in minutes instead of hours.
      const timeLapse = motion.windGain ?? 1;
      const speed = (cfg.speed ?? 1) * timeLapse;
      const degPerSec = 1 / 60 / 3600; // 1 knot = 1/60 degree per hour
      const lonScale = 1 / Math.max(0.25, Math.cos((sp.lat * Math.PI) / 180));
      sp.lon += (u * speed + cu * turb * timeLapse * 0.08) * degPerSec * dt * lonScale;
      sp.lat += (v * speed + cv * turb * timeLapse * 0.08) * degPerSec * dt;

      // Keep the field honest: a sprite that drifts into air where its
      // channel no longer exists dies off rather than wandering a clear sky.
      sp.intensity = channelIntensity(sp.channel, blender, sp.lon, sp.lat);
      const thresh = (cfg.threshold ?? 0.2) * 0.45;
      if (sp.intensity < thresh) sp.age += dt * 2.2; // accelerate its exit

      // Weather belongs to Texas. A sprite carried over the border ages out
      // quickly so masses feather at the state line rather than streaming off
      // across the frame — at the default time-lapse a sprite would otherwise
      // travel a third of the screen beyond the border before dying.
      // Checked on a stagger: the point-in-path test is the costliest thing
      // per sprite, and a sprite does not cross a border in two frames.
      if (inState && (this.frame + sp.seed) % 7 === 0) {
        sp.outside = !inState(sp.lon, sp.lat);
      }
      if (sp.outside) sp.age += dt * 3.5;

      if (sp.lon < w - 1.5 || sp.lon > e + 1.5 || sp.lat < s - 1.5 || sp.lat > n + 1.5) {
        this.stats.retired++;
        continue;
      }
      sp.rot += sp.rotSpeed * dt * (cfg.speed ?? 1) * 0.5;
      keep.push(sp);
    }
    this.sprites = keep;

    // --- spawn -----------------------------------------------------------
    const byChannel = {};
    for (const sp of this.sprites) byChannel[sp.channel] = (byChannel[sp.channel] || 0) + 1;

    // Share the sprite budget across the enabled channels by how much of the
    // state each one currently occupies.
    const demand = [];
    let demandTotal = 0;
    for (const channel of CHANNEL_LIST) {
      const cfg = show.channels[channel];
      if (!cfg?.enabled) continue;
      if (!pool.forChannel(channel).length) continue;
      const anchors = this.refreshClusters(blender, channel, {
        samples: 120,
        keep: 14,
        threshold: cfg.threshold ?? 0.2,
      });
      if (!anchors.length) continue;
      const coverage = anchors.reduce((a, c) => a + c.strength, 0) / 14;
      const d = coverage * (cfg.density ?? 1);
      demand.push({ channel, cfg, anchors, d });
      demandTotal += d;
    }

    this.stats.byChannel = byChannel;
    if (!demandTotal) {
      this.stats.total = this.sprites.length;
      return this.stats;
    }

    for (const { channel, cfg, anchors, d } of demand) {
      const target = Math.round((d / demandTotal) * maxTotal);
      const have = byChannel[channel] || 0;
      const deficit = target - have;
      if (deficit <= 0) continue;

      // Spawn rate is bounded so a channel fills in over ~2s rather than
      // popping into existence in a single frame.
      const acc = (this._spawnAccumulator.get(channel) || 0) + Math.min(deficit, deficit * dt * 2.5 + dt * 6);
      let budget = Math.floor(acc);
      this._spawnAccumulator.set(channel, acc - budget);

      while (budget-- > 0 && this.sprites.length < maxTotal) {
        const sp = this._spawnOne(channel, cfg, anchors, blender, pool, inState, show);
        if (sp) {
          this.sprites.push(sp);
          this.stats.spawned++;
        }
      }
    }

    this.stats.total = this.sprites.length;
    return this.stats;
  }

  _spawnOne(channel, cfg, anchors, blender, pool, inState, show) {
    const cohesion = show.motion.clusterCohesion ?? 0.6;
    const jitter = cfg.jitter ?? 0.5;

    // Try a few placements: near a cluster anchor most of the time, anywhere
    // in the active field occasionally, so masses have soft edges.
    for (let attempt = 0; attempt < 6; attempt++) {
      let lon;
      let lat;
      if (this.rand() < cohesion && anchors.length) {
        const a = anchors[Math.floor(this.rand() * anchors.length)];
        // Gaussian-ish scatter around the anchor.
        const spread = 0.35 + jitter * 1.5;
        lon = a.lon + (this.rand() + this.rand() - 1) * spread;
        lat = a.lat + (this.rand() + this.rand() - 1) * spread * 0.8;
      } else {
        const [w, s, e, n] = this.bbox;
        lon = w + this.rand() * (e - w);
        lat = s + this.rand() * (n - s);
      }

      const v = channelIntensity(channel, blender, lon, lat);
      if (v < (cfg.threshold ?? 0.2)) continue;
      // Accept proportionally to intensity so cores are denser than fringes.
      if (this.rand() > v) continue;
      // Spawning is always confined to Texas. `clipToState` governs only the
      // hard render clip — without this split, switching the clip off let
      // weather spawn over Mexico, Oklahoma and the open Gulf.
      if (inState && !inState(lon, lat)) continue;

      const entry = pool.pick(channel, this.rand());
      if (!entry) return null;

      const sp = new Sprite(channel, lon, lat, entry.item.id, Math.floor(this.rand() * 1e6));
      sp.intensity = v;
      return sp;
    }
    return null;
  }

  /**
   * Draw every sprite.
   *
   * Painters-order by channel so storms sit above cloud, then batched by
   * effective blend mode: switching globalCompositeOperation per sprite
   * measured three times the cost of the drawImage itself, so the whole frame
   * is bucketed and the composite op is set once per bucket.
   */
  draw(ctx, view, show, pool) {
    const order = ['calm', 'cloud', 'cold', 'heat', 'wind', 'rain', 'storm'];
    const base = Math.min(view.width, view.height);

    // Build the draw list once, tagged with its blend bucket.
    const buckets = new Map();
    for (let oi = 0; oi < order.length; oi++) {
      const channel = order[oi];
      const cfg = show.channels[channel];
      if (!cfg?.enabled) continue;
      for (const sp of this.sprites) {
        if (sp.channel !== channel) continue;
        const entry = pool.entries.get(sp.entryId);
        if (!entry?.ready) continue;

        const [x, y] = view.toScreen(sp.lon, sp.lat);
        const size =
          base *
          0.055 *
          (cfg.size ?? 1) *
          (entry.item.render?.scale ?? 1) *
          sp.scaleJitter *
          (0.55 + sp.intensity * 0.85);

        // Cull offscreen sprites before doing any drawing work.
        if (x + size < 0 || y + size < 0 || x - size > view.width || y - size > view.height) continue;

        let rotation = 0;
        const mode = entry.item.render?.rotate || 'drift';
        if (mode === 'drift') rotation = sp.rot;
        else if (mode === 'spin') rotation = this.time * 0.6 + sp.phase * 6.28;
        else if (mode === 'align-wind') rotation = sp.windAngle ?? sp.rot;

        const blend = entry.item.render?.blend || cfg.blend || 'source-over';
        // Order key keeps painters-order inside a bucket.
        const job = { entry, x, y, size, rotation, alpha: sp.fade * (cfg.opacity ?? 1), oi };
        const list = buckets.get(blend);
        if (list) list.push(job);
        else buckets.set(blend, [job]);
      }
    }

    let drawn = 0;
    const prevAlpha = ctx.globalAlpha;
    for (const [blend, jobs] of buckets) {
      ctx.globalCompositeOperation = blend;
      jobs.sort((a, b) => a.oi - b.oi);
      for (const j of jobs) {
        if (pool.drawSprite(ctx, j.entry, j)) drawn++;
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = prevAlpha;

    this.stats.drawn = drawn;
    return drawn;
  }

  /** Recompute wind-aligned angles; cheap enough to do once per frame. */
  alignToWind(blender, view) {
    for (const sp of this.sprites) {
      const [u, v] = blender.wind(sp.lon, sp.lat);
      if (Math.hypot(u, v) < 0.5) continue;
      // Screen Y grows southward, so negate v to get a screen-space angle.
      sp.windAngle = Math.atan2(-v, u);
    }
  }

  clear() {
    this.sprites = [];
    this.clusters.clear();
  }
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
