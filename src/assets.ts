import { defineAssets } from '@iwsdk/core';
import creatureHand from './scene-assets/creature-hand.scene-asset.js';
import peekerFace from './scene-assets/peeker-face.scene-asset.js';

// Every sound and most visuals are procedural. These two monster models are
// registered so they can be inspected in isolation (asset render-preview);
// the threats build their own rigs from the same factories.
export default defineAssets({
  'creature-hand': creatureHand,
  'peeker-face': peekerFace,
});
