// Understanding controller instructions, spoken or typed (rule-based).
//   "Speedbird 123, runway 27 cleared to land"
//   "BAW123 taxi to holding point runway 27 via alpha, cross runway 15"
//   "air china 1234 taxi to stand bravo 4"

import { normalize } from './lib/parser.js';
import { hasChinese, zhNormalize } from './zh.js';

const PHONETIC = {
  alpha: 'a', alfa: 'a', bravo: 'b', charlie: 'c', delta: 'd', echo: 'e', foxtrot: 'f', golf: 'g', hotel: 'h',
  india: 'i', juliet: 'j', juliett: 'j', kilo: 'k', lima: 'l', mike: 'm', november: 'n', oscar: 'o', papa: 'p',
  quebec: 'q', romeo: 'r', sierra: 's', tango: 't', uniform: 'u', victor: 'v', whiskey: 'w', whisky: 'w',
  xray: 'x', yankee: 'y', zulu: 'z',
};

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
    .replace(/\b([a-z]) (\d{1,2})\b/g, '$1$2');
}

// returns {ac, score, ambiguous}
export function matchCallsign(text, aircraft) {
  let n = normalize(numberWords(text));
  for (const re of NOT_CALLSIGN) n = n.replace(re, ' ');
  const squashed = n.replace(/\s+/g, '');
  const scored = aircraft.map((ac) => {
    const tel = ac.tel.toLowerCase().replace(/\s+/g, '');
    const num = String(ac.num);
    const code = ac.code.toLowerCase();
    const hasNum = new RegExp(`(^|[^0-9])${num}([^0-9]|$)`).test(n);
    const hasTel = squashed.includes(tel);
    const hasCode = squashed.includes(`${code}${num}`);
    let score = 0;
    if (hasCode || (hasNum && hasTel)) score = 10;
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
  return out;
}

// known: Set of the airport's taxiway names (optional)
export function parseInstruction(text, rules, known = null) {
  const n = phoneticToLetters(normalize(numberWords(text)));
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
  else if (rw && type !== 'cross' && type !== 'hold_short') cmd.runway = rw[1].padStart(2, '0') + (rw[2] || '').toUpperCase();
  const gate = n.match(/\b(?:gate|stand|parking) (?:([a-z])\s?)?(\d{1,3})\b/);
  if (gate) cmd.gate = `${gate[1] || ''}${gate[2]}`.toUpperCase();
  const via = n.match(/\bvia ((?:(?:and |then )?[a-z]{1,3}\d{0,3}\b\s*)+)/);
  if (via) {
    const tokens = via[1].trim().split(/\s+/).filter((t) => t !== 'and' && t !== 'then' && /^[a-z]{1,3}\d{0,3}$/.test(t))
      .filter((t) => !['to', 'for', 'at', 'on'].includes(t));
    cmd.via = viaNames(tokens, known);
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
// Chinese: callsign by Chinese name (南方3101) or English, then the instruction
export function matchCallsignZh(text, aircraft) {
  const n = zhNormalize(text).replace(/\s+/g, '').replace(/跑道\d{1,2}[LRC]?|停机位[A-Z]?\d+[A-Z]?|穿越\d{1,2}[LRC]?/g, '|');
  const scored = aircraft.map((ac) => {
    const num = String(ac.num);
    const hasNum = new RegExp(`(^|[^0-9])${num}([^0-9]|$)`).test(n);
    const hasName = (ac.telZh && n.includes(ac.telZh)) || n.toLowerCase().includes(ac.tel.toLowerCase().replace(/\s+/g, ''));
    const tight = (ac.telZh && n.includes(`${ac.telZh}${num}`)) || n.includes(`${ac.code}${num}`);
    return { ac, score: tight ? 10 : (hasNum && hasName ? 9 : (hasNum ? 4 : (hasName ? 1 : 0))) };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return { ac: null, score: 0 };
  const top = scored.filter((x) => x.score === scored[0].score);
  if (top.length > 1) return { ac: null, score: scored[0].score, ambiguous: top.map((x) => x.ac) };
  return { ac: scored[0].ac, score: scored[0].score };
}

export function parseInstructionZh(text, rules, known = null) {
  const n = zhNormalize(text);
  const flat = n.replace(/\s+/g, '');
  let type = null;
  for (const rule of rules || []) {
    if (rule.patterns.some((p) => new RegExp(p).test(flat))) { type = rule.cmd; break; }
  }
  const cmd = { type };
  const crosses = [...flat.matchAll(/穿越(?:跑道)?(\d{1,2})([LRC]?)/g)].map((m) => m[1].padStart(2, '0') + m[2]);
  const runways = [...flat.matchAll(/(穿越)?跑道(\d{1,2})([LRC]?)/g)].filter((m) => !m[1]).map((m) => m[2].padStart(2, '0') + m[3]);
  if (runways.length) cmd.runway = runways[runways.length - 1];
  const gate = flat.match(/(?:停机位|机位)([A-Z]?\d{1,3}[A-Z]?)/);
  if (gate) cmd.gate = gate[1];
  const via = n.match(/经由?\s*([A-Z0-9][A-Z0-9 ]*?)\s*(?=滑|到|穿越|$)/);
  if (via) {
    const tokens = via[1].trim().split(/\s+/).filter(Boolean);
    cmd.via = known ? tokens.map((t) => t.toUpperCase()) : tokens.map((t) => t.toUpperCase());
  }
  if (crosses.length) cmd.cross = crosses;
  if (type === 'cross' && crosses.length) cmd.runway = crosses[0];
  if (type === 'hold_short') {
    const m = flat.match(/跑道(\d{1,2})([LRC]?)外等待/);
    if (m) cmd.runway = m[1].padStart(2, '0') + m[2];
  }
  return cmd;
}

export function understand(text, aircraft, rules, selectedId = null, known = null, rulesZh = null) {
  if (rulesZh && hasChinese(text)) {
    const mz = matchCallsignZh(text, aircraft);
    let acz = mz.ac;
    if (!acz && !mz.ambiguous && selectedId != null) acz = aircraft.find((a) => a.id === selectedId) || null;
    const cmdz = parseInstructionZh(text, rulesZh, known);
    if (!acz) return { ac: null, cmd: cmdz, error: mz.ambiguous ? `哪一架：${mz.ambiguous.map((a) => a.callsign).join('、')}？` : '没有听到呼号。请先说呼号，或点选飞机。' };
    if (!cmdz.type) return { ac: acz, cmd: cmdz, error: '没听懂指令。' };
    return { ac: acz, cmd: cmdz, error: null };
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
