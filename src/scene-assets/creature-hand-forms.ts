/**
 * Geometry for the creature hand (creature-hand.scene-asset.ts): continuous
 * lofted phalanges with bony knuckle heads, the thin back of the hand and the
 * forearm as one lofted sleeve with displaced tendons/knuckles, and thick
 * overgrown nails. Pure and deterministic (no World, DOM or timers).
 *
 * Coordinates are hand/joint-local: +Y along the finger (toward the tip),
 * +Z out of the back of the hand (dorsal), -Z the palm.
 */

import { BufferAttribute, BufferGeometry } from '@iwsdk/core';
import { LoftSurface, makeRandom, type TubeSection } from './lib/hardsurface.js';

/** Cross-section in hand space: halfwidth w (X), dorsal d (+Z) and palmar p (-Z) extents. */
export interface HandSection {
  y: number;
  w: number;
  d: number;
  p: number;
  cx?: number;
  cz?: number;
  pow?: number;
}

function toTube(s: HandSection): TubeSection {
  // Tube (x, y, z) becomes hand (-x, z, y) in toHandSpace(), hence -cx.
  return { z: s.y, halfW: s.w, hUp: s.d, hDown: s.p, cx: -(s.cx ?? 0), cy: s.cz ?? 0, power: s.pow ?? 2.2 };
}

/** Proper rotation tube -> hand: sweep axis to +Y, tube "up" to +Z (dorsal). */
function toHandSpace(geo: BufferGeometry): BufferGeometry {
  geo.rotateX(-Math.PI / 2);
  geo.rotateY(Math.PI);
  return geo;
}

/** Linear interpolation of a section table at y (the loft itself is linear between sections). */
export function sectionAt(sections: readonly HandSection[], y: number): HandSection {
  const first = sections[0]!;
  const last = sections[sections.length - 1]!;
  if (y <= first.y) return first;
  if (y >= last.y) return last;
  for (let i = 1; i < sections.length; i++) {
    const b = sections[i]!;
    if (y > b.y) continue;
    const a = sections[i - 1]!;
    const t = (y - a.y) / (b.y - a.y || 1);
    const l = (u: number, v: number) => u + (v - u) * t;
    return { y, w: l(a.w, b.w), d: l(a.d, b.d), p: l(a.p, b.p), cx: l(a.cx ?? 0, b.cx ?? 0), cz: l(a.cz ?? 0, b.cz ?? 0) };
  }
  return last;
}

// ─── Phalanges ──────────────────────────────────────────────────────────────

/**
 * One phalanx of length L and radius r, joint-local (origin = the pivot it
 * hinges on). The proximal end is a dome centred on its own pivot, so it stays
 * buried inside the parent's knuckle head at any curl; a middle phalanx ends
 * in a bony head (dorsal ridge between two skin creases) that contains a
 * sphere around the child's pivot. A distal phalanx (tip) ends exactly at y = L.
 */
export function phalanxSections(L: number, r: number, tip: boolean): HandSection[] {
  const s: HandSection[] = [
    { y: -0.92 * r, w: 0.32 * r, d: 0.32 * r, p: 0.32 * r },
    { y: -0.55 * r, w: 0.84 * r, d: 0.84 * r, p: 0.84 * r },
    { y: 0, w: 1.0 * r, d: 1.0 * r, p: 0.98 * r },
    { y: 0.14 * L, w: 1.0 * r, d: 0.97 * r, p: 0.93 * r },
    { y: 0.4 * L, w: 0.88 * r, d: 0.9 * r, p: 0.82 * r, cz: 0.02 * r },
  ];
  if (!tip) {
    s.push(
      { y: 0.66 * L, w: 0.87 * r, d: 0.89 * r, p: 0.8 * r, cz: 0.02 * r },
      { y: L - 0.75 * r, w: 0.95 * r, d: 0.93 * r, p: 0.86 * r },
      { y: L - 0.45 * r, w: 1.02 * r, d: 0.95 * r, p: 0.9 * r },
      { y: L - 0.1 * r, w: 1.05 * r, d: 1.08 * r, p: 0.94 * r },
      { y: L + 0.25 * r, w: 1.0 * r, d: 0.97 * r, p: 0.93 * r },
      { y: L + 0.6 * r, w: 0.82 * r, d: 0.78 * r, p: 0.78 * r },
      { y: L + 0.9 * r, w: 0.36 * r, d: 0.34 * r, p: 0.34 * r },
    );
  } else {
    s.push(
      { y: 0.62 * L, w: 0.9 * r, d: 0.74 * r, p: 0.88 * r, cz: -0.04 * r },
      { y: 0.8 * L, w: 0.88 * r, d: 0.66 * r, p: 0.9 * r, cz: -0.06 * r },
      { y: 0.92 * L, w: 0.72 * r, d: 0.52 * r, p: 0.72 * r, cz: -0.06 * r },
      { y: 0.98 * L, w: 0.42 * r, d: 0.3 * r, p: 0.44 * r },
      { y: L, w: 0.12 * r, d: 0.1 * r, p: 0.12 * r },
    );
  }
  return s;
}

export function phalanxGeometry(L: number, r: number, tip: boolean, segments = 10): BufferGeometry {
  const s = phalanxSections(L, r, tip);
  const geo = LoftSurface.tube(s.map(toTube)).build(
    s.map((q) => q.y),
    segments,
    true,
  );
  return toHandSpace(geo);
}

// ─── Nails ──────────────────────────────────────────────────────────────────

export interface NailGeometry {
  geo: BufferGeometry;
  /** Joint-local x of the crack (and the chip in the free edge). */
  crackX: number;
  /** Joint-local y where the nail starts (under the cuticle) and ends (free edge). */
  y0: number;
  y1: number;
}

/**
 * A thick, overgrown nail for the distal phalanx (length L, radius r) in that
 * joint's local frame: rooted under a cuticle on the dorsal surface, leaving
 * the finger near the tip and curling slightly down `ext` past it, curved
 * across like a real nail, with one chip broken out of the free edge.
 */
export function nailGeometry(L: number, r: number, ext: number, seed: number): NailGeometry {
  const tip = phalanxSections(L, r, true);
  const surf = (y: number) => {
    const s = sectionAt(tip, y);
    return (s.cz ?? 0) + s.d;
  };
  const rnd = makeRandom(seed);
  const y0 = 0.4 * L;
  const z2 = surf(0.72 * L) + 0.0004;
  const st: HandSection[] = [
    { y: y0, w: 0.5 * r, d: 0.00025, p: 0.00025, cz: surf(y0) - 0.0004, pow: 3 },
    { y: 0.52 * L, w: 0.66 * r, d: 0.0005, p: 0.0005, cz: surf(0.52 * L) + 0.0003, pow: 3 },
    { y: 0.72 * L, w: 0.72 * r, d: 0.0006, p: 0.0006, cz: z2, pow: 3 },
    { y: L - 0.0004, w: 0.7 * r, d: 0.00065, p: 0.00065, cz: z2 - 0.0002, pow: 3 },
    { y: L + 0.5 * ext, w: 0.6 * r, d: 0.0006, p: 0.0006, cz: z2 - 0.001, pow: 3 },
    { y: L + ext, w: 0.36 * r, d: 0.00045, p: 0.00045, cz: z2 - 0.0026, pow: 3 },
  ];
  const geo = toHandSpace(
    LoftSurface.tube(st.map(toTube)).build(
      st.map((q) => q.y),
      12,
      true,
    ),
  );
  // Crack/chip sits on a vertex column (x = 0 or about +-0.7 of the half-width).
  const pick = rnd();
  const crackX = pick < 0.34 ? 0 : (pick < 0.67 ? -0.5 : 0.5) * r;
  const pos = geo.getAttribute('position') as BufferAttribute;
  const yChip = L + 0.35 * ext;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    let y = pos.getY(i);
    // Transverse C-curve: the edges wrap down around the finger.
    const z = pos.getZ(i) - 75 * x * x;
    if (y > yChip) {
      const g = Math.exp(-((x - crackX) * (x - crackX)) / (2 * 0.0011 * 0.0011));
      y -= 0.0019 * g * Math.min(1, (y - yChip) / (0.65 * ext));
    }
    pos.setXYZ(i, x, y, z);
  }
  geo.computeVertexNormals();
  return { geo, crackX, y0, y1: L + ext };
}

// ─── Back of the hand + forearm (one lofted sleeve, split into two meshes) ─

/** Wrist ring where the sleeve splits into Hand/Back (above) and Hand/Forearm (below). */
export const WRIST_Y = -0.095;

const ARM: HandSection[] = [
  { y: -0.42, w: 0.03, d: 0.0215, p: 0.0235, cx: 0.002 },
  { y: -0.3, w: 0.029, d: 0.0205, p: 0.022, cx: 0.0015 },
  { y: -0.2, w: 0.0268, d: 0.0178, p: 0.019, cx: 0.001, pow: 2.25 },
  { y: -0.135, w: 0.0245, d: 0.0142, p: 0.0152, cx: 0.0005, pow: 2.3 },
  { y: WRIST_Y, w: 0.0238, d: 0.0124, p: 0.0134, pow: 2.4 },
  { y: -0.08, w: 0.0285, d: 0.0124, p: 0.0138, cx: -0.0025, pow: 2.35 },
  { y: -0.064, w: 0.037, d: 0.0124, p: 0.0138, cx: -0.0065, pow: 2.3 },
  { y: -0.048, w: 0.0445, d: 0.0124, p: 0.0136, cx: -0.0098, pow: 2.3 },
  { y: -0.034, w: 0.044, d: 0.0121, p: 0.0128, cx: -0.0062, pow: 2.3 },
  // The slab thins toward the knuckle line to ~1.15x the proximal radius, so
  // the fingers leave it under the knuckle bumps instead of from under a ledge.
  { y: -0.018, w: 0.0432, d: 0.0109, p: 0.0113, cx: -0.0022, pow: 2.35 },
  { y: -0.004, w: 0.0428, d: 0.0094, p: 0.0096, pow: 2.4 },
  { y: 0.004, w: 0.041, d: 0.0086, p: 0.0087, pow: 2.4 },
  { y: 0.009, w: 0.036, d: 0.0064, p: 0.0065, pow: 2.4 },
  { y: 0.013, w: 0.027, d: 0.0033, p: 0.0033, pow: 2.3 },
  // Knuckle roll closes to a line between the finger roots (no cap, no hole).
  { y: 0.0155, w: 0.01, d: 0, p: 0, pow: 2.2 },
];
/** The arm is baked black and discarded below about -0.165 (creature-hand-skin.ts), so the sleeve stops at -0.19. */
const ARM_ALONGS = [
  -0.19, -0.165, -0.14, -0.115, WRIST_Y, -0.087, -0.079, -0.071, -0.064, -0.056, -0.048, -0.04, -0.032, -0.024,
  -0.016, -0.009, -0.003, 0.002, 0.0065, 0.0105, 0.0135, 0.0155,
];

const gauss = (d2: number, s: number) => Math.exp(-d2 / (2 * s * s));
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** Squared XY distance from (x, y) to segment a-b, and the segment parameter. */
function segDist2(x: number, y: number, ax: number, ay: number, bx: number, by: number): [number, number] {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  const ex = x - (ax + dx * t);
  const ey = y - (ay + dy * t);
  return [ex * ex + ey * ey, t];
}

const KNUCKLE_H = [0.004, 0.0043, 0.0038, 0.003];
const TENDON_WRIST_X = [-0.011, -0.004, 0.004, 0.011];

/**
 * Bony relief of the back of the hand (metres along the normal): knuckle heads,
 * metacarpal tendons with gaunt hollows between them, the thumb's metacarpal
 * ridge and mound around the thumb root, and the wrist's ulnar bump.
 */
export function handRelief(
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
  fingerX: readonly number[],
  thumb: readonly number[],
): number {
  const dorsal = smooth(0.15, 0.75, nz);
  const front = smooth(-0.2, 0.6, nz + 0.8 * ny);
  let h = 0;
  for (let i = 0; i < 4; i++) {
    const fx = fingerX[i] ?? 0;
    const kx = (x - fx) / 0.0058;
    const ky = (y - 0.0005) / 0.0065;
    h += (KNUCKLE_H[i] ?? 0) * front * Math.exp(-0.5 * (kx * kx + ky * ky));
    const [d2, t] = segDist2(x, y, TENDON_WRIST_X[i] ?? 0, -0.09, fx, -0.004);
    h += 0.0011 * dorsal * smooth(0, 0.3, t) * (1 - 0.35 * t) * gauss(d2, 0.0024);
    if (i < 3) {
      const nfx = fingerX[i + 1] ?? 0;
      const wx = 0.5 * ((TENDON_WRIST_X[i] ?? 0) + (TENDON_WRIST_X[i + 1] ?? 0));
      const [h2, u] = segDist2(x, y, wx, -0.075, 0.5 * (fx + nfx), -0.006);
      h -= 0.0011 * dorsal * Math.sin(Math.PI * u) * gauss(h2, 0.0035);
    }
  }
  const tx = thumb[0] ?? 0;
  const ty = thumb[1] ?? 0;
  const tz = thumb[2] ?? 0;
  const [r2, u] = segDist2(x, y, -0.02, -0.086, tx + 0.002, ty);
  h += 0.0038 * smooth(0, 0.35, u) * gauss(r2, 0.0085);
  h += 0.0012 * smooth(0, 0.7, nz - 0.6 * nx) * gauss(r2, 0.003);
  h += 0.0022 * gauss((x - tx) ** 2 + (y - ty) ** 2 + (z - tz) ** 2, 0.006);
  h += 0.0022 * gauss((x - 0.0215) ** 2 + (y + 0.094) ** 2 + (z - 0.004) ** 2, 0.0045);
  return h;
}

/** Copy the triangles whose centroid lies above (or below) yCut into a new indexed geometry. */
function splitByY(geo: BufferGeometry, yCut: number, above: boolean): BufferGeometry {
  const index = geo.index;
  const pos = geo.getAttribute('position') as BufferAttribute;
  const remap = new Int32Array(pos.count).fill(-1);
  const tris: number[] = [];
  let used = 0;
  if (index) {
    for (let t = 0; t < index.count; t += 3) {
      const a = index.getX(t);
      const b = index.getX(t + 1);
      const c = index.getX(t + 2);
      if ((pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3 > yCut !== above) continue;
      for (const v of [a, b, c]) {
        if ((remap[v] ?? -1) < 0) remap[v] = used++;
        tris.push(remap[v] ?? 0);
      }
    }
  }
  const out = new BufferGeometry();
  for (const name of Object.keys(geo.attributes)) {
    const src = geo.getAttribute(name) as BufferAttribute;
    const n = src.itemSize;
    const arr = new Float32Array(used * n);
    for (let v = 0; v < pos.count; v++) {
      const m = remap[v] ?? -1;
      if (m < 0) continue;
      for (let k = 0; k < n; k++) arr[m * n + k] = src.getComponent(v, k);
    }
    out.setAttribute(name, new BufferAttribute(arr, n));
  }
  out.setIndex(tris);
  return out;
}

export interface ArmGeometry {
  back: BufferGeometry;
  forearm: BufferGeometry;
}

/**
 * The back of the hand and the forearm, lofted as one sleeve (so the wrist has
 * no seam), relief-displaced, then split at WRIST_Y into two meshes that share
 * the wrist ring exactly. Each keeps a 'relief' attribute (metres) for baking.
 */
export function armGeometry(fingerX: readonly number[], thumb: readonly number[], segments = 36): ArmGeometry {
  const surface = LoftSurface.tube(ARM.map(toTube));
  const geo = surface.build(ARM_ALONGS, segments, false);
  const pos = geo.getAttribute('position') as BufferAttribute;
  // Re-space every ring by weighted arc length: uniform angles starve the wide,
  // flat back of the hand, and the tendons need columns there (dorsal = tube up).
  const N = 180;
  const acc = new Float64Array(N + 1);
  for (let r = 0; r < ARM_ALONGS.length; r++) {
    const z = ARM_ALONGS[r] ?? 0;
    let prev = surface.point(z, 0);
    for (let k = 1; k <= N; k++) {
      const t = (k / N) * Math.PI * 2;
      const pt = surface.point(z, t);
      acc[k] = (acc[k - 1] ?? 0) + pt.distanceTo(prev) * (Math.sin(t - Math.PI / N) > 0 ? 1.5 : 0.7);
      prev = pt;
    }
    const total = acc[N] ?? 1;
    let k = 1;
    for (let j = 0; j < segments; j++) {
      const target = (j / segments) * total;
      while (k < N && (acc[k] ?? 0) < target) k++;
      const a = acc[k - 1] ?? 0;
      const b = acc[k] ?? 0;
      const f = b > a ? (target - a) / (b - a) : 0;
      const pt = surface.point(z, ((k - 1 + f) / N) * Math.PI * 2);
      pos.setXYZ(r * segments + j, pt.x, pt.y, pt.z);
    }
  }
  toHandSpace(geo);
  geo.computeVertexNormals();
  const nrm = geo.getAttribute('normal') as BufferAttribute;
  const relief = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = nrm.getX(i);
    const ny = nrm.getY(i);
    const nz = nrm.getZ(i);
    // Fade out before the knuckle roll closes, so the closing line never opens.
    const h = handRelief(x, y, z, nx, ny, nz, fingerX, thumb) * (1 - smooth(0.011, 0.0155, y));
    pos.setXYZ(i, x + nx * h, y + ny * h, z + nz * h);
    relief[i] = h;
  }
  geo.setAttribute('relief', new BufferAttribute(relief, 1));
  geo.computeVertexNormals();
  return { back: splitByY(geo, WRIST_Y, true), forearm: splitByY(geo, WRIST_Y, false) };
}
