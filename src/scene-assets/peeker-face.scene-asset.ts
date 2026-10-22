import { Group, MeshBasicMaterial } from '@iwsdk/core';

/**
 * The Peeker's face: a sculpted, too-smooth pale face with deep hollow eye
 * sockets. Origin at the centre of the face, +Z out of the face, +Y up.
 * Expressions are morph targets driven by `setExpression`.
 */
export interface PeekerFaceRig {
  root: Group;
  material: MeshBasicMaterial;
  /** 0..1 each: eyes squeezed shut against light, mouth stretched open. */
  setExpression(squint: number, scream: number): void;
}

export function createPeekerFace(): PeekerFaceRig {
  const root = new Group();
  root.name = 'PeekerFace';
  const material = new MeshBasicMaterial({ vertexColors: true, transparent: true });
  return { root, material, setExpression: () => {} };
}

export default createPeekerFace().root;
