// Which real 3D model stands in for an aircraft type, and how it is placed. Pure, so it can be tested.
//
// The models are amvlab's open airliner models (glTF, CC BY 4.0: see assets/models/LICENSE-amvlab.txt), five shapes.
// A type without a close match (turboprops) keeps the plain built-in shape rather than a wrong-looking jet.
export const MODEL_FILES = ['A320', 'A350', 'A380', 'B737', 'B787'];

const BY_TYPE = {
  // single-aisle, Airbus-style
  A318: 'A320', A319: 'A320', A320: 'A320', A20N: 'A320', A321: 'A320', A21N: 'A320', E190: 'A320', E290: 'A320', E195: 'A320', E75L: 'A320', E75S: 'A320', CRJ9: 'A320', CRJ7: 'A320', AJ27: 'A320',
  // single-aisle, Boeing-style
  B737: 'B737', B738: 'B737', B739: 'B737', B38M: 'B737', B39M: 'B737', B752: 'B737', B753: 'B737', C919: 'B737',
  // twin-aisle
  A332: 'A350', A333: 'A350', A339: 'A350', A359: 'A350', A35K: 'A350',
  B763: 'B787', B764: 'B787', B772: 'B787', B77L: 'B787', B77W: 'B787', B788: 'B787', B789: 'B787', B78X: 'B787',
  // four engines
  A388: 'A380', A343: 'A380', A346: 'A380', B744: 'A380', B748: 'A380',
};

export function modelFor(code) {
  return BY_TYPE[String(code || '').toUpperCase()] || null;
}

// Where the model goes: scaled to the type's real length (the models have their own sizes), its middle on the origin,
// its wheels on the ground. `box` is the model's bounding box as { min: [x,y,z], max: [x,y,z] }, nose along +x.
export function placement(box, length) {
  const size = box.max.map((v, i) => v - box.min[i]);
  const scale = (Number(length) || size[0]) / size[0];
  return {
    scale,
    offset: [-(box.min[0] + box.max[0]) / 2 * scale, -box.min[1] * scale, -(box.min[2] + box.max[2]) / 2 * scale],
  };
}

// 3D quality: the Mac app (and anyone who asks) gets the real models, shadows and a finer airport; a browser, especially on
// a phone, keeps the light version.
export function qualityFor(pick, { desktop = false, device = 'normal' } = {}) {
  if (pick === 'high' || pick === 'standard') return pick;
  return desktop && device !== 'low' ? 'high' : 'standard';
}
