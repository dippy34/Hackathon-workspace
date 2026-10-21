import { outlineMaterial, type World } from '@iwsdk/core';

/** Faint pale bone: the hands read as a ghostly rim against the dark. */
const HAND_OUTLINE = 0xcfc6b8;

/**
 * Restyles IWSDK's default hands for the dark room and removes the pointer
 * rays (hands only; nothing here is ray-interactable).
 *
 * Draw order: IWSDK's hand is a depth-only fill (renderOrder 0) plus a
 * back-face outline (renderOrder 999). The darkness shell is transparent at
 * renderOrder -1000 with no depth write, so it is always drawn first and the
 * outline lands on top of it. The fill's depth then also lets the real hand
 * hide the beam and monsters behind it.
 *
 * Some pieces only exist once XR starts, so everything is guarded and
 * re-applied on every session start.
 */
export function styleHands(world: World): void {
  const apply = (): void => {
    outlineMaterial?.uniforms?.outlineColor?.value?.set?.(HAND_OUTLINE);
    const pointers = world.input?.xr?.multiPointers;
    pointers?.left?.toggleSubPointer?.('ray', false);
    pointers?.right?.toggleSubPointer?.('ray', false);
  };
  try {
    apply();
  } catch (e) {
    console.warn('[hand-look] styling deferred until session start:', e);
  }
  world.renderer?.xr?.addEventListener?.('sessionstart', () => {
    try {
      apply();
    } catch (e) {
      console.warn('[hand-look] could not restyle hands:', e);
    }
  });
}
