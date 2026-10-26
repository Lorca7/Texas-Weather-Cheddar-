/**
 * Broadcast furniture: title, clock, station readouts, alert banner, legend.
 *
 * Deliberately restrained — the media collage is the subject, this is the
 * frame around it. Everything here can be switched off for a clean render.
 */
import { hexToRgba } from './map.js';

const FONTS = {
  condensed: '"Oswald","Archivo Narrow","Helvetica Neue Condensed",Impact,system-ui,sans-serif',
  mono: 'ui-monospace,"SF Mono",Menlo,Consolas,monospace',
  serif: 'Georgia,"Times New Roman",serif',
  sans: 'system-ui,-apple-system,"Segoe UI",sans-serif',
};

export class Overlay {
  constructor({ view }) {
    this.view = view;
    this.alertIndex = 0;
    this.lastAlertRotate = 0;
  }

  font(show, size, weight = 400) {
    const fam = FONTS[show.overlay.font] || FONTS.condensed;
    return `${weight} ${size}px ${fam}`;
  }

  draw(ctx, show, blender, extra = {}) {
    const o = show.overlay;
    const { width, height } = this.view;
    const scale = Math.min(width, height) / 1080;
    const pad = 46 * scale;

    if (o.showStations) this._stations(ctx, show, blender, scale);
    const bannerTop = o.showAlerts ? this._alerts(ctx, show, blender, scale, pad) : null;
    if (o.showReadout) this._readout(ctx, show, blender, scale, pad);
    if (o.showLegend) this._legend(ctx, show, scale, pad, extra, { bannerTop });
    this._title(ctx, show, blender, scale, pad, extra);
  }

  /* ---------- station dots ---------- */

  _stations(ctx, show, blender, scale) {
    const stations = blender.stations;
    if (!stations?.length) return;
    const v = this.view;
    ctx.save();
    ctx.font = this.font(show, 13 * scale, 500);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const st of stations) {
      const [x, y] = v.toScreen(st.lon, st.lat);
      if (x < -40 || y < -40 || x > v.width + 40 || y > v.height + 40) continue;

      ctx.beginPath();
      ctx.arc(x, y, 2.6 * scale, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(show.map.ink, 0.72);
      ctx.fill();

      if (st.tempC !== null && st.tempC !== undefined) {
        const label = `${Math.round(st.tempC * 1.8 + 32)}`;
        ctx.lineWidth = 3 * scale;
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.strokeText(label, x, y - 13 * scale);
        ctx.fillStyle = hexToRgba(show.map.ink, 0.95);
        ctx.fillText(label, x, y - 13 * scale);
      }
    }
    ctx.restore();
  }

  /* ---------- alert banner ---------- */

  /** Draws the alert banner and returns its top edge, or null if none. */
  _alerts(ctx, show, blender, scale, pad) {
    const alerts = blender.current?.alerts || [];
    if (!alerts.length) return null;
    const now = performance.now();
    if (now - this.lastAlertRotate > 7000) {
      this.lastAlertRotate = now;
      this.alertIndex = (this.alertIndex + 1) % alerts.length;
    }
    const a = alerts[this.alertIndex % alerts.length];
    const { width, height } = this.view;
    const h = 52 * scale;
    const y = height - pad - h;

    ctx.save();
    const severe = /Extreme|Severe/i.test(a.severity);
    ctx.fillStyle = severe ? 'rgba(146,18,18,0.88)' : 'rgba(18,22,34,0.8)';
    ctx.fillRect(pad, y, width - pad * 2, h);
    ctx.fillStyle = severe ? '#ffd9d0' : show.overlay.accent;
    ctx.fillRect(pad, y, 6 * scale, h);

    ctx.font = this.font(show, 20 * scale, 600);
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    const text = `${a.event.toUpperCase()}${a.areaDesc ? ` — ${a.areaDesc}` : ''}`;
    ctx.fillText(clip(ctx, text, width - pad * 2 - 40 * scale), pad + 20 * scale, y + h / 2);

    if (alerts.length > 1) {
      ctx.textAlign = 'right';
      ctx.font = this.font(show, 15 * scale, 400);
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillText(`${(this.alertIndex % alerts.length) + 1}/${alerts.length}`, width - pad - 14 * scale, y + h / 2);
    }
    ctx.restore();
    return y;
  }

  /* ---------- numeric readout ---------- */

  _readout(ctx, show, blender, scale, pad) {
    const s = blender.summary;
    if (!s || !s.tempC) return;
    const { width } = this.view;
    const lines = [
      ['HIGH', s.tempC.max === null ? '--' : `${Math.round(s.tempC.max * 1.8 + 32)}°F`],
      ['LOW', s.tempC.min === null ? '--' : `${Math.round(s.tempC.min * 1.8 + 32)}°F`],
      ['WIND', s.windKt?.mean === null ? '--' : `${Math.round(s.windKt.mean * 1.151)} mph`],
      ['GUST', s.gustKt?.max ? `${Math.round(s.gustKt.max * 1.151)} mph` : '--'],
      ['CLOUD', `${Math.round((s.cloudMean ?? 0) * 100)}%`],
      ['RAIN', `${(100 * (s.precipCoverage ?? 0)).toFixed(1)}%`],
      ['CELLS', String(s.stormCells ?? 0)],
    ];

    ctx.save();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    let y = pad + 26 * scale;
    for (const [k, v] of lines) {
      ctx.font = this.font(show, 13 * scale, 400);
      ctx.fillStyle = hexToRgba(show.overlay.accent, 0.75);
      ctx.fillText(k, width - pad - 86 * scale, y);
      ctx.font = this.font(show, 26 * scale, 600);
      ctx.fillStyle = hexToRgba(show.map.ink, 0.96);
      ctx.fillText(v, width - pad, y);
      y += 40 * scale;
    }
    ctx.restore();
  }

  /* ---------- legend ---------- */

  _legend(ctx, show, scale, pad, extra, { bannerTop = null } = {}) {
    const active = Object.entries(show.channels).filter(([, c]) => c.enabled);
    if (!active.length) return;
    const { height } = this.view;
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    // Sit above the alert banner when one is on screen, rather than under it.
    const rows = active.filter(([n]) => extra.channelLabels?.[n]).length;
    const blockHeight = (rows + 1) * 21 * scale + 12 * scale;
    const floor = bannerTop !== null ? bannerTop - 14 * scale : height - pad;
    let y = floor - blockHeight;
    ctx.font = this.font(show, 12 * scale, 500);
    ctx.fillStyle = hexToRgba(show.overlay.accent, 0.7);
    ctx.fillText('STANDING IN FOR', pad, y);
    y += 22 * scale;
    for (const [name] of active) {
      const label = extra.channelLabels?.[name];
      if (!label) continue;
      ctx.font = this.font(show, 15 * scale, 400);
      ctx.fillStyle = hexToRgba(show.map.ink, 0.8);
      ctx.fillText(`${name.toUpperCase()} · ${label}`, pad, y);
      y += 21 * scale;
    }
    ctx.restore();
  }

  /* ---------- title block ---------- */

  _title(ctx, show, blender, scale, pad, extra) {
    const o = show.overlay;
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    if (o.title) {
      ctx.font = this.font(show, 54 * scale, 700);
      ctx.fillStyle = hexToRgba(show.map.ink, 0.97);
      ctx.fillText(o.title, pad, pad + 48 * scale);
    }
    if (o.subtitle) {
      ctx.font = this.font(show, 18 * scale, 400);
      ctx.fillStyle = hexToRgba(o.accent, 0.9);
      ctx.fillText(o.subtitle, pad, pad + 76 * scale);
    }

    if (o.showClock) {
      const t = blender.current ? new Date(blender.current.t) : new Date();
      const stamp = t.toLocaleString('en-US', {
        timeZone: 'America/Chicago',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      });
      ctx.font = this.font(show, 15 * scale, 400);
      ctx.fillStyle = hexToRgba(show.map.ink, 0.62);
      ctx.fillText(stamp, pad, pad + 102 * scale);
    }

    // Provenance line — and, crucially, an unmissable badge when the field is
    // modelled rather than observed.
    const src = blender.current?.source;
    if (src === 'synthetic') {
      const label = 'SIMULATED — NOT NWS OBSERVATIONS';
      ctx.font = this.font(show, 16 * scale, 700);
      const w = ctx.measureText(label).width + 22 * scale;
      ctx.fillStyle = 'rgba(190,40,30,0.92)';
      ctx.fillRect(pad, pad + 116 * scale, w, 28 * scale);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, pad + 11 * scale, pad + 136 * scale);
    } else if (blender.current?.stale) {
      ctx.font = this.font(show, 14 * scale, 600);
      ctx.fillStyle = 'rgba(214,160,40,0.95)';
      ctx.fillText('DATA STALE — holding last good observation', pad, pad + 134 * scale);
    }

    if (extra.watermark) {
      ctx.font = this.font(show, 12 * scale, 400);
      ctx.fillStyle = hexToRgba(show.map.ink, 0.35);
      ctx.textAlign = 'right';
      ctx.fillText(extra.watermark, this.view.width - pad, this.view.height - pad + 16 * scale);
    }
    ctx.restore();
  }
}

/** Truncate to fit a pixel width, with an ellipsis. */
function clip(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}
