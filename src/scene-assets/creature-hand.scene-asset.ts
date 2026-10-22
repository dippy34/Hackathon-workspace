import { Group, MeshBasicMaterial, Object3D } from '@iwsdk/core';

/**
 * The creature hand shared by Under the Desk (and the Peeker's hand on the
 * glass). Joint contract used by the threat animations:
 * - `hand`: the hand root (origin at the knuckle line, +Y toward the fingertips,
 *   +Z out of the back of the hand);
 * - `fingers[i][k]`: index..pinky (i = 0..3), proximal..distal joints (k = 0..2);
 *   each child joint sits at +Y of its parent; rotation.x curls, rotation.z splays;
 * - `thumb[k]`: two joints, same convention;
 * - `material`: shared unlit material whose opacity/colour the threat animates.
 */
export interface CreatureHandRig {
  root: Group;
  hand: Group;
  fingers: Object3D[][];
  thumb: Object3D[];
  material: MeshBasicMaterial;
}

export function createCreatureHand(): CreatureHandRig {
  const root = new Group();
  root.name = 'CreatureHand';
  const hand = new Group();
  hand.name = 'Hand';
  root.add(hand);
  const material = new MeshBasicMaterial({ vertexColors: true, transparent: true });
  return { root, hand, fingers: [], thumb: [], material };
}

export default createCreatureHand().root;
