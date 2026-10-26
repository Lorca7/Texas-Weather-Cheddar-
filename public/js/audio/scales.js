/**
 * The mapping from weather to musical material.
 *
 * The rules are deliberately legible, so that what you hear is readable back
 * to what the sky is doing:
 *
 *   temperature      -> root pitch (cool = low, hot = high) and register
 *   temperature      -> mode brightness (cold = phrygian/aeolian, hot = lydian)
 *   pressure         -> tuning drift; deep lows detune the drone
 *   humidity         -> pad density (muggy air = thicker voicing)
 *   cloud cover      -> filter darkness
 *   wind speed       -> event rate, and the wind voice's register
 *   frontal gradient -> dissonance (a front puts a second/tritone in the pad)
 *   precipitation    -> rain granulation density
 *   storm cells      -> thunder probability
 */

export const MODES = {
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  minorPentatonic: [0, 3, 5, 7, 10],
  pentatonic: [0, 2, 4, 7, 9],
};

/** Coldest to warmest. 'auto' walks this list by temperature. */
export const MODE_BY_WARMTH = ['phrygian', 'aeolian', 'dorian', 'mixolydian', 'lydian'];

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Equal temperament, A4 = 440. */
export const midiToFreq = (m) => 440 * 2 ** ((m - 69) / 12);

export function noteNameToPitchClass(name) {
  const i = NOTE_NAMES.indexOf(String(name).toUpperCase().replace('B#', 'C'));
  return i === -1 ? 2 : i;
}

/**
 * Roots ordered around the circle of fifths, so a slow temperature change
 * moves the key to a neighbouring one instead of lurching a tritone.
 */
const ROOT_WALK = [2, 9, 4, 11, 6, 1, 8, 3, 10, 5, 0, 7]; // D A E B F# C# G# D# A# F C G

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Derive the full musical state from a WeatherFrame summary.
 *
 * @param {object} summary  frame.summary
 * @param {object} cfg      show.audio
 */
export function weatherToMusic(summary = {}, cfg = {}) {
  const meanTemp = summary.tempC?.mean ?? 18;
  const spread = summary.tempC?.spread ?? 8;
  const windMean = summary.windKt?.mean ?? 8;
  const gustMax = summary.gustKt?.max ?? windMean;
  const pressure = summary.pressureHpa?.mean ?? 1013;
  const rh = summary.rh?.mean ?? 50;
  const cloud = clamp01(summary.cloudMean ?? 0.3);
  const precipCover = clamp01(summary.precipCoverage ?? 0);
  const precipMax = clamp01(summary.precipMax ?? 0);
  const storms = summary.stormCells ?? 0;
  const front = summary.frontalGradient ?? 0;
  const alert = clamp01(summary.alertLevel ?? 0);

  // --- warmth 0..1 over the range Texas actually occupies -----------------
  const warmth = clamp01((meanTemp + 5) / 45);

  // --- mode ---------------------------------------------------------------
  let mode = cfg.scaleMode && cfg.scaleMode !== 'auto' ? cfg.scaleMode : null;
  if (!mode) {
    const idx = Math.round(warmth * (MODE_BY_WARMTH.length - 1));
    mode = MODE_BY_WARMTH[clamp(idx, 0, MODE_BY_WARMTH.length - 1)];
    // Heavy weather overrides brightness: a squall line is not lydian.
    if (alert > 0.6 || precipCover > 0.35) mode = warmth > 0.6 ? 'dorian' : 'aeolian';
    if (storms > 12 && alert > 0.7) mode = 'phrygian';
  }
  const degrees = MODES[mode] || MODES.aeolian;

  // --- root ---------------------------------------------------------------
  let pitchClass;
  if (cfg.rootMode === 'fixed') {
    pitchClass = noteNameToPitchClass(cfg.rootNote || 'D');
  } else {
    pitchClass = ROOT_WALK[clamp(Math.floor(warmth * ROOT_WALK.length), 0, ROOT_WALK.length - 1)];
  }
  // Cool air sits the drone an octave down; heat lifts it.
  const octave = warmth < 0.3 ? 1 : warmth < 0.7 ? 2 : 2;
  const rootMidi = 12 * (octave + 1) + pitchClass; // MIDI 24..47-ish

  // --- tension / dissonance ----------------------------------------------
  // A sharp temperature gradient across the state is a front: let it bite.
  const tension = clamp01(front * 1.9 + alert * 0.45 + clamp01(spread / 28) * 0.35);

  // --- brightness (filter openness) --------------------------------------
  const brightness = clamp01(0.82 - cloud * 0.55 + warmth * 0.22);

  // --- rhythm -------------------------------------------------------------
  // Wind sets the pulse: dead calm is one event every ~9s, a 40kt gale ~1.3s.
  const windNorm = clamp01(windMean / 38);
  const eventIntervalSec = lerp(9, 1.3, windNorm) / clamp(cfg.tempoBias || 1, 0.25, 4);

  // --- pad voicing --------------------------------------------------------
  const voices = 2 + Math.round(clamp01((rh - 25) / 60) * 3); // 2..5 notes
  const padSpread = lerp(0.3, 1, clamp01(spread / 25));

  // --- low pressure detunes the drone ------------------------------------
  const pressureDev = clamp((1013 - pressure) / 30, -1, 1.5);
  const detuneCents = pressureDev * 22 + tension * 14;

  return {
    mode,
    degrees,
    rootMidi,
    rootName: NOTE_NAMES[pitchClass],
    warmth,
    brightness,
    tension,
    detuneCents,
    voices,
    padSpread,
    eventIntervalSec,
    // Voice drive levels, before the operator's own mixer settings.
    drive: {
      wind: clamp01(windNorm * 1.15),
      gust: clamp01((gustMax - windMean) / 22),
      rain: clamp01(precipCover * 3.2),
      rainBrightness: clamp01(precipMax),
      thunder: clamp01(storms / 14) * (0.45 + alert * 0.55),
      bells: clamp01(0.25 + cloud * 0.5),
      pad: clamp01(0.4 + rh / 200),
    },
    readout: {
      meanTempC: Number(meanTemp.toFixed(1)),
      windMeanKt: Number(windMean.toFixed(1)),
      pressureHpa: Number(pressure.toFixed(1)),
      cloud: Number(cloud.toFixed(2)),
      storms,
    },
  };
}

/**
 * MIDI note for a scale degree, where degree may exceed the scale length and
 * wraps into higher octaves.
 */
export function degreeToMidi(rootMidi, degrees, degree) {
  const n = degrees.length;
  const oct = Math.floor(degree / n);
  const idx = ((degree % n) + n) % n;
  return rootMidi + degrees[idx] + 12 * oct;
}

/** A stacked voicing on a degree, in scale steps of two. */
export function chordMidi(rootMidi, degrees, degree, voices = 3) {
  const out = [];
  for (let i = 0; i < voices; i++) out.push(degreeToMidi(rootMidi, degrees, degree + i * 2));
  return out;
}
