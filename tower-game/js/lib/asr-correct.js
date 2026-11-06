// Making a speech model's transcript fit the radio. A general speech model has never heard "Speedbird",
// "Shenzhen" or "Loong Air" on a frequency and writes the nearest ordinary words ("speed bird", "Chen Jen",
// "long air"). Here the transcript is compared, by SOUND, with what can actually be said right now:
//   - the airline names of the aircraft on frequency (any word, not only real English ones),
//   - the ICAO alphabet, inside a taxi route ("bravoh", "charly", "alfa" -> bravo, charlie, alpha),
//   - the usual command words ("runaway" -> runway).
// Chinese transcripts only get traditional characters turned into simplified ones; the Chinese parser
// (zh.js) already finds airline names and letters by sound.

import { ICAO_WORDS } from '../commands.js';

const NUMBER_WORDS = new Set(['zero', 'oh', 'one', 'won', 'two', 'to', 'too', 'three', 'tree', 'four', 'for', 'five', 'fife', 'six', 'seven', 'eight', 'nine', 'niner', 'double', 'triple']);
const isNumberish = (w) => /\d/.test(w) || NUMBER_WORDS.has(w);

export const COMMAND_WORDS = ['runway', 'taxi', 'taxiway', 'holding', 'point', 'stand', 'gate', 'via', 'cross', 'crossing', 'hold', 'short', 'position',
  'cleared', 'land', 'landing', 'takeoff', 'take-off', 'line', 'wait', 'pushback', 'approved', 'expect', 'continue', 'approach', 'go', 'around',
  'contact', 'departure', 'tower', 'ground', 'good', 'day', 'left', 'right', 'center', 'centre', 'then', 'onto', 'along', 'and'];

// ---------------------------------------------------------------- sound
// A rough "how it sounds" key: vowels are one class, voiced and unvoiced pairs are one (b/p, d/t, g/k, v/f, z/s),
// sh/ch/zh/j are one, silent h and doubled letters are gone. Good enough to tell "chenjen" from "shenzhen".
export function soundKey(word) {
  let s = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  s = s.replace(/x/g, 'ks').replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/tch|sch|sh|ch|zh|dg|j/g, 'X')
    .replace(/c(?=[eiy])/g, 's').replace(/[cq]/g, 'k').replace(/wh/g, 'w').replace(/kn/g, 'n').replace(/wr/g, 'r').replace(/gh/g, '')
    .replace(/h/g, '').replace(/[aeiouy]+/g, 'a')
    .replace(/b/g, 'p').replace(/d/g, 't').replace(/g/g, 'k').replace(/v/g, 'f').replace(/z/g, 's')
    .replace(/(.)\1+/g, '$1');
  return s;
}

export function similarity(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

// ---------------------------------------------------------------- tokens
// words (letters and digits) with the text between them, so a rewritten transcript keeps its punctuation
function tokenize(text) {
  const parts = String(text).match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*|[^\p{L}\p{N}]+/gu) || [];
  const toks = [];
  let sep = '';
  for (const p of parts) {
    if (/^[\p{L}\p{N}]/u.test(p)) { toks.push({ w: p, sep }); sep = ''; } else sep += p;
  }
  return { toks, tail: sep };
}
const join = (toks, tail) => toks.map((t, i) => (i ? t.sep || ' ' : t.sep) + t.w).join('') + tail;

// ---------------------------------------------------------------- English
// aircraft: [{tel, num, code}]; the callsign of each is "tel num" ("Speedbird 123")
function snapCallsigns(toks, aircraft) {
  const tels = [...new Set(aircraft.map((a) => String(a.tel || '').trim()).filter((t) => t.length > 2))];
  const cands = [];
  for (const tel of tels) {
    const k = tel.split(/\s+/).length;
    const key = soundKey(tel);
    if (key.length < 3) continue;
    for (let size = Math.max(1, k - 1); size <= k + 1; size += 1) {
      for (let i = 0; i + size <= toks.length; i += 1) {
        const win = toks.slice(i, i + size);
        if (win.some((t) => isNumberish(t.w.toLowerCase()))) continue;
        const heard = win.map((t) => t.w).join('');
        const score = similarity(soundKey(heard), key);
        // callsigns come with a flight number: a weaker match is believed only next to a number
        const nextToNumber = (toks[i - 1] && isNumberish(toks[i - 1].w.toLowerCase())) || (toks[i + size] && isNumberish(toks[i + size].w.toLowerCase()));
        const need = nextToNumber ? (key.length <= 4 ? 0.8 : 0.7) : 0.9;
        if (score >= need) cands.push({ i, size, tel, score: score - Math.abs(size - k) * 0.02 });
      }
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const used = new Set();
  const take = [];
  for (const c of cands) {
    const span = Array.from({ length: c.size }, (_, n) => c.i + n);
    if (span.some((n) => used.has(n))) continue;
    span.forEach((n) => used.add(n));
    take.push(c);
  }
  take.sort((a, b) => b.i - a.i);
  for (const c of take) toks.splice(c.i, c.size, { w: c.tel, sep: toks[c.i].sep, fixed: true });
}

const ROUTE_ON = new Set(['via', 'taxiway', 'taxiways', 'along', 'onto', 'then']);
const ROUTE_OFF = new Set(['runway', 'stand', 'gate', 'hold', 'cross', 'crossing', 'to', 'cleared', 'contact']);

function snapAlphabet(toks) {
  const known = new Set([...ICAO_WORDS, 'alfa', 'juliett', 'xray', 'x-ray', 'whisky', 'charley']);
  let inRoute = false;
  for (const t of toks) {
    const w = t.w.toLowerCase();
    if (t.fixed) { inRoute = false; continue; }
    if (ROUTE_ON.has(w)) { inRoute = true; continue; }
    if (ROUTE_OFF.has(w)) { inRoute = false; continue; }
    if (!inRoute || w.length < 4 || known.has(w) || COMMAND_WORDS.includes(w) || /\d/.test(w)) continue;
    const key = soundKey(w);
    let best = null;
    for (const c of ICAO_WORDS) {
      const s = similarity(key, soundKey(c));
      if (s >= 0.75 && (!best || s > best.s)) best = { c, s };
    }
    if (best) t.w = best.c;
  }
}

function snapCommands(toks) {
  const keys = COMMAND_WORDS.map((c) => [c, soundKey(c)]);
  for (const t of toks) {
    const w = t.w.toLowerCase();
    if (t.fixed || w.length < 6 || COMMAND_WORDS.includes(w) || ICAO_WORDS.includes(w) || /\d/.test(w)) continue;
    const key = soundKey(w);
    let best = null;
    for (const [c, ck] of keys) {
      if (c[0] !== w[0] || c.length < 5) continue;
      const s = similarity(key, ck);
      if (s >= 0.8 && (!best || s > best.s)) best = { c, s };
    }
    if (best) t.w = best.c;
  }
}

export function correctEnglish(text, { aircraft = [] } = {}) {
  const { toks, tail } = tokenize(text);
  snapCallsigns(toks, aircraft);
  snapAlphabet(toks);
  snapCommands(toks);
  return join(toks, tail);
}

// ---------------------------------------------------------------- Chinese
// Whisper writes Chinese in either script. The radio phraseology is simplified, so the characters that matter are converted.
const TRAD = '並亞來個備優兩則動區問國場奧寫對島後從態應時會東機歐歸準澤灣為無爾現環當確約納紐級經維線繫繼續羅義聯聽臺與華葉處號複見規計許話該認說請諾證讀讓貝貨賓較轉這進運過達邁還邊錯長門開間陸陽隊際隨離雲電靈預頓題風飛馬魯麗點';
const SIMP = '并亚来个备优两则动区问国场奥写对岛后从态应时会东机欧归准泽湾为无尔现环当确约纳纽级经维线系继续罗义联听台与华叶处号复见规计许话该认说请诺证读让贝货宾较转这进运过达迈还边错长门开间陆阳队际随离云电灵预顿题风飞马鲁丽点';
const T2S = new Map([...TRAD].map((c, i) => [c, [...SIMP][i]]));
export function toSimplified(text) {
  return [...String(text)].map((c) => T2S.get(c) || c).join('');
}

export function correctTranscript(text, { aircraft = [], zh = false } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (zh || /[㐀-鿿]/.test(raw)) return toSimplified(raw);
  return correctEnglish(raw, { aircraft });
}

// ---------------------------------------------------------------- what the model is told to expect
// Whisper can be given a short text before the audio; it then spells names the way the text does. This is the list
// of what to expect (callsigns first, as they are the hardest), cut to roughly the prompt size the model allows.
export function recognitionPrompt(hints = [], { zh = false, maxChars = 700 } = {}) {
  const head = zh ? '空中交通管制无线电通话。' : 'Air traffic control radio. ';
  const phrases = [];
  const seen = new Set();
  for (const h of [...hints].sort((a, b) => b.boost - a.boost)) {
    const t = String(h.text || '').trim();
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); phrases.push(t); }
  }
  let out = head;
  for (const p of phrases) {
    const add = zh ? `${p}，` : `${p}, `;
    if (out.length + add.length > maxChars) break;
    out += add;
  }
  return out.trim();
}
