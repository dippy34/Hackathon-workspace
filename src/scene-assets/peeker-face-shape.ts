/**
 * Peeker face, part 1 of 3: the base head and its vertex grid.
 *
 * The head is a vertical loft of horizontal sections (superellipse-fronted,
 * elliptical-backed) closed at the top by a full dome and left open at the
 * bottom of a short neck. Rows are horizontal (constant base y) and are spaced
 * by weighted arc length along the face's centre line, so the eyes, nostrils
 * and mouth get the dense rows; columns are angles around the vertical axis,
 * densest straight out of the face. Pure maths: no Three objects, no state.
 *
 * Units are metres. Origin: centre of the face, just below the eye sockets.
 * +Y up, +Z out of the face, +X to the face's left (viewer's right).
 */

export const HEAD = {
  /** Crown (top of the dome) and the height where the dome meets the face. */
  yTop: 0.147,
  yEq: 0.06,
  /** Open bottom of the neck (fully transparent there). */
  yBot: -0.165,
  /** The crown sits a little behind the face plane. */
  zCrown: -0.02,
  /** Dome profile exponent (>2: fuller, "high domed"). */
  domeQ: 2.3,
  /** Share of the row parameter spent on the dome. */
  uEq: 0.3,
  /** Feature lines that get an exact grid row. */
  yEye: 0.012,
  yNostril: -0.033,
  yMouth: -0.066,
} as const;

/** Section knots, ascending in y: [y, halfWidth, frontDepth, backDepth, frontPower]. */
const KNOTS: readonly (readonly [number, number, number, number, number])[] = [
  [-0.165, 0.046, 0.024, 0.06, 2.0],
  [-0.135, 0.043, 0.022, 0.06, 2.0],
  [-0.122, 0.043, 0.027, 0.062, 2.0],
  [-0.112, 0.045, 0.043, 0.064, 2.1],
  [-0.1, 0.046, 0.057, 0.068, 2.2],
  [-0.08, 0.057, 0.067, 0.076, 2.3],
  [-0.055, 0.072, 0.073, 0.084, 2.4],
  [-0.03, 0.082, 0.077, 0.09, 2.5],
  [0.0, 0.088, 0.079, 0.095, 2.5],
  [0.03, 0.09, 0.08, 0.098, 2.4],
  [0.06, 0.091, 0.079, 0.1, 2.2],
];

/** Hermite tangents per knot and channel (1..4), zero at the dome joint. */
const TANGENTS: number[][] = KNOTS.map((k, i) => {
  const out = [0, 0, 0, 0, 0];
  for (let c = 1; c <= 4; c++) {
    if (i === KNOTS.length - 1) continue;
    const n = KNOTS[i + 1];
    const dNext = (n[c] - k[c]) / (n[0] - k[0]);
    if (i === 0) {
      out[c] = dNext;
      continue;
    }
    const p = KNOTS[i - 1];
    const dPrev = (k[c] - p[c]) / (k[0] - p[0]);
    if (dPrev * dNext <= 0) continue;
    const hp = k[0] - p[0];
    const hn = n[0] - k[0];
    const m = (dPrev * hn + dNext * hp) / (hp + hn);
    const lim = 3 * Math.min(Math.abs(dPrev), Math.abs(dNext));
    out[c] = Math.sign(m) * Math.min(Math.abs(m), lim);
  }
  return out;
});

export interface Section {
  y: number;
  /** Half-width (x). */
  w: number;
  /** Front depth (+z from zc) and back depth (-z from zc). */
  f: number;
  b: number;
  /** Superellipse power of the front half (2 = ellipse, larger = flatter face). */
  p: number;
  zc: number;
}

function evalKnots(y: number, out: Section): void {
  const last = KNOTS.length - 1;
  let i = 0;
  while (i < last - 1 && y > KNOTS[i + 1][0]) i++;
  const a = KNOTS[i];
  const b = KNOTS[i + 1];
  const h = b[0] - a[0];
  const t = Math.min(1, Math.max(0, (y - a[0]) / h));
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  const ta = TANGENTS[i];
  const tb = TANGENTS[i + 1];
  const v = (c: number) => h00 * a[c] + h10 * h * ta[c] + h01 * b[c] + h11 * h * tb[c];
  out.w = v(1);
  out.f = v(2);
  out.b = v(3);
  out.p = v(4);
}

/** Section at row parameter u (0 = crown, 1 = bottom of the neck). */
export function section(u: number, out: Section): Section {
  if (u < HEAD.uEq) {
    const a = (Math.max(0, u) / HEAD.uEq) * (Math.PI / 2);
    const e = 2 / HEAD.domeQ;
    const fs = Math.pow(Math.sin(a), e);
    const top = KNOTS[KNOTS.length - 1];
    out.y = HEAD.yEq + (HEAD.yTop - HEAD.yEq) * Math.pow(Math.cos(a), e);
    out.w = top[1] * fs;
    out.f = top[2] * fs;
    out.b = top[3] * fs;
    out.p = top[4];
    out.zc = HEAD.zCrown * (1 - fs);
    return out;
  }
  out.y = HEAD.yEq - ((Math.min(1, u) - HEAD.uEq) / (1 - HEAD.uEq)) * (HEAD.yEq - HEAD.yBot);
  evalKnots(out.y, out);
  out.zc = 0;
  return out;
}

/** Row parameter of a base height below the dome joint. */
export function uForY(y: number): number {
  return HEAD.uEq + ((HEAD.yEq - y) / (HEAD.yEq - HEAD.yBot)) * (1 - HEAD.uEq);
}

const tmpSec: Section = { y: 0, w: 0, f: 0, b: 0, p: 2, zc: 0 };

/** Base head point at (u, theta); theta 0 = straight out of the face, +pi/2 = +X. */
export function basePoint(u: number, theta: number, out: Float64Array, o = 0): void {
  const s = section(u, tmpSec);
  const sn = Math.sin(theta);
  const as = Math.min(1, Math.abs(sn));
  out[o] = s.w * sn;
  out[o + 1] = s.y;
  out[o + 2] =
    s.zc +
    (Math.cos(theta) >= 0
      ? s.f * Math.pow(Math.max(0, 1 - Math.pow(as, s.p)), 1 / s.p)
      : -s.b * Math.sqrt(Math.max(0, 1 - as * as)));
}

const pa = new Float64Array(3);
const pb = new Float64Array(3);
const pc = new Float64Array(3);
const pd = new Float64Array(3);

/** Outward unit normal of the base head (finite differences). */
export function baseNormal(u: number, theta: number, out: Float64Array, o = 0): void {
  const du = 1e-4;
  const dt = 1e-4;
  basePoint(Math.min(1, u + du), theta, pa);
  basePoint(Math.max(1e-4, u - du), theta, pb);
  basePoint(u, theta + dt, pc);
  basePoint(u, theta - dt, pd);
  const ux = pa[0] - pb[0], uy = pa[1] - pb[1], uz = pa[2] - pb[2];
  const tx = pc[0] - pd[0], ty = pc[1] - pd[1], tz = pc[2] - pd[2];
  // Rows run down (+u), columns run toward +X at the front: n = du x dtheta.
  let nx = uy * tz - uz * ty;
  let ny = uz * tx - ux * tz;
  let nz = ux * ty - uy * tx;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l;
  ny /= l;
  nz /= l;
  out[o] = nx;
  out[o + 1] = ny;
  out[o + 2] = nz;
}

/** Row density along the face's centre line (higher = finer rows). */
function rowWeight(y: number): number {
  const g = (d: number, s: number) => Math.exp(-(d * d) / (2 * s * s));
  const band = Math.min(1, Math.max(0, (0.095 - y) / 0.02)) * Math.min(1, Math.max(0, (y + 0.125) / 0.015));
  return (
    0.62 +
    0.6 * band +
    0.5 * g(y - HEAD.yEye, 0.017) +
    1.0 * g(y - HEAD.yMouth, 0.011) +
    // The band the scream's jaw drop stretches gets extra rows.
    0.8 * g(y - (HEAD.yMouth - 0.012), 0.014) +
    0.25 * g(y - HEAD.yNostril, 0.006)
  );
}

export interface FaceGrid {
  cols: number;
  /** Rows including the crown pole (row 0 is the single pole vertex). */
  rows: number;
  count: number;
  /** Per row u, per column theta. */
  u: Float64Array;
  theta: Float64Array;
  /** Per vertex: base position and base outward normal. */
  base: Float64Array;
  normal: Float64Array;
  /** Per vertex: its row and column (pole: row 0, column 0). */
  row: Int32Array;
  col: Int32Array;
  index: number[];
}

export function vertexId(cols: number, r: number, j: number): number {
  return r === 0 ? 0 : 1 + (r - 1) * cols + (((j % cols) + cols) % cols);
}

/**
 * The vertex grid: `cols` columns (front-dense angle warp, seam at the back)
 * and `rows` rows from the crown pole to the open neck.
 */
export function buildGrid(cols: number, rows: number, frontDensity = 0.45): FaceGrid {
  const theta = new Float64Array(cols);
  for (let j = 0; j < cols; j++) {
    const t = -1 + (2 * j) / cols;
    theta[j] = Math.PI * (frontDensity * t + (1 - frontDensity) * t * t * t);
  }

  // Weighted arc length down the centre line, then equal steps of it.
  const N = 4000;
  const cum = new Float64Array(N + 1);
  const p0 = new Float64Array(3);
  const p1 = new Float64Array(3);
  basePoint(0, 0, p0);
  for (let i = 1; i <= N; i++) {
    basePoint(i / N, 0, p1);
    const ds = Math.hypot(p1[1] - p0[1], p1[2] - p0[2]);
    cum[i] = cum[i - 1] + ds * rowWeight(0.5 * (p0[1] + p1[1]));
    p0.set(p1);
  }
  const u = new Float64Array(rows);
  let k = 0;
  for (let r = 1; r < rows; r++) {
    const target = (r / (rows - 1)) * cum[N];
    while (k < N - 1 && cum[k + 1] < target) k++;
    const f = (target - cum[k]) / Math.max(1e-12, cum[k + 1] - cum[k]);
    u[r] = Math.min(1, (k + f) / N);
  }
  // Snap the nearest row onto each feature line so slits and creases land on vertices.
  const sec: Section = { y: 0, w: 0, f: 0, b: 0, p: 2, zc: 0 };
  for (const y of [HEAD.yEye, HEAD.yNostril, HEAD.yMouth]) {
    let best = 1;
    for (let r = 1; r < rows; r++) {
      if (Math.abs(section(u[r], sec).y - y) < Math.abs(section(u[best], sec).y - y)) best = r;
    }
    u[best] = uForY(y);
  }

  const count = 1 + (rows - 1) * cols;
  const base = new Float64Array(count * 3);
  const normal = new Float64Array(count * 3);
  const row = new Int32Array(count);
  const col = new Int32Array(count);
  basePoint(0, 0, base, 0);
  normal[1] = 1;
  for (let r = 1; r < rows; r++) {
    for (let j = 0; j < cols; j++) {
      const v = vertexId(cols, r, j);
      basePoint(u[r], theta[j], base, v * 3);
      baseNormal(u[r], theta[j], normal, v * 3);
      row[v] = r;
      col[v] = j;
    }
  }

  // Winding: counter-clockwise seen from outside.
  const index: number[] = [];
  for (let j = 0; j < cols; j++) index.push(0, vertexId(cols, 1, j), vertexId(cols, 1, j + 1));
  for (let r = 1; r < rows - 1; r++) {
    for (let j = 0; j < cols; j++) {
      const a = vertexId(cols, r, j);
      const b = vertexId(cols, r + 1, j);
      const c = vertexId(cols, r, j + 1);
      const d = vertexId(cols, r + 1, j + 1);
      index.push(a, b, c, c, b, d);
    }
  }
  return { cols, rows, count, u, theta, base, normal, row, col, index };
}
