// Understanding what the pilot typed or said (rule-based, no AI).

const NUMBER_WORDS = {
  zero: '0', oh: '0', one: '1', won: '1', two: '2', three: '3', tree: '3', four: '4',
  five: '5', fife: '5', six: '6', seven: '7', eight: '8', nine: '9', niner: '9',
};
const SIDES = { left: 'l', right: 'r', center: 'c', centre: 'c' };

// Turn free text into a compact, searchable form:
// "climb flight level three five zero, squawk 4 7 2 1" -> "climbflightlevel350squawk4721"
export function normalize(text) {
  const words = String(text || '').toLowerCase()
    .replace(/(\d),(\d{3})\b/g, '$1$2')          // 5,000 -> 5000
    .replace(/[^a-z0-9.\s]/g, ' ')
    .replace(/\.(?!\d)/g, ' ')
    .split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length; i += 1) {
    let w = words[i];
    if (w in NUMBER_WORDS) w = NUMBER_WORDS[w];
    if (w === 'decimal' || w === 'point' || w === 'dot') {
      // only a decimal point between numbers ("one two one decimal niner"),
      // not in "holding point"
      const next = words[i + 1];
      const prevIsDigit = out.length && /^\d+$/.test(out[out.length - 1]);
      if (prevIsDigit && next && (next in NUMBER_WORDS || /^\d/.test(next))) w = '.';
    }
    if (w === 'thousand' || w === 'hundred') {
      // fold the preceding run of digits: "1 1 thousand" -> 11000, "5 hundred" -> 500
      const mult = w === 'thousand' ? 1000 : 100;
      let digits = '';
      while (out.length && /^\d+$/.test(out[out.length - 1])) digits = out.pop() + digits;
      let value = Number(digits || '1') * mult;
      if (out.length && out[out.length - 1].startsWith('#')) value += Number(out.pop().slice(1));
      out.push(`#${value}`);
      continue;
    }
    if (w in SIDES && out.length && /^\d+$/.test(out[out.length - 1].replace('#', ''))) {
      w = SIDES[w];
    }
    out.push(w);
  }
  // "#3000" followed by "#500" was merged above; strip markers and join
  return out.map((w) => (w.startsWith('#') ? w.slice(1) : w)).join(' ')
    .replace(/(\d)\s+(?=[\d.])/g, '$1').replace(/\.\s+(?=\d)/g, '.')
    .replace(/(\d)\s+([lrc])\b/g, '$1$2');
}

export function compact(text) {
  return normalize(text).replace(/[^a-z0-9]/g, '');
}

// Which required readback items are missing from the pilot's message?
// items: [{key, label, token}] where token is a compact string or array of alternatives.
export function missingItems(text, items) {
  const c = compact(text);
  return items.filter((item) => {
    const alts = Array.isArray(item.token) ? item.token : [item.token];
    return !alts.some((a) => a && c.includes(String(a).toLowerCase().replace(/[^a-z0-9]/g, '')));
  });
}

// Intent rules come from the phraseology file ("intents": [{intent, patterns}]),
// checked in order. Patterns are regular expressions on the normalized text.
export function detectIntent(text, rules) {
  const n = normalize(text);
  for (const rule of rules || []) {
    for (const p of rule.patterns) {
      if (new RegExp(p, 'i').test(n)) return rule.intent;
    }
  }
  return null;
}
