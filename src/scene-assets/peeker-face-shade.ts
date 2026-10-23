/**
 * Peeker face, part 3 of 3: baked unlit shading. The scene has no lights, so
 * everything the eye reads as form is written into RGBA vertex colours here:
 * a key light from the front (the viewer's side), cavity darkness (sockets and
 * the mouth go near-black), curvature occlusion in creases, a pale bone /
 * sickly skin with faint grey-green mottling, a few darker veins at the
 * temples, and a baked fresnel: the head always stares at the viewer, so the
 * base normal's z stands in for "facing the viewer" and the sides, temples,
 * crown and neck die into the dark (rgb and alpha) at no shader cost. Only the
 * brow ridge, cheekbones, nose bridge, chin and socket rims catch light. Noise and
 * masks use the BASE positions so the skin pattern does not swim between
 * expressions. Colours are linear (Three's vertex-colour convention).
 */
import type { FaceGrid } from './peeker-face-shape.js';
import type { Sculpt } from './peeker-face-sculpt.js';

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const lin = (r: number, g: number, b: number) => [toLin(r), toLin(g), toLin(b)] as const;

const SKIN = lin(0.87, 0.855, 0.8);
const MOTTLE = lin(0.62, 0.68, 0.6);
const BRUISE = lin(0.5, 0.47, 0.54);
const VEIN = lin(0.33, 0.39, 0.42);
const LIP = lin(0.6, 0.55, 0.56);
const VOID = lin(0.016, 0.018, 0.026);
/** Shadows lean blue-grey. */
const SHADOW_TINT = [0.8, 0.88, 1.0] as const;

/** Mostly from the front (where the player is), a little from above. */
const KEY = (() => {
  const x = 0.12, y = 0.25, z = 0.96;
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l] as const;
})();

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function sstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

const SEED = 0x5eed_face;
function hash(ix: number, iy: number, iz: number): number {
  let h = (Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(iz, 0x1b873593) ^ SEED) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967296) * 2 - 1;
}
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
/** Smooth seeded value noise in [-1, 1]. */
function noise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const u = fade(x - ix), v = fade(y - iy), w = fade(z - iz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const x00 = l(hash(ix, iy, iz), hash(ix + 1, iy, iz), u);
  const x10 = l(hash(ix, iy + 1, iz), hash(ix + 1, iy + 1, iz), u);
  const x01 = l(hash(ix, iy, iz + 1), hash(ix + 1, iy, iz + 1), u);
  const x11 = l(hash(ix, iy + 1, iz + 1), hash(ix + 1, iy + 1, iz + 1), u);
  return l(l(x00, x10, v), l(x01, x11, v), w);
}
function fbm(x: number, y: number, z: number): number {
  return (
    0.57 * noise3(x, y, z) + 0.29 * noise3(2.03 * x + 5.1, 2.03 * y - 1.7, 2.03 * z + 3.3) +
    0.14 * noise3(4.1 * x - 2.2, 4.1 * y + 7.4, 4.1 * z - 6.1)
  );
}

/** Curvature occlusion: >0 where a vertex sits below its grid neighbours (a crease). */
function concavity(grid: FaceGrid, pos: Float32Array, nrm: Float32Array, v: number): number {
  if (v === 0) return 0;
  const { cols, rows } = grid;
  const r = grid.row[v];
  const j = grid.col[v];
  const ids = [
    r - 1 === 0 ? 0 : 1 + (r - 2) * cols + j,
    1 + (r - 1) * cols + ((j + 1) % cols),
    1 + (r - 1) * cols + ((j + cols - 1) % cols),
    r + 1 < rows ? 1 + r * cols + j : -1,
  ];
  const px = pos[v * 3], py = pos[v * 3 + 1], pz = pos[v * 3 + 2];
  let ax = 0, ay = 0, az = 0, dist = 0, k = 0;
  for (const id of ids) {
    if (id < 0) continue;
    const qx = pos[id * 3] - px, qy = pos[id * 3 + 1] - py, qz = pos[id * 3 + 2] - pz;
    ax += qx;
    ay += qy;
    az += qz;
    dist += Math.hypot(qx, qy, qz);
    k++;
  }
  if (k === 0 || dist <= 0) return 0;
  return (ax * nrm[v * 3] + ay * nrm[v * 3 + 1] + az * nrm[v * 3 + 2]) / dist;
}

/** RGBA (linear) per vertex for one sculpted expression with its final normals. */
export function bakeColors(grid: FaceGrid, s: Sculpt, nrm: Float32Array): Float32Array {
  const n = grid.count;
  const out = new Float32Array(n * 4);
  const c = [0, 0, 0];
  for (let v = 0; v < n; v++) {
    const i = v * 3;
    const bx = grid.base[i], by = grid.base[i + 1], bz = grid.base[i + 2];
    const bnz = grid.normal[i + 2];
    const X = Math.abs(bx);

    // Albedo: pale bone skin, grey-green mottling, blotches, tints, temple veins.
    const mott = 0.32 * sstep(-0.05, 0.6, fbm(bx * 34, by * 34, bz * 34));
    const blot = 1 - 0.07 * fbm(bx * 95 + 11, by * 95 - 4, bz * 95 + 7);
    const temple =
      Math.exp(-(((X - 0.074) / 0.02) ** 2) / 2 - (((by - 0.05) / 0.03) ** 2) / 2) * sstep(-0.35, 0.15, bnz);
    const vn = Math.abs(noise3(bx * 26 + 3.7, by * 26, bz * 26 - 1.3) + 0.35 * noise3(bx * 58, by * 58 + 9.1, bz * 58));
    const vein = 0.62 * temple * (1 - sstep(0.02, 0.11, vn));
    const bruise = 0.45 * s.bruise[v];
    const lip = 0.35 * s.lip[v];
    for (let ch = 0; ch < 3; ch++) {
      let a = SKIN[ch] + (MOTTLE[ch] - SKIN[ch]) * mott;
      a *= blot;
      a += (BRUISE[ch] - a) * bruise;
      a += (LIP[ch] - a) * lip;
      a += (VEIN[ch] - a) * vein;
      c[ch] = a;
    }

    // Light: a tight key from the front, blue-grey shadows, crease occlusion;
    // the squeezed lids (lid mask) stay in the socket's shadow.
    const nx = nrm[i], ny = nrm[i + 1], nz = nrm[i + 2];
    const hl = clamp01((nx * KEY[0] + ny * KEY[1] + nz * KEY[2]) * 0.7 + 0.3);
    const light = (0.06 + 0.94 * Math.pow(hl, 2.6)) * (1 - 0.7 * s.lid[v]);
    const lap = concavity(grid, s.pos, nrm, v);
    const ao = lap > 0 ? 1 - Math.min(0.75, lap * 1.4) : 1 + Math.min(0.06, -lap * 0.2);
    // Baked fresnel: sides and temples, the crown and the neck below the chin
    // die into the near-black (linear factors: ~0.02 reads as black after sRGB
    // encoding), so no skull outline reads against the dark.
    // A soft elliptical vignette around the features turns the flat-fronted head
    // into a mask surfacing from the dark rather than a lit prop with an outline.
    const vy = by + 0.012;
    const vig = Math.hypot(bx / 0.058, vy / (vy > 0 ? 0.085 : 0.11));
    const edge =
      lerp(0.015, 1, sstep(0.3, 0.88, bnz)) * lerp(1, 0.015, sstep(0.05, 0.125, by)) * lerp(0.03, 1, sstep(-0.118, -0.102, by)) *
      lerp(1, 0.02, sstep(0.55, 1.05, vig));
    const cav = Math.pow(s.cav[v], 0.9) * 0.993;
    for (let ch = 0; ch < 3; ch++) {
      const tint = SHADOW_TINT[ch] + (1 - SHADOW_TINT[ch]) * light;
      const lit = c[ch] * light * tint * ao * edge;
      out[v * 4 + ch] = lit + (VOID[ch] - lit) * cav;
    }
    out[v * 4 + 3] =
      sstep(0.05, 0.55, bnz) * sstep(-0.128, -0.106, by) * (1 - sstep(0.095, 0.14, by)) * (1 - sstep(0.95, 1.3, vig));
  }
  return out;
}
