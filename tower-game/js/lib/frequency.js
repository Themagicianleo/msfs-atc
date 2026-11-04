// Real-world VHF COM channel rules (ICAO Annex 10 Vol V and Vol II).
//
// Channels are named in MHz with three decimals. In each 25 kHz block B:
//   B.xx0 / B.xx5 named "...00, ...25, ...50, ...75"  -> 25 kHz channel, carrier B
//   B + .005 -> 8.33 kHz channel, carrier B
//   B + .010 -> 8.33 kHz channel, carrier B + 8.33 kHz
//   B + .015 -> 8.33 kHz channel, carrier B + 16.67 kHz
// So "118.700" (25 kHz) and "118.705" (8.33 kHz) are the same carrier.

export const COM_MIN = 118.0;
export const COM_MAX = 136.99;

// kHz offset inside the 25 kHz block for a channel name, or null if the
// value is not a valid channel name
function channelOffset(mhz) {
  const khz = Math.round(Number(mhz) * 1000);
  if (Math.abs(Number(mhz) * 1000 - khz) > 0.05) return null;
  const off = khz % 25;
  return [0, 5, 10, 15].includes(off) ? { base: khz - off, off } : null;
}

export function isComChannel(mhz) {
  const v = Number(mhz);
  return Number.isFinite(v) && v >= COM_MIN && v <= COM_MAX + 1e-9 && channelOffset(v) !== null;
}

export function is833Channel(mhz) {
  const c = channelOffset(mhz);
  return !!c && c.off !== 0;
}

// carrier frequency in MHz for a channel name; values that are not channel
// names (a sim reporting 118.70833) are taken as carrier frequencies already
export function carrierMHz(mhz) {
  const c = channelOffset(mhz);
  if (!c) return Number(mhz);
  const extra = { 0: 0, 5: 0, 10: 25 / 3, 15: 50 / 3 }[c.off];
  return (c.base + extra) / 1000;
}

export function sameFrequency(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (Math.abs(Number(a) - Number(b)) < 0.0005) return true;
  return Math.abs(carrierMHz(a) - carrierMHz(b)) < 0.002;
}

// Spoken/written designator. ICAO Annex 10 Vol II 5.2.1.4.1: use all six
// digits, except when the fifth and sixth are both zero, then use four.
// style "trim" drops every trailing zero (common US/FAA practice).
export function designator(mhz, style = 'icao') {
  const six = Number(mhz).toFixed(3);
  if (style === 'trim') {
    const t = six.replace(/0+$/, '');
    return t.endsWith('.') ? `${t}0` : t;
  }
  return six.endsWith('00') ? six.slice(0, -2) : six;
}

// digit strings a pilot may say back for a frequency (all accepted)
export function readbackTokens(mhz) {
  const forms = new Set([designator(mhz, 'icao'), designator(mhz, 'trim'), Number(mhz).toFixed(3)]);
  return [...forms].map((f) => f.replace(/\D/g, ''));
}
