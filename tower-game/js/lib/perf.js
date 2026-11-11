// How hard the game works on this device. The decisions live here (pure, so they can be tested); app.js applies them.
//
// What costs a slow device most is not the airport (a map is drawn once and kept, a frame is a few milliseconds) but the number
// of pixels it has to fill 60 times a second: a retina laptop screen is 1440x900 points but 2880x1800 pixels. So:
//   - a pixel budget: the picture is drawn with fewer pixels per point on a big screen (sharp lines are still sharp at 1.5x);
//   - a picture rate: aircraft move slowly, so 30 pictures a second look the same as 60 and cost half (while you pan or zoom,
//     every frame is still drawn);
//   - three profiles: Sharp (as much as the screen can show), Balanced (the default on a normal device) and Smooth (for old
//     laptops, low-end phones and anything that struggles).

const MB = 1e6;

// 'low' | 'normal' | 'high': from what the browser says about the device (it does not say everything: Safari hides its memory)
export function deviceClass({ cores = 4, memory = null, coarse = false } = {}) {
  if (cores <= 2 || (memory !== null && memory <= 2)) return 'low';
  if (cores <= 4 && !coarse) return 'low'; // a dual-core or old quad-core laptop
  if (memory !== null && memory <= 4 && cores <= 4) return 'low';
  return cores >= 8 && (memory === null || memory >= 8) ? 'high' : 'normal';
}

// the settings for a mode: pick is 'auto' | 'sharp' | 'smooth'
export function profileFor(pick, device = 'normal') {
  const mode = pick === 'sharp' ? 'sharp' : pick === 'smooth' ? 'smooth' : (device === 'low' ? 'smooth' : 'balanced');
  const table = {
    sharp: { mode, maxDpr: 2, budget2d: 16 * MB, budget3d: 8 * MB, interval: 0, panelMs: 150, solid: false, antialias: true },
    balanced: { mode, maxDpr: 2, budget2d: 4.2 * MB, budget3d: 2.4 * MB, interval: 33, panelMs: 150, solid: false, antialias: true },
    smooth: { mode, maxDpr: 1.25, budget2d: 2 * MB, budget3d: 1.1 * MB, interval: 50, panelMs: 300, solid: true, antialias: false },
  };
  return { ...table[mode], pick: pick || 'auto', device };
}

// pixels per point for a canvas of cssW x cssH points: the screen's own ratio, capped, and cut so the canvas stays inside the budget
export function pixelRatio({ devicePixelRatio = 1, maxDpr = 2, cssW = 0, cssH = 0, budget = Infinity } = {}) {
  let d = Math.min(devicePixelRatio || 1, maxDpr || 2);
  if (cssW > 0 && cssH > 0 && Number.isFinite(budget)) d = Math.min(d, Math.sqrt(budget / (cssW * cssH)));
  return Math.max(Math.min(1, devicePixelRatio || 1), Math.round(d * 100) / 100); // never below 1 (or the screen's own ratio if that is lower)
}

// the picture interval (ms) for a profile: touch devices keep their own pacing (see app.js); a laptop uses the profile's
export function drawInterval({ profile, coarse = false, view = 'map', speed = 1, forced = 0 }) {
  const own = coarse ? (view !== 'map' || speed < 2 ? 50 : 33) : profile.interval;
  return Math.max(forced, coarse && profile.mode === 'smooth' ? Math.max(own, 50) : own);
}
