// Words the speech recogniser should expect. Recognisers guess far better when they are told what the
// speaker is likely to say: here the callsigns on frequency, the ICAO alphabet for taxiway names, the
// airport's own taxiway names and the controller's usual phrases. (Chrome takes them as "contextual
// biasing" phrases; recognisers that don't support it ignore them.)

import { ZH_CODE_WORDS } from '../zh.js';

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike',
  'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'x-ray', 'yankee', 'zulu'];
const LETTERS = Object.fromEntries(WORDS.map((w) => [w[0], w]));
const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner'];
const ZH_WORDS = ZH_CODE_WORDS;
const ZH_DIGITS = '洞幺两三四五六拐八九';

const EN_COMMANDS = ['cleared to land', 'cleared for take-off', 'line up and wait', 'hold position', 'hold short of runway', 'cross runway',
  'taxi to holding point runway', 'taxi to stand', 'via', 'pushback approved', 'expect runway', 'continue taxi', 'continue approach', 'go around',
  'contact departure', 'taxiway', 'good day'];
const ZH_COMMANDS = ['可以落地', '可以起飞', '进跑道等待', '原地等待', '外等待点', '穿越跑道', '滑到跑道', '滑到停机位', '经', '滑行道', '可以推出', '预计跑道',
  '继续滑行', '继续进近', '复飞', '联系离场', '再见'];

// "B1" -> "bravo one"; "WA" -> "whiskey alpha"
export function spellTaxiway(name, zh = false) {
  return [...String(name).toUpperCase()].map((c) => {
    if (/\d/.test(c)) return zh ? ZH_DIGITS[Number(c)] : DIGITS[Number(c)];
    return zh ? (ZH_WORDS[c] || c) : (LETTERS[c.toLowerCase()] || c);
  }).join(zh ? '' : ' ');
}

// a flight number said digit by digit
function spokenNumber(num, zh) {
  return [...String(num)].map((c) => (zh ? ZH_DIGITS[Number(c)] : DIGITS[Number(c)])).join(zh ? '' : ' ');
}

// aircraft: [{tel, telZh, num, callsign}]; taxiways: iterable of names. Returns [{text, boost}]
// (boost 1..10), at most `max` phrases, most useful first.
export function recognitionHints({ aircraft = [], taxiways = [], runways = [], zh = false, max = 180 } = {}) {
  const out = [];
  const seen = new Set();
  const add = (text, boost) => { if (text && !seen.has(text)) { seen.add(text); out.push({ text, boost }); } };
  for (const ac of aircraft) {
    const chinese = zh && !!ac.telZh;
    add(`${chinese ? ac.telZh : ac.tel}${chinese ? '' : ' '}${spokenNumber(ac.num, chinese)}`.trim(), 10);
    add(String(ac.callsign || '').trim(), 6);
  }
  // the runway names, with the side: "跑道35右", "runway three five right". The side is what a recogniser loses.
  for (const r of runways) {
    const m = String(r).toUpperCase().match(/^(\d{1,2})([LRC]?)$/);
    if (!m) continue;
    const num = m[1].padStart(2, '0');
    if (zh) {
      const side = { L: '左', R: '右', C: '中' }[m[2]] || '';
      add(`跑道${num}${side}`, 9);
      add(`跑道${[...num].map((c) => ZH_DIGITS[Number(c)]).join('')}${side}`, 8);
    } else {
      const side = { L: 'left', R: 'right', C: 'center' }[m[2]] || '';
      add(`runway ${[...num].map((c) => DIGITS[Number(c)]).join(' ')}${side ? ` ${side}` : ''}`, 9);
    }
  }
  for (const t of (zh ? ZH_COMMANDS : EN_COMMANDS)) add(t, 5);
  for (const w of WORDS) add(w, 7);
  if (zh) { for (const w of WORDS) add(w, 7); for (const w of Object.values(ZH_WORDS)) add(w, 4); }
  for (const t of taxiways) add(spellTaxiway(t, zh), 4);
  return out.slice(0, max);
}

// gives the phrases to a recogniser that supports them (Chrome's SpeechRecognition.phrases); true if it took them
export function applyHints(rec, hints) {
  try {
    const Phrase = typeof window !== 'undefined' && window.SpeechRecognitionPhrase;
    if (!Phrase || !('phrases' in rec) || !hints?.length) return false;
    rec.phrases = hints.map((h) => new Phrase(h.text, h.boost));
    return true;
  } catch { return false; }
}
