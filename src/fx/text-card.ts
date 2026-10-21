import {
  CanvasTexture,
  Euler,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  ShaderMaterial,
  Vector3,
  type Object3D,
  type World,
} from '@iwsdk/core';
import { CONFIG } from '../config.js';
import type { TextCardLike, TextCardOptions } from '../game/contracts.js';

const DEG = Math.PI / 180;
const TYPEWRITER = 'Special Elite';
const HAND = 'Caveat';
const FALLBACK = 'Georgia, "Times New Roman", serif';
/** Pale bone, a little warm. */
const BONE = '#ddd4c4';
const GLOW = 'rgba(3, 4, 7, 0.9)';

// ─── Web fonts (non-blocking; cards re-render when they arrive) ───────────

const FONT_CSS =
  'https://fonts.googleapis.com/css2?family=Special+Elite&family=Caveat:wght@600&display=swap';
const fontListeners = new Set<() => void>();
let fontsRequested = false;

/** Fetch the Google Fonts CSS, register each @font-face with the FontFace API, then load the latin faces. */
function requestFonts(): void {
  if (fontsRequested || typeof document === 'undefined' || !document.fonts || typeof FontFace === 'undefined') return;
  fontsRequested = true;
  void (async () => {
    const res = await fetch(FONT_CSS);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const css = await res.text();
    for (const block of css.match(/@font-face\s*{[^}]*}/g) ?? []) {
      const family = /font-family:\s*['"]?([^;'"]+)/.exec(block)?.[1];
      const url = /src:\s*url\(([^)]+)\)/.exec(block)?.[1];
      if (!family || !url) continue;
      document.fonts.add(
        new FontFace(family, `url(${url})`, {
          style: /font-style:\s*(\w+)/.exec(block)?.[1] ?? 'normal',
          weight: /font-weight:\s*([\d ]+)/.exec(block)?.[1]?.trim() ?? 'normal',
          unicodeRange: /unicode-range:\s*([^;]+)/.exec(block)?.[1] ?? 'U+0-10FFFF',
        }),
      );
    }
    // Only the faces whose unicode-range covers the sample text download.
    await Promise.all([document.fonts.load(`64px "${TYPEWRITER}"`, 'Night'), document.fonts.load(`600 64px "${HAND}"`, 'hands')]);
    for (const fn of fontListeners) fn();
  })().catch((e: unknown) => console.warn('[text-card] web fonts unavailable, using serif fallback:', e));
}

/** Greedy wrap of one paragraph; returns the line count. */
function greedyWrap(words: string[], maxChars: number, out: string[] | null): number {
  let line = '';
  let count = 0;
  for (const word of words) {
    if (line && line.length + 1 + word.length > maxChars) {
      out?.push(line);
      count++;
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  out?.push(line);
  return count + 1;
}

/** Word wrap to ~maxChars per line, balanced so a paragraph never ends on a lonely word. */
function wrapLines(text: string, maxChars: number, out: string[]): string[] {
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    const n = greedyWrap(words, maxChars, null);
    let width = maxChars;
    while (n > 1 && width > 8 && greedyWrap(words, width - 1, null) === n) width--;
    greedyWrap(words, width, out);
  }
  return out;
}

const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const smooth01 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

const ANGLES = { yaw: 0, pitch: 0 };
const _q = new Quaternion();
const _fwd = new Vector3();

/** Yaw/pitch of the head's view direction (-Z); keeps `prevYaw` when looking straight up/down. */
function headAngles(head: Object3D, prevYaw: number): { yaw: number; pitch: number } {
  const f = _fwd.set(0, 0, -1).applyQuaternion(head.getWorldQuaternion(_q));
  ANGLES.yaw = Math.hypot(f.x, f.z) > 0.1 ? Math.atan2(-f.x, -f.z) : prevYaw;
  ANGLES.pitch = Math.asin(Math.max(-1, Math.min(1, f.y)));
  return ANGLES;
}

// ─── TextCard ─────────────────────────────────────────────────────────────

const CARD_W = 1024;
const CARD_H = 512;
/** Canvas pixels per text line (~ the headset's resolution at the default size and distance). */
const LINE_PX = 76;
const FONT_PX = 54;
const SUB_SCALE = 0.62;
const PAD_PX = 30;
/** Main-text swaps dip out this fast before the new text fades in. */
const SWAP_SEC = 0.15;
/** Re-centring stops once the card is this close to centre. */
const SETTLED_DEG = 2.5;

/**
 * A floating line of typewritten text: intro instructions, "Night N", the
 * ending. Always readable over the darkness (no depth test, drawn last).
 */
export class TextCard implements TextCardLike {
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private readonly material: MeshBasicMaterial;
  private readonly mesh: Mesh;

  private text = '';
  private subtitle = '';
  private color = BONE;
  /** What the canvas currently shows (null = must redraw). */
  private drawnText: string | null = null;
  private drawnSubtitle = '';
  private drawnColor = '';
  private fontsChanged = false;
  private swapping = false;

  private mode: 'gaze' | 'world' = 'gaze';
  private size: number = CONFIG.text.lineHeightM;
  private alpha = 0;
  private target = 0;
  private fadeInSec: number = CONFIG.text.fadeInSec;
  private fadeOutSec: number = CONFIG.text.fadeOutSec;
  private lifeSec = Infinity;
  private placed = false;
  private recentring = false;
  private yaw = 0;
  private pitch = 0;

  private readonly worldPos = new Vector3();
  private readonly anchor = new Vector3();
  private readonly headPos = new Vector3();
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly lines: string[] = [];
  private readonly subLines: string[] = [];

  constructor(world: World) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = CARD_W;
    this.canvas.height = CARD_H;
    this.g = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.material = new MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      opacity: 0,
    });
    this.mesh = new Mesh(new PlaneGeometry(1, 1), this.material);
    this.mesh.name = 'text-card';
    this.mesh.renderOrder = 3000;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    world.createTransformEntity(this.mesh, { persistent: true });

    fontListeners.add(() => (this.fontsChanged = true));
    requestFonts();
  }

  get visible(): boolean {
    return this.target > 0 || this.alpha > 0;
  }

  show(text: string, opts: TextCardOptions = {}): void {
    const color = opts.color ?? BONE;
    const mode = opts.mode ?? 'gaze';
    const showing = this.target > 0 && (this.alpha > 0.02 || this.swapping);
    const mainChanged = text !== this.text || color !== this.color;

    this.text = text;
    this.subtitle = opts.subtitle ?? '';
    this.color = color;
    this.size = opts.size ?? CONFIG.text.lineHeightM;
    this.fadeInSec = opts.fadeInSec ?? CONFIG.text.fadeInSec;
    this.lifeSec = opts.durationSec ?? Infinity;
    if (opts.position) this.worldPos.copy(opts.position);
    if (mode !== this.mode) this.placed = false;
    this.mode = mode;
    this.target = 1;

    if (showing && mainChanged) {
      this.swapping = true; // dip out, swap, fade back in (update)
    } else if (!showing) {
      this.swapping = false;
      this.placed = false;
      this.redraw();
      if (this.fadeInSec <= 0) this.alpha = 1;
    } else if (!this.swapping) {
      this.redraw(); // same text, maybe a new subtitle: update in place
    }
    this.applyAlpha();
  }

  hide(fadeSec: number = CONFIG.text.fadeOutSec): void {
    this.target = 0;
    this.swapping = false;
    this.fadeOutSec = fadeSec;
    if (fadeSec <= 0) this.alpha = 0;
    this.applyAlpha();
  }

  update(dt: number, head: Object3D): void {
    if (!this.visible) return;
    if (this.fontsChanged) {
      this.fontsChanged = false;
      this.drawnText = null;
      if (!this.swapping) this.redraw();
    }

    this.lifeSec -= dt;
    if (this.target > 0 && this.lifeSec <= 0) this.hide();

    if (this.swapping) {
      this.alpha -= dt / SWAP_SEC;
      if (this.alpha <= 0) {
        this.alpha = this.fadeInSec <= 0 ? 1 : 0;
        this.swapping = false;
        this.redraw();
      }
    } else if (this.alpha < this.target) {
      this.alpha = this.fadeInSec <= 0 ? 1 : Math.min(1, this.alpha + dt / this.fadeInSec);
    } else if (this.alpha > this.target) {
      this.alpha = this.fadeOutSec <= 0 ? 0 : Math.max(0, this.alpha - dt / this.fadeOutSec);
    }

    head.getWorldPosition(this.headPos);
    if (this.mode === 'gaze') this.placeGaze(dt, head);
    else this.placeWorld();
    this.applyAlpha();
  }

  /** Tag-along: stays put until it is > gazeRecentreDeg off-centre, then glides back. Never rolls. */
  private placeGaze(dt: number, head: Object3D): void {
    const t = CONFIG.text;
    const a = headAngles(head, this.yaw);
    const targetPitch = Math.max(-t.gazeMaxDownDeg * DEG, Math.min(0, a.pitch));
    if (!this.placed) {
      this.yaw = a.yaw;
      this.pitch = targetPitch;
      this.anchor.copy(this.headPos);
      this.placed = true;
      this.recentring = false;
    }
    // Triggered by how far the card is from the actual gaze; glides to the (pitch-clamped) target.
    const dyaw = wrapAngle(a.yaw - this.yaw);
    const cosP = Math.cos(this.pitch);
    if (Math.hypot(dyaw * cosP, a.pitch - this.pitch) > t.gazeRecentreDeg * DEG) this.recentring = true;
    if (this.recentring) {
      const dpitch = targetPitch - this.pitch;
      const k = 1 - Math.exp(-dt * 4);
      this.yaw = wrapAngle(this.yaw + dyaw * k);
      this.pitch += dpitch * k;
      if (Math.hypot(dyaw * cosP, dpitch) < SETTLED_DEG * DEG) this.recentring = false;
    }
    // The anchor trails the head a little so small head bobs don't drag the text.
    this.anchor.lerp(this.headPos, 1 - Math.exp(-dt / 0.25));

    const cp = Math.cos(this.pitch);
    const d = t.gazeDistanceM;
    this.mesh.position.set(
      this.anchor.x - Math.sin(this.yaw) * cp * d,
      this.anchor.y + Math.sin(this.pitch) * d,
      this.anchor.z - Math.cos(this.yaw) * cp * d,
    );
    this.mesh.quaternion.setFromEuler(this.euler.set(this.pitch, this.yaw, 0, 'YXZ'));
  }

  /** Fixed in the world, turning (yaw only) to face the head. */
  private placeWorld(): void {
    this.mesh.position.copy(this.worldPos);
    const yaw = Math.atan2(this.headPos.x - this.worldPos.x, this.headPos.z - this.worldPos.z);
    this.mesh.quaternion.setFromEuler(this.euler.set(0, yaw, 0, 'YXZ'));
  }

  private applyAlpha(): void {
    this.material.opacity = smooth01(this.alpha);
    this.mesh.visible = this.alpha > 0.001;
    const k = this.size / LINE_PX;
    this.mesh.scale.set(CARD_W * k, CARD_H * k, 1);
  }

  /** Re-renders the canvas only when the text, subtitle, colour or font changed. */
  private redraw(): void {
    if (this.drawnText === this.text && this.drawnSubtitle === this.subtitle && this.drawnColor === this.color) return;
    this.drawnText = this.text;
    this.drawnSubtitle = this.subtitle;
    this.drawnColor = this.color;

    const g = this.g;
    const lines = wrapLines(this.text, CONFIG.text.charsPerLine, (this.lines.length = 0, this.lines));
    const subs = this.subtitle ? wrapLines(this.subtitle, CONFIG.text.charsPerLine + 8, (this.subLines.length = 0, this.subLines)) : [];
    const family = `"${TYPEWRITER}", ${FALLBACK}`;

    // Fit: shrink everything if a line is too wide or there are too many lines.
    g.font = `${FONT_PX}px ${family}`;
    let widest = 0;
    for (const l of lines) widest = Math.max(widest, g.measureText(l).width);
    g.font = `${FONT_PX * SUB_SCALE}px ${family}`;
    for (const l of subs) widest = Math.max(widest, g.measureText(l).width);
    const subGap = subs.length ? 0.35 : 0;
    const totalLines = lines.length + (subs.length + subGap) * SUB_SCALE;
    const fit = Math.min(1, (CARD_W - 2 * PAD_PX) / Math.max(1, widest), (CARD_H - 2 * PAD_PX) / (totalLines * LINE_PX));
    const linePx = LINE_PX * fit;
    const fontPx = FONT_PX * fit;

    g.clearRect(0, 0, CARD_W, CARD_H);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = this.color;
    g.shadowColor = GLOW;
    // Row centres, top to bottom: title lines, a small gap, subtitle lines.
    const rows: { text: string; y: number; sub: boolean }[] = [];
    let top = (CARD_H - totalLines * linePx) / 2;
    for (const l of lines) {
      rows.push({ text: l, y: top + linePx / 2, sub: false });
      top += linePx;
    }
    top += subGap * SUB_SCALE * linePx;
    for (const l of subs) {
      rows.push({ text: l, y: top + (SUB_SCALE * linePx) / 2, sub: true });
      top += SUB_SCALE * linePx;
    }
    // Smoky dark glow (wide, wide, tight) so it reads over a lit room, then crisp ink.
    // Glow passes draw the glyphs off-canvas and only their shadow lands on it.
    for (const blur of [fontPx * 0.7, fontPx * 0.7, fontPx * 0.18, 0]) {
      const off = blur > 0 ? CARD_W * 2 : 0;
      g.shadowBlur = blur;
      g.shadowOffsetX = off;
      for (const r of rows) {
        g.globalAlpha = r.sub ? 0.72 : 1;
        g.font = `${r.sub ? fontPx * SUB_SCALE : fontPx}px ${family}`;
        g.fillText(r.text, CARD_W / 2 - off, r.y);
      }
    }
    g.globalAlpha = 1;
    g.shadowBlur = 0;
    g.shadowOffsetX = 0;
    this.texture.needsUpdate = true;
  }
}

// ─── ScrawlLabel ──────────────────────────────────────────────────────────

const SCRAWL_W = 768;
const SCRAWL_H = 192;
const SCRAWL_FONT_PX = 112;
/** Hand-drawn "boil": a new wobble this many times a second. */
const BOIL_HZ = 11;

const SCRAWL_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** Reveals left to right (a slightly slanted edge), as if being written. */
const SCRAWL_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uOpacity;
uniform float uReveal;
varying vec2 vUv;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float x = vUv.x + (vUv.y - 0.5) * 0.06;
  float shown = 1.0 - smoothstep(uReveal - 0.05, uReveal, x);
  gl_FragColor = vec4(t.rgb, t.a * uOpacity * shown);
  #include <colorspace_fragment>
}`;

/** Tiny deterministic PRNG so a scrawl's wobble is the same every time it is redrawn. */
function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/**
 * A faint, hand-scrawled hint floating near a threat on its teaching attack
 * ("hands flat"). Low alpha, slightly jittery, written in left to right.
 */
export class ScrawlLabel {
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private readonly material: ShaderMaterial;
  private readonly mesh: Mesh;

  private text = '';
  private renderedKey = '';
  private fontsChanged = false;
  private alpha = 0;
  private target = 0;
  /** 0..1 writing progress, swept across the text's own extent [revealFrom, revealTo] (UV x). */
  private reveal = 0;
  private revealFrom = 0;
  private revealTo = 1;
  private lifeSec = 0;
  private boilSec = 0;
  private roll = 0;
  private flick = 1;

  private readonly anchor = new Vector3();
  private readonly jitter = new Vector3();
  private readonly headPos = new Vector3();

  constructor(world: World) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = SCRAWL_W;
    this.canvas.height = SCRAWL_H;
    this.g = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.material = new ShaderMaterial({
      uniforms: {
        uMap: { value: this.texture },
        uOpacity: { value: 0 },
        uReveal: { value: 0 },
      },
      vertexShader: SCRAWL_VERT,
      fragmentShader: SCRAWL_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new Mesh(new PlaneGeometry(1, 1), this.material);
    this.mesh.name = 'scrawl-label';
    this.mesh.renderOrder = 2900;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    world.createTransformEntity(this.mesh, { persistent: true });

    fontListeners.add(() => (this.fontsChanged = true));
    requestFonts();
  }

  get visible(): boolean {
    return this.target > 0 || this.alpha > 0;
  }

  show(text: string, position: Vector3, durationSec: number): void {
    if (text !== this.text || this.alpha <= 0) this.reveal = 0;
    this.text = text;
    this.anchor.copy(position);
    this.lifeSec = durationSec;
    this.target = 1;
    this.redraw();
  }

  hide(): void {
    this.target = 0;
  }

  update(dt: number, head: Object3D): void {
    if (!this.visible) {
      this.mesh.visible = false;
      return;
    }
    if (this.fontsChanged) {
      this.fontsChanged = false;
      this.renderedKey = '';
      this.redraw();
    }

    this.lifeSec -= dt;
    if (this.lifeSec <= 0) this.target = 0;
    const fade = CONFIG.text.scrawlFadeSec;
    this.alpha = this.alpha < this.target ? Math.min(1, this.alpha + dt / fade) : Math.max(this.target, this.alpha - dt / fade);
    this.reveal = Math.min(1, this.reveal + dt / CONFIG.text.scrawlWriteSec);

    head.getWorldPosition(this.headPos);
    const dist = Math.max(0.2, this.headPos.distanceTo(this.anchor));
    const lineH = Math.max(0.025, dist * Math.tan(CONFIG.text.scrawlLineDeg * DEG));

    // Stop-motion boil: a tiny new offset, tilt and ink density several times a second.
    this.boilSec -= dt;
    if (this.boilSec <= 0) {
      this.boilSec = 1 / BOIL_HZ;
      const j = lineH * 0.035;
      this.jitter.set((Math.random() - 0.5) * j, (Math.random() - 0.5) * j, (Math.random() - 0.5) * j);
      this.roll = (Math.random() - 0.5) * 1.6 * DEG;
      this.flick = 0.82 + Math.random() * 0.18;
    }

    this.mesh.position.copy(this.anchor).add(this.jitter);
    this.mesh.lookAt(this.headPos); // +Z toward the head, world up: no roll...
    this.mesh.rotateZ(this.roll); // ...except the deliberate wobble
    this.mesh.scale.set((lineH * SCRAWL_W) / SCRAWL_H, lineH, 1);

    const u = this.material.uniforms;
    u.uOpacity.value = smooth01(this.alpha) * CONFIG.text.scrawlOpacity * this.flick;
    u.uReveal.value = this.revealFrom + (this.revealTo + 0.06 - this.revealFrom) * this.reveal;
    this.mesh.visible = this.alpha > 0.001;
  }

  /** Each character gets its own small tilt and baseline drift: a hasty, shaky hand. */
  private redraw(): void {
    const key = this.text;
    if (key === this.renderedKey) return;
    this.renderedKey = key;

    const g = this.g;
    const family = `"${HAND}", "${TYPEWRITER}", ${FALLBACK}`;
    let fontPx = SCRAWL_FONT_PX;
    g.font = `600 ${fontPx}px ${family}`;
    const w = g.measureText(this.text).width;
    if (w > SCRAWL_W - 40) {
      fontPx *= (SCRAWL_W - 40) / w;
      g.font = `600 ${fontPx}px ${family}`;
    }

    g.clearRect(0, 0, SCRAWL_W, SCRAWL_H);
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillStyle = BONE;
    g.shadowColor = GLOW;
    g.shadowBlur = fontPx * 0.25;
    let seed = 7;
    for (let i = 0; i < this.text.length; i++) seed = (seed * 31 + this.text.charCodeAt(i)) | 0;
    const rnd = seeded(seed);
    const total = g.measureText(this.text).width;
    let x = (SCRAWL_W - total) / 2;
    this.revealFrom = x / SCRAWL_W;
    this.revealTo = (x + total) / SCRAWL_W;
    for (const ch of this.text) {
      const adv = g.measureText(ch).width;
      g.save();
      g.translate(x + adv / 2, SCRAWL_H / 2 + (rnd() - 0.5) * fontPx * 0.08);
      g.rotate((rnd() - 0.5) * 0.12);
      g.globalAlpha = 0.75 + rnd() * 0.25;
      g.fillText(ch, -adv / 2, 0);
      g.restore();
      x += adv;
    }
    g.shadowBlur = 0;
    g.globalAlpha = 1;
    this.texture.needsUpdate = true;
  }
}
