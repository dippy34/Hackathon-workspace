import {
  CanvasTexture,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
  type World,
} from '@iwsdk/core';
import { CONFIG, type ThreatId } from '../config.js';
import type { AttackView } from '../core/types.js';
import type { DebugInfo, DebugOverlayLike, FrameContext, HandState, RoomFeature } from '../game/contracts.js';

const DEG = Math.PI / 180;

// ─── Panel layout (canvas pixels) ─────────────────────────────────────────

const W = 1024;
const H = 1024;
const PAD = 18;
const LINE_PX = 32;
const FONT_PX = 24;
const MAX_LINES = Math.floor((H - 2 * PAD) / LINE_PX);
const FONT = `600 ${FONT_PX}px ui-monospace, "DejaVu Sans Mono", "Droid Sans Mono", Menlo, Consolas, monospace`;
const LOG_LINES = 5;
const BAR_CELLS = 10;
/**
 * Lazy follow (no desk yet): re-centre once the head has turned this far from
 * the followed yaw. Well past overlayHeadLeftDeg, so turning to read the panel
 * never sets it off.
 */
const FOLLOW_DEADZONE_DEG = 50;

const C = {
  text: '#d9d1c1',
  dim: '#7c8492',
  head: '#9fb2cc',
  ok: '#7fd494',
  warn: '#e9b04e',
  bad: '#ff6a5c',
  bg: `rgba(6, 8, 12, ${CONFIG.debug.overlayBgOpacity})`,
  edge: 'rgba(150, 165, 190, 0.35)',
  track: 'rgba(255, 255, 255, 0.09)',
} as const;

// ─── Formatting (redraw only) ─────────────────────────────────────────────

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const num = (x: number, digits = 1): string => (Number.isFinite(x) ? x.toFixed(digits) : '--');
const pct = (x: number): string => `${Math.round(clamp01(x) * 100)}%`.padStart(4);
const onOff = (v: unknown): string => (v === undefined ? '?' : v === true ? 'on' : v === false ? 'off' : String(v));
function clock(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
/** green below `warn`, amber below `bad`, red above. */
const level = (x: number, warn: number, bad: number): string => (x < warn ? C.ok : x < bad ? C.warn : C.bad);

/**
 * Development overlay (BUILD_SPEC "Debug overlay"): a floating canvas-texture
 * panel off to the player's left with every sense, threat and room-scan value,
 * kept out of the central view (gaze cards, windows, the Peeker). Hidden in
 * release (?debug=0). Positioned every frame; the canvas redraws at most
 * CONFIG.debug.overlayHz times a second.
 */
export class DebugOverlay implements DebugOverlayLike {
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private readonly mesh: Mesh;

  private shown = false;
  private sinceDraw = Infinity;

  // Text cursor (cells, lines) and font metrics.
  private line = 0;
  private col = 0;
  private charW = FONT_PX * 0.6;
  private cols = 60;

  // Placement (no allocations per frame).
  private readonly pos = new Vector3();
  private readonly anchor = new Vector3();
  private readonly toDoor = new Vector3();
  private followYaw = 0;
  private followPlaced = false;
  private recentring = false;

  constructor(world: World) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.g = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    // Seen up close (magnified): skip mipmap generation on every upload.
    this.texture.generateMipmaps = false;
    this.texture.minFilter = LinearFilter;

    const width = CONFIG.debug.overlayWidthM;
    this.mesh = new Mesh(
      new PlaneGeometry(width, (width * H) / W),
      new MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    this.mesh.name = 'debug-overlay';
    this.mesh.renderOrder = 5000; // over the darkness, text cards and threats
    this.mesh.visible = false;
    world.createTransformEntity(this.mesh, { persistent: true });
  }

  get visible(): boolean {
    return this.shown;
  }

  setVisible(v: boolean): void {
    this.shown = v;
    this.mesh.visible = v;
    this.sinceDraw = Infinity; // redraw as soon as it is shown again
    this.followPlaced = false;
  }

  update(ctx: FrameContext, info: DebugInfo): void {
    if (!this.shown) return;
    this.place(ctx);
    this.sinceDraw += ctx.dt;
    if (this.sinceDraw < 1 / CONFIG.debug.overlayHz) return;
    this.sinceDraw = 0;
    this.redraw(ctx, info);
  }

  // ─── Placement ─────────────────────────────────────────────────────────

  /**
   * Standing on the desk to the player's left, else lazily following the head
   * (left and a little down). Always turned (and tilted back) to face the head.
   */
  private place(ctx: FrameContext): void {
    const d = CONFIG.debug;
    const head = ctx.headPos;
    const desk = ctx.desk;
    if (desk) {
      // Player's left = (-towardPlayer.z, 0, towardPlayer.x).
      const t = desk.towardPlayer;
      this.pos.copy(desk.center).addScaledVector(t, -d.overlayBeyondDeskM);
      this.pos.x -= t.z * d.overlayDeskLeftM;
      this.pos.z += t.x * d.overlayDeskLeftM;
      this.pos.y = desk.height + d.overlayAboveDeskM;
      this.followPlaced = false;
    } else {
      const f = ctx.headForward;
      const horiz = Math.hypot(f.x, f.z);
      const yaw = horiz > 0.2 ? Math.atan2(-f.x, -f.z) : this.followYaw;
      if (!this.followPlaced) {
        this.followPlaced = true;
        this.followYaw = yaw;
        this.anchor.copy(head);
      }
      const off = Math.atan2(Math.sin(yaw - this.followYaw), Math.cos(yaw - this.followYaw));
      if (Math.abs(off) > FOLLOW_DEADZONE_DEG * DEG) this.recentring = true;
      if (this.recentring) {
        this.followYaw += off * (1 - Math.exp(-ctx.dt * 3));
        if (Math.abs(off) < 3 * DEG) this.recentring = false;
      }
      this.anchor.lerp(head, 1 - Math.exp(-ctx.dt * 2));
      // Direction for (yaw, pitch) = (-sin yaw cos pitch, sin pitch, -cos yaw cos pitch); +yaw turns left.
      const panelYaw = this.followYaw + d.overlayHeadLeftDeg * DEG;
      const panelPitch = -d.overlayHeadDownDeg * DEG;
      const flat = Math.cos(panelPitch) * d.overlayHeadDistM;
      this.pos.set(
        this.anchor.x - Math.sin(panelYaw) * flat,
        this.anchor.y + Math.sin(panelPitch) * d.overlayHeadDistM,
        this.anchor.z - Math.cos(panelYaw) * flat,
      );
    }
    this.mesh.position.copy(this.pos);
    this.mesh.lookAt(head); // +Z (the plane's face) toward the head; no roll
  }

  // ─── Drawing ───────────────────────────────────────────────────────────

  private redraw(ctx: FrameContext, info: DebugInfo): void {
    const g = this.g;
    g.clearRect(0, 0, W, H);
    g.fillStyle = C.bg;
    g.fillRect(0, 0, W, H);
    g.strokeStyle = C.edge;
    g.lineWidth = 3;
    g.strokeRect(1.5, 1.5, W - 3, H - 3);
    g.font = FONT;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    this.charW = g.measureText('MMMMMMMMMM').width / 10;
    this.cols = Math.floor((W - 2 * PAD) / this.charW);
    this.line = 0;
    this.col = 0;

    this.drawHeader(info);
    this.drawHands(ctx);
    this.drawMic(ctx, info);
    this.drawLight(ctx);
    this.drawThreats(info);
    this.drawRoom(ctx);
    this.drawLog(info);
    this.texture.needsUpdate = true;
  }

  private drawHeader(info: DebugInfo): void {
    const phaseColor = info.phase === 'caught' ? C.bad : info.phase === 'night' ? C.warn : C.text;
    this.t('PHASE ', C.head).t(info.phase, phaseColor);
    this.t(`  N${info.night}  t ${num(info.phaseTimeSec)}s`);
    const r = info.runner;
    if (r) this.t('  clock ', C.dim).t(clock(r.remainingSec), r.remainingSec < 10 ? C.ok : C.text).t(` ${r.state}`, C.dim);
    this.nl();

    this.t('fps ', C.head).t(num(info.fps, 0), info.fps >= 70 ? C.ok : info.fps >= 60 ? C.warn : C.bad);
    this.t('  intro ', C.head).t(info.introStep || '-', info.introStep === 'done' ? C.ok : C.text);
    this.nl();

    this.t('session ', C.head);
    this.words(info.session || '(no session)', C.dim, 2, 2);
    this.nl();
  }

  private drawHands(ctx: FrameContext): void {
    const hands = ctx.hands;
    const desk = ctx.desk;
    this.t('HANDS ', C.head).t('both flat ', C.dim).t(hands.bothFlat ? 'YES' : 'no', hands.bothFlat ? C.ok : C.text);
    this.t('  desk ', C.dim);
    if (desk) this.t(`${num(desk.height, 3)} m`, C.ok);
    else this.t('not calibrated', C.warn);
    this.nl();

    const door = ctx.room.doors[0] as RoomFeature | undefined;
    const facing = door ? hands.palmFacing(door.position) : null;
    this.drawHand(hands.left, 'L', door, facing === 'left');
    this.drawHand(hands.right, 'R', door, facing === 'right');
  }

  private drawHand(h: HandState, tag: string, door: RoomFeature | undefined, facingDoor: boolean): void {
    const tune = CONFIG.hands;
    this.t(`${tag} `, C.head);
    this.t(h.tracked ? 'TRK  ' : h.seen ? 'lost ' : 'never', h.tracked ? C.ok : h.seen ? C.warn : C.bad);
    this.t(h.flat ? ' FLAT' : ' lift', h.flat ? C.ok : C.dim);
    this.t(h.pinching ? ' PINCH' : ' pinch', h.pinching ? C.warn : C.dim);
    this.t(h.seen ? `${num(h.pinchDistance * 1000, 0).padStart(4)}mm` : '  --  ', h.pinching ? C.warn : C.dim);
    const hd = h.heightAboveDesk;
    this.t(' h', C.dim).t(
      Number.isFinite(hd) ? `${hd >= 0 ? '+' : ''}${num(hd * 100)}cm`.padStart(8) : '      --',
      Number.isFinite(hd) && Math.abs(hd) <= tune.flatHeightToleranceM ? C.ok : C.text,
    );
    this.t(' down', C.dim).t(
      `${num(h.palmDownAngleDeg, 0).padStart(4)}°`,
      h.palmDownAngleDeg <= tune.flatPalmDownMaxAngleDeg ? C.ok : C.text,
    );
    this.t(' door', C.dim);
    if (!door || !h.seen) {
      this.t(' --', C.dim);
    } else {
      const d = this.toDoor.subVectors(door.position, h.palm);
      const len = d.length();
      const angle = len > 1e-4 ? Math.acos(Math.max(-1, Math.min(1, d.dot(h.palmNormal) / len))) / DEG : NaN;
      this.t(`${num(angle, 0).padStart(4)}° `, angle <= tune.palmFacingMaxAngleDeg ? C.text : C.dim);
      this.t(facingDoor ? 'YES' : 'no', facingDoor ? C.ok : C.dim);
    }
    this.nl();
  }

  private drawMic(ctx: FrameContext, info: DebugInfo): void {
    const mic = ctx.mic;
    const st = mic.status;
    this.t('MIC ', C.head).t(st, st === 'granted' ? C.ok : st === 'requesting' ? C.warn : st === 'idle' ? C.dim : C.bad);
    const s = mic.settings;
    if (s) this.t(`  EC ${onOff(s.echoCancellation)}  NS ${onOff(s.noiseSuppression)}  AGC ${onOff(s.autoGainControl)}`, C.dim);
    else if (st === 'denied' || st === 'unavailable') this.t('  Listener off', C.warn);
    this.nl();

    const base = mic.baseline;
    const thr = mic.threshold;
    const scale = Number.isFinite(thr) ? thr * 2 : 0.05;
    this.t(' lvl ', C.dim).t(num(mic.level, 4), mic.noisy ? C.bad : C.text);
    this.t(' base ', C.dim).t(base === null ? '--' : num(base, 4));
    this.t(' thr ', C.dim).t(Number.isFinite(thr) ? num(thr, 4) : '--').t(' ');
    this.bar(mic.level / scale, BAR_CELLS + 2, mic.noisy ? C.bad : C.ok, base === null ? -1 : base / scale, Number.isFinite(thr) ? thr / scale : -1);
    this.t(mic.noisy ? 'NOISY' : 'quiet', mic.noisy ? C.bad : C.dim);
    this.nl();

    const leak = info.micLeak;
    this.t(' leak ', C.dim).t('out ', C.dim).t(num(leak.gameLevel, 3));
    this.t(' aud ', C.dim).t(`${num(leak.ratioWhileGameAudible)}x`).t(' cut ', C.dim).t(`${num(leak.ratioWhileCut)}x  `);
    let verdict = '?';
    let color: string = C.dim;
    if (st === 'granted' && base !== null && leak.ratioWhileGameAudible > 0) {
      // Compare against the quiet (cut) reading when there is one; the room baseline otherwise.
      const r = leak.ratioWhileGameAudible / Math.max(1, leak.ratioWhileCut);
      verdict = r >= CONFIG.debug.micLeakRatio ? 'YES' : 'no';
      color = r >= CONFIG.mic.noiseRatio ? C.bad : r >= CONFIG.debug.micLeakRatio ? C.warn : C.ok;
    }
    this.t('mic hears game: ', C.dim).t(verdict, color);
    this.nl();
  }

  private drawLight(ctx: FrameContext): void {
    const f = ctx.flashlight;
    const low = CONFIG.flashlight.lowBatteryFraction;
    this.t('LIGHT ', C.head).t(f.on ? `ON ${f.hand ?? '?'}  ` : 'off     ', f.on ? C.warn : C.dim);
    this.t('battery ', C.dim);
    this.bar(f.battery, BAR_CELLS, f.battery > 0.5 ? C.ok : f.battery > low ? C.warn : C.bad);
    this.t(pct(f.battery), f.battery > low ? C.text : C.bad);
    this.nl();
  }

  private drawThreats(info: DebugInfo): void {
    const r = info.runner;
    this.t('THREATS ', C.head);
    if (r) {
      const tn = r.tuning;
      const active = r.activeAttacks();
      this.t(`night ${tn.night} x${num(tn.aggression, 2)}  active ${active.length}/${tn.maxConcurrent}`, C.text);
    } else {
      this.t('no night running', C.dim);
    }
    if (info.disabled.length) this.t('  off: ', C.dim).t(info.disabled.join(', '), C.warn);
    this.nl();

    for (const id of info.threatsTonight) this.drawThreat(id, info);
  }

  private drawThreat(id: ThreatId, info: DebugInfo): void {
    const r = info.runner;
    this.t(' ').t(id.padEnd(10), C.text);
    if (info.disabled.includes(id)) {
      this.t('OFF (disabled)', C.warn).nl();
      return;
    }
    if (!r) {
      this.t('-', C.dim).nl();
      return;
    }
    let attack: AttackView | null = null;
    for (const a of r.activeAttacks()) if (a.id === id) attack = a;
    if (attack) {
      const m = attack.meter;
      this.t('ATK ', C.bad).t(attack.teaching ? 'T ' : '  ', C.warn);
      this.bar(m, BAR_CELLS, level(m, 0.4, 0.75));
      this.t(pct(m), level(m, 0.4, 0.75));
      this.t(` ctr ${num(attack.counteredSec)}/${num(CONFIG.threats[id].leavesAfterSec)}s`, attack.countering ? C.ok : C.text);
      this.t(attack.countering ? ' C' : '  ', C.ok);
      this.t(` age ${num(attack.ageSec)}`, C.dim);
    } else {
      const next = r.nextAttackInSec(id);
      this.t('idle ', C.dim).t('next ', C.dim).t(next === null ? '--' : `${num(next)}s`, next !== null && next < 0 ? C.warn : C.text);
      const why = r.blockedReason(id);
      if (why) this.t('  wait: ', C.dim).t(why, C.warn);
    }
    this.nl();
  }

  private drawRoom(ctx: FrameContext): void {
    const rep = ctx.room.report;
    this.t('ROOM ', C.head);
    this.t('planes ', C.dim).t(rep.planeDetection ? 'ON' : 'OFF', rep.planeDetection ? C.ok : C.bad).t(` ${rep.planeCount}`);
    this.t('  meshes ', C.dim).t(rep.meshDetection ? 'ON' : 'OFF', rep.meshDetection ? C.ok : C.bad).t(` ${rep.meshCount}`);
    this.t(`  scan ${num(rep.scanAgeSec)}s`, C.dim);
    this.nl();

    // Every label gets shown; split the spare lines between the two lists (log keeps its lines).
    const spare = Math.max(2, MAX_LINES - this.line - 2 - LOG_LINES);
    const planeLines = Math.max(1, Math.ceil(spare / 2));
    this.labels(' plane: ', rep.planeLabels, planeLines);
    this.labels(' mesh:  ', rep.meshLabels, Math.max(1, spare - planeLines));

    this.features('WINDOWS ', ctx.room.windows);
    this.features('  DOORS ', ctx.room.doors);
    this.nl();
  }

  private labels(title: string, counts: Record<string, number>, maxLines: number): void {
    this.t(title, C.dim);
    const keys = Object.keys(counts);
    if (!keys.length) this.t('(none yet)', C.dim);
    const lastLine = this.line + maxLines - 1;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const ignored = k.includes('ignored');
      const isOpening = !ignored && (k.includes('window') || k.includes('door'));
      const item = `${k} ${counts[k]}`;
      if (!this.item(item, ignored ? C.warn : isOpening ? C.ok : C.text, title.length, lastLine)) {
        this.t(` +${keys.length - i}`, C.warn);
        break;
      }
    }
    this.nl();
  }

  private features(title: string, list: readonly RoomFeature[]): void {
    this.t(title, C.head).t(String(list.length), list.length ? C.ok : C.warn);
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      this.t(i === 0 ? ' ' : ', ', C.dim).t(f.source === 'placed' ? 'placed' : `${f.source}:${f.label}`, C.text);
    }
  }

  private drawLog(info: DebugInfo): void {
    const log = info.log;
    for (let i = Math.max(0, log.length - LOG_LINES); i < log.length; i++) this.t(log[i], C.dim).nl();
  }

  // ─── Text cursor ───────────────────────────────────────────────────────

  private nl(): this {
    this.line++;
    this.col = 0;
    return this;
  }

  /** Write a coloured run at the cursor; clipped (with …) at the panel edge and below the last line. */
  private t(s: string, color: string = C.text): this {
    const room = this.cols - this.col;
    if (this.line >= MAX_LINES || room <= 0 || !s) return this;
    const str = s.length > room ? `${s.slice(0, room - 1)}…` : s;
    this.g.fillStyle = color;
    this.g.fillText(str, PAD + this.col * this.charW, PAD + (this.line + 0.5) * LINE_PX);
    this.col += str.length;
    return this;
  }

  /** A comma-separated list item that wraps to `indent` on a new line; false when out of lines. */
  private item(s: string, color: string, indent: number, lastLine: number): boolean {
    const first = this.col <= indent;
    if (!first && this.col + 2 + s.length > this.cols - 4) {
      if (this.line >= lastLine) return false;
      this.nl();
      this.col = indent;
    } else if (!first) {
      this.t(', ', C.dim);
    }
    this.t(s, color);
    return true;
  }

  /** Space-separated words, wrapping onto at most `maxLines` lines indented by `indent`. */
  private words(s: string, color: string, indent: number, maxLines: number): void {
    const lastLine = this.line + maxLines - 1;
    for (const w of s.split(' ')) {
      if (this.col + 1 + w.length > this.cols && this.line < lastLine) {
        this.nl();
        this.col = indent;
      }
      this.t(`${w} `, color);
    }
  }

  /** A small meter, `cells` characters wide, with optional tick marks at fractions t1 / t2. */
  private bar(frac: number, cells: number, color: string, t1 = -1, t2 = -1): void {
    if (this.line >= MAX_LINES || this.col + cells > this.cols) return;
    const g = this.g;
    const x = PAD + this.col * this.charW;
    const y = PAD + this.line * LINE_PX + 8;
    const w = cells * this.charW;
    const h = LINE_PX - 16;
    g.fillStyle = C.track;
    g.fillRect(x, y, w, h);
    g.fillStyle = color;
    g.fillRect(x, y, w * clamp01(frac), h);
    g.fillStyle = C.text;
    if (t1 >= 0 && t1 <= 1) g.fillRect(x + w * t1 - 1, y - 4, 2, h + 8);
    if (t2 >= 0 && t2 <= 1) g.fillRect(x + w * t2 - 1.5, y - 5, 3, h + 10);
    this.col += cells + 1;
  }
}
