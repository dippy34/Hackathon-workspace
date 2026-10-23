/**
 * Peeker face, part 2 of 3: the sculpt. Analytic facial features displace the
 * base head along its normal (plus small tangential slides for the
 * expressions). Every feature is a smooth field of the BASE (x, y), so the
 * neutral, squint and scream shapes share one vertex grid and their
 * differences become morph targets. Each field also reports how dark a vertex
 * should be baked (cavity), a bruise tint ring around the sockets and a lip tint.
 */
import { HEAD, basePoint, baseNormal, section, uForY, type FaceGrid, type Section } from './peeker-face-shape.js';

export interface Expr {
  /** Eyes crushed shut against light: 0..1. */
  squint: number;
  /** Jaw dropped, mouth stretched open: 0..1. */
  scream: number;
}

export interface FieldOut {
  disp: number;
  dx: number;
  dy: number;
  /** Back/forward slide (the jaw swings down and back). */
  dz: number;
  cav: number;
  bruise: number;
  lip: number;
  /** Squeezed-lid mask (squint only): the bake keeps these shelves in shadow. */
  lid: number;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function sstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
const gauss = (d: number, s: number) => Math.exp(-(d * d) / (2 * s * s));
/** Smooth compact falloff of a normalised distance (1 at 0, 0 at >= 1). */
function fall(r: number): number {
  return r >= 1 ? 0 : 1 - r * r * (3 - 2 * r);
}
const ell = (dx: number, dy: number, rx: number, ry: number) => Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2);

/** Position along (t) and signed distance above (perp) the line a->b in the (X, y) plane. */
function lineCoords(X: number, y: number, ax: number, ay: number, bx: number, by: number, out: number[]): void {
  const vx = bx - ax;
  const vy = by - ay;
  const len = Math.hypot(vx, vy);
  out[0] = ((X - ax) * vx + (y - ay) * vy) / (len * len);
  out[1] = (-(X - ax) * vy + (y - ay) * vx) / len;
}
const lc = [0, 0];

/** Eye-socket shape; exported so the glints can sit on the socket floor. */
export const SOCKET = { x: 0.035, glintX: 0.029, glintY: 0.0185 } as const;

/**
 * All the features at base point (x, y). `nz` is the base normal's z (gates
 * the face features to the front of the head); `theta` the column angle.
 */
export function faceField(x: number, y: number, nz: number, theta: number, e: Expr, o: FieldOut): FieldOut {
  const sq = e.squint;
  const sc = e.scream;
  const X = Math.abs(x);
  const sx = x < 0 ? -1 : 1;
  let disp = 0;
  let dx = 0;
  let dy = 0;
  let cav = 0;
  let bruise = 0;
  let lip = 0;
  let lid = 0;
  let dyJaw = 0;
  let dzJaw = 0;

  // ── Brow ridge, forehead, temples ──────────────────────────────────────
  const browY = 0.039 + 0.0035 * (X / 0.06) ** 2;
  const browA = 0.0095 * (1 - sstep(0.058, 0.092, X)) * (0.72 + 0.28 * sstep(0.004, 0.03, X)) * (1 + 0.45 * sq);
  const db = y - browY;
  disp += browA * (db < 0 ? gauss(db, 0.0055) : gauss(db, 0.0135));
  disp += 0.0032 * fall(ell(x, y - 0.088, 0.075, 0.05));
  disp -= 0.006 * fall(ell(X - 0.078, y - 0.045, 0.022, 0.034));
  // Squint: the brow drops and crowds in; scream: it lifts.
  const browSlide = fall(ell(X - 0.034, y - 0.03, 0.052, 0.034));
  dy += browSlide * (-0.0075 * sq + 0.0045 * sc);
  dx -= sx * browSlide * 0.003 * sq;
  const glab = gauss(X - 0.0085, 0.0024) * sstep(0.022, 0.03, y) * sstep(0.05, 0.04, y) * sq;
  disp -= 0.0009 * glab;
  cav += 0.25 * glab;

  // ── Eye sockets: deep, wide, empty ─────────────────────────────────────
  const lx = X - (SOCKET.x + 0.001 * sc);
  const ly = y - HEAD.yEye + 0.12 * lx; // outer corners droop
  const rx = lerp(0.029, 0.025, sq) * (1 + 0.06 * sc);
  const ryUp = lerp(0.0205, 0.0055, sq) * (1 + 0.12 * sc);
  const ryDn = lerp(0.025, 0.006, sq) * (1 + 0.1 * sc);
  const rs = ell(lx, ly, rx, ly > 0 ? ryUp : ryDn);
  disp -= lerp(0.03, 0.0105, sq) * (1 + 0.08 * sc) * (1 - sstep(0.3, 1, rs));
  cav += lerp(sstep(0.98, 0.55, rs), 0.92 * sstep(1.0, 0.3, rs), sq);
  const rb = ell(lx, ly, 0.029, ly > 0 ? 0.0205 : 0.025);
  bruise += sstep(1.6, 0.95, rb) * sstep(0.55, 0.9, rb);
  if (sq > 0) {
    // The squeezed lids stay inside the socket's shadow; their seam is void.
    lid = sq * (1 - sstep(0.85, 1.2, rb));
    cav += 0.9 * sq * gauss(ly, 0.0025) * (1 - sstep(0.022, 0.03, Math.abs(lx)));
    // Crow's feet fanning from the outer corner, and the fold under the eye.
    for (const ang of [-0.38, 0, 0.36]) {
      const ox = 0.062;
      const oy = HEAD.yEye - 0.004;
      lineCoords(X, y, ox, oy, ox + Math.cos(ang) * 0.024, oy + Math.sin(ang) * 0.024, lc);
      const w = sstep(-0.05, 0.15, lc[0]) * sstep(1.05, 0.6, lc[0]) * gauss(lc[1], 0.0019) * sq;
      disp -= 0.0016 * w;
      cav += 0.5 * w;
    }
    const fold = gauss(ly + 0.0105, 0.0022) * (1 - sstep(0.02, 0.032, Math.abs(lx))) * sq;
    disp -= 0.0014 * fold;
    cav += 0.4 * fold;
  }

  // ── Sharp cheekbones over hollow cheeks ────────────────────────────────
  lineCoords(X, y, 0.038, -0.016, 0.079, -0.003, lc);
  const zygW = sstep(-0.15, 0.25, lc[0]) * sstep(1.0, 0.55, lc[0]);
  disp += 0.0068 * (1 + 0.3 * sq + 0.2 * sc) * zygW * (lc[1] < 0 ? gauss(lc[1], 0.0058) : gauss(lc[1], 0.011));
  dy += 0.0068 * sq * fall(ell(X - 0.046, y + 0.02, 0.046, 0.034));
  const hollow = fall(ell(X - 0.058, y + 0.047, 0.027, 0.029));
  disp -= (0.011 + 0.006 * sc) * hollow;
  cav += 0.14 * hollow;

  // ── Nose: a thin bridge, barely a tip, two slit nostrils ───────────────
  const nSig = 0.0042 + 0.0022 * sstep(0.02, -0.028, y);
  const nH = lerp(0.0022, 0.0085, sstep(0.03, -0.024, y)) * sstep(0.042, 0.026, y) * sstep(-0.037, -0.027, y);
  disp += nH * gauss(x, nSig);
  disp += 0.0028 * fall(ell(x, y + 0.026, 0.012, 0.0085));
  const nlx = X - 0.0078;
  const nos = fall(ell(nlx, y - HEAD.yNostril - 0.18 * nlx, 0.0048 * (1 + 0.35 * sc), 0.0019));
  disp -= 0.0035 * nos;
  cav += 0.85 * nos;
  dy += 0.002 * sq * fall(ell(x, y + 0.03, 0.02, 0.016));
  const bridge = (gauss(y - 0.023, 0.0017) + gauss(y - 0.0165, 0.0017)) * gauss(x, 0.007) * sq;
  disp -= 0.0012 * bridge;
  cav += 0.35 * bridge;

  // ── Mouth: a lipless slit over a narrow chin ───────────────────────────
  const cornerT = (X / 0.026) ** 2;
  const my = HEAD.yMouth + 0.0025 * cornerT - 0.0035 * sq * cornerT;
  const slit = (1 - sstep(0.017, 0.028, X)) * gauss(y - my, 0.0016);
  disp -= 0.0032 * (1 + 0.3 * sq) * slit;
  cav += 0.88 * slit;
  lip += gauss(y - my, 0.006) * (1 - sstep(0.02, 0.034, X));
  disp += 0.0045 * fall(ell(x, y + 0.061, 0.042, 0.03));
  disp += 0.0042 * fall(ell(x, y + 0.097, 0.024, 0.016));
  disp -= 0.0015 * gauss(y + 0.081, 0.004) * (1 - sstep(0.012, 0.03, X));

  // ── Scream: the jaw drops, the mouth tears far too wide and tall ───────
  if (sc > 0) {
    const side = sstep(0.028, 0.075, X);
    const a = lerp(0.008, 0.042, side);
    const b = lerp(0.017, 0.026, side);
    const S = sstep(my + a, my - b, y); // 0 above the mouth line, 1 below
    const jawW = 1 - sstep(1.35, 2.2, Math.abs(theta));
    const drop = 0.065 * (1 - 0.55 * sstep(0, 0.07, X)) * lerp(1, 0.65, sstep(-0.13, -0.165, y));
    dyJaw = -sc * jawW * drop * S;
    dzJaw = 0.5 * dyJaw; // a hinge behind the cheek: the chin swings back as it drops
    dy += sc * 0.0045 * (1 - S) * gauss(y - my, 0.012) * (1 - sstep(0.025, 0.045, X));
    dx += sc * sx * 0.009 * sstep(0.004, 0.03, X) * (1 - sstep(0.045, 0.085, X)) * gauss(y - my, 0.018);
    dx -= sc * sx * 0.004 * S * sstep(0.03, 0.06, X);
    // A tear taller than it is wide (an unhinged jaw, not a grin). Its edge is
    // spread over 4-5 columns and the void bleeds past it, so the carved walls
    // never leave lit slivers ("teeth") between columns.
    const wOpen = lerp(0.012, 0.022, Math.sin(Math.PI * S));
    // The lips (where the void meets lit skin) sit on the unstretched rows just
    // outside the band the drop stretches, so that edge stays smooth too.
    const lipGate = sstep(my + a + 0.004, my + a - 0.0005, y) * sstep(my - b - 0.006, my - b + 0.0005, y);
    const open = (1 - sstep(wOpen - 0.012, wOpen + 0.006, X)) * lipGate;
    // The carve deepens only inside the void (open^2), so the lit rim never
    // stands as a steep wall that a close camera sees edge-on.
    disp -= sc * 0.026 * open * open;
    cav += sc * sstep(0, 0.6, open);
    // A soft dark ring around the tear: lips and walls sink into shadow, and the
    // void's edge spreads wider than a (stretched) grid cell, so it never steps.
    const ring =
      (1 - sstep(wOpen - 0.002, wOpen + 0.03, X)) * sstep(my + a + 0.016, my + a - 0.002, y) * sstep(my - b - 0.016, my - b + 0.002, y);
    cav += sc * 0.95 * Math.sqrt(ring); // sqrt: cav mixes in linear light, so lift the mid-range
  }

  // Face features live on the front of the head only.
  const front = sstep(0.05, 0.42, nz);
  disp *= front;
  dx *= front;
  dy *= front;
  cav *= front;
  bruise *= front;
  lip *= front;
  lid *= front;
  dy += dyJaw;

  // ── Jaw line: a narrow mandible edge with a hollow under it ────────────
  lineCoords(X, y, 0.017, -0.104, 0.066, -0.066, lc);
  const jawLineW = sstep(-0.15, 0.15, lc[0]) * sstep(1.05, 0.7, lc[0]) * sstep(0.0, 0.35, nz);
  disp += jawLineW * (lc[1] > 0 ? 0.0022 * gauss(lc[1], 0.007) : -0.0006 * gauss(lc[1], 0.012));

  o.disp = disp;
  o.dx = dx;
  o.dy = dy;
  o.dz = dzJaw;
  o.cav = clamp01(cav);
  o.bruise = clamp01(bruise);
  o.lip = clamp01(lip);
  o.lid = clamp01(lid);
  return o;
}

export interface Sculpt {
  /** Final positions (xyz per vertex). */
  pos: Float32Array;
  /** Per vertex 0..1: baked cavity darkness, socket-rim bruise tint, lip tint, squeezed-lid mask. */
  cav: Float32Array;
  bruise: Float32Array;
  lip: Float32Array;
  lid: Float32Array;
}

const field: FieldOut = { disp: 0, dx: 0, dy: 0, dz: 0, cav: 0, bruise: 0, lip: 0, lid: 0 };

/** Sculpt every grid vertex for one expression. */
export function sculpt(grid: FaceGrid, e: Expr): Sculpt {
  const n = grid.count;
  const out: Sculpt = {
    pos: new Float32Array(n * 3),
    cav: new Float32Array(n),
    bruise: new Float32Array(n),
    lip: new Float32Array(n),
    lid: new Float32Array(n),
  };
  const { base, normal } = grid;
  for (let v = 0; v < n; v++) {
    const i = v * 3;
    const th = v === 0 ? Math.PI : grid.theta[grid.col[v]];
    faceField(base[i], base[i + 1], normal[i + 2], th, e, field);
    out.pos[i] = base[i] + normal[i] * field.disp + field.dx;
    out.pos[i + 1] = base[i + 1] + normal[i + 1] * field.disp + field.dy;
    out.pos[i + 2] = base[i + 2] + normal[i + 2] * field.disp + field.dz;
    out.cav[v] = field.cav;
    out.bruise[v] = field.bruise;
    out.lip[v] = field.lip;
    out.lid[v] = field.lid;
  }
  return out;
}

const sp = new Float64Array(3);
const sn = new Float64Array(3);

/** Sculpted surface point (and base normal) at base (x, y) on the face, below the dome. */
export function facePointAt(x: number, y: number, e: Expr, outPos: Float64Array, outNormal: Float64Array): void {
  const u = uForY(y);
  const w = section(u, secTmp).w;
  const theta = Math.asin(Math.max(-1, Math.min(1, x / w)));
  basePoint(u, theta, sp);
  baseNormal(u, theta, sn);
  faceField(sp[0], sp[1], sn[2], theta, e, field);
  outPos[0] = sp[0] + sn[0] * field.disp + field.dx;
  outPos[1] = sp[1] + sn[1] * field.disp + field.dy;
  outPos[2] = sp[2] + sn[2] * field.disp + field.dz;
  outNormal.set(sn);
}
const secTmp: Section = { y: 0, w: 0, f: 0, b: 0, p: 2, zc: 0 };
