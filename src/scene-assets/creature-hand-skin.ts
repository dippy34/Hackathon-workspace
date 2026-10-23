/**
 * Baked look of the creature hand: RGBA vertex colours (grey-bone skin, pale
 * knuckle ridges, creases, cavity/AO from neighbouring fingers, mottled
 * bruising, yellowed cracked nails, the forearm's colour fade into the dark)
 * plus one shared unlit material. Pure and deterministic.
 */

import { BufferAttribute, type BufferGeometry, Color, type Matrix4, MeshBasicMaterial, Vector3, Vector4 } from '@iwsdk/core';

// Quiet-dread palette (sRGB hex; Color converts to linear).
const SKIN = new Color(0xb7b2a5);
const PALM = new Color(0x9a9489);
const KNUCKLE = new Color(0xd2cbb9);
const BRUISE = new Color(0x5e5566);
const JAUNDICE = new Color(0xa39d74);
const NAIL_BED = new Color(0x6a5e62);
const CAVITY = new Color(0x1b1e26);
const NAIL = new Color(0xa39a80);
const NAIL_ROOT = new Color(0x574d40);
const NAIL_EDGE = new Color(0xbcb08e);
const CRACK = new Color(0x2f2922);

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const bump = (d: number, s: number) => Math.exp(-(d * d) / (2 * s * s));

function hash3(i: number, j: number, k: number, seed: number): number {
  let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(k, 0x9e3779b1) ^ Math.imul(seed, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Deterministic trilinear value noise in [0, 1). */
export function valueNoise(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fy = y - yi;
  const fz = z - zi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const w = fz * fz * (3 - 2 * fz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (a: number, b: number, d: number) => hash3(xi + a, yi + b, zi + d, seed);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}

/**
 * Rest-pose distance field of the hand (capsules per phalanx, a rounded box
 * for the back, a capsule for the forearm), used only to bake ambient
 * occlusion: a vertex is darkened by the parts of OTHER groups near it.
 */
export class HandAoField {
  private readonly caps: number[] = [];
  private readonly boxes: number[] = [];

  addCapsule(a: Vector3, b: Vector3, r: number, group: number): void {
    this.caps.push(a.x, a.y, a.z, b.x, b.y, b.z, r, group);
  }

  addRoundBox(c: Vector3, half: Vector3, r: number, group: number): void {
    this.boxes.push(c.x, c.y, c.z, half.x - r, half.y - r, half.z - r, r, group);
  }

  /** only: -1 = every group, 0 = the hand/arm group only, 1 = the finger groups only. */
  sdf(x: number, y: number, z: number, skip: number, only = -1): number {
    let d = 1e9;
    const C = this.caps;
    for (let i = 0; i < C.length; i += 8) {
      const g = C[i + 7]!;
      if (g === skip || (only === 0 && g !== 0) || (only === 1 && g === 0)) continue;
      const ax = C[i]!, ay = C[i + 1]!, az = C[i + 2]!;
      const bx = C[i + 3]! - ax, by = C[i + 4]! - ay, bz = C[i + 5]! - az;
      const px = x - ax, py = y - ay, pz = z - az;
      const t = Math.min(1, Math.max(0, (px * bx + py * by + pz * bz) / (bx * bx + by * by + bz * bz)));
      d = Math.min(d, Math.hypot(px - bx * t, py - by * t, pz - bz * t) - C[i + 6]!);
    }
    const B = this.boxes;
    for (let i = 0; i < B.length; i += 8) {
      const g = B[i + 7]!;
      if (g === skip || (only === 0 && g !== 0) || (only === 1 && g === 0)) continue;
      const qx = Math.abs(x - B[i]!) - B[i + 3]!;
      const qy = Math.abs(y - B[i + 1]!) - B[i + 4]!;
      const qz = Math.abs(z - B[i + 2]!) - B[i + 5]!;
      const out = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
      d = Math.min(d, out + Math.min(Math.max(qx, qy, qz), 0) - B[i + 6]!);
    }
    return d;
  }

  /**
   * 0.2 (buried) .. 1 (open) along normal n at hand-space point p. A finger
   * (skip > 0) takes the full cavity from the hand and arm, but its
   * neighbouring fingers only shade it down to FINGER_AO_FLOOR, so the flanks
   * the splayed/curled poses expose do not bake two-tone.
   */
  ao(p: Vector3, n: Vector3, skip: number): number {
    if (skip === 0) return this.aoOf(p, n, skip, -1);
    return Math.min(this.aoOf(p, n, skip, 0), Math.max(FINGER_AO_FLOOR, this.aoOf(p, n, skip, 1)));
  }

  private aoOf(p: Vector3, n: Vector3, skip: number, only: number): number {
    let occ = 0;
    for (let i = 0; i < 4; i++) {
      const d = AO_STEP[i] ?? 0.01;
      const s = this.sdf(p.x + n.x * d, p.y + n.y * d, p.z + n.z * d, skip, only);
      occ += (AO_WEIGHT[i] ?? 0) * Math.min(1, Math.max(0, (d - s) / d));
    }
    return Math.min(1, Math.max(0.2, 1 - 1.15 * occ));
  }
}
const AO_STEP = [0.002, 0.004, 0.007, 0.011];
const AO_WEIGHT = [0.4, 0.3, 0.2, 0.1];
const FINGER_AO_FLOOR = 0.65;

export interface SkinBake {
  /** 'arm': back of hand + forearm (hand space, carries 'relief'); 'mid': a phalanx with a knuckle head; 'tip': a distal phalanx under a nail. */
  kind: 'arm' | 'mid' | 'tip';
  /** Phalanx length and radius (ignored for 'arm'). */
  L: number;
  r: number;
  /** AO field group of this part; its own primitives are skipped. */
  group: number;
  /** Rig seed: the mottling is one hand-space field, continuous across parts. */
  seed: number;
}

/** Bake RGBA vertex colours into geo; toHand maps the mesh's local space to rest-pose hand space. */
export function bakeSkin(geo: BufferGeometry, toHand: Matrix4, field: HandAoField, o: SkinBake): void {
  const pos = geo.getAttribute('position') as BufferAttribute;
  const nrm = geo.getAttribute('normal') as BufferAttribute;
  const relief = geo.getAttribute('relief') as BufferAttribute | undefined;
  const rgba = new Float32Array(pos.count * 4);
  const p = new Vector3();
  const n = new Vector3();
  const c = new Color();
  const { L, r } = o;
  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i);
    const ly = pos.getY(i);
    const nlz = nrm.getZ(i);
    p.set(lx, ly, pos.getZ(i)).applyMatrix4(toHand);
    n.set(nrm.getX(i), nrm.getY(i), nlz).transformDirection(toHand);
    // The palm side is darker on the hand; on the fingers only half as much (curled poses show it).
    if (o.kind === 'arm') c.copy(PALM).lerp(SKIN, smooth(-0.5, 0.6, nlz));
    else c.copy(SKIN).lerp(PALM, 0.5 * (1 - smooth(-0.5, 0.6, nlz)));
    const dz = smooth(0.1, 0.6, nlz);
    const pz = smooth(0.2, 0.7, -nlz);
    let f = 1;
    let alpha = 1;
    if (o.kind === 'arm') {
      const rel = relief ? relief.getX(i) : 0;
      // Bone shows pale on knuckles and tendons; the gaunt hollows sink darker.
      if (rel > 0) c.lerp(KNUCKLE, Math.min(1, rel / 0.0035) * 0.55 * dz);
      f *= 1 + Math.max(-1, Math.min(1, rel / 0.0025)) * 0.16;
      // The arm dissolves into the dark right below the wrist: colour to black,
      // and alpha only for the hard alphaTest discard at the very end (the material is opaque).
      alpha = smooth(-0.17, -0.06, ly);
      f *= 0.6 + 0.4 * alpha;
    } else {
      // No two joints match: crease strength varies +-15% per phalanx.
      const vary = 0.85 + 0.3 * hash3(o.group, Math.round(L * 1e5), Math.round(r * 1e5), o.seed + 41);
      // Palmar flexion crease at the base of every phalanx.
      f *= 1 - 0.12 * vary * pz * bump(ly - 0.05 * L, 0.1 * L);
      if (o.kind === 'mid') {
        // Dorsal knuckle: a faint pale bony ridge between two transverse skin creases.
        c.lerp(KNUCKLE, 0.35 * dz * bump(ly - (L - 0.1 * r), 0.22 * r));
        // Broken wrinkles rather than rings: modulated by fine noise and kept on top of the joint.
        const wrinkle = smooth(0.35, 0.9, nlz) * (0.35 + 0.9 * valueNoise(p.x * 700, p.y * 700, p.z * 700, o.seed + 21));
        f *= 1 - 0.2 * vary * wrinkle * (bump(ly - (L - 0.45 * r), 0.1 * r) + bump(ly - (L + 0.25 * r), 0.1 * r));
        f *= 1 - 0.15 * vary * pz * bump(ly - (L - 0.2 * r), 0.3 * r);
      } else {
        // Dark nail bed: shows at the cuticle and the lateral folds around the nail.
        const bed =
          dz * smooth(0.3 * L, 0.42 * L, ly) * (1 - smooth(0.95 * L, L, ly)) * (1 - smooth(0.7 * r, 0.95 * r, Math.abs(lx)));
        c.lerp(NAIL_BED, 0.75 * bed);
      }
    }
    // Faint mottled bruising, one seeded field in rest-pose hand space.
    const m = valueNoise(p.x * 42 + 3.1, p.y * 42, p.z * 42, o.seed);
    const bruise = smooth(0.58, 0.8, m);
    c.lerp(BRUISE, 0.5 * bruise);
    c.lerp(JAUNDICE, 0.28 * smooth(0.46, 0.58, m) * (1 - bruise));
    f *= 0.86 + 0.16 * valueNoise(p.x * 90, p.y * 90, p.z * 90, o.seed + 7) + 0.08 * valueNoise(p.x * 190, p.y * 190, p.z * 190, o.seed + 13);
    // Baked cavity: darker between the fingers and where they leave the hand.
    const ao = 1 - 0.85 * (1 - field.ao(p, n, o.group));
    c.multiplyScalar(f * ao).lerp(CAVITY, (1 - ao) * 0.3);
    rgba[i * 4] = c.r;
    rgba[i * 4 + 1] = c.g;
    rgba[i * 4 + 2] = c.b;
    rgba[i * 4 + 3] = alpha;
  }
  geo.setAttribute('color', new BufferAttribute(rgba, 4));
  if (relief) geo.deleteAttribute('relief');
}

/** Yellow-grey nail: dark cuticle root, ridged streaks, a dark crack, a yellowed broken free edge, grime underneath. */
export function bakeNail(geo: BufferGeometry, y0: number, y1: number, L: number, crackX: number, seed: number): void {
  const pos = geo.getAttribute('position') as BufferAttribute;
  const nrm = geo.getAttribute('normal') as BufferAttribute;
  const rgba = new Float32Array(pos.count * 4);
  const c = new Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const t = Math.min(1, Math.max(0, (y - y0) / (y1 - y0)));
    c.copy(NAIL).lerp(NAIL_ROOT, 1 - smooth(0.04, 0.22, t));
    c.lerp(NAIL_EDGE, 0.8 * smooth(L - 0.001, L + 0.003, y));
    c.lerp(CRACK, 0.8 * bump(x - crackX, 0.0007) * smooth(0.3, 0.65, t));
    let f = 0.84 + 0.3 * valueNoise(x * 1400 + seed * 3.7, seed * 0.37, 0.5, seed);
    if (nrm.getZ(i) < -0.3) f *= 0.4;
    f *= 1 - 0.35 * smooth(0.85, 1, t);
    c.multiplyScalar(f);
    rgba[i * 4] = c.r;
    rgba[i * 4 + 1] = c.g;
    rgba[i * 4 + 2] = c.b;
    rgba[i * 4 + 3] = 1;
  }
  geo.setAttribute('color', new BufferAttribute(rgba, 4));
}

/** Per-material shader inputs of the hand (the threat writes them each frame; no allocation). */
export interface HandShadeUniforms {
  /**
   * The 'desk shadow': colour *= s * s with s = clamp(dot(xyz, worldPos) + w, 0, 1).
   * (0, 0, 0, 1) switches it off (the default, so previews are unchanged).
   */
  uShadePlane: { value: Vector4 };
  /** 0 = the dim top-light look in the dark, 1 = the flat frontal response in the flashlight beam. */
  uHsLit: { value: number };
  /** Presence 0..1: 0 sinks the whole hand into uHsFloor (fade in/out without alpha blending). */
  uHsFade: { value: number };
  /**
   * The darkest tone (linear): what the forearm fade, the desk shadow and uHsFade sink into.
   * Black by default; the threat sets about the darkness shell's own colour so only a faint silhouette remains.
   */
  uHsFloor: { value: Color };
}

/**
 * The hand's one shared material: unlit (no scene lights exist), RGBA vertex
 * colours, OPAQUE (the threat fades it with uHsFade toward uHsFloor and dims
 * it with material.color, so the buried knuckle domes never show through as
 * they would with alpha blending across 16 sorted meshes). The baked colours carry the albedo,
 * creases and cavity; onBeforeCompile adds the light in VIEW space so it stays
 * right however far the fingers curl: in the dark a steep key from above the
 * viewer (only top-facing knuckles, nails and the silhouette rim catch it; the
 * flat back sinks), blended by uHsLit toward the old frontal headlamp look for
 * the beam; then the forearm's vertex alpha, the desk-shadow plane and uHsFade
 * all sink it into uHsFloor. alphaTest is only the hard discard of the fully
 * faded forearm.
 */
export function createHandMaterial(): { material: MeshBasicMaterial; shade: HandShadeUniforms } {
  const material = new MeshBasicMaterial({ vertexColors: true, transparent: false, depthWrite: true, alphaTest: 0.01 });
  material.name = 'CreatureHandSkin';
  const shade: HandShadeUniforms = {
    uShadePlane: { value: new Vector4(0, 0, 0, 1) },
    uHsLit: { value: 0 },
    uHsFade: { value: 1 },
    uHsFloor: { value: new Color(0, 0, 0) },
  };
  material.userData.handShade = shade;
  const vary = 'varying vec3 vHsN;\nvarying vec3 vHsV;\nvarying vec3 vHsW;';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uShadePlane = shade.uShadePlane;
    shader.uniforms.uHsLit = shade.uHsLit;
    shader.uniforms.uHsFade = shade.uHsFade;
    shader.uniforms.uHsFloor = shade.uHsFloor;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vary}`)
      .replace(
        '#include <project_vertex>',
        [
          '#include <project_vertex>',
          'vHsN = normalize( normalMatrix * normal );',
          'vHsV = -mvPosition.xyz;',
          'vHsW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
        ].join('\n'),
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n${vary}\nuniform vec4 uShadePlane;\nuniform float uHsLit;\nuniform float uHsFade;\nuniform vec3 uHsFloor;`,
      )
      .replace(
        '#include <color_fragment>',
        [
          '#include <color_fragment>',
          '{',
          '  vec3 hsN = normalize( vHsN );',
          '  float hsKey = clamp( ( dot( hsN, vec3( 0.17, 0.5, 0.85 ) ) + 0.35 ) / 1.35, 0.0, 1.0 );',
          '  float hsRim = pow( 1.0 - clamp( dot( hsN, normalize( vHsV ) ), 0.0, 1.0 ), 3.0 );',
          '  float hsDark = 0.08 + 0.92 * hsKey * hsKey * hsKey + 0.3 * hsRim;',
          '  float hsLit = 0.26 + 0.74 * hsKey * hsKey + 0.1 * hsRim;',
          '  float hsS = clamp( dot( uShadePlane.xyz, vHsW ) + uShadePlane.w, 0.0, 1.0 );',
          '  vec3 hsRgb = diffuseColor.rgb * mix( hsDark, hsLit, uHsLit );',
          '  diffuseColor.rgb = mix( uHsFloor, hsRgb, hsS * hsS * diffuseColor.a * uHsFade );',
          '}',
        ].join('\n'),
      );
  };
  return { material, shade };
}
