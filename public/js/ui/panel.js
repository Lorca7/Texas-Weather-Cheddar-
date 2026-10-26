/**
 * The operator console.
 *
 * Every control writes straight into the live scene and is debounced back to
 * the server, so the show survives a restart and the headless encoder renders
 * exactly what the operator tuned.
 */
import { TEXTURE_TYPES } from '../visual/textures.js';
import { CHANNEL_LIST } from '../visual/particles.js';

const BLENDS = [
  'source-over', 'screen', 'lighter', 'multiply', 'overlay',
  'soft-light', 'hard-light', 'difference', 'exclusion', 'hue', 'luminosity',
];
const ROTATIONS = ['none', 'drift', 'spin', 'align-wind'];
const MASKS = ['none', 'circle', 'soft', 'blob'];
const SCALE_MODES = ['auto', 'phrygian', 'aeolian', 'dorian', 'mixolydian', 'lydian', 'pentatonic', 'minorPentatonic'];
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FONTS = ['condensed', 'sans', 'mono', 'serif'];

/* ---------- tiny DOM helpers --------------------------------------------- */

const el = (tag, attrs = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const kid of [].concat(kids)) if (kid) n.append(kid);
  return n;
};

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o ?? {})[k], obj);

function nest(path, value) {
  const keys = path.split('.');
  const out = {};
  let cur = out;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) cur[k] = value;
    else cur = cur[k] = {};
  });
  return out;
}

function deepMerge(a, b) {
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      a[k] = deepMerge(a[k] && typeof a[k] === 'object' ? a[k] : {}, v);
    } else {
      a[k] = v;
    }
  }
  return a;
}

export class ControlPanel {
  constructor({ app, root }) {
    this.app = app;
    this.root = root;
    this.pending = {};
    this.flushTimer = null;
    this.open_ = false;
    this.streamStatusTimer = null;
  }

  /* ---------- show plumbing ---------- */

  /** Set a show value: live immediately, persisted shortly after. */
  set(path, value) {
    const keys = path.split('.');
    let cur = this.app.show;
    for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]];
    cur[keys[keys.length - 1]] = value;

    this.app.engine.setShow(this.app.show);
    this.app.audio?.setShow(this.app.show);

    deepMerge(this.pending, nest(path, value));
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), 350);
  }

  async flush() {
    const body = this.pending;
    this.pending = {};
    if (!Object.keys(body).length) return;
    try {
      const { show } = await this.app.getJson('/api/show', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      this.app.show = show;
      this.app.engine.setShow(show);
      this.app.audio?.setShow(show);
    } catch (err) {
      this.app.banner(`could not save show settings: ${err.message}`, 'warn');
    }
  }

  /* ---------- control factories ---------- */

  slider(label, path, { min = 0, max = 1, step = 0.01, format } = {}) {
    const value = getPath(this.app.show, path);
    const out = el('span', { class: 'ctl__val', text: fmt(value, format) });
    const input = el('input', {
      type: 'range', min, max, step, value,
      oninput: (e) => {
        const v = Number(e.target.value);
        out.textContent = fmt(v, format);
        this.set(path, v);
      },
    });
    return el('label', { class: 'ctl' }, [el('span', { class: 'ctl__label', text: label }), input, out]);
  }

  colour(label, path) {
    const value = getPath(this.app.show, path);
    const input = el('input', {
      type: 'color', value,
      oninput: (e) => this.set(path, e.target.value),
    });
    return el('label', { class: 'ctl ctl--colour' }, [
      el('span', { class: 'ctl__label', text: label }),
      input,
    ]);
  }

  toggle(label, path) {
    const input = el('input', {
      type: 'checkbox',
      oninput: (e) => this.set(path, e.target.checked),
    });
    input.checked = !!getPath(this.app.show, path);
    return el('label', { class: 'ctl ctl--toggle' }, [
      input,
      el('span', { class: 'ctl__label', text: label }),
    ]);
  }

  select(label, path, options) {
    const value = getPath(this.app.show, path);
    const sel = el('select', { oninput: (e) => this.set(path, e.target.value) },
      options.map((o) => {
        const opt = el('option', { value: o, text: o });
        if (o === value) opt.selected = true;
        return opt;
      })
    );
    return el('label', { class: 'ctl' }, [el('span', { class: 'ctl__label', text: label }), sel]);
  }

  textField(label, path, { placeholder = '' } = {}) {
    const input = el('input', {
      type: 'text', value: getPath(this.app.show, path) ?? '', placeholder,
      oninput: (e) => this.set(path, e.target.value),
    });
    return el('label', { class: 'ctl ctl--text' }, [
      el('span', { class: 'ctl__label', text: label }),
      input,
    ]);
  }

  section(title, kids, { collapsed = true } = {}) {
    const body = el('div', { class: 'sect__body' }, kids);
    const head = el('button', {
      class: 'sect__head', type: 'button',
      onclick: () => {
        const on = sect.classList.toggle('sect--open');
        head.setAttribute('aria-expanded', String(on));
      },
    }, [el('span', { text: title }), el('span', { class: 'sect__chev', text: '▾' })]);
    const sect = el('div', { class: `sect${collapsed ? '' : ' sect--open'}` }, [head, body]);
    head.setAttribute('aria-expanded', String(!collapsed));
    return sect;
  }

  /* ---------- build ---------- */

  async init() {
    this.root.innerHTML = '';
    this.root.append(
      el('div', { class: 'panel__head' }, [
        el('strong', { text: 'CONSOLE' }),
        el('button', { class: 'panel__close', type: 'button', text: '×', onclick: () => this.close() }),
      ]),
      el('div', { class: 'panel__scroll' }, [
        this.sourceSection(),
        this.mapSection(),
        this.mediaSection(),
        this.channelSection(),
        this.motionSection(),
        this.audioSection(),
        this.overlaySection(),
        this.streamSection(),
      ])
    );
    this.app.pool.addEventListener('change', () => this.renderMediaList());
    this.app.pool.addEventListener('ready', () => this.renderMediaList());
    this.renderMediaList();
    await this.refreshWeatherStatus();
    return this;
  }

  /* --- source --- */

  sourceSection() {
    this.sourceInfo = el('pre', { class: 'readout', text: 'loading…' });
    const modes = ['auto', 'nws', 'synthetic'];
    const sel = el('select', {
      oninput: async (e) => {
        try {
          await this.app.getJson('/api/weather/source', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: e.target.value }),
          });
          this.app.banner(`weather source set to ${e.target.value}`, 'info');
          await this.refreshWeatherStatus();
        } catch (err) {
          this.app.banner(`could not change source: ${err.message}`, 'error');
        }
      },
    }, modes.map((m) => el('option', { value: m, text: m })));
    this.sourceSelect = sel;

    return this.section('Weather source', [
      el('p', { class: 'hint', text: 'auto = live NOAA, falling back to the model if NOAA is unreachable. nws = live only, never simulated. synthetic = rehearsal.' }),
      el('label', { class: 'ctl' }, [el('span', { class: 'ctl__label', text: 'mode' }), sel]),
      el('div', { class: 'btnrow' }, [
        el('button', {
          type: 'button', class: 'btn', text: 'Refresh now',
          onclick: async () => {
            try {
              await this.app.getJson('/api/weather/refresh', { method: 'POST' });
              await this.refreshWeatherStatus();
            } catch (err) {
              this.app.banner(`refresh failed: ${err.message}`, 'error');
            }
          },
        }),
      ]),
      this.sourceInfo,
    ], { collapsed: false });
  }

  async refreshWeatherStatus() {
    try {
      const s = await this.app.getJson('/api/weather/status');
      if (this.sourceSelect) this.sourceSelect.value = s.mode;
      const f = s.frame;
      this.sourceInfo.textContent = [
        `mode        ${s.mode}`,
        `stations    ${s.stationCount} (${s.stationsFrom})`,
        `radar       ${s.radarEnabled ? (s.health.lastRadarOk ? `ok ${s.health.lastRadarOk}` : `unavailable`) : 'disabled'}`,
        s.health.lastRadarError ? `  radar err  ${s.health.lastRadarError}` : null,
        `obs ok      ${s.health.lastObsOk ?? 'never'}`,
        s.health.lastObsError ? `  obs err    ${s.health.lastObsError}` : null,
        f ? `frame       ${f.source}${f.stale ? ' (STALE)' : ''}` : 'frame       none',
        f?.notes?.length ? `notes       ${f.notes.join('\n            ')}` : null,
        f ? `temp        ${f.summary.tempC.min}…${f.summary.tempC.max} C` : null,
        f ? `wind mean   ${f.summary.windKt.mean} kt` : null,
        f ? `rain cover  ${(f.summary.precipCoverage * 100).toFixed(1)}%` : null,
        f ? `storm cells ${f.summary.stormCells}` : null,
        f ? `alerts      ${f.summary.alertCount}` : null,
      ].filter(Boolean).join('\n');
    } catch (err) {
      this.sourceInfo.textContent = `status unavailable: ${err.message}`;
    }
  }

  onFrame() {
    if (this.open_) this.refreshWeatherStatus();
  }

  /* --- map --- */

  mapSection() {
    const textureImages = () => {
      const opts = ['(none)'];
      for (const e of this.app.pool.entries.values()) {
        if (e.item.kind === 'image' || (e.item.kind === 'remote' && e.item.mediaKind === 'image')) {
          opts.push(e.item.label);
        }
      }
      return opts;
    };

    const texSel = el('select', {
      oninput: (e) => {
        const label = e.target.value;
        if (label === '(none)') return this.set('map.texture.imageId', null);
        const found = [...this.app.pool.entries.values()].find((x) => x.item.label === label);
        this.set('map.texture.imageId', found?.item.id ?? null);
      },
    }, textureImages().map((o) => el('option', { value: o, text: o })));
    this.textureImageSelect = texSel;

    return this.section('Map colour & texture', [
      el('div', { class: 'grid2' }, [
        this.colour('background', 'map.background'),
        this.colour('land', 'map.land'),
        this.colour('land shadow', 'map.landAlt'),
        this.colour('outline', 'map.outline'),
        this.colour('counties', 'map.counties'),
        this.colour('glow', 'map.glow'),
        this.colour('ink / labels', 'map.ink'),
        this.colour('cold', 'map.tempCold'),
        this.colour('hot', 'map.tempHot'),
      ]),
      this.slider('temperature shading', 'map.tempShading'),
      this.toggle('county lines', 'map.countyLines'),
      this.slider('county line width', 'map.countyLineWidth', { min: 0.1, max: 3, step: 0.05 }),
      this.slider('outline width', 'map.outlineWidth', { min: 0.2, max: 10, step: 0.1 }),
      this.slider('outline glow', 'map.glowStrength'),
      el('hr'),
      this.select('texture', 'map.texture.type', [...TEXTURE_TYPES, 'image']),
      el('label', { class: 'ctl' }, [el('span', { class: 'ctl__label', text: 'texture image' }), texSel]),
      this.slider('texture scale', 'map.texture.scale', { min: 0.05, max: 8, step: 0.05 }),
      this.slider('texture strength', 'map.texture.strength'),
      this.slider('texture rotate', 'map.texture.rotate', { min: 0, max: 180, step: 1, format: 'deg' }),
      el('hr'),
      this.slider('vignette', 'map.vignette'),
      this.slider('film grain', 'map.grain'),
      this.slider('bloom', 'map.bloom'),
    ]);
  }

  /* --- media --- */

  mediaSection() {
    const fileInput = el('input', {
      type: 'file', multiple: 'multiple',
      accept: 'image/*,video/*',
      onchange: (e) => this.uploadFiles(e.target.files),
    });

    const urlInput = el('input', { type: 'url', placeholder: 'https://example.com/live-still.jpg' });
    const kindSel = el('select', {}, ['image', 'video'].map((k) => el('option', { value: k, text: k })));
    const refreshInput = el('input', { type: 'number', value: '15', min: '2', max: '600' });

    this.mediaList = el('div', { class: 'medialist' });
    this.dropZone = el('div', { class: 'drop', text: 'drop images or clips here' });
    this.dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.dropZone.classList.add('drop--over');
    });
    this.dropZone.addEventListener('dragleave', () => this.dropZone.classList.remove('drop--over'));
    this.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      this.dropZone.classList.remove('drop--over');
      this.uploadFiles(e.dataTransfer.files);
    });

    return this.section('Visual content', [
      el('p', { class: 'hint', text: 'Assign each item to the weather channels it should stand in for. A clip tagged "rain" is drawn wherever radar shows rain.' }),
      this.dropZone,
      fileInput,
      el('hr'),
      el('div', { class: 'ctl ctl--text' }, [
        el('span', { class: 'ctl__label', text: 'remote source' }), urlInput,
      ]),
      el('div', { class: 'grid2' }, [
        el('label', { class: 'ctl' }, [el('span', { class: 'ctl__label', text: 'kind' }), kindSel]),
        el('label', { class: 'ctl' }, [el('span', { class: 'ctl__label', text: 'refresh (s)' }), refreshInput]),
      ]),
      el('div', { class: 'btnrow' }, [
        el('button', {
          type: 'button', class: 'btn', text: 'Add remote source',
          onclick: async () => {
            if (!urlInput.value.trim()) return;
            try {
              await this.app.getJson('/api/media/remote', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  source: urlInput.value.trim(),
                  mediaKind: kindSel.value,
                  refreshMs: Number(refreshInput.value) * 1000,
                  channels: ['cloud'],
                }),
              });
              urlInput.value = '';
              await this.app.pool.load();
              this.app.banner('remote source added', 'info');
            } catch (err) {
              this.app.banner(`remote source rejected: ${err.message}`, 'error');
            }
          },
        }),
        el('button', {
          type: 'button', class: 'btn', text: 'Add camera',
          onclick: () => this.addLive('camera'),
        }),
        el('button', {
          type: 'button', class: 'btn', text: 'Add screen',
          onclick: () => this.addLive('screen'),
        }),
      ]),
      el('hr'),
      this.mediaList,
    ]);
  }

  async addLive(type) {
    try {
      await this.app.pool.addLiveSource({ type, channels: ['cloud'] });
      this.app.banner(`${type} added as a live source (this browser only)`, 'info');
    } catch (err) {
      this.app.banner(`could not add ${type}: ${err.message}`, 'error');
    }
  }

  async uploadFiles(files) {
    if (!files?.length) return;
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    fd.append('channels', 'cloud');
    this.app.banner(`uploading ${files.length} file(s)…`, 'info', 3000);
    try {
      const { added } = await this.app.getJson('/api/media/upload', { method: 'POST', body: fd });
      await this.app.pool.load();
      this.app.banner(`added ${added.length} item(s) — now assign their channels`, 'info');
    } catch (err) {
      this.app.banner(`upload failed: ${err.message}`, 'error');
    }
  }

  renderMediaList() {
    if (!this.mediaList) return;
    this.mediaList.innerHTML = '';
    const items = [...this.app.pool.entries.values()];
    if (!items.length) {
      this.mediaList.append(el('p', { class: 'hint', text: 'No visual content yet. Until you add some, the map renders bare.' }));
      return;
    }

    for (const entry of items) {
      const item = entry.item;
      const r = item.render || {};

      const chans = el('div', { class: 'chips' }, CHANNEL_LIST.map((c) => {
        const on = item.channels?.includes(c);
        return el('button', {
          type: 'button',
          class: `chip${on ? ' chip--on' : ''}`,
          text: c,
          onclick: async (e) => {
            const next = new Set(item.channels || []);
            if (next.has(c)) next.delete(c);
            else next.add(c);
            const list = [...next];
            this.app.pool.setChannels(item.id, list);
            e.target.classList.toggle('chip--on');
            if (item.kind !== 'live') {
              try {
                await this.app.getJson(`/api/media/${item.id}`, {
                  method: 'PATCH',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ channels: list }),
                });
              } catch (err) {
                this.app.banner(`could not save channels: ${err.message}`, 'warn');
              }
            }
          },
        });
      }));

      const renderCtl = (label, key, attrs, transform = Number) => {
        const input = el('input', {
          ...attrs,
          value: r[key] ?? attrs.value,
          oninput: (e) => this.patchRender(item, { [key]: transform(e.target.value) }),
        });
        return el('label', { class: 'ctl ctl--tight' }, [
          el('span', { class: 'ctl__label', text: label }), input,
        ]);
      };

      const renderSel = (label, key, options) => {
        const sel = el('select', {
          oninput: (e) => this.patchRender(item, { [key]: e.target.value }),
        }, options.map((o) => {
          const opt = el('option', { value: o, text: o });
          if ((r[key] ?? options[0]) === o) opt.selected = true;
          return opt;
        }));
        return el('label', { class: 'ctl ctl--tight' }, [
          el('span', { class: 'ctl__label', text: label }), sel,
        ]);
      };

      const thumb = el('div', { class: 'thumb' });
      if (entry.ready && entry.el) {
        if (entry.el instanceof HTMLVideoElement) {
          thumb.append(el('span', { class: 'thumb__tag', text: item.kind === 'live' ? 'LIVE' : 'CLIP' }));
          thumb.style.background = '#111';
        } else {
          thumb.style.backgroundImage = `url("${entry.el.src}")`;
        }
      } else if (entry.error) {
        thumb.append(el('span', { class: 'thumb__tag', text: 'ERR' }));
      }

      this.mediaList.append(
        el('div', { class: 'mediaitem' }, [
          el('div', { class: 'mediaitem__top' }, [
            thumb,
            el('div', { class: 'mediaitem__meta' }, [
              el('strong', { text: item.label }),
              el('small', { text: `${item.kind}${item.mediaKind ? `/${item.mediaKind}` : ''}${entry.ready ? '' : ' · loading'}` }),
            ]),
            el('button', {
              type: 'button', class: 'btn btn--danger', text: 'remove',
              onclick: async () => {
                if (item.kind === 'live') return this.app.pool.removeLiveSource(item.id);
                try {
                  await this.app.getJson(`/api/media/${item.id}`, { method: 'DELETE' });
                  await this.app.pool.load();
                } catch (err) {
                  this.app.banner(`could not remove: ${err.message}`, 'error');
                }
              },
            }),
          ]),
          chans,
          el('div', { class: 'grid2' }, [
            renderCtl('scale', 'scale', { type: 'range', min: 0.1, max: 6, step: 0.05, value: 1 }),
            renderCtl('opacity', 'opacity', { type: 'range', min: 0, max: 1, step: 0.01, value: 1 }),
            renderCtl('weight', 'weight', { type: 'range', min: 0, max: 8, step: 0.1, value: 1 }),
            item.mediaKind === 'video' || item.kind === 'video' || item.kind === 'live'
              ? renderCtl('speed', 'playbackRate', { type: 'range', min: 0.1, max: 3, step: 0.05, value: 1 })
              : null,
            renderSel('rotate', 'rotate', ROTATIONS),
            renderSel('mask', 'mask', MASKS),
            renderSel('blend', 'blend', BLENDS),
          ].filter(Boolean)),
        ])
      );
    }
    // Keep the texture-image picker in step with the library.
    if (this.textureImageSelect) {
      const current = this.app.show.map.texture.imageId;
      const opts = ['(none)'];
      for (const e of this.app.pool.entries.values()) {
        if (e.item.kind === 'image' || (e.item.kind === 'remote' && e.item.mediaKind === 'image')) opts.push(e.item.label);
      }
      this.textureImageSelect.innerHTML = '';
      for (const o of opts) {
        const found = [...this.app.pool.entries.values()].find((x) => x.item.label === o);
        const opt = el('option', { value: o, text: o });
        if (found && found.item.id === current) opt.selected = true;
        this.textureImageSelect.append(opt);
      }
    }
  }

  async patchRender(item, patch) {
    this.app.pool.applyRender(item.id, patch);
    if (item.kind === 'live') return;
    clearTimeout(this._renderTimers?.[item.id]);
    this._renderTimers = this._renderTimers || {};
    this._renderTimers[item.id] = setTimeout(async () => {
      try {
        await this.app.getJson(`/api/media/${item.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ render: this.app.pool.entries.get(item.id)?.item.render }),
        });
      } catch (err) {
        this.app.banner(`could not save render settings: ${err.message}`, 'warn');
      }
    }, 400);
  }

  /* --- channels --- */

  channelSection() {
    return this.section('Weather channels', [
      el('p', { class: 'hint', text: 'Each channel is a field read from the live data. Density sets how much media fills it; threshold sets how strong the weather must be before anything appears.' }),
      ...CHANNEL_LIST.map((c) =>
        el('div', { class: 'subsect' }, [
          el('div', { class: 'subsect__head' }, [this.toggle(c, `channels.${c}.enabled`)]),
          el('div', { class: 'grid2' }, [
            this.slider('density', `channels.${c}.density`, { min: 0, max: 3, step: 0.05 }),
            this.slider('size', `channels.${c}.size`, { min: 0.1, max: 5, step: 0.05 }),
            this.slider('speed', `channels.${c}.speed`, { min: 0, max: 5, step: 0.05 }),
            this.slider('opacity', `channels.${c}.opacity`),
            this.slider('threshold', `channels.${c}.threshold`),
            this.slider('scatter', `channels.${c}.jitter`),
          ]),
          this.select('blend', `channels.${c}.blend`, BLENDS),
        ])
      ),
    ]);
  }

  /* --- motion --- */

  motionSection() {
    return this.section('Motion', [
      el('p', { class: 'hint', text: 'Time-lapse multiplies the measured wind so weather visibly moves; direction and relative speed stay real. At 1x the air is effectively still at this scale.' }),
      this.slider('time-lapse ×', 'motion.windGain', { min: 0, max: 6000, step: 25, format: 'int' }),
      this.slider('turbulence', 'motion.turbulence', { min: 0, max: 3, step: 0.02 }),
      this.slider('trails', 'motion.trails', { min: 0, max: 0.97, step: 0.01 }),
      this.slider('cluster cohesion', 'motion.clusterCohesion'),
      this.slider('max sprites', 'motion.maxSprites', { min: 40, max: 2500, step: 10, format: 'int' }),
      el('p', { class: 'hint', text: 'The engine thins the sprite population automatically if the frame rate drops below target; the HUD shows the quality factor in use.' }),
      this.toggle('clip to the state outline (costly)', 'motion.clipToState'),
    ]);
  }

  /* --- audio --- */

  audioSection() {
    this.audioInfo = el('pre', { class: 'readout', text: '' });
    clearInterval(this._audioTimer);
    this._audioTimer = setInterval(() => {
      if (!this.open_ || !this.audioInfo) return;
      const a = this.app.audio?.started ? this.app.audio.stats() : null;
      this.audioInfo.textContent = a
        ? [
            `state      ${a.state} @ ${a.sampleRate} Hz`,
            `key        ${a.key}`,
            `tension    ${a.tension}   brightness ${a.brightness}`,
            `pulse      ${a.intervalSec}s   pad voices ${a.voices}`,
            `drive      ${Object.entries(a.drive).map(([k, v]) => `${k}:${v}`).join('  ')}`,
            `events     chords ${a.events.chords}  bells ${a.events.bells}  grains ${a.events.grains}  thunder ${a.events.thunder}`,
          ].join('\n')
        : 'audio not started — click the stage or the enable-audio button';
    }, 700);

    return this.section('Score', [
      el('div', { class: 'btnrow' }, [
        el('button', { type: 'button', class: 'btn', text: 'Start / resume audio', onclick: () => this.app.startAudio() }),
      ]),
      this.slider('master', 'audio.master'),
      el('div', { class: 'grid2' }, [
        this.slider('drone', 'audio.drone'),
        this.slider('pad', 'audio.pad'),
        this.slider('wind', 'audio.wind'),
        this.slider('rain', 'audio.rain'),
        this.slider('thunder', 'audio.thunder'),
        this.slider('bells', 'audio.bells'),
      ]),
      this.slider('reverb', 'audio.reverb'),
      this.select('mode', 'audio.scaleMode', SCALE_MODES),
      this.select('root', 'audio.rootMode', ['auto', 'fixed']),
      this.select('root note (when fixed)', 'audio.rootNote', NOTES),
      this.slider('tempo bias', 'audio.tempoBias', { min: 0.25, max: 4, step: 0.05 }),
      this.audioInfo,
    ]);
  }

  /* --- overlay --- */

  overlaySection() {
    return this.section('Overlay', [
      this.textField('title', 'overlay.title'),
      this.textField('subtitle', 'overlay.subtitle'),
      this.select('font', 'overlay.font', FONTS),
      this.colour('accent', 'overlay.accent'),
      el('div', { class: 'grid2' }, [
        this.toggle('station temps', 'overlay.showStations'),
        this.toggle('readout', 'overlay.showReadout'),
        this.toggle('alerts', 'overlay.showAlerts'),
        this.toggle('clock', 'overlay.showClock'),
        this.toggle('legend', 'overlay.showLegend'),
      ]),
      el('div', { class: 'btnrow' }, [
        el('button', {
          type: 'button', class: 'btn btn--danger', text: 'Reset the whole show',
          onclick: async () => {
            if (!confirm('Reset every visual, audio and overlay setting to defaults?')) return;
            const { show } = await this.app.getJson('/api/show/reset', { method: 'POST' });
            this.app.show = show;
            this.app.engine.setShow(show);
            this.app.audio?.setShow(show);
            await this.init();
            this.open();
            this.app.banner('show reset to defaults', 'info');
          },
        }),
      ]),
    ]);
  }

  /* --- stream --- */

  streamSection() {
    const presetSel = el('select', {}, ['720p30', '1080p30', '1080p60', '720p60', '480p30'].map((p) =>
      el('option', { value: p, text: p })
    ));
    const rtmpInput = el('input', { type: 'text', value: 'rtmp://a.rtmp.youtube.com/live2' });
    const keyInput = el('input', { type: 'password', placeholder: 'YouTube stream key', autocomplete: 'off' });
    const encoderSel = el('select', {}, ['headless', 'external'].map((e) =>
      el('option', { value: e, text: e === 'headless' ? 'headless (server renders)' : 'external (this browser)' })
    ));
    const targetSel = el('select', {}, [
      el('option', { value: 'rtmp', text: 'RTMP (YouTube / Twitch)' }),
      el('option', { value: 'file', text: 'local file (test)' }),
    ]);
    this.streamInfo = el('pre', { class: 'readout', text: 'not streaming' });

    const start = async () => {
      const body = {
        targetType: targetSel.value,
        rtmpUrl: rtmpInput.value.trim(),
        streamKey: keyInput.value,
        preset: presetSel.value,
        encoder: encoderSel.value,
      };
      try {
        const st = await this.app.getJson('/api/stream/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        keyInput.value = '';
        this.app.banner(`broadcast starting → ${st.target}`, 'info');
        if (st.encoderUrl) {
          this.app.banner('external encoder selected — opening the encoder window', 'info');
          window.open(st.encoderUrl, 'twc-encoder', 'width=960,height=560');
        }
        this.pollStream();
      } catch (err) {
        this.app.banner(`could not start the broadcast: ${err.message}`, 'error');
      }
    };

    return this.section('Broadcast', [
      el('p', { class: 'hint', text: 'YouTube Live: create a stream in YouTube Studio, copy its stream key here, then press Go live. The key is sent once and never logged.' }),
      el('p', { class: 'hint', text: '720p30 is the safe default for a CPU-only encoder. 1080p needs GPU-accelerated canvas rendering; without it the engine thins the sprite population to hold the frame rate.' }),
      el('label', { class: 'ctl' }, [el('span', { class: 'ctl__label', text: 'target' }), targetSel]),
      el('div', { class: 'ctl ctl--text' }, [el('span', { class: 'ctl__label', text: 'RTMP URL' }), rtmpInput]),
      el('div', { class: 'ctl ctl--text' }, [el('span', { class: 'ctl__label', text: 'stream key' }), keyInput]),
      el('div', { class: 'grid2' }, [
        el('label', { class: 'ctl' }, [el('span', { class: 'ctl__label', text: 'quality' }), presetSel]),
        el('label', { class: 'ctl' }, [el('span', { class: 'ctl__label', text: 'encoder' }), encoderSel]),
      ]),
      el('div', { class: 'btnrow' }, [
        el('button', { type: 'button', class: 'btn btn--go', text: 'Go live', onclick: start }),
        el('button', {
          type: 'button', class: 'btn btn--danger', text: 'Stop',
          onclick: async () => {
            try {
              await this.app.getJson('/api/stream/stop', { method: 'POST' });
              this.app.banner('broadcast stopped', 'info');
              this.pollStream();
            } catch (err) {
              this.app.banner(err.message, 'error');
            }
          },
        }),
      ]),
      this.streamInfo,
    ]);
  }

  pollStream() {
    clearInterval(this.streamStatusTimer);
    const tick = async () => {
      try {
        const s = await this.app.getJson('/api/stream/status');
        this.streamInfo.textContent = s.running
          ? [
              `state     ${s.state}`,
              `target    ${s.target}`,
              `encoder   ${s.encoder}${s.encoderConnected ? ' (connected)' : ' (waiting)'}`,
              `settings  ${s.settings.width}x${s.settings.height}@${s.settings.fps} ${s.settings.videoBitrate}kbps`,
              `audio     ${s.hasAudio === null ? 'unknown' : s.hasAudio ? 'yes' : 'silence substituted'}`,
              `uptime    ${s.uptimeSec}s`,
              `received  ${(s.bytesIn / 1048576).toFixed(2)} MB in ${s.chunks} chunks`,
              '',
              ...(s.logTail || []).slice(-8),
            ].join('\n')
          : ['not streaming', '', ...(s.logTail || []).slice(-8)].join('\n');
      } catch (err) {
        this.streamInfo.textContent = `status unavailable: ${err.message}`;
      }
    };
    tick();
    this.streamStatusTimer = setInterval(tick, 2500);
  }

  /* ---------- open / close ---------- */

  open() {
    this.open_ = true;
    this.root.classList.add('panel--on');
    document.body.classList.add('panel-open');
    this.refreshWeatherStatus();
    this.pollStream();
  }

  close() {
    this.open_ = false;
    this.root.classList.remove('panel--on');
    document.body.classList.remove('panel-open');
    clearInterval(this.streamStatusTimer);
  }

  toggle() {
    this.open_ ? this.close() : this.open();
  }
}

function fmt(v, format) {
  if (format === 'int') return String(Math.round(v));
  if (format === 'deg') return `${Math.round(v)}°`;
  return typeof v === 'number' ? v.toFixed(2) : String(v);
}
