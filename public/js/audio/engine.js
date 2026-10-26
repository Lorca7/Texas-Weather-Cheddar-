/**
 * The ambient score.
 *
 * Six voices, all parameterised by the live weather, summing through a
 * generated-impulse reverb into a soft limiter:
 *
 *   drone    three detuned oscillators; root from temperature, detune from
 *            barometric pressure, filter from cloud cover
 *   pad      slow chord voicings; thickness from humidity, dissonance from
 *            the frontal temperature gradient
 *   wind     band-passed noise; centre frequency and level from wind speed,
 *            stereo position from wind direction, swells on gusts
 *   rain     granular noise bursts; density from radar coverage, brightness
 *            from rain rate
 *   thunder  low sweep plus noise body; probability from storm-cell count
 *            and NWS alert severity
 *   bells    generative FM voice picking notes from the active mode
 *
 * Everything is scheduled with a lookahead so timing does not depend on the
 * render loop, which matters when the visual engine is busy.
 */
import { weatherToMusic, degreeToMidi, chordMidi, midiToFreq } from './scales.js';

const LOOKAHEAD_SEC = 0.35;
const TICK_MS = 90;

export class AmbientEngine {
  constructor({ show } = {}) {
    this.show = show;
    this.ctx = null;
    this.music = weatherToMusic({}, show?.audio || {});
    this.started = false;
    this.nextBell = 0;
    this.nextPad = 0;
    this.nextRain = 0;
    this.nextThunderCheck = 0;
    this.lastThunder = -999;
    this.padDegree = 0;
    this.events = { bells: 0, grains: 0, thunder: 0, chords: 0 };
    this._tick = null;
  }

  /* ---------- lifecycle ---------- */

  async start() {
    if (this.started) return this;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('Web Audio is not available in this browser');
    const ctx = new Ctx({ latencyHint: 'interactive', sampleRate: 48000 });
    this.ctx = ctx;
    // Autoplay policy: a context created before a gesture starts suspended.
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

    this._buildGraph();
    this._startDrone();
    this.started = true;

    const t = ctx.currentTime;
    this.nextPad = t + 0.5;
    this.nextBell = t + 1.5;
    this.nextRain = t + 0.2;
    this.nextThunderCheck = t + 4;

    this._tick = setInterval(() => this._schedule(), TICK_MS);
    this.update(this._lastSummary || {});
    return this;
  }

  async resume() {
    if (this.ctx?.state === 'suspended') await this.ctx.resume().catch(() => {});
    return this.ctx?.state;
  }

  stop() {
    if (this._tick) clearInterval(this._tick);
    this._tick = null;
    this.started = false;
    try {
      this.drone?.oscs.forEach((o) => o.stop());
      this.windNoise?.stop();
    } catch {
      /* already stopped */
    }
    const ctx = this.ctx;
    this.ctx = null;
    return ctx?.close?.();
  }

  /** The audio side of the broadcast stream. */
  get stream() {
    return this.streamDest?.stream || null;
  }

  /* ---------- graph ---------- */

  _buildGraph() {
    const ctx = this.ctx;
    const a = this.show.audio;

    // Master: gentle limiting so a thunderclap cannot clip the stream.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.004;
    this.limiter.release.value = 0.25;

    this.master = ctx.createGain();
    this.master.gain.value = a.master;

    this.limiter.connect(this.master);
    this.master.connect(ctx.destination);

    // A second destination so the broadcast captures the identical mix.
    this.streamDest = ctx.createMediaStreamDestination();
    this.master.connect(this.streamDest);

    // Reverb: a generated impulse response, so there is no asset to ship.
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = makeImpulse(ctx, 4.6, 2.4);
    this.wet = ctx.createGain();
    this.wet.gain.value = a.reverb;
    this.convolver.connect(this.wet);
    this.wet.connect(this.limiter);

    // Per-voice buses, each with its own dry path and reverb send.
    this.bus = {};
    for (const name of ['drone', 'pad', 'wind', 'rain', 'thunder', 'bells']) {
      const g = ctx.createGain();
      g.gain.value = a[name] ?? 0.5;
      const send = ctx.createGain();
      // Percussive voices get more reverb; the drone needs little.
      send.gain.value = name === 'drone' ? 0.25 : name === 'thunder' ? 0.8 : 0.55;
      g.connect(this.limiter);
      g.connect(send);
      send.connect(this.convolver);
      this.bus[name] = g;
    }

    this.noiseBuffer = makeNoise(ctx, 3);
  }

  /** The drone runs continuously; only its parameters move. */
  _startDrone() {
    const ctx = this.ctx;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    filter.Q.value = 0.8;

    const sum = ctx.createGain();
    sum.gain.value = 0.26;

    const oscs = [];
    const gains = [];
    // Root, fifth, and an octave below: a stable bed, not a chord.
    for (const [ratioSemitones, level, type] of [
      [0, 1, 'sawtooth'],
      [7, 0.55, 'triangle'],
      [-12, 0.7, 'sine'],
    ]) {
      const o = ctx.createOscillator();
      o.type = type;
      const g = ctx.createGain();
      g.gain.value = level;
      o.connect(g);
      g.connect(sum);
      o.start();
      o.__semitones = ratioSemitones;
      oscs.push(o);
      gains.push(g);
    }

    // Slow amplitude breathing keeps the bed from feeling static.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.045;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.07;
    lfo.connect(lfoGain);
    lfoGain.connect(sum.gain);
    lfo.start();

    sum.connect(filter);
    filter.connect(this.bus.drone);
    this.drone = { oscs, gains, filter, sum, lfo };
    this._startWind();
  }

  _startWind() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 480;
    band.Q.value = 0.9;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 160;

    const gain = ctx.createGain();
    gain.gain.value = 0.0001;

    const pan = ctx.createStereoPanner();
    pan.pan.value = 0;

    src.connect(band);
    band.connect(hp);
    hp.connect(gain);
    gain.connect(pan);
    pan.connect(this.bus.wind);
    src.start();

    this.windNoise = src;
    this.wind = { band, hp, gain, pan };
  }

  /* ---------- weather -> parameters ---------- */

  setShow(show) {
    this.show = show;
    if (!this.started) return;
    const a = show.audio;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(a.master, t, 0.1);
    this.wet.gain.setTargetAtTime(a.reverb, t, 0.2);
    for (const name of Object.keys(this.bus)) {
      this.bus[name].gain.setTargetAtTime(a[name] ?? 0.5, t, 0.15);
    }
    // A changed scale setting should take effect on the next chord.
    this.update(this._lastSummary || {});
  }

  /**
   * Retarget every continuous parameter from a new WeatherFrame summary.
   * Called whenever a frame arrives; glides rather than jumps.
   */
  update(summary, windVector = null) {
    this._lastSummary = summary;
    this.music = weatherToMusic(summary, this.show.audio);
    if (!this.started) return this.music;

    const ctx = this.ctx;
    const t = ctx.currentTime;
    const m = this.music;
    const glide = 6; // seconds; weather does not lurch, so neither does the score

    // --- drone ---
    const rootF = midiToFreq(m.rootMidi);
    for (const o of this.drone.oscs) {
      o.frequency.setTargetAtTime(rootF * 2 ** (o.__semitones / 12), t, glide);
      o.detune.setTargetAtTime(m.detuneCents * (o.__semitones === 7 ? -1 : 1), t, glide);
    }
    this.drone.filter.frequency.setTargetAtTime(220 + m.brightness * 2400, t, glide);
    this.drone.filter.Q.setTargetAtTime(0.7 + m.tension * 3.2, t, glide);

    // --- wind ---
    const d = m.drive;
    this.wind.band.frequency.setTargetAtTime(320 + d.wind * 1500, t, 3);
    this.wind.band.Q.setTargetAtTime(0.6 + d.gust * 2.4, t, 3);
    this.wind.gain.gain.setTargetAtTime(0.004 + d.wind * 0.5, t, 3);
    if (windVector) {
      // Stereo image follows the wind: westerly flow sits left-of-centre.
      const [u] = windVector;
      this.wind.pan.pan.setTargetAtTime(Math.max(-0.85, Math.min(0.85, u / 30)), t, 4);
    }

    return m;
  }

  /* ---------- scheduler ---------- */

  _schedule() {
    if (!this.started || !this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const until = now + LOOKAHEAD_SEC;
    const m = this.music;
    const d = m.drive;

    // --- pad chords ---
    while (this.nextPad < until) {
      const at = Math.max(this.nextPad, now);
      this._chord(at, m);
      // Chord length scales with the pulse but stays slow and ambient.
      this.nextPad = at + m.eventIntervalSec * 2.6 + Math.random() * 2;
    }

    // --- bells ---
    while (this.nextBell < until) {
      const at = Math.max(this.nextBell, now);
      if (Math.random() < d.bells) this._bell(at, m);
      this.nextBell = at + m.eventIntervalSec * (0.5 + Math.random());
    }

    // --- rain grains ---
    if (d.rain > 0.004) {
      const grainsPerSec = 2 + d.rain * 90;
      while (this.nextRain < until) {
        const at = Math.max(this.nextRain, now);
        this._grain(at, d);
        this.nextRain = at + 1 / grainsPerSec * (0.6 + Math.random() * 0.8);
      }
    } else {
      this.nextRain = Math.max(this.nextRain, now);
    }

    // --- thunder ---
    if (this.nextThunderCheck < until) {
      const at = Math.max(this.nextThunderCheck, now);
      // Checked every few seconds; probability derives from storm cells.
      if (d.thunder > 0.02 && at - this.lastThunder > 6 && Math.random() < d.thunder * 0.42) {
        this._thunder(at, d);
        this.lastThunder = at;
      }
      this.nextThunderCheck = at + 3.5 + Math.random() * 3;
    }
  }

  /* ---------- voices ---------- */

  _chord(at, m) {
    const ctx = this.ctx;
    // Voice-lead by small steps so the harmony wanders rather than jumps.
    const step = [-2, -1, 0, 1, 2][Math.floor(Math.random() * 5)];
    this.padDegree = ((this.padDegree + step) % 7 + 7) % 7;
    const notes = chordMidi(m.rootMidi + 24, m.degrees, this.padDegree, m.voices);

    // A front adds a neighbouring tone — the dissonance you can hear.
    if (m.tension > 0.45 && Math.random() < m.tension) {
      notes.push(degreeToMidi(m.rootMidi + 24, m.degrees, this.padDegree + 1));
    }

    const dur = m.eventIntervalSec * 3.1;
    const bus = this.bus.pad;

    for (const n of notes) {
      const o = ctx.createOscillator();
      o.type = Math.random() < 0.5 ? 'triangle' : 'sine';
      o.frequency.value = midiToFreq(n);
      o.detune.value = (Math.random() - 0.5) * 12 * m.padSpread;

      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 500 + m.brightness * 3200;

      const g = ctx.createGain();
      const peak = (0.1 / Math.sqrt(notes.length)) * m.drive.pad;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(peak, at + dur * 0.4);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);

      o.connect(f);
      f.connect(g);
      g.connect(bus);
      o.start(at);
      o.stop(at + dur + 0.1);
    }
    this.events.chords++;
  }

  _bell(at, m) {
    const ctx = this.ctx;
    // Pick from the mode, favouring the upper register in warm air.
    const degree = Math.floor(Math.random() * 7) + (m.warmth > 0.6 ? 7 : 0);
    const note = degreeToMidi(m.rootMidi + 36, m.degrees, degree);
    const freq = midiToFreq(note);

    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = freq;

    // FM index rides tension: calm air is a pure bell, a front makes it metallic.
    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = freq * (m.tension > 0.5 ? 2.41 : 2);
    const modGain = ctx.createGain();
    modGain.gain.value = freq * (0.3 + m.tension * 2.2);
    mod.connect(modGain);
    modGain.connect(carrier.frequency);

    const g = ctx.createGain();
    const decay = 1.6 + Math.random() * 2.4;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.14, at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + decay);

    const pan = ctx.createStereoPanner();
    pan.pan.value = (Math.random() - 0.5) * 1.4;

    carrier.connect(g);
    g.connect(pan);
    pan.connect(this.bus.bells);
    carrier.start(at);
    mod.start(at);
    carrier.stop(at + decay + 0.1);
    mod.stop(at + decay + 0.1);
    this.events.bells++;
  }

  _grain(at, d) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const offset = Math.random() * (this.noiseBuffer.duration - 0.1);
    const dur = 0.012 + Math.random() * 0.05;

    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    // Heavier rain is brighter and spikier.
    f.frequency.value = 900 + Math.random() * (2200 + d.rainBrightness * 6000);
    f.Q.value = 1.2 + Math.random() * 3;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.02 + d.rainBrightness * 0.05, at + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);

    const pan = ctx.createStereoPanner();
    pan.pan.value = (Math.random() - 0.5) * 1.8;

    src.connect(f);
    f.connect(g);
    g.connect(pan);
    pan.connect(this.bus.rain);
    src.start(at, offset, dur + 0.02);
    this.events.grains++;
  }

  _thunder(at, d) {
    const ctx = this.ctx;
    const intensity = 0.4 + d.thunder * 0.6;

    // Body: filtered noise with a long tail.
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = 0.35 + Math.random() * 0.3;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, at);
    lp.frequency.exponentialRampToValueAtTime(90, at + 2.6);
    lp.Q.value = 1.4;

    const g = ctx.createGain();
    const dur = 2.4 + Math.random() * 2.6;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.5 * intensity, at + 0.05);
    g.gain.exponentialRampToValueAtTime(0.14 * intensity, at + 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);

    src.connect(lp);
    lp.connect(g);
    g.connect(this.bus.thunder);
    src.start(at, Math.random() * 1.5, dur + 0.2);

    // Sub: the pressure wave you feel more than hear.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(62, at);
    sub.frequency.exponentialRampToValueAtTime(24, at + dur * 0.8);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, at);
    sg.gain.exponentialRampToValueAtTime(0.3 * intensity, at + 0.08);
    sg.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    sub.connect(sg);
    sg.connect(this.bus.thunder);
    sub.start(at);
    sub.stop(at + dur + 0.1);

    this.events.thunder++;
  }

  stats() {
    return {
      state: this.ctx?.state ?? 'closed',
      sampleRate: this.ctx?.sampleRate ?? null,
      key: `${this.music.rootName} ${this.music.mode}`,
      tension: Number(this.music.tension.toFixed(2)),
      brightness: Number(this.music.brightness.toFixed(2)),
      intervalSec: Number(this.music.eventIntervalSec.toFixed(2)),
      voices: this.music.voices,
      events: { ...this.events },
      drive: Object.fromEntries(
        Object.entries(this.music.drive).map(([k, v]) => [k, Number(v.toFixed(2))])
      ),
    };
  }
}

/* ---------- buffer helpers ------------------------------------------------ */

/** Stereo noise buffer, reused by the wind, rain and thunder voices. */
function makeNoise(ctx, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    // Lightly integrated white noise: closer to pink, easier on the ears.
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5 + white * 0.4;
    }
  }
  return buf;
}

/**
 * Exponentially-decaying noise as a reverb impulse. Cheap, and it gives the
 * big slow hall this piece wants without shipping an audio file.
 */
function makeImpulse(ctx, seconds, decay) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // A short pre-delay keeps the direct sound distinct from the tail.
      const pre = t < 0.012 ? t / 0.012 : 1;
      data[i] = (Math.random() * 2 - 1) * (1 - t) ** decay * pre;
    }
  }
  return buf;
}
