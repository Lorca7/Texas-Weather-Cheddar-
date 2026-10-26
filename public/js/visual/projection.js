/**
 * Albers equal-area conic projection, tuned for Texas.
 *
 * Standard parallels at 27.5N / 35N keep the Rio Grande Valley and the
 * Panhandle both honest — a plain lon/lat stretch makes Texas look squat and
 * leans the western border the wrong way.
 */
const D2R = Math.PI / 180;

export class Albers {
  constructor({ lat0 = 31.25, lon0 = -99.5, lat1 = 27.5, lat2 = 35 } = {}) {
    this.lon0 = lon0;
    const s1 = Math.sin(lat1 * D2R);
    const s2 = Math.sin(lat2 * D2R);
    this.n = (s1 + s2) / 2;
    this.C = Math.cos(lat1 * D2R) ** 2 + 2 * this.n * s1;
    this.rho0 = Math.sqrt(this.C - 2 * this.n * Math.sin(lat0 * D2R)) / this.n;
  }

  /**
   * lon/lat (degrees) -> unitless projected plane.
   *
   * Y is negated relative to the textbook formula so that it grows southward,
   * matching canvas coordinates. Without this Texas renders mirrored about
   * the horizontal axis.
   */
  project(lon, lat) {
    const theta = this.n * (lon - this.lon0) * D2R;
    const inner = this.C - 2 * this.n * Math.sin(lat * D2R);
    const rho = Math.sqrt(Math.max(0, inner)) / this.n;
    return [rho * Math.sin(theta), -(this.rho0 - rho * Math.cos(theta))];
  }

  /** Inverse, so screen gestures can be read back as coordinates. */
  invert(x, y) {
    const dy = this.rho0 + y; // undo the southward-positive flip
    const rho = Math.hypot(x, dy);
    const theta = Math.atan2(x, dy);
    const lat = Math.asin((this.C - rho * rho * this.n * this.n) / (2 * this.n)) / D2R;
    const lon = this.lon0 + theta / this.n / D2R;
    return [lon, lat];
  }
}

/**
 * Fits a projection to a viewport with padding, and exposes the forward
 * transform the renderers use. Rebuilt whenever the canvas resizes.
 */
export class MapView {
  constructor({ geo, width, height, padding = 0.045 }) {
    this.albers = new Albers();
    this.geo = geo;
    this.resize(width, height, padding);
  }

  resize(width, height, padding = this.padding ?? 0.045) {
    this.width = width;
    this.height = height;
    this.padding = padding;

    // Project every outline vertex once to find the true projected extent.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const visit = (coords) => {
      if (typeof coords[0] === 'number') {
        const [x, y] = this.albers.project(coords[0], coords[1]);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        return;
      }
      for (const c of coords) visit(c);
    };
    visit(this.geo.outline.coordinates);

    const padX = width * padding;
    const padY = height * padding;
    const scale = Math.min((width - 2 * padX) / (maxX - minX), (height - 2 * padY) / (maxY - minY));

    this.scale = scale;
    this.offsetX = (width - (maxX - minX) * scale) / 2 - minX * scale;
    this.offsetY = (height - (maxY - minY) * scale) / 2 - minY * scale;
    this.extent = { minX, minY, maxX, maxY };
    return this;
  }

  /** lon/lat -> canvas pixels. */
  toScreen(lon, lat) {
    const [x, y] = this.albers.project(lon, lat);
    return [x * this.scale + this.offsetX, y * this.scale + this.offsetY];
  }

  /** canvas pixels -> lon/lat. */
  toLonLat(px, py) {
    return this.albers.invert((px - this.offsetX) / this.scale, (py - this.offsetY) / this.scale);
  }

  /**
   * Screen-space displacement for a wind vector in knots.
   * Converts knots to degrees per second, then to pixels, so sprite drift is
   * proportional to the real wind rather than an arbitrary constant.
   */
  windToPixels(uKt, vKt, lat, seconds) {
    const degPerKtSec = 1 / 60 / 3600; // 1 knot = 1 nautical mile/hour = 1/60 deg/hour
    const dLon = (uKt * degPerKtSec * seconds) / Math.max(0.2, Math.cos(lat * D2R));
    const dLat = vKt * degPerKtSec * seconds;
    return [dLon, dLat];
  }

  /** Build a Path2D for a GeoJSON geometry in screen space. */
  path(geometry, path = new Path2D()) {
    const ring = (r) => {
      for (let i = 0; i < r.length; i++) {
        const [x, y] = this.toScreen(r[i][0], r[i][1]);
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
      path.closePath();
    };
    const polys =
      geometry.type === 'Polygon' ? [geometry.coordinates]
      : geometry.type === 'MultiPolygon' ? geometry.coordinates
      : [];
    for (const poly of polys) for (const r of poly) ring(r);
    return path;
  }
}
