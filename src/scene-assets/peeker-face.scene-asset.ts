import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Vector2,
  Vector3,
  type Camera,
} from '@iwsdk/core';
import { buildGrid } from './peeker-face-shape.js';
import { SOCKET, facePointAt, sculpt, type Expr } from './peeker-face-sculpt.js';
import { bakeColors } from './peeker-face-shade.js';

/**
 * The Peeker's face: a sculpted, too-smooth pale face with deep hollow eye
 * sockets. Origin at the centre of the face (just below the sockets), +Z out
 * of the face, +Y up; about 0.19 m wide and 0.31 m tall including a short
 * neck that dissolves into the dark (vertex alpha), as does the back of the
 * head. Unlit: all shading is baked into RGBA vertex colours.
 * Expressions are morph targets (0 = squint, 1 = scream) driven by `setExpression`.
 *
 * Parts: `Face/Skin` (the head), `Face/EyeGlintL` / `Face/EyeGlintR` (tiny
 * additive wet glints deep on the socket floors; L is the face's own left, +X,
 * and sits a little higher; R is smaller). The glints only show when the face
 * is close (camera distance fade) and never while squinting or screaming.
 */
export interface PeekerFaceRig {
  root: Group;
  /** The skin's unlit material; animate its opacity and colour. The glints follow it. */
  material: MeshBasicMaterial;
  /** Squint 0..1 (eyes squeezed shut against light); scream 0..SCREAM_MAX (1 = full; above it the jaw overdrives). */
  setExpression(squint: number, scream: number): void;
  /** `Face/Skin`. morphTargetInfluences: [squint, scream]. */
  skin: Mesh;
  /** `Face/EyeGlintL`, `Face/EyeGlintR`. Hidden while squinting or screaming; fade out beyond ~1-1.8 m. */
  glints: readonly [Mesh, Mesh];
  /** Shared glint material; its opacity is re-derived from `material` every frame it renders. */
  glintMaterial: MeshBasicMaterial;
  /** Local point midway between the glints (a good flashlight aim point). */
  eyeCenter: Vector3;
  /** Local size of the neutral skin (m): x width, y height, z depth. */
  size: Vector3;
  /**
   * Local z of the front of the neutral skin (m; its frontmost point), a stopping reference for
   * anything that brings the face close. The skin geometry's bounding box is larger: it includes the
   * morph extents (the scream's dropped jaw).
   */
  front: number;
}

export interface PeekerFaceOptions {
  /** Render order of the skin; the glints draw right after it. Default 20 (threat bodies). */
  renderOrder?: number;
}

/** Grid: 64 columns x 62 rows -> 7,744 triangles for the skin. */
const GRID_COLS = 64;
const GRID_ROWS = 62;
const GLINT_RADIUS = 0.0016;
/** Glint offset off the socket floor along the base normal (m). */
const GLINT_LIFT = 0.0005;
/** The left glint sits this much higher (m); the right one is this much smaller. */
const GLINT_L_RAISE = 0.0015;
const GLINT_R_SCALE = 0.7;
/** Glints fade out between these camera distances (m): only a close face has wet eyes. */
const GLINT_NEAR_M = 1.0;
const GLINT_FAR_M = 1.8;
/**
 * The scream morph may be overdriven (extrapolated) this far for the caught moment; the Peeker clamps
 * CONFIG.threatFx.peeker.rushScreamMax to it.
 */
export const SCREAM_MAX = 1.25;
const GLINT_COLOR = 0xe9e6d6;
/** Glint opacity relative to the skin's opacity (it also brightens with the skin's colour). */
const GLINT_STRENGTH = 0.5;
/** Preview-only expression of the manifest prototype (asset render-preview); keep [0, 0]. */
const PREVIEW_EXPRESSION: readonly [number, number] = [0, 0];

const NEUTRAL: Expr = { squint: 0, scream: 0 };
const EXPRESSIONS: readonly Expr[] = [NEUTRAL, { squint: 1, scream: 0 }, { squint: 0, scream: 1 }];

/** Vertex-shader patch: expression colour deltas (attributes) weighted like the morphs. */
const EXPR_SHADER = {
  pars: 'attribute vec3 colorSquint;\nattribute vec3 colorScream;\nuniform vec2 uExpr;',
  main: 'vColor.rgb += colorSquint * uExpr.x + colorScream * uExpr.y;',
};

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const camPos = new Vector3();
const glintPos = new Vector3();
function sstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

function vertexNormals(index: number[], pos: Float32Array): Float32Array {
  const g = new BufferGeometry();
  g.setIndex(index);
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const n = (g.getAttribute('normal').array as Float32Array).slice();
  g.dispose();
  return n;
}

function delta(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] - b[i];
  return out;
}

interface SkinBuild {
  geometry: BufferGeometry;
  size: Vector3;
  front: number;
}

/** The sculpted head with neutral attributes and squint/scream morphs (position; colour via EXPR_SHADER). */
function buildSkin(): SkinBuild {
  const grid = buildGrid(GRID_COLS, GRID_ROWS);
  const shapes = EXPRESSIONS.map((e) => sculpt(grid, e));
  const normals = shapes.map((s) => vertexNormals(grid.index, s.pos));
  const colors = shapes.map((s, k) => bakeColors(grid, s, normals[k]));
  const g = new BufferGeometry();
  g.setIndex(grid.index);
  g.setAttribute('position', new BufferAttribute(shapes[0].pos, 3));
  g.setAttribute('normal', new BufferAttribute(normals[0], 3));
  g.setAttribute('color', new BufferAttribute(colors[0], 4));
  g.morphTargetsRelative = true;
  g.morphAttributes.position = [1, 2].map((k) => new BufferAttribute(delta(shapes[k].pos, shapes[0].pos), 3));
  // No morphAttributes.normal: the unlit material never reads normals (the shading is baked).
  // Expression colour deltas are plain attributes blended by the skin material
  // (EXPR_SHADER): three's morphAttributes.color breaks every material without
  // vertex colours (clay previews, editor helpers).
  const names = ['colorSquint', 'colorScream'];
  for (const k of [1, 2]) {
    const d = new Float32Array(grid.count * 3);
    for (let v = 0; v < grid.count; v++) {
      for (let ch = 0; ch < 3; ch++) d[v * 3 + ch] = colors[k][v * 4 + ch] - colors[0][v * 4 + ch];
    }
    g.setAttribute(names[k - 1], new BufferAttribute(d, 3));
  }
  const lo = new Vector3(Infinity, Infinity, Infinity);
  const hi = new Vector3(-Infinity, -Infinity, -Infinity);
  const p = shapes[0].pos;
  for (let i = 0; i < p.length; i += 3) {
    lo.set(Math.min(lo.x, p[i]), Math.min(lo.y, p[i + 1]), Math.min(lo.z, p[i + 2]));
    hi.set(Math.max(hi.x, p[i]), Math.max(hi.y, p[i + 1]), Math.max(hi.z, p[i + 2]));
  }
  g.computeBoundingBox(); // includes the morph extents (the scream's dropped jaw)
  g.computeBoundingSphere();
  const front = hi.z;
  return { geometry: g, size: hi.sub(lo), front };
}

/** A tiny soft disc (bright centre, black rim) for additive blending; faces +Z. */
function glintGeometry(): BufferGeometry {
  const seg = 8;
  const pos = [0, 0, 0];
  const col = [1, 1, 1];
  const index: number[] = [];
  for (let k = 0; k < seg; k++) {
    const a = (k / seg) * Math.PI * 2;
    pos.push(Math.cos(a) * GLINT_RADIUS * 1.25, Math.sin(a) * GLINT_RADIUS, 0);
    col.push(0, 0, 0);
    index.push(0, 1 + k, 1 + ((k + 1) % seg));
  }
  const g = new BufferGeometry();
  g.setIndex(index);
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

export function createPeekerFace(options: PeekerFaceOptions = {}): PeekerFaceRig {
  const renderOrder = options.renderOrder ?? 20;
  const root = new Group();
  root.name = 'Face';
  const face = root;

  const { geometry, size, front } = buildSkin();
  const material = new MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: true,
    alphaTest: 0.02,
  });
  const expr = { value: new Vector2() };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uExpr = expr;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + EXPR_SHADER.pars)
      .replace('#include <color_vertex>', '#include <color_vertex>\n' + EXPR_SHADER.main);
  };
  material.customProgramCacheKey = () => 'peeker-face-expr';
  const skin = new Mesh(geometry, material);
  skin.name = 'Skin';
  skin.renderOrder = renderOrder;
  face.add(skin);

  const glintMaterial = new MeshBasicMaterial({
    color: GLINT_COLOR,
    vertexColors: true,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const glintGeo = glintGeometry();
  const pos = new Float64Array(3);
  const nrm = new Float64Array(3);
  let glintLevel = 1;
  let glintRef: Mesh | null = null;
  // Follows the skin's opacity and brightness (and fades with camera distance)
  // without any per-frame call from the threat. Allocation-free.
  const syncGlint = (_renderer?: unknown, _scene?: unknown, camera?: Camera) => {
    let near = 1;
    if (camera && glintRef) {
      camPos.setFromMatrixPosition(camera.matrixWorld);
      glintPos.setFromMatrixPosition(glintRef.matrixWorld);
      near = 1 - sstep(GLINT_NEAR_M, GLINT_FAR_M, camPos.distanceTo(glintPos));
    }
    glintMaterial.opacity =
      material.opacity * glintLevel * near * GLINT_STRENGTH * (0.45 + 0.55 * Math.min(1, material.color.r));
  };
  const makeGlint = (side: 1 | -1, name: string, raise: number, scale: number) => {
    const m = new Mesh(glintGeo, glintMaterial);
    m.name = name;
    facePointAt(side * SOCKET.glintX, SOCKET.glintY + raise, NEUTRAL, pos, nrm);
    m.position.set(pos[0] + nrm[0] * GLINT_LIFT, pos[1] + nrm[1] * GLINT_LIFT, pos[2] + nrm[2] * GLINT_LIFT);
    m.scale.setScalar(scale);
    m.renderOrder = renderOrder + 1;
    m.onBeforeRender = syncGlint;
    face.add(m);
    return m;
  };
  const glints = [makeGlint(1, 'EyeGlintL', GLINT_L_RAISE, 1), makeGlint(-1, 'EyeGlintR', 0, GLINT_R_SCALE)] as const;
  glintRef = glints[0];
  const eyeCenter = new Vector3().addVectors(glints[0].position, glints[1].position).multiplyScalar(0.5);

  const influences = skin.morphTargetInfluences ?? (skin.morphTargetInfluences = [0, 0]);
  const setExpression = (squint: number, scream: number) => {
    const s = clamp01(squint);
    const sc = scream < 0 ? 0 : scream > SCREAM_MAX ? SCREAM_MAX : scream;
    influences[0] = s;
    influences[1] = sc;
    // The scream's colour (the void of the mouth) leads its shape (full by 0.35),
    // so a slack, part-open jaw already reads as a dark opening, not a grey band.
    const k = 1 - Math.min(1, sc / 0.35);
    expr.value.set(s, sc < 1 ? 1 - k * k * k : sc);
    glintLevel = (1 - sstep(0.2, 0.55, s)) * (1 - sstep(0.2, 0.5, sc));
    const show = glintLevel > 0.001;
    glints[0].visible = show;
    glints[1].visible = show;
  };
  setExpression(0, 0);
  syncGlint();

  return { root, material, setExpression, skin, glints, glintMaterial, eyeCenter, size, front };
}

const prototype = createPeekerFace();
prototype.setExpression(PREVIEW_EXPRESSION[0], PREVIEW_EXPRESSION[1]);
export default prototype.root;
