// Understanding controller instructions, spoken or typed (rule-based).
//   "Speedbird 123, runway 27 cleared to land"
//   "BAW123 taxi to holding point runway 27 via alpha, cross runway 15"
//   "air china 1234 taxi to stand bravo 4"

import { normalize } from './lib/parser.js';
import { hasChinese, zhCanon, zhNormalize, zhTaxiwayTokens } from './zh.js';

// The ICAO alphabet, with the ways recognisers commonly write each word. Used for taxiway names in
// English, and in Chinese too: controllers say "经 Alpha Bravo" even in Chinese.
const PHONETIC = {
  alpha: 'a', alfa: 'a', alfah: 'a', alpa: 'a', bravo: 'b', brava: 'b', brevo: 'b', charlie: 'c', charley: 'c', charly: 'c', charlee: 'c',
  delta: 'd', dalta: 'd', echo: 'e', eco: 'e', ecko: 'e', foxtrot: 'f', foxtrotte: 'f', golf: 'g', gulf: 'g', golfe: 'g',
  hotel: 'h', hotell: 'h', india: 'i', indya: 'i', juliet: 'j', juliett: 'j', julliet: 'j', juliette: 'j', kilo: 'k', keylo: 'k',
  lima: 'l', leema: 'l', mike: 'm', mic: 'm', november: 'n', novembre: 'n', oscar: 'o', oskar: 'o', papa: 'p', poppa: 'p', pappa: 'p',
  quebec: 'q', kebec: 'q', quebeck: 'q', romeo: 'r', romio: 'r', sierra: 's', siera: 's', ciara: 's', tango: 't', tanggo: 't',
  uniform: 'u', victor: 'v', viktor: 'v', whiskey: 'w', whisky: 'w', wiskey: 'w', xray: 'x', yankee: 'y', yanky: 'y', zulu: 'z', zoolu: 'z',
};
export const ICAO_WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike',
  'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu'];

// code words a recogniser splits in two
const SPLIT_WORDS = [[/\bx[\s-]+ray\b/g, 'xray'], [/\bex[\s-]+ray\b/g, 'xray'], [/\bfox[\s-]+trot\b/g, 'foxtrot'],
  [/\bzoo[\s-]+loo\b/g, 'zulu'], [/\bal[\s-]+fa\b/g, 'alpha'], [/\bsi[\s-]+erra\b/g, 'sierra']];

// Words a recogniser writes for a spoken digit. Changed only after a number or after "runway / stand / gate",
// so "cleared to land" and "hold for traffic" stay as they are.
const HOMOPHONES = { to: '2', too: '2', tu: '2', for: '4', fore: '4', ate: '8', fife: '5', nein: '9', free: '3' };
const NUMBERISH = new Set(['zero', 'oh', 'one', 'won', 'two', 'three', 'tree', 'four', 'five', 'fife', 'six', 'seven', 'eight', 'nine', 'niner', 'nein']);
const AFTER_WORDS = new Set(['runway', 'stand', 'gate', 'parking', 'crossing', 'squawk', 'qnh']);
const SIDE_WORDS = new Set(['left', 'right', 'center', 'centre', 'l', 'r', 'c']);
const isNum = (w) => /^\d+$/.test(w) || NUMBERISH.has(w);
// Said fast, recognisers join words: "alphabravo", "bravo1", "whiskeyalpha". Split them back into code words.
const CODE_KEYS = Object.keys(PHONETIC).sort((a, b) => b.length - a.length);
const CODE_GLUED_DIGIT = new RegExp(`\\b(${CODE_KEYS.join('|')})(\\d{1,2})\\b`, 'g');
function splitCodeWords(word) {
  if (word.length < 8 || !/^[a-z]+$/.test(word)) return word;
  const best = new Array(word.length + 1).fill(null);
  best[0] = [];
  for (let i = 1; i <= word.length; i += 1) {
    for (const k of CODE_KEYS) {
      const j = i - k.length;
      if (j >= 0 && best[j] && word.startsWith(k, j) && (!best[i] || best[j].length + 1 < best[i].length)) best[i] = [...best[j], k];
    }
  }
  return best[word.length] && best[word.length].length > 1 ? best[word.length].join(' ') : word;
}

export function fixHeard(text) {
  let t = String(text || '').toLowerCase();
  for (const [re, to] of SPLIT_WORDS) t = t.replace(re, to);
  t = t.replace(/\btaxy(ing)?\b|\btaxiing\b/g, 'taxi').replace(/[a-z]{8,}/g, splitCodeWords).replace(CODE_GLUED_DIGIT, '$1 $2');
  const w = t.split(/(\s+)/); // words at even positions
  const bare = (i) => (i >= 0 && i < w.length ? w[i].replace(/[^a-z0-9]/g, '') : '');
  let prev = '';
  for (let i = 0; i < w.length; i += 2) {
    const word = bare(i);
    const next = bare(i + 2);
    // "runway to seven left", "runway two for": a digit word that follows a number or runway/stand/gate and
    // is followed by another number (or a side)
    if (word in HOMOPHONES && ((isNum(prev) && isNum(next)) || (AFTER_WORDS.has(prev) && (isNum(next) || SIDE_WORDS.has(next))))) {
      w[i] = w[i].replace(word, HOMOPHONES[word]);
      prev = HOMOPHONES[word];
    } else prev = word;
  }
  return w.join('');
}

// numbers that are not flight numbers: runway, wind, QNH, stand
const NOT_CALLSIGN = [
  /\brunway \d{1,2}[lrc]?\b/g, /\bwind \d{1,3}( degrees)?( at)? \d{1,2}( knots)?/g, /\b(qnh|squawk) \d{4}\b/g,
  /\b(gate|stand|parking) [a-z]+ ?\d{0,2}\b/g, /\b(gate|stand|parking) \d{1,3}\b/g, /\bcross(ing)? (runway )?\d{1,2}[lrc]?\b/g,
];

const TEENS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ONES = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, niner: 9 };

// "runway twenty seven" / "stand twelve" -> digits (US-style numbers)
export function numberWords(text) {
  return String(text).toLowerCase()
    .replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\s-]+(one|two|three|four|five|six|seven|eight|nine|niner))?\b/g,
      (_, t, o) => String(TENS[t] + (o ? ONES[o] : 0)))
    .replace(/\b(ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\b/g, (w) => String(TEENS[w]));
}

function phoneticToLetters(text) {
  return text.split(' ').map((w) => PHONETIC[w] || w).join(' ')
    .replace(/\b([a-z]) (\d{1,2})\b/g, '$1$2')
    // "runway two eight lima / romeo / charlie" is 28L / 28R / 28C (but "via b 1 c" stays three names)
    .replace(/\b((?:runway|crossing|cross|short of) \d{1,2}) ([lrc])\b/g, '$1$2');
}

// returns {ac, score, ambiguous}
export function matchCallsign(text, aircraft) {
  let n = normalize(numberWords(fixHeard(text)));
  for (const re of NOT_CALLSIGN) n = n.replace(re, ' ');
  const squashed = n.replace(/\s+/g, '');
  const scored = aircraft.map((ac) => {
    const tel = ac.tel.toLowerCase().replace(/\s+/g, '');
    const num = String(ac.num);
    const code = ac.code.toLowerCase();
    const hasNum = new RegExp(`(^|[^0-9])${num}([^0-9]|$)`).test(n);
    const hasTel = squashed.includes(tel);
    const hasCode = squashed.includes(`${code}${num}`);
    // after first contact controllers shorten it: "Delta 234" for Delta 1234 (airline name and the last three digits)
    const abbreviated = hasTel && num.length > 3 && new RegExp(`(^|[^0-9])${num.slice(-3)}([^0-9]|$)`).test(n);
    let score = 0;
    if (hasCode || (hasNum && hasTel)) score = 10;
    else if (abbreviated) score = 9;
    else if (hasNum) score = 4;
    else if (hasTel) score = 1;
    return { ac, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return { ac: null, score: 0 };
  const top = scored.filter((x) => x.score === scored[0].score);
  if (top.length > 1) return { ac: null, score: scored[0].score, ambiguous: top.map((x) => x.ac) };
  return { ac: scored[0].ac, score: scored[0].score };
}

// "via w a b1 then ..." -> ['WA', 'B1'] using the airport's taxiway names:
// spoken letters are joined into the longest name that exists
function viaNames(tokens, known) {
  if (!known) return tokens.map((t) => t.toUpperCase());
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    let taken = null;
    for (let j = Math.min(tokens.length, i + 4); j > i; j -= 1) {
      const name = tokens.slice(i, j).join('').toUpperCase();
      if (known.has(name)) { taken = { name, j }; break; }
    }
    if (!taken) taken = { name: tokens[i].toUpperCase(), j: i + 1 };
    out.push(taken.name);
    i = taken.j;
  }
  return fixGluedDigits(out, known);
}

// A recogniser that glues letters and a digit ("T G 6") puts the digit on the wrong letter. A name that does not exist
// followed by one that does ("T", "G6") is read the other way when that gives names that all exist ("T6", "G").
function fixGluedDigits(names, known) {
  const out = [...names];
  for (let i = 0; i + 1 < out.length; i += 1) {
    const a = out[i];
    const m = out[i + 1].match(/^([A-Z]+)(\d+)$/);
    if (known.has(a) || !m || !/^[A-Z]+$/.test(a)) continue;
    if (known.has(a + m[2]) && known.has(m[1])) { out[i] = a + m[2]; out[i + 1] = m[1]; i += 1; }
  }
  return out;
}

// "via alpha, bravo one, then taxiway whiskey alpha" -> ['A', 'B1', 'WA']. A route can be given in several
// pieces ("via A, cross runway 15, then via B"); the taxiway names of the airport (known) decide how
// letters are joined, and which short words are names and which are just talk.
const ROUTE_START = new Set(['via', 'along', 'taxiway', 'taxiways', 'onto', 'using']);
const ROUTE_SKIP = new Set(['and', 'then', 'the', 'turn', 'left', 'right', 'next', 'follow', 'continue', 'on']);
const ROUTE_TALK = new Set(['to', 'for', 'at', 'in', 'of', 'is', 'it', 'up', 'off', 'out', 'you', 'can', 'now', 'not', 'all', 'but', 'her', 'his']);
function englishRoute(n, known) {
  n = n.replace(/\bturn (?:left|right)(?: (?:on|onto|at|into))? /g, 'via '); // "turn left on bravo" starts a route
  const tokens = [];
  let inRoute = false;
  for (const w of n.split(' ')) {
    if (ROUTE_START.has(w)) { inRoute = true; continue; }
    if (!inRoute) continue;
    if (ROUTE_SKIP.has(w)) continue;
    const name = /^[a-z]{1,3}\d{0,3}$/.test(w) && (w.length === 1 || /\d/.test(w) || !ROUTE_TALK.has(w) || (known && known.has(w.toUpperCase())));
    if (name) tokens.push(w); else inRoute = false; // a runway, "hold short", a stand...: the route piece ends
  }
  return viaNames(tokens, known);
}

// known: Set of the airport's taxiway names (optional)
export function parseInstruction(text, rules, known = null) {
  const n = phoneticToLetters(normalize(numberWords(fixHeard(text))));
  let type = null;
  for (const rule of rules || []) {
    if (rule.patterns.some((p) => new RegExp(p, 'i').test(n))) { type = rule.cmd; break; }
  }
  const cmd = { type };
  const rw = n.match(/\brunway (\d{1,2})([lrc])?\b/);
  // in "cross runway 15, taxi to runway 27" the destination is the last runway that is not crossed
  const allRunways = [...n.matchAll(/\b(cross(?:ing)? |hold(?:ing)? short (?:of )?)?runway (\d{1,2})([lrc])?\b/g)];
  const target = allRunways.filter((m) => !m[1]).pop();
  if (target) cmd.runway = target[2].padStart(2, '0') + (target[3] || '').toUpperCase();
  else if (rw && type !== 'cross' && type !== 'hold_short' && type !== 'taxi') cmd.runway = rw[1].padStart(2, '0') + (rw[2] || '').toUpperCase();
  const gate = n.match(/\b(?:gate|stand|parking) (?:([a-z])\s?)?(\d{1,3})\b/);
  if (gate) cmd.gate = `${gate[1] || ''}${gate[2]}`.toUpperCase();
  const via = englishRoute(n, known);
  if (via.length) cmd.via = via;
  // "taxi ... hold short of runway 15": stop at that runway (the default until crossing is given)
  if (type === 'taxi') {
    const holds = [...n.matchAll(/\bhold(?:ing)? short (?:of )?(?:runway )?(\d{1,2})([lrc])?\b/g)]
      .map((m) => m[1].padStart(2, '0') + (m[2] || '').toUpperCase());
    if (holds.length) cmd.holdShort = [...new Set(holds)];
  }
  if (type === 'hold_short' && cmd.via?.length) {
    // "via alpha, hold short of runway 15": a route that ends at a stop is a taxi instruction
    const m = n.match(/\bhold(?:ing)? short (?:of )?(?:runway )?(\d{1,2})([lrc])?\b/);
    cmd.type = 'taxi';
    delete cmd.runway;
    if (m) cmd.holdShort = [m[1].padStart(2, '0') + (m[2] || '').toUpperCase()];
    return cmd;
  }
  const crosses = [...n.matchAll(/\bcross(?:ing)? (?:runway )?(\d{1,2})([lrc])?\b/g)]
    .map((m) => m[1].padStart(2, '0') + (m[2] || '').toUpperCase());
  if (crosses.length) cmd.cross = crosses;
  if (type === 'cross' || type === 'hold_short') {
    const m = type === 'cross' ? crosses[0] : n.match(/hold(?:ing)? short (?:of )?(?:runway )?(\d{1,2})([lrc])?/);
    if (type === 'cross' && m) cmd.runway = m;
    if (type === 'hold_short' && m) cmd.runway = m[1].padStart(2, '0') + (m[2] || '').toUpperCase();
  }
  return cmd;
}

// Whole thing: which aircraft and what. selectedId is the aircraft tapped on
// screen, used when no callsign was recognised.
// Chinese: callsign by Chinese name (南方3101) or English, then the instruction.
// The recogniser's mistakes (舞 for 五, 退出 for 推出, 诶 比 西 for letters)
// are cleaned up in zh.js; command words are compared by sound.
const namesOf = (aircraft) => aircraft.map((a) => a.telZh).filter(Boolean);

export function matchCallsignZh(text, aircraft) {
  const n = zhNormalize(text, namesOf(aircraft)).replace(/\s+/g, '');
  // numbers that are not flight numbers: runway, stand, crossing (found by sound too)
  const stripped = zhCanon(n).replace(new RegExp(zhCanon('跑道\\d{1,2}[LRC]?|停机位[A-Z]?\\d+[A-Z]?|机位[A-Z]?\\d+[A-Z]?|穿越\\d{1,2}[LRC]?'), 'g'), '|');
  const scored = aircraft.map((ac) => {
    const num = String(ac.num);
    const hasNum = new RegExp(`(^|[^0-9])${num}([^0-9]|$)`).test(stripped);
    const hasName = (ac.telZh && n.includes(ac.telZh)) || n.toLowerCase().includes(ac.tel.toLowerCase().replace(/\s+/g, ''));
    const tight = (ac.telZh && n.includes(`${ac.telZh}${num}`)) || n.includes(`${ac.code}${num}`);
    // the last three digits with the airline name are enough for a clear call
    const abbreviated = hasName && num.length > 3 && new RegExp(`(^|[^0-9])${num.slice(-3)}([^0-9]|$)`).test(stripped);
    return { ac, score: tight ? 10 : (hasNum && hasName ? 9 : (hasNum ? 4 : (abbreviated ? 3 : (hasName ? 1 : 0)))) };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return { ac: null, score: 0 };
  const top = scored.filter((x) => x.score === scored[0].score);
  if (top.length > 1) return { ac: null, score: scored[0].score, ambiguous: top.map((x) => x.ac) };
  return { ac: scored[0].ac, score: scored[0].score };
}

// "AB2" said as one word: split into the airport's taxiway names if possible
function splitTaxiway(token, known) {
  if (!known || known.has(token) || token.length < 2) return [token];
  const best = new Array(token.length + 1).fill(null);
  best[0] = [];
  for (let i = 1; i <= token.length; i += 1) {
    for (let j = Math.max(0, i - 4); j < i; j += 1) {
      if (best[j] && known.has(token.slice(j, i)) && (!best[i] || best[j].length + 1 < best[i].length)) best[i] = [...best[j], token.slice(j, i)];
    }
  }
  return best[token.length] || [token];
}

const ZH_RE = new Map();
const zhRe = (p, flags = '') => {
  const k = `${p}/${flags}`;
  if (!ZH_RE.has(k)) ZH_RE.set(k, new RegExp(zhCanon(p), flags));
  return ZH_RE.get(k);
};

export function parseInstructionZh(text, rules, known = null, names = []) {
  const n = zhNormalize(text, names);
  const flat = n.replace(/\s+/g, '');
  // compared by sound, so 退出 is 推出; same length as flat, so positions line up
  const cflat = zhCanon(flat);
  let type = null;
  for (const rule of rules || []) {
    if (rule.patterns.some((p) => zhRe(p).test(cflat))) { type = rule.cmd; break; }
  }
  const cmd = { type };
  const crosses = [...cflat.matchAll(zhRe('穿越(?:跑道)?(\\d{1,2})([LRC]?)', 'g'))].map((m) => m[1].padStart(2, '0') + m[2]);
  const runways = [...cflat.matchAll(zhRe('(穿越)?跑道(\\d{1,2})([LRC]?)', 'g'))].filter((m) => !m[1]).map((m) => m[2].padStart(2, '0') + m[3]);
  // "跑道15外等待" inside a taxi route is a stop short of that runway; "...外等待点" (or the only runway named) is where
  // the aircraft is going. 在跑道15外等待 is always a stop.
  let skipRunway = new Set();
  if (type === 'taxi') {
    const waits = [...cflat.matchAll(zhRe('(在)?跑道(\\d{1,2})([LRC]?)外等待(点?)', 'g'))]
      .map((m) => ({ id: m[2].padStart(2, '0') + m[3], at: !!m[1], point: !!m[4] }));
    const dest = waits.filter((w) => w.point && !w.at).pop() || waits.filter((w) => !w.at).pop() || null;
    const ids = [...new Set(waits.filter((w) => w !== dest).map((w) => w.id))].filter((id) => id !== dest?.id && !crosses.includes(id));
    if (ids.length) { cmd.holdShort = ids; skipRunway = new Set(ids); }
  }
  const finalRunways = skipRunway.size ? runways.filter((r) => !skipRunway.has(r)) : runways;
  if (finalRunways.length) cmd.runway = finalRunways[finalRunways.length - 1];
  const gate = cflat.match(zhRe('(?:停机位|机位)([A-Z]?\\d{1,3}[A-Z]?)'));
  if (gate) cmd.gate = gate[1];
  // "经A、B2滑到...", "经滑行道A比2": letters come from their Chinese sounds or code words. A route can come in
  // several pieces ("经A，穿越跑道15，再经B").
  const vias = [];
  for (const via of cflat.matchAll(zhRe('(?:经由?|沿着?|取道|通过|走|滑行道|滑道)(?:滑行道|滑道)?(.*?)(?=滑|到|穿越|跑道|停机|机位|外等待|等待|在|可以|$)', 'g'))) {
    const at = via.index + via[0].length - via[1].length;
    const tokens = zhTaxiwayTokens(flat.slice(at, at + via[1].length)).flatMap((t) => splitTaxiway(t, known));
    vias.push(...tokens);
  }
  if (vias.length) cmd.via = viaNames(vias, known);
  // "经A、B，在跑道15外等待": a route that ends at a stop is a taxi instruction
  if (type === 'hold_short' && cmd.via?.length) {
    const m = cflat.match(zhRe('跑道(\\d{1,2})([LRC]?)外等待'));
    cmd.type = 'taxi';
    delete cmd.runway;
    if (m) cmd.holdShort = [m[1].padStart(2, '0') + m[2]];
    return cmd;
  }
  if (crosses.length) cmd.cross = crosses;
  if (type === 'cross' && crosses.length) cmd.runway = crosses[0];
  if (type === 'hold_short') {
    const m = cflat.match(zhRe('跑道(\\d{1,2})([LRC]?)外等待'));
    if (m) cmd.runway = m[1].padStart(2, '0') + m[2];
  }
  return cmd;
}

export function understand(text, aircraft, rules, selectedId = null, known = null, rulesZh = null) {
  if (rulesZh && hasChinese(text)) {
    const mz = matchCallsignZh(text, aircraft);
    let acz = mz.ac;
    if (!acz && !mz.ambiguous && selectedId != null) acz = aircraft.find((a) => a.id === selectedId) || null;
    const cmdz = parseInstructionZh(text, rulesZh, known, namesOf(aircraft));
    const heard = zhNormalize(text, namesOf(aircraft));
    if (!acz) return { ac: null, cmd: cmdz, heard, error: mz.ambiguous ? `哪一架：${mz.ambiguous.map((a) => a.callsign).join('、')}？` : '没有听到呼号。请先说呼号，或点选飞机。' };
    if (!cmdz.type) return { ac: acz, cmd: cmdz, heard, error: '没听懂指令。' };
    return { ac: acz, cmd: cmdz, heard, error: null };
  }
  const m = matchCallsign(text, aircraft);
  let ac = m.ac;
  if (!ac && !m.ambiguous && selectedId != null) ac = aircraft.find((a) => a.id === selectedId) || null;
  const cmd = parseInstruction(text, rules, known);
  if (!ac) {
    return { ac: null, cmd, error: m.ambiguous ? `Which one: ${m.ambiguous.map((a) => a.callsign).join(' or ')}?` : 'No callsign recognised. Say the callsign first, or tap an aircraft.' };
  }
  if (!cmd.type) return { ac, cmd, error: 'Instruction not understood.' };
  return { ac, cmd, error: null };
}

// Speech recognisers give several guesses for what was said. Try each and take
// the first that is a whole instruction (an aircraft and a command); failing
// that, the one that got furthest. alternatives: strings, best guess first.
export function understandBest(alternatives, ...rest) {
  const known = rest[3] || null;
  let best = null;
  for (let i = 0; i < alternatives.length; i += 1) {
    const text = alternatives[i];
    const u = { ...understand(text, ...rest), text };
    // a route naming taxiways the airport really has beats one with names that don't exist
    const via = u.cmd?.via || [];
    const viaOk = known && via.length ? via.filter((v) => known.has(v)).length / via.length : 1;
    const score = (u.ac ? 2 : 0) + (u.cmd?.type ? 2 : 0) + (u.error ? 0 : 1) + (via.length ? viaOk * 0.5 : 0) - i * 0.01;
    if (!best || score > best.score) best = { u, score };
    // the first complete instruction whose route is all real: no need to read the other guesses
    if (!u.error && viaOk === 1) break;
  }
  return best.u;
}
