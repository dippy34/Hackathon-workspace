/**
 * Room scan from RAW WebXR plane / mesh detection (frame.detectedPlanes /
 * frame.detectedMeshes; IWSDK's SceneUnderstanding system is not used).
 *
 * - Counts every semantic label the headset reports and logs each new one once
 *   ('[room]' prefix), since Quest Browser label support is unverified.
 * - Turns window / door planes (and meshes) into stable RoomFeature objects
 *   that follow the headset's refinements.
 * - Point-and-pinch placement fallback: ray-cast against detected walls.
 * - Open-plan rooms: Quest labels Space Setup's invisible walls 'window'. A
 *   "window" at least CONFIG.room.maxWindowHeightM tall is one of those, so it
 *   never becomes a feature (logged once per plane, and counted in the report
 *   under '<label> (wall-sized, ignored)' instead of its label).
 *
 * Plane space: Y is the plane normal and the polygon lies in its XZ plane.
 */

import {
  BufferGeometry,
  CanvasTexture,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type Entity,
  type World,
} from '@iwsdk/core';
import { CONFIG } from '../config.js';
import type { FeatureKind, RoomFeature, RoomScanReport, RoomScannerLike } from '../game/contracts.js';

const NO_LABEL = '(none)';
/** Report key suffix for a wall-sized 'window' (an invisible wall), e.g. 'window (wall-sized, ignored)'. */
const WALL_SIZED_SUFFIX = ' (wall-sized, ignored)';
const UP = new Vector3(0, 1, 0);
/** Debug marker colours: cold cyan windows, amber doors. */
const MARKER_COLOR: Record<FeatureKind, number> = { window: 0x7fdcff, door: 0xffa845 };
const MARKER_CSS: Record<FeatureKind, string> = { window: '#7fdcff', door: '#ffa845' };

function normalizeLabel(raw: string | null | undefined): string {
  const s = raw?.trim().toLowerCase();
  return s ? s : NO_LABEL;
}

/** Quest reports 'window' / 'door'; also accept 'window frame', 'door_frame', ... (label is lowercase). */
function openingKind(label: string): FeatureKind | null {
  if (label.includes('window')) return 'window';
  if (label.includes('door')) return 'door';
  return null;
}

function fmt(v: { x: number; y: number; z: number }): string {
  return `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
}

/** Heading (deg, 0 = facing -Z, + = turned left) of an orientation's forward (-Z) axis. */
function yawDeg(q: { x: number; y: number; z: number; w: number }): number {
  const fx = -2 * (q.x * q.z + q.w * q.y);
  const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
  return (Math.atan2(-fx, -fz) * 180) / Math.PI;
}

class Feature implements RoomFeature {
  readonly position = new Vector3();
  readonly normal = new Vector3(0, 0, 1);
  width = 1;
  height = 1;
  /** The detection currently driving this feature (null: placed, or its plane/mesh went away). */
  owner: Detection | null = null;
  marker: Marker | null = null;

  constructor(
    readonly kind: FeatureKind,
    public source: RoomFeature['source'],
    public label: string,
  ) {}
}

/** One XRPlane or XRMesh, keyed by object identity (the browser updates them in place). */
class Detection {
  seenFrame = -1;
  labelRead = false;
  rawLabel: string | undefined;
  label = NO_LABEL;
  kind: FeatureKind | null = null;
  changedTime = NaN;
  /** Bounds in plane/mesh space (planes: the polygon, y = 0). */
  readonly min = new Vector3();
  readonly max = new Vector3();
  /** Plane/mesh space -> world. */
  readonly matrix = new Matrix4();
  poseValid = false;
  vertical = false;
  logged = false;
  feature: Feature | null = null;
  /** A 'window' at least CONFIG.room.maxWindowHeightM tall (an invisible wall): never drives a feature. */
  wallSized = false;
  wallLogged = false;
  /** Key this detection is counted under in the report's label list. */
  countKey = NO_LABEL;

  constructor(
    readonly source: 'plane' | 'mesh',
    readonly space: XRSpace,
  ) {}
}

interface Marker {
  readonly root: Group;
  readonly rect: LineSegments;
  readonly label: Mesh;
  readonly canvas: HTMLCanvasElement;
  readonly texture: CanvasTexture;
  readonly labelMaterial: MeshBasicMaterial;
  readonly entity: Entity;
  shownSource: string;
  shownLabel: string;
}

export class RoomScanner implements RoomScannerLike {
  private readonly windowList: Feature[] = [];
  private readonly doorList: Feature[] = [];
  readonly windows: readonly RoomFeature[] = this.windowList;
  readonly doors: readonly RoomFeature[] = this.doorList;
  readonly report: RoomScanReport = {
    planeDetection: false,
    meshDetection: false,
    planeCount: 0,
    meshCount: 0,
    planeLabels: {},
    meshLabels: {},
    scanAgeSec: 0,
  };

  private readonly planes = new Map<XRPlane, Detection>();
  private readonly meshes = new Map<XRMesh, Detection>();
  private readonly planeLabelKeys: string[] = [];
  private readonly meshLabelKeys: string[] = [];
  private readonly loggedPlaneLabels = new Set<string>();
  private readonly loggedMeshLabels = new Set<string>();
  private session: XRSession | null = null;
  private sessionNo = 0;
  private frameNo = 0;
  private summaryLogged = false;
  private markersVisible = false;

  // Per-update context for the Set/Map forEach callbacks (no closures per frame).
  private frame: XRFrame | null = null;
  private refSpace: XRReferenceSpace | null = null;

  // Scratch.
  private readonly playerMat = new Matrix4();
  private readonly headPos = new Vector3();
  private readonly pos = new Vector3();
  private readonly nrm = new Vector3();
  private measuredWidth = 0;
  private measuredHeight = 0;
  private readonly logPos = new Vector3();
  private readonly logQuat = new Quaternion();
  private readonly invMat = new Matrix4();
  private readonly rayOrigin = new Vector3();
  private readonly rayDir = new Vector3();
  private readonly localOrigin = new Vector3();
  private readonly localDir = new Vector3();
  private bestT = 0;
  private bestHit: Detection | null = null;
  /** Feature being removed (unlinkOrphan clears every detection's reference to it). */
  private orphan: Feature | null = null;
  /** The last placementPoint() wall hit, so place() can use that wall's real normal. */
  private lastHitValid = false;
  private readonly lastHitPos = new Vector3();
  private readonly lastHitNormal = new Vector3();

  // Shared marker resources.
  private readonly rectGeometry = new BufferGeometry();
  private readonly pinGeometry = new BufferGeometry();
  private readonly labelGeometry = new PlaneGeometry(0.34, 0.085);
  private readonly lineMaterial: Record<FeatureKind, LineBasicMaterial> = {
    window: new LineBasicMaterial({ color: MARKER_COLOR.window, transparent: true, opacity: 0.9, depthWrite: false }),
    door: new LineBasicMaterial({ color: MARKER_COLOR.door, transparent: true, opacity: 0.9, depthWrite: false }),
  };

  constructor(private readonly world: World) {
    // Unit rectangle outline in XY (scaled to the feature), facing +Z.
    this.rectGeometry.setAttribute(
      'position',
      new Float32BufferAttribute(
        [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, -0.5, -0.5, 0],
        3,
      ),
    );
    // Fixed-size centre cross plus a tick along the normal (into the room).
    const c = 0.06;
    this.pinGeometry.setAttribute(
      'position',
      new Float32BufferAttribute([-c, 0, 0, c, 0, 0, 0, -c, 0, 0, c, 0, 0, 0, 0, 0, 0, 0.2], 3),
    );
    world.renderer?.xr?.addEventListener?.('sessionend', this.logSessionEnd);
  }

  // ─── Per frame ──────────────────────────────────────────────────────────

  update(frame: XRFrame, refSpace: XRReferenceSpace, dt: number): void {
    if (frame.session !== this.session) this.startSession(frame, refSpace);
    const report = this.report;
    report.scanAgeSec += dt;
    this.frameNo++;
    this.frame = frame;
    this.refSpace = refSpace;
    this.playerMat.copy(this.world.player.matrixWorld);
    this.world.player.head.getWorldPosition(this.headPos);

    zeroCounts(report.planeLabels, this.planeLabelKeys);
    zeroCounts(report.meshLabels, this.meshLabelKeys);

    if (report.planeDetection) {
      const planes = readSet(frame, 'detectedPlanes');
      if (planes) {
        planes.forEach(this.visitPlane);
        report.planeCount = planes.size;
      } else {
        report.planeCount = 0;
      }
      this.planes.forEach(this.sweepPlane);
    }
    if (report.meshDetection) {
      const meshes = readSet(frame, 'detectedMeshes');
      if (meshes) {
        meshes.forEach(this.visitMesh);
        report.meshCount = meshes.size;
      } else {
        report.meshCount = 0;
      }
      this.meshes.forEach(this.sweepMesh);
    }
    this.frame = null;
    this.refSpace = null;

    if (this.markersVisible) {
      this.syncMarkers(this.windowList);
      this.syncMarkers(this.doorList);
    }
    if (!this.summaryLogged && report.scanAgeSec >= CONFIG.intro.roomScanTimeoutSec) this.logSummary();
  }

  // ─── Placement fallback ─────────────────────────────────────────────────

  placementPoint(origin: Vector3, dir: Vector3, out: Vector3): Vector3 {
    this.rayOrigin.copy(origin);
    this.rayDir.copy(dir);
    if (this.rayDir.lengthSq() < 1e-12) this.rayDir.set(0, 0, -1);
    this.rayDir.normalize();
    this.bestT = CONFIG.room.placementMaxDistM;
    this.bestHit = null;
    this.planes.forEach(this.rayTest);

    const hit = this.bestHit as Detection | null; // set by rayTest
    out.copy(this.rayOrigin).addScaledVector(this.rayDir, hit ? this.bestT : CONFIG.intro.placementFallbackDistM);
    this.lastHitValid = hit !== null;
    if (hit) {
      this.lastHitPos.copy(out);
      const e = hit.matrix.elements;
      this.lastHitNormal.set(e[4], 0, e[6]);
    }
    return out;
  }

  place(kind: FeatureKind, position: Vector3, towardPoint: Vector3): RoomFeature {
    const existing = this.nearest(this.listFor(kind), position);
    if (existing) return existing;

    const f = new Feature(kind, 'placed', 'placed');
    f.position.copy(position);
    // Prefer the real wall normal when this is the point placementPoint() just hit.
    if (this.lastHitValid && position.distanceToSquared(this.lastHitPos) < 1e-4) f.normal.copy(this.lastHitNormal);
    else f.normal.set(towardPoint.x - position.x, 0, towardPoint.z - position.z);
    orientToward(f.normal, position, towardPoint);
    f.width = kind === 'window' ? CONFIG.room.placedWindowWidthM : CONFIG.room.placedDoorWidthM;
    f.height = kind === 'window' ? CONFIG.room.placedWindowHeightM : CONFIG.room.placedDoorHeightM;
    this.addFeature(f);
    return f;
  }

  setMarkersVisible(v: boolean): void {
    this.markersVisible = v;
    for (const list of [this.windowList, this.doorList]) {
      for (const f of list) if (f.marker) f.marker.root.visible = v;
      if (v) this.syncMarkers(list);
    }
  }

  // ─── Detection visitors (bound once; called from Set/Map forEach) ──────

  private readonly visitPlane = (plane: XRPlane): void => {
    let d = this.planes.get(plane);
    if (!d) {
      d = new Detection('plane', plane.planeSpace);
      this.planes.set(plane, d);
    }
    d.seenFrame = this.frameNo;
    this.readLabel(d, plane.semanticLabel);
    if (d.changedTime !== plane.lastChangedTime) {
      d.changedTime = plane.lastChangedTime;
      polygonBounds(plane.polygon, d);
    }
    this.trackPlane(d, plane.orientation as string | null | undefined);
    // Counted after tracking, which may have found a wall-sized 'window'.
    countLabel(this.report.planeLabels, this.planeLabelKeys, d.countKey);
  };

  /**
   * Vertical planes (walls, windows, doors) are re-posed every frame for
   * features and placement; horizontal ones only until they've been logged.
   */
  private trackPlane(d: Detection, orientation: string | null | undefined): void {
    if (orientation === 'horizontal') d.vertical = false;
    if (orientation === 'horizontal' && d.logged) return;
    this.refreshPose(d);
    if (!d.poseValid) return;
    if (orientation !== 'horizontal') {
      d.vertical = orientation === 'vertical' || Math.abs(d.matrix.elements[5]) < 0.5;
    }
    if (!d.logged) this.logDetection(d, orientation ?? (d.vertical ? 'vertical?' : 'horizontal?'));
    if (d.kind && d.vertical) this.driveFeature(d);
  }

  private readonly visitMesh = (mesh: XRMesh): void => {
    let d = this.meshes.get(mesh);
    if (!d) {
      d = new Detection('mesh', mesh.meshSpace);
      this.meshes.set(mesh, d);
    }
    d.seenFrame = this.frameNo;
    this.readLabel(d, mesh.semanticLabel);
    if (d.changedTime !== mesh.lastChangedTime) {
      d.changedTime = mesh.lastChangedTime;
      vertexBounds(mesh.vertices, d);
    }
    this.trackMesh(d);
    // Counted after tracking, which may have found a wall-sized 'window'.
    countLabel(this.report.meshLabels, this.meshLabelKeys, d.countKey);
  };

  private trackMesh(d: Detection): void {
    if (d.logged && !d.kind) return;
    this.refreshPose(d);
    if (!d.poseValid) return;
    if (!d.logged) this.logDetection(d, null);
    if (d.kind) this.driveFeature(d);
  }

  private readonly sweepPlane = (d: Detection, plane: XRPlane): void => {
    if (d.seenFrame === this.frameNo) return;
    this.releaseFeature(d);
    this.planes.delete(plane);
  };

  private readonly sweepMesh = (d: Detection, mesh: XRMesh): void => {
    if (d.seenFrame === this.frameNo) return;
    this.releaseFeature(d);
    this.meshes.delete(mesh);
  };

  private readonly unlinkOrphan = (d: Detection): void => {
    if (d.feature === this.orphan) d.feature = null;
  };

  private readonly rayTest = (d: Detection): void => {
    if (!d.vertical || !d.poseValid) return;
    const inv = this.invMat.copy(d.matrix).invert();
    const o = this.localOrigin.copy(this.rayOrigin).applyMatrix4(inv);
    const v = this.localDir.copy(this.rayDir).transformDirection(inv);
    if (Math.abs(v.y) < 1e-6) return;
    const t = -o.y / v.y; // rigid transform: local t = world distance
    if (t <= 0 || t >= this.bestT) return;
    const x = o.x + v.x * t;
    const z = o.z + v.z * t;
    if (x < d.min.x || x > d.max.x || z < d.min.z || z > d.max.z) return;
    this.bestT = t;
    this.bestHit = d;
  };

  // ─── Detections -> features ─────────────────────────────────────────────

  private readLabel(d: Detection, raw: string | undefined): void {
    if (d.labelRead && raw === d.rawLabel) return;
    d.labelRead = true;
    d.rawLabel = raw;
    d.label = normalizeLabel(raw);
    d.wallSized = false; // re-judged by driveFeature under the new label
    d.countKey = d.label;
    const kind = openingKind(d.label);
    if (kind !== d.kind) {
      this.releaseFeature(d);
      d.kind = kind;
    }
  }

  private refreshPose(d: Detection): void {
    const pose = this.frame!.getPose(d.space, this.refSpace!);
    d.poseValid = !!pose;
    if (pose) d.matrix.fromArray(pose.transform.matrix).premultiply(this.playerMat);
  }

  /** Centre, inward normal and size of a window/door detection into pos / nrm / measured*. */
  private measure(d: Detection): void {
    const e = d.matrix.elements;
    this.pos.addVectors(d.min, d.max).multiplyScalar(0.5).applyMatrix4(d.matrix);
    const sx = d.max.x - d.min.x;
    const sy = d.max.y - d.min.y;
    const sz = d.max.z - d.min.z;
    // How vertical each local axis is in the world (columns of a rigid matrix).
    const upX = Math.abs(e[1]);
    const upY = Math.abs(e[5]);
    const upZ = Math.abs(e[9]);
    let normalAxis: number;
    if (d.source === 'plane') {
      // Normal = plane Y; of the in-plane axes the more vertical one is the height.
      normalAxis = 1;
      this.measuredHeight = upX >= upZ ? sx : sz;
      this.measuredWidth = upX >= upZ ? sz : sx;
    } else {
      // Mesh box: the most vertical axis is the height, the thinner horizontal one the normal.
      const vAxis = upX >= upY && upX >= upZ ? 0 : upY >= upZ ? 1 : 2;
      const a = (vAxis + 1) % 3;
      const b = (vAxis + 2) % 3;
      const sa = a === 0 ? sx : a === 1 ? sy : sz;
      const sb = b === 0 ? sx : b === 1 ? sy : sz;
      normalAxis = sa <= sb ? a : b;
      this.measuredWidth = Math.max(sa, sb);
      this.measuredHeight = vAxis === 0 ? sx : vAxis === 1 ? sy : sz;
    }
    this.nrm.set(e[normalAxis * 4], 0, e[normalAxis * 4 + 2]);
    orientToward(this.nrm, this.pos, this.headPos);
  }

  private driveFeature(d: Detection): void {
    this.measure(d);
    if (d.kind === 'window' && this.measuredHeight >= CONFIG.room.maxWindowHeightM) {
      this.rejectWallSized(d);
      return;
    }
    this.setWallSized(d, false);
    if (!d.feature) d.feature = this.claim(d);
    const f = d.feature;
    if (!f.owner && f.source !== 'placed') {
      f.owner = d;
      f.source = d.source;
      f.label = d.label;
    }
    if (f.owner !== d) return; // a duplicate of a feature another detection drives
    f.position.copy(this.pos);
    f.normal.copy(this.nrm);
    f.width = this.measuredWidth;
    f.height = this.measuredHeight;
  }

  /**
   * Quest maps Space Setup's invisible walls (open-plan room boundaries) to the
   * label 'window'. One that's wall-sized is one of those: it drives no feature,
   * and any feature it was driving goes away (so the intro's placement fallback
   * runs if no real window is left). Uses the measure() just done.
   */
  private rejectWallSized(d: Detection): void {
    this.setWallSized(d, true);
    if (d.feature) this.discardFeatureOf(d);
    if (d.wallLogged) return;
    d.wallLogged = true;
    console.log(
      `[room] ${d.label} label but wall-sized (${this.measuredWidth.toFixed(2)} x ${this.measuredHeight.toFixed(2)} m): ` +
        `treating as invisible wall, ignored [${d.source} at ${fmt(this.pos)}]`,
    );
  }

  private setWallSized(d: Detection, wallSized: boolean): void {
    if (d.wallSized === wallSized) return;
    d.wallSized = wallSized;
    d.countKey = wallSized ? d.label + WALL_SIZED_SUFFIX : d.label;
  }

  /**
   * Unlink a detection that turned out not to be an opening from its feature. A
   * feature it was driving is removed outright (released features normally keep
   * their last pose), along with every other detection's link to it.
   */
  private discardFeatureOf(d: Detection): void {
    const f = d.feature!;
    d.feature = null;
    if (f.owner !== d) return; // placed, or driven by another detection: not ours to remove
    const list = this.listFor(f.kind);
    const i = list.indexOf(f);
    if (i >= 0) list.splice(i, 1);
    if (f.marker) disposeMarker(f.marker);
    f.marker = null;
    f.owner = null;
    this.orphan = f;
    this.planes.forEach(this.unlinkOrphan);
    this.meshes.forEach(this.unlinkOrphan);
    this.orphan = null;
    console.log(`[room] - ${f.kind} at ${fmt(f.position)}: its ${d.source} is now wall-sized; ${list.length} ${f.kind}s left`);
  }

  /** Existing feature within the merge distance (de-dupe), else a new one. */
  private claim(d: Detection): Feature {
    const kind = d.kind!;
    const existing = this.nearest(this.listFor(kind), this.pos);
    if (existing) return existing;
    const f = new Feature(kind, d.source, d.label);
    f.position.copy(this.pos);
    f.normal.copy(this.nrm);
    f.width = this.measuredWidth;
    f.height = this.measuredHeight;
    this.addFeature(f);
    return f;
  }

  private releaseFeature(d: Detection): void {
    if (!d.feature) return;
    if (d.feature.owner === d) d.feature.owner = null; // keeps its last pose; may be re-claimed
    d.feature = null;
  }

  private nearest(list: readonly Feature[], p: Vector3): Feature | null {
    let best: Feature | null = null;
    let bestDist: number = CONFIG.room.featureMergeDistM;
    for (let i = 0; i < list.length; i++) {
      const dist = list[i].position.distanceTo(p);
      if (dist <= bestDist) {
        best = list[i];
        bestDist = dist;
      }
    }
    return best;
  }

  private listFor(kind: FeatureKind): Feature[] {
    return kind === 'window' ? this.windowList : this.doorList;
  }

  private addFeature(f: Feature): void {
    const list = this.listFor(f.kind);
    list.push(f);
    f.marker = this.createMarker(f);
    if (this.markersVisible) this.syncMarker(f);
    console.log(
      `[room] + ${f.kind} #${list.length} from ${f.source}${f.source === 'placed' ? '' : ` "${f.label}"`} at ${fmt(f.position)}, ` +
        `${f.width.toFixed(2)} x ${f.height.toFixed(2)} m, facing ${fmt(f.normal)}`,
    );
  }

  // ─── Session + logging ──────────────────────────────────────────────────

  /**
   * XRPlane / XRMesh objects belong to their session, so a new session rebuilds
   * every detection and drops the detected features: they come straight back
   * from the new scan, in the new session's coordinates, whether or not its
   * origin moved. Placed features are kept, like the director's desk
   * calibration; both assume Quest keeps the same local-floor origin for every
   * session of the page. UNVERIFIED: compare the head pose logged at session
   * end with the next session's start. If the origin moves, placed features and
   * the desk must be redone on resume (re-run the intro) or anchored (XRAnchor).
   */
  private startSession(frame: XRFrame, refSpace: XRReferenceSpace): void {
    this.session = frame.session;
    this.sessionNo++;
    this.logSessionStart(frame, refSpace);
    const features = frame.session.enabledFeatures;
    this.report.planeDetection = features
      ? features.includes('plane-detection')
      : readSet(frame, 'detectedPlanes') !== undefined;
    this.report.meshDetection = features
      ? features.includes('mesh-detection')
      : readSet(frame, 'detectedMeshes') !== undefined;
    this.planes.clear();
    this.meshes.clear();
    this.dropDetected(this.windowList);
    this.dropDetected(this.doorList);
    this.report.planeCount = 0;
    this.report.meshCount = 0;
    this.report.scanAgeSec = 0;
    this.summaryLogged = false;
    console.log(
      `[room] scan started: plane-detection ${this.report.planeDetection}, mesh-detection ${this.report.meshDetection}`,
    );
  }

  /** Once per session (allocates): where the origin put the head, plus the placed features kept. */
  private logSessionStart(frame: XRFrame, refSpace: XRReferenceSpace): void {
    const t = frame.getViewerPose(refSpace)?.transform;
    const head = t ? `head ${fmt(t.position)} yaw ${yawDeg(t.orientation).toFixed(0)}°` : 'no viewer pose yet';
    const kept = [...this.windowList, ...this.doorList]
      .filter((f) => f.source === 'placed')
      .map((f) => `${f.kind} ${fmt(f.position)}`);
    console.log(`[room] session ${this.sessionNo} start: ${head}; kept placed: ${kept.length ? kept.join(', ') : 'none'}`);
  }

  private readonly logSessionEnd = (): void => {
    const head = this.world.player.head;
    head.getWorldPosition(this.logPos);
    head.getWorldQuaternion(this.logQuat);
    console.log(`[room] session ${this.sessionNo} end: head ${fmt(this.logPos)} yaw ${yawDeg(this.logQuat).toFixed(0)}°`);
  };

  private dropDetected(list: Feature[]): void {
    for (let i = list.length - 1; i >= 0; i--) {
      const f = list[i];
      if (f.source === 'placed') continue;
      if (f.marker) disposeMarker(f.marker);
      f.marker = null;
      f.owner = null;
      list.splice(i, 1);
    }
  }

  private logDetection(d: Detection, orientation: string | null): void {
    d.logged = true;
    const seen = d.source === 'plane' ? this.loggedPlaneLabels : this.loggedMeshLabels;
    if (seen.has(d.label)) return;
    seen.add(d.label);
    this.logPos.addVectors(d.min, d.max).multiplyScalar(0.5).applyMatrix4(d.matrix);
    const size =
      d.source === 'plane'
        ? `${(d.max.x - d.min.x).toFixed(2)} x ${(d.max.z - d.min.z).toFixed(2)} m`
        : `box ${(d.max.x - d.min.x).toFixed(2)} x ${(d.max.y - d.min.y).toFixed(2)} x ${(d.max.z - d.min.z).toFixed(2)} m`;
    console.log(
      `[room] new ${d.source} label "${d.label}"${orientation ? ` (${orientation})` : ''} at ${fmt(this.logPos)}, ${size}`,
    );
  }

  private logSummary(): void {
    this.summaryLogged = true;
    const r = this.report;
    console.log(
      `[room] after ${r.scanAgeSec.toFixed(1)} s: ${r.planeCount} planes ${JSON.stringify(r.planeLabels)}, ` +
        `${r.meshCount} meshes ${JSON.stringify(r.meshLabels)}; ${this.windowList.length} windows, ${this.doorList.length} doors`,
    );
    if (r.planeDetection && r.planeCount === 0) {
      console.warn('[room] no planes reported: has Space Setup been run on this headset?');
    }
  }

  // ─── Debug markers ──────────────────────────────────────────────────────

  private createMarker(f: Feature): Marker {
    const root = new Group();
    root.name = `room-${f.kind}-marker`;
    root.visible = this.markersVisible;
    const rect = new LineSegments(this.rectGeometry, this.lineMaterial[f.kind]);
    const pin = new LineSegments(this.pinGeometry, this.lineMaterial[f.kind]);
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const labelMaterial = new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
    const label = new Mesh(this.labelGeometry, labelMaterial);
    root.add(rect, pin, label);
    const entity = this.world.createTransformEntity(root, { persistent: true });
    const marker: Marker = { root, rect, label, canvas, texture, labelMaterial, entity, shownSource: '', shownLabel: '' };
    drawMarkerLabel(marker, f);
    return marker;
  }

  private syncMarkers(list: readonly Feature[]): void {
    for (let i = 0; i < list.length; i++) this.syncMarker(list[i]);
  }

  private syncMarker(f: Feature): void {
    const m = f.marker;
    if (!m) return;
    if (m.shownSource !== f.source || m.shownLabel !== f.label) drawMarkerLabel(m, f);
    m.root.position.copy(f.position);
    m.root.quaternion.setFromAxisAngle(UP, Math.atan2(f.normal.x, f.normal.z)); // +Z -> normal
    const w = Math.max(f.width, 0.05);
    const h = Math.max(f.height, 0.05);
    m.rect.scale.set(w, h, 1);
    m.label.position.set(0, h / 2 + 0.07, 0);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** frame.detectedPlanes / detectedMeshes; throws in Chrome if the feature isn't enabled. */
function readSet<K extends 'detectedPlanes' | 'detectedMeshes'>(frame: XRFrame, key: K): XRFrame[K] | undefined {
  try {
    return frame[key];
  } catch {
    return undefined;
  }
}

function zeroCounts(rec: Record<string, number>, keys: readonly string[]): void {
  for (let i = 0; i < keys.length; i++) rec[keys[i]] = 0;
}

function countLabel(rec: Record<string, number>, keys: string[], label: string): void {
  const c = rec[label];
  if (c === undefined) {
    rec[label] = 1;
    keys.push(label);
  } else {
    rec[label] = c + 1;
  }
}

function polygonBounds(polygon: readonly DOMPointReadOnly[], d: Detection): void {
  if (!polygon.length) {
    d.min.set(0, 0, 0);
    d.max.set(0, 0, 0);
    return;
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  d.min.set(minX, 0, minZ);
  d.max.set(maxX, 0, maxZ);
}

function vertexBounds(vertices: Float32Array, d: Detection): void {
  if (vertices.length < 3) {
    d.min.set(0, 0, 0);
    d.max.set(0, 0, 0);
    return;
  }
  d.min.set(Infinity, Infinity, Infinity);
  d.max.set(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    const x = vertices[i];
    const y = vertices[i + 1];
    const z = vertices[i + 2];
    if (x < d.min.x) d.min.x = x;
    if (x > d.max.x) d.max.x = x;
    if (y < d.min.y) d.min.y = y;
    if (y > d.max.y) d.max.y = y;
    if (z < d.min.z) d.min.z = z;
    if (z > d.max.z) d.max.z = z;
  }
}

/** Flatten `n` to horizontal, normalise, and flip it to face `toward` from `from`. */
function orientToward(n: Vector3, from: Vector3, toward: Vector3): void {
  n.y = 0;
  const dx = toward.x - from.x;
  const dz = toward.z - from.z;
  if (n.lengthSq() < 1e-8) n.set(dx, 0, dz);
  if (n.lengthSq() < 1e-8) n.set(0, 0, 1);
  n.normalize();
  if (n.x * dx + n.z * dz < 0) n.negate();
}

function drawMarkerLabel(m: Marker, f: Feature): void {
  m.shownSource = f.source;
  m.shownLabel = f.label;
  const g = m.canvas.getContext('2d');
  if (!g) return;
  const { width: w, height: h } = m.canvas;
  const color = MARKER_CSS[f.kind];
  g.clearRect(0, 0, w, h);
  g.fillStyle = 'rgba(6, 8, 12, 0.72)';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = color;
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, w - 3, h - 3);
  g.fillStyle = color;
  g.font = '600 44px ui-monospace, Menlo, Consolas, monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const extra = f.label !== f.kind && f.source !== 'placed' ? ` "${f.label}"` : '';
  g.fillText(`${f.kind.toUpperCase()} · ${f.source}${extra}`, w / 2, h / 2, w - 24);
  m.texture.needsUpdate = true;
}

function disposeMarker(m: Marker): void {
  m.entity.dispose({ disposeResources: false }); // geometry + line materials are shared
  m.texture.dispose();
  m.labelMaterial.dispose();
}
