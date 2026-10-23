import { Euler, Matrix4, Quaternion, Vector3 } from '@iwsdk/core';
import type { Director } from '../game/director.js';

// Desktop preview only: drives IWER's emulated Quest 3 (window.IWER_DEVICE) from the
// Director's live state. The autopilot is e2e/autopilot.mjs + e2e/flow.mjs, ported.

type Side = 'left' | 'right';
interface Vec3Like {
  set(x: number, y: number, z: number): unknown;
}
interface QuatLike {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
  set(x: number, y: number, z: number, w: number): unknown;
}
interface IwerHand {
  readonly position: Vec3Like;
  readonly quaternion: QuatLike;
  poseId: string;
  updatePinchValue(value: number): void;
}
/** The slice of IWER's emulated XRDevice the preview uses. */
export interface IwerDevice {
  readonly activeSession: unknown;
  controlMode: 'manual' | 'programmatic';
  primaryInputMode: 'hand' | 'controller';
  readonly position: Vec3Like;
  readonly quaternion: QuatLike;
  readonly hands: Readonly<Record<Side, IwerHand>>;
  readonly devui?: { readonly devUIContainer?: HTMLElement };
  /** In programmatic mode the DevUI then re-reads the head/hand poses and the input mode. */
  notifyStateChange(): void;
}
/** IWER DevUI's hand gizmo (window.transformHandles): a child of its head rig, copied onto the hand every frame in manual mode. */
interface DevUIHandle {
  readonly position: Vec3Like;
  readonly quaternion: QuatLike;
  readonly parent: { readonly matrixWorld: { readonly elements: ArrayLike<number> } } | null;
}

/** 'auto' plays perfectly, 'catch' ignores every threat with the hands off the desk, 'off' leaves the hands alone. */
export type HandsMode = 'auto' | 'catch' | 'off';

const TICK_MS = 40;
/** The e2e desk: palms flat at 0.75 m, 0.4 m ahead, 0.36 m apart; the player sits with eyes at 1.2 m. */
const DESK_Y = 0.75;
const SEAT_Y = 1.2;
const DEG = Math.PI / 180;
/** Follow camera: fraction of the remaining turn made per tick (~0.45 s time constant). */
const LOOK_RATE = 1 - Math.exp(-TICK_MS / 450);
/** Placement: aim at the wall, pinch from 2.5 s to 4 s, retry every 5 s until placed. */
const PLACE_CYCLE_MS = 5000;

export class Pilot {
  hands: HandsMode = 'auto';
  /** true: the follow camera owns the head (IWER programmatic); false: free look with IWER's DevUI. */
  follow = true;

  private readonly v = new Vector3();
  private readonly q = new Quaternion();
  private readonly qh = new Quaternion();
  private readonly e = new Euler(0, 0, 0, 'YXZ');
  private readonly m = new Matrix4();
  private readonly target = new Vector3();
  private readonly flatQ = new Quaternion().setFromEuler(new Euler(-30 * DEG, 0, 0, 'YXZ'));
  private readonly wallQ = new Quaternion().setFromEuler(new Euler(0, -90 * DEG, 0, 'YXZ'));
  private readonly peekerFace: Vector3;
  private readonly knockerDoor: Vector3;
  private yaw = 0;
  private pitch = -20 * DEG;
  private steering = false;
  private inSession = false;
  private placeStep = '';
  private placeMs = 0;

  constructor(
    private readonly director: Director,
    private readonly device: IwerDevice,
  ) {
    // The autopilot's aim points; the threats keep them private, so read them structurally.
    this.peekerFace = (director.threats.peeker as unknown as { facePos: Vector3 }).facePos;
    this.knockerDoor = (director.threats.knocker as unknown as { doorTarget: Vector3 }).doorTarget;
    setInterval(() => this.tick(), TICK_MS);
  }

  private tick(): void {
    const d = this.device;
    const live = !!d.activeSession;
    if (live && !this.inSession) {
      d.primaryInputMode = 'hand';
      d.hands.left.poseId = d.hands.right.poseId = 'default';
    }
    this.inSession = live;
    // Free look hands the head to IWER's DevUI (manual); otherwise we drive it (programmatic).
    const mode = live && !this.follow ? 'manual' : 'programmatic';
    if (d.controlMode !== mode) {
      // While still programmatic, let the DevUI pick up the seated pose and hand input before it takes over.
      if (mode === 'manual') d.notifyStateChange();
      d.controlMode = mode;
    }
    // IWER's DevUI (and its "remote control" banner) only shows in free look.
    const ui = d.devui?.devUIContainer;
    const display = mode === 'manual' ? '' : 'none';
    if (ui && ui.style.display !== display) ui.style.display = display;
    if (!live) return;

    if (this.hands !== 'off') this.poseHands();
    if (this.follow) this.steerHead();
    this.steering = this.follow;
  }

  // ─── Hands ──────────────────────────────────────────────────────────────

  private poseHands(): void {
    const dir = this.director;
    const flow = dir.flow;
    const step = dir.intro.status;
    if (flow.phase === 'intro' && (step === 'placeDoor' || step === 'placeWindow')) {
      // No door (or window) in the room: point the right hand at the wall on the right and pinch.
      if (step !== this.placeStep) this.placeMs = 0;
      this.placeStep = step;
      this.placeMs += TICK_MS;
      const t = this.placeMs % PLACE_CYCLE_MS;
      this.hand('left', -0.18, DESK_Y, -0.4, this.flatQ, 0);
      this.hand('right', 0.2, 1.0, -0.3, this.wallQ, t > 2500 && t < 4000 ? 1 : 0);
      return;
    }
    this.placeStep = '';
    if (this.hands === 'catch' && flow.phase !== 'intro') {
      // Hands in the lap, off the desk; no threat is countered.
      this.hand('left', -0.18, DESK_Y + 0.3, -0.3, this.flatQ, 0);
      this.hand('right', 0.18, DESK_Y + 0.3, -0.3, this.flatQ, 0);
      return;
    }
    let under = false;
    let peeker = false;
    let knocker = false;
    const runner = flow.phase === 'night' ? flow.runner : null;
    if (runner) {
      for (const a of runner.activeAttacks()) {
        if (a.id === 'underDesk') under = true;
        else if (a.id === 'peeker') peeker = true;
        else if (a.id === 'knocker') knocker = true;
      }
    }
    // Desk first (both palms flat, still; also calibration and rest); otherwise the
    // right hand pinches the flashlight at the Peeker's face, the left palm faces the Knocker's door.
    if (peeker && !under) this.hand('right', 0.2, 1.0, -0.3, this.aim(0.2, 1.0, -0.3, this.peekerFace, false), 1);
    else this.hand('right', 0.18, DESK_Y, -0.4, this.flatQ, 0);
    if (knocker && !under) this.hand('left', -0.2, DESK_Y + 0.3, -0.3, this.aim(-0.2, DESK_Y + 0.3, -0.3, this.knockerDoor, true), 0);
    else this.hand('left', -0.18, DESK_Y, -0.4, this.flatQ, 0);
  }

  /** Point the hand's -Z at `to` (flashlight), or (palm) yaw toward it with a 60 deg pitch that turns the palm to face it. */
  private aim(x: number, y: number, z: number, to: Vector3, palm: boolean): Quaternion {
    const dx = to.x - x;
    const dz = to.z - z;
    const pitch = palm ? 60 * DEG : Math.atan2(to.y - y, Math.hypot(dx, dz));
    return this.q.setFromEuler(this.e.set(pitch, Math.atan2(-dx, -dz), 0));
  }

  private hand(side: Side, x: number, y: number, z: number, q: Quaternion, pinch: number): void {
    const h = this.device.hands[side];
    h.updatePinchValue(pinch);
    const gizmo = this.follow ? null : (window as unknown as { transformHandles?: Map<Side, DevUIHandle> }).transformHandles?.get(side);
    if (!gizmo?.parent) {
      h.position.set(x, y, z);
      h.quaternion.set(q.x, q.y, q.z, q.w);
      return;
    }
    // Free look: the DevUI copies its gizmos onto the hands each frame, so pose the gizmo (rig-local) instead.
    this.m.fromArray(gizmo.parent.matrixWorld.elements).invert();
    this.v.set(x, y, z).applyMatrix4(this.m);
    this.qh.setFromRotationMatrix(this.m).multiply(q);
    gizmo.position.set(this.v.x, this.v.y, this.v.z);
    gizmo.quaternion.set(this.qh.x, this.qh.y, this.qh.z, this.qh.w);
  }

  // ─── Follow camera ──────────────────────────────────────────────────────

  private steerHead(): void {
    const d = this.device;
    if (!this.steering) {
      // Taking over from free look: start from where the head points now.
      this.e.setFromQuaternion(this.qh.set(d.quaternion.x, d.quaternion.y, d.quaternion.z, d.quaternion.w), 'YXZ');
      this.yaw = this.e.y;
      this.pitch = this.e.x;
    }
    const t = this.lookTarget();
    if (t) {
      const yaw = Math.atan2(-t.x, -t.z);
      const pitch = Math.atan2(t.y - SEAT_Y, Math.hypot(t.x, t.z));
      let turn = yaw - this.yaw;
      turn -= Math.round(turn / (2 * Math.PI)) * 2 * Math.PI;
      this.yaw += turn * LOOK_RATE;
      this.pitch += (pitch - this.pitch) * LOOK_RATE;
    }
    this.qh.setFromEuler(this.e.set(this.pitch, this.yaw, 0));
    d.position.set(0, SEAT_Y, 0);
    d.quaternion.set(this.qh.x, this.qh.y, this.qh.z, this.qh.w);
  }

  /** The most urgent threat that can be seen (highest meter), else the desk; null holds the view (caught). */
  private lookTarget(): Vector3 | null {
    const dir = this.director;
    const flow = dir.flow;
    if (flow.phase === 'caught') return null;
    if (this.placeStep) return this.target.set(1.5, 1.0, -0.6);
    let best: string | null = null;
    let meter = -1;
    const runner = flow.phase === 'night' ? flow.runner : null;
    if (runner) {
      for (const a of runner.activeAttacks()) {
        if (a.id !== 'listener' && a.meter > meter) {
          best = a.id;
          meter = a.meter;
        }
      }
    }
    if (best === 'peeker') return this.target.copy(this.peekerFace);
    if (best === 'knocker') return this.target.copy(this.knockerDoor);
    if (best === 'underDesk') return dir.threats.underDesk.hintAnchor(dir.ctx, this.target);
    // Calm: the desk and the room beyond it.
    const desk = dir.ctx.desk;
    return desk ? this.target.copy(desk.center).addScaledVector(desk.towardPlayer, -0.6) : this.target.set(0, DESK_Y, -1);
  }
}
