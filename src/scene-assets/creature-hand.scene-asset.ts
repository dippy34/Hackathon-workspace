import { BufferAttribute, BufferGeometry, Group, Matrix4, Mesh, type MeshBasicMaterial, Object3D, Vector3 } from '@iwsdk/core';
import { armGeometry, nailGeometry, phalanxGeometry } from './creature-hand-forms.js';
import {
  HandAoField,
  type HandShadeUniforms,
  bakeNail,
  bakeSkin,
  createHandMaterial,
  type SkinBake,
} from './creature-hand-skin.js';

// ─── Joint contract (metres, hand-local: +Y = fingers, +Z = back of the hand) ─
// Single source of truth for the threats' animations (src/threats/under-desk.ts).

/** Phalanx lengths: proximal, middle, distal. Deliberately too long. */
export const SEG_LEN = [0.068, 0.05, 0.036] as const;
export const SEG_RADIUS = [0.0076, 0.0066, 0.0056] as const;
/** Index → pinky along the knuckle line. The thumb sits on the -X side. */
export const FINGER_X = [-0.031, -0.0105, 0.0105, 0.03] as const;
export const FINGER_SCALE = [0.95, 1.07, 1.0, 0.8] as const;
/**
 * Rest splay of each proximal joint (its rotation.z). Note the sign: these
 * draw the fingertips slightly TOGETHER; spreading a finger outward means
 * moving its rotation.z against the sign of its FINGER_SPLAY.
 */
export const FINGER_SPLAY = [-0.07, -0.022, 0.025, 0.08] as const;
export const THUMB_LEN = [0.044, 0.033] as const;
export const THUMB_RADIUS = [0.0086, 0.0071] as const;
/** The thumb's proximal joint, hand-local. */
export const THUMB_ROOT = [-0.042, -0.048, 0.006] as const;
/** How far each overgrown nail reaches past its fingertip: index..pinky, then the thumb. */
export const NAIL_EXT = [0.0062, 0.0068, 0.0065, 0.0052, 0.006] as const;
/** Mild hook used by the manifest prototype so previews show the curled joints. */
export const PREVIEW_CURL = [-0.55, -0.5, -0.32] as const;

/** Phalanx radius of finger i, joint k (the short pinky is a little thinner). */
export function fingerRadius(i: number, k: number): number {
  return (SEG_RADIUS[k] ?? 0.006) * (0.82 + 0.18 * (FINGER_SCALE[i] ?? 1));
}

/**
 * Named meshes (Hand/Back, Hand/Forearm, Finger0..3/.../Seg0..2, Thumb/.../Seg0..1).
 * Each nail is merged into its distal segment (Finger0..3/Joint1/Joint2/Seg2 and
 * Thumb/Joint1/Seg1): same joint, same material, one draw.
 */
export interface CreatureHandParts {
  back: Mesh;
  forearm: Mesh;
  /** fingerSegs[i][k] hangs under fingers[i][k]; fingerSegs[i][2] carries the nail. */
  fingerSegs: Mesh[][];
  /** thumbSegs[1] carries the thumbnail. */
  thumbSegs: Mesh[];
}

/**
 * The creature hand shared by Under the Desk (and the Peeker's hand on the
 * glass). Joint contract used by the threat animations:
 * - `hand`: the hand root (origin at the knuckle line, +Y toward the fingertips,
 *   +Z out of the back of the hand);
 * - `fingers[i][k]`: index..pinky (i = 0..3), proximal..distal joints (k = 0..2);
 *   each child joint sits at +Y of its parent; rotation.x curls (negative toward
 *   the palm), rotation.z splays;
 * - `thumb[k]`: two joints, same convention;
 * - `material`: shared unlit OPAQUE material; the threat dims it with
 *   material.color, never opacity;
 * - `shade`: that material's uniforms: setCreatureHandShade (desk shadow),
 *   uHsLit (beam response), uHsFade (presence) and uHsFloor (the dark it sinks into).
 */
export interface CreatureHandRig {
  root: Group;
  hand: Group;
  fingers: Object3D[][];
  thumb: Object3D[];
  material: MeshBasicMaterial;
  shade: HandShadeUniforms;
  parts: CreatureHandParts;
}

/**
 * The 'desk shadow': below the world-horizontal plane at `height` the hand
 * fades to black within `depth` metres (it is at full value `lift` metres
 * above the plane), so whatever crests the desk edge catches the light and
 * the rest sinks into the dark. Allocation-free; call it every frame if needed.
 */
export function setCreatureHandShade(rig: CreatureHandRig, height: number, depth: number, lift: number): void {
  const k = 1 / Math.max(1e-4, depth + lift);
  rig.shade.uShadePlane.value.set(0, k, 0, (depth - height) * k);
}

/** Switch the desk shadow off (the default). */
export function clearCreatureHandShade(rig: CreatureHandRig): void {
  rig.shade.uShadePlane.value.set(0, 0, 0, 1);
}

export interface CreatureHandOptions {
  /** Render order of every mesh (default 20 = RENDER_ORDER.body in threats/common.ts). */
  renderOrder?: number;
  /** Seed of the mottling and the nail cracks. */
  seed?: number;
}

/** Curl every finger by the same joint angles (rotation.x) at its rest splay, and set the thumb. */
export function poseCreatureHand(
  rig: CreatureHandRig,
  curl: readonly number[],
  thumbCurl: number,
  thumbOut: number,
): void {
  for (let i = 0; i < rig.fingers.length; i++) {
    const j = rig.fingers[i];
    if (!j) continue;
    j[0]?.rotation.set(curl[0] ?? 0, 0, FINGER_SPLAY[i] ?? 0);
    if (j[1]) j[1].rotation.x = curl[1] ?? 0;
    if (j[2]) j[2].rotation.x = curl[2] ?? 0;
  }
  rig.thumb[0]?.rotation.set(thumbCurl, 0, thumbOut);
  if (rig.thumb[1]) rig.thumb[1].rotation.x = -0.35;
}

const AO_ARM = 0;
/** The thumb's root is buried in the thenar mound, so it skips the arm's occluders (else its knuckle bakes black). */
const AO_THUMB = AO_ARM;
/** Thumb rest pose (curl, out) the skin is baked in: out to the side, under the palm. */
const THUMB_REST = [-0.9, 0.5] as const;
/** The cavity is baked with the fingers spread apart (this many times FINGER_SPLAY: negative = outward), as the poses spread them. */
const BAKE_SPLAY = -1.5;

/** Append b's triangles to a (same local space): only the attributes both carry survive. */
function mergeInto(a: BufferGeometry, b: BufferGeometry): BufferGeometry {
  const out = new BufferGeometry();
  const na = a.getAttribute('position').count;
  const nb = b.getAttribute('position').count;
  for (const name of Object.keys(a.attributes)) {
    const sa = a.getAttribute(name) as BufferAttribute;
    const sb = b.getAttribute(name) as BufferAttribute | undefined;
    if (!sb || sb.itemSize !== sa.itemSize) continue;
    const n = sa.itemSize;
    const arr = new Float32Array((na + nb) * n);
    for (let v = 0; v < na; v++) for (let k = 0; k < n; k++) arr[v * n + k] = sa.getComponent(v, k);
    for (let v = 0; v < nb; v++) for (let k = 0; k < n; k++) arr[(na + v) * n + k] = sb.getComponent(v, k);
    out.setAttribute(name, new BufferAttribute(arr, n));
  }
  const idx: number[] = [];
  const ia = a.index;
  const ib = b.index;
  if (ia) for (let t = 0; t < ia.count; t++) idx.push(ia.getX(t));
  else for (let v = 0; v < na; v++) idx.push(v);
  if (ib) for (let t = 0; t < ib.count; t++) idx.push(na + ib.getX(t));
  else for (let v = 0; v < nb; v++) idx.push(na + v);
  out.setIndex(idx);
  a.dispose();
  b.dispose();
  return out;
}

/**
 * Build a fresh hand rig (geometry, baked colours and its own material).
 * About 5.4k triangles in 16 meshes; init-time only.
 */
export function createCreatureHand(opts: CreatureHandOptions = {}): CreatureHandRig {
  const renderOrder = opts.renderOrder ?? 20;
  const seed = opts.seed ?? 1337;
  const root = new Group();
  root.name = 'CreatureHand';
  const hand = new Group();
  hand.name = 'Hand';
  root.add(hand);
  const { material, shade } = createHandMaterial();
  const mesh = (geo: BufferGeometry, name: string, parent: Object3D): Mesh => {
    const m = new Mesh(geo, material);
    m.name = name;
    m.renderOrder = renderOrder;
    parent.add(m);
    return m;
  };

  const arm = armGeometry(FINGER_X, THUMB_ROOT);
  const back = mesh(arm.back, 'Back', hand);
  const forearm = mesh(arm.forearm, 'Forearm', hand);
  // The forearm fades out into the dark: keep it out of the preview's camera fit.
  forearm.userData.iwsdkPreviewBounds = 'exclude';

  const fingers: Object3D[][] = [];
  const fingerSegs: Mesh[][] = [];
  /** Baked nail geometry per finger (then the thumb), merged into the distal segments after the skin bake. */
  const nails: BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    const s = FINGER_SCALE[i] ?? 1;
    const joints: Object3D[] = [];
    const segs: Mesh[] = [];
    let parent: Object3D = hand;
    for (let k = 0; k < 3; k++) {
      const joint = new Object3D();
      if (k === 0) {
        joint.name = `Finger${i}`;
        joint.position.set(FINGER_X[i] ?? 0, 0, 0);
        joint.rotation.z = FINGER_SPLAY[i] ?? 0;
      } else {
        joint.name = `Joint${k}`;
        joint.position.y = (SEG_LEN[k - 1] ?? 0) * s;
      }
      parent.add(joint);
      segs.push(mesh(phalanxGeometry((SEG_LEN[k] ?? 0) * s, fingerRadius(i, k), k === 2), `Seg${k}`, joint));
      joints.push(joint);
      parent = joint;
    }
    const L = SEG_LEN[2] * s;
    const nail = nailGeometry(L, fingerRadius(i, 2), NAIL_EXT[i] ?? 0.006, seed + 31 * i);
    bakeNail(nail.geo, nail.y0, nail.y1, L, nail.crackX, seed + i);
    nails.push(nail.geo);
    fingers.push(joints);
    fingerSegs.push(segs);
  }

  const thumb: Object3D[] = [];
  const thumbSegs: Mesh[] = [];
  let parent: Object3D = hand;
  for (let k = 0; k < 2; k++) {
    const joint = new Object3D();
    if (k === 0) {
      joint.name = 'Thumb';
      joint.position.set(...THUMB_ROOT);
      joint.rotation.set(THUMB_REST[0], 0, THUMB_REST[1]);
    } else {
      joint.name = 'Joint1';
      joint.position.y = THUMB_LEN[0];
      joint.rotation.x = -0.35;
    }
    parent.add(joint);
    thumbSegs.push(mesh(phalanxGeometry(THUMB_LEN[k] ?? 0.03, THUMB_RADIUS[k] ?? 0.007, k === 1), `Seg${k}`, joint));
    thumb.push(joint);
    parent = joint;
  }
  const tn = nailGeometry(THUMB_LEN[1], THUMB_RADIUS[1], NAIL_EXT[4], seed + 211);
  bakeNail(tn.geo, tn.y0, tn.y1, THUMB_LEN[1], tn.crackX, seed + 5);
  nails.push(tn.geo);

  // Bake the skin in the rest pose: straight fingers, splayed wider than at
  // rest so the flanks the reach/smother poses expose are not baked dark.
  for (let i = 0; i < 4; i++) fingers[i]![0]!.rotation.z = (FINGER_SPLAY[i] ?? 0) * BAKE_SPLAY;
  root.updateMatrixWorld(true);
  const field = new HandAoField();
  field.addRoundBox(new Vector3(-0.003, -0.038, -0.0005), new Vector3(0.041, 0.048, 0.0122), 0.009, AO_ARM);
  field.addCapsule(new Vector3(0, -0.1, 0), new Vector3(0, -0.45, 0), 0.021, AO_ARM);
  const a = new Vector3();
  const b = new Vector3();
  for (let i = 0; i < 4; i++) {
    for (let k = 0; k < 3; k++) {
      const j = fingers[i]?.[k];
      if (!j) continue;
      j.localToWorld(a.set(0, 0, 0));
      j.localToWorld(b.set(0, SEG_LEN[k]! * (FINGER_SCALE[i] ?? 1), 0));
      field.addCapsule(a, b, fingerRadius(i, k), 1 + i);
    }
  }
  const handInv = hand.matrixWorld.clone().invert();
  const toHand = new Matrix4();
  const bake = (m: Mesh | undefined, kind: SkinBake['kind'], L: number, r: number, group: number) => {
    if (!m) return;
    toHand.multiplyMatrices(handInv, m.matrixWorld);
    bakeSkin(m.geometry, toHand, field, { kind, L, r, group, seed });
  };
  bake(back, 'arm', 0, 0, AO_ARM);
  bake(forearm, 'arm', 0, 0, AO_ARM);
  for (let i = 0; i < 4; i++) {
    for (let k = 0; k < 3; k++) {
      const L = SEG_LEN[k]! * (FINGER_SCALE[i] ?? 1);
      bake(fingerSegs[i]?.[k], k === 2 ? 'tip' : 'mid', L, fingerRadius(i, k), 1 + i);
    }
  }
  for (let k = 0; k < 2; k++) bake(thumbSegs[k], k === 1 ? 'tip' : 'mid', THUMB_LEN[k]!, THUMB_RADIUS[k]!, AO_THUMB);
  for (let i = 0; i < 4; i++) fingers[i]![0]!.rotation.z = FINGER_SPLAY[i] ?? 0;
  root.updateMatrixWorld(true);

  // Each nail joins its distal segment (same joint frame and material): 16 draws instead of 21.
  const distal = [...fingerSegs.map((s) => s[2]), thumbSegs[1]];
  for (let i = 0; i < distal.length; i++) {
    const m = distal[i];
    const n = nails[i];
    if (m && n) m.geometry = mergeInto(m.geometry, n);
  }

  return { root, hand, fingers, thumb, material, shade, parts: { back, forearm, fingerSegs, thumbSegs } };
}

/** Manifest prototype: deterministic, parentless, in a mild hook so the curls show. */
function createPrototype(): Group {
  const rig = createCreatureHand();
  poseCreatureHand(rig, PREVIEW_CURL, -0.75, 0.55);
  return rig.root;
}

export default createPrototype();
