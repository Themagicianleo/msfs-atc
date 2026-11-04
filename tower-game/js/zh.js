// Chinese radiotelephony helpers (CAAC style).
// Digits are read one by one the aviation way: 1 幺, 2 两, 7 拐, 0 洞.

const READ = { 0: '洞', 1: '幺', 2: '两', 3: '三', 4: '四', 5: '五', 6: '六', 7: '拐', 8: '八', 9: '九' };
const SIDE = { L: '左', R: '右', C: '中' };

export const hasChinese = (s) => /[㐀-鿿]/.test(String(s || ''));

// "3101" -> "三幺洞幺"; letters stay as they are (read as letters)
export function zhDigits(str) {
  return String(str).replace(/\d/g, (d) => READ[d]);
}

export function zhRunway(id) {
  const m = String(id).toUpperCase().match(/^(\d{1,2})([LRC]?)$/);
  if (!m) return { t: String(id), s: zhDigits(id) };
  const n = m[1].padStart(2, '0');
  return { t: `${n}${SIDE[m[2]] || ''}`, s: `${zhDigits(n)}${SIDE[m[2]] || ''}` };
}

// metric wind: "350度5米每秒"
export function zhWind(w) {
  if (!w || w.wind_kt == null) return null;
  const mps = Math.round(w.wind_kt / 1.943844);
  if (!mps) return { t: '静风', s: '静风' };
  const dir = w.wind_dir == null ? null : String(w.wind_dir).padStart(3, '0');
  return dir == null ? { t: `风向不定${mps}米每秒`, s: `风向不定${zhDigits(mps)}米每秒` }
    : { t: `${dir}度${mps}米每秒`, s: `${zhDigits(dir)}度${zhDigits(mps)}米每秒` };
}

// spoken or typed Chinese -> digits and plain letters, for matching:
// "南方三幺洞幺，跑道三五右可以落地" -> "南方3101跑道35R可以落地"
const NUM = { 洞: 0, 零: 0, 〇: 0, 幺: 1, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 拐: 7, 七: 7, 八: 8, 九: 9 };
export function zhNormalize(text) {
  return String(text || '').toUpperCase()
    .replace(/[洞零〇幺一两二三四五六拐七八九]/g, (c) => String(NUM[c]))
    .replace(/(\d)\s*左/g, '$1L').replace(/(\d)\s*右/g, '$1R').replace(/(\d)\s*中/g, '$1C')
    .replace(/[，。、,.\s]+/g, ' ').trim();
}

// readbacks may explain why a pilot can't comply; translate the common reasons
const REASONS = [
  [/^we are lined up for runway (\S+)$/, (m) => `我们对准的是跑道${m[1]}`],
  [/^runway (\S+) is not available$/, (m) => `跑道${m[1]}不可用`],
  [/^we can't find taxiway (.+)$/, (m) => `找不到滑行道${m[1]}`],
  [/^there is no stand (\S+)$/, (m) => `没有停机位${m[1]}`],
  [/^stand (\S+) is occupied$/, (m) => `停机位${m[1]}被占用`],
  [/^stand (\S+) is too small for us$/, (m) => `停机位${m[1]}太小`],
  [/^we are taxiing for runway (\S+)$/, (m) => `我们正滑向跑道${m[1]}`],
];
export function zhReason(reason, table = {}) {
  if (table[reason]) return table[reason];
  for (const [re, fn] of REASONS) {
    const m = String(reason).match(re);
    if (m) return fn(m);
  }
  return reason;
}
