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

// ---------------------------------------------------------------- understanding speech
// The browser's recogniser writes what it thinks it heard, and for radio
// Chinese it is often wrong in predictable ways: 五 becomes 舞, 九 becomes 角,
// 推出 becomes 退出, and letters come out as 诶 比 西 or as 阿尔法 布拉沃.
// So the text is cleaned up before it is matched:
//   1. airline names are found (even if misheard) and protected;
//   2. digits are read, including words that sound like a digit when they
//      stand next to one (舞 next to 拐 is 5);
//   3. command words are compared by sound (退出 = 推出);
//   4. taxiway letters are read from their Chinese sounds or code words.

const NUM = { 洞: 0, 零: 0, 〇: 0, 幺: 1, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 拐: 7, 七: 7, 八: 8, 九: 9 };

// words that sound like a digit; only read as one next to a digit
const WEAK_DIGITS = {
  0: '动冻栋董懂咚东侗',
  1: '腰邀妖么要夭吆衣医依伊椅',
  2: '俩量亮辆耳尔而',
  3: '山散叁伞',
  4: '死寺肆似思',
  5: '舞午伍武无吴乌悟物误雾勿',
  6: '陆路绿留流溜刘',
  7: '怪乖挂卦柺妻期气柒齐漆戚欺',
  8: '吧巴爸扒捌把芭',
  9: '酒久玖旧就角救',
};
const WEAK = {};
for (const [d, chars] of Object.entries(WEAK_DIGITS)) for (const c of chars) WEAK[c] = Number(d);

// groups of characters that sound alike (ignoring tone); the first is the
// one used for comparing. Covers the radio words and the airline names.
const SOUND_GROUPS = [
  '推腿退颓蜕', '出初除楚处触储', '起企气启器弃汽齐奇旗', '飞非菲肥废费匪', '复付服富负副父福附', '落洛络骆罗', '地底帝弟迪第递',
  '可克刻客课', '以已意义易艺议', '允运云晕', '许续序绪蓄叙需徐虚', '继记际己级及急集机基鸡积几既技计吉', '位为味喂围伟未',
  '滑华花化画话', '行星兴形型醒姓', '到道倒盗导岛', '跑泡炮抛袍', '回会汇惠悔', '进近仅紧禁尽今金', '经京精惊景境静',
  '联连脸练恋', '系西息细希习席', '再在载', '见建件剑间键渐', '转专砖', '换环还欢', '频品拼贫', '停亭庭挺听厅', '止只之知支职直',
  '住主注助驻柱', '等灯登邓', '待带代戴袋贷', '外歪', '原圆远员院愿', '穿川传串', '越约月跃阅悦岳', '请情清轻青',
  '左做坐座佐作', '右又有友油诱游', '中钟终忠种众', '离里理力立利', '场厂常长尝', '点电店典', '继续',
  // airline names at Daxing
  '南男难楠', '方房芳防仿访', '东冬董懂动栋冻', '白百柏', '鹭路露陆鹿', '航杭', '首手守寿', '都督读毒独', '山杉珊', '四死寺思', '祥想向象相香',
];
const CANON = {};
for (const g of SOUND_GROUPS) for (const c of [...g]) if (!(c in CANON)) CANON[c] = [...g][0];
// same length, same positions: a text and its sound form line up character by character
export function zhCanon(s) {
  return [...String(s)].map((c) => CANON[c] || c).join('');
}

// taxiway letters: how they are said in Chinese, and as code words
const CODE_WORDS = [
  ['A', 'ALPHA|ALFA|ALFAH|AL FA|阿尔法|阿尔发|阿法|阿尔夫|啊尔法|爱尔法'], ['B', 'BRAVO|BREVO|BRAVA|布拉沃|布拉伏|布拉窝|不拉我|波拉沃'],
  ['C', 'CHARLIE|CHARLEY|CHARLY|查理|恰理|察理|查里'], ['D', 'DELTA|德尔塔|戴尔塔|德而塔|得尔塔|代尔塔'],
  ['E', 'ECHO|ECKO|艾科|艾可|埃科|回声|爱科'], ['F', 'FOXTROT|FOX TROT|FOX-TROT|福克斯特罗特|福克斯特|福克斯'], ['G', 'GOLF|GULF|高尔夫|古尔夫'],
  ['H', 'HOTEL|赫特尔|荷特尔|酒店|豪特尔'], ['I', 'INDIA|INDYA|因的亚|印度|英迪亚'], ['J', 'JULIETT|JULIET|JULIETTE|朱丽叶|茱莉叶|朱莉叶'],
  ['K', 'KILO|基洛|凯罗|公斤|奇洛'], ['L', 'LIMA|利马|里马|莉玛'], ['M', 'MIKE|迈克|麦克'], ['N', 'NOVEMBER|诺维姆博|十一月|诺文博'],
  ['O', 'OSCAR|OSKAR|奥斯卡'], ['P', 'PAPA|POPPA|帕帕|爸爸|趴趴'], ['Q', 'QUEBEC|KEBEC|魁北克|奎贝克'], ['R', 'ROMEO|ROMIO|罗密欧|罗米欧|罗蜜欧'],
  ['S', 'SIERRA|SIERA|CIARA|塞拉|谢拉|赛拉|西拉'], ['T', 'TANGO|探戈|唐果'], ['U', 'UNIFORM|优尼佛姆|尤尼福姆|制服|有你服'],
  ['V', 'VICTOR|VIKTOR|维克多|威克多'], ['W', 'WHISKEY|WHISKY|WISKEY|威士忌|维斯基'], ['X', 'X[ -]?RAY|EX[ -]?RAY|艾克斯雷|爱克斯雷|X光'],
  ['Y', 'YANKEE|YANKY|洋基|扬基|杨基'], ['Z', 'ZULU|ZOOLU|祖鲁|祖路|租鲁'],
];
const CODE_RE = CODE_WORDS.map(([l, words]) => [l, new RegExp(words, 'g')]);

// each letter: single characters that sound like it, then (after a space) whole words
const LETTER_SOUNDS = {
  A: '诶欸哎啊阿埃', B: '比逼必毕笔币碧', C: '西希斯', D: '迪帝地第弟', E: '伊衣依以', F: ' 艾弗 爱抚 艾夫 艾佛', G: '吉鸡机集',
  H: ' 艾尺 爱吃 艾奇 艾驰', I: '艾爱哀', J: '杰节洁街', K: '开凯', L: ' 艾勒 艾乐 爱乐 艾尔', M: ' 艾姆 爱慕 艾木', N: '恩嗯安',
  O: '欧哦噢偶', P: '屁皮披', Q: '秋丘球 吉吾', R: ' 阿儿 阿尔 艾儿 啊儿 爱儿', S: ' 艾斯 爱死 艾丝', T: '提梯踢', U: '优幽油',
  V: '维威微', W: ' 达布留 大不留 达不留 双U', X: ' 艾克斯 爱克斯', Y: '歪外', Z: '贼泽 贼德 泽德',
};
const SOUND_TO_LETTER = new Map();
for (const [letter, spec] of Object.entries(LETTER_SOUNDS)) {
  const [chars, ...words] = spec.split(' ');
  for (const c of chars) SOUND_TO_LETTER.set(c, letter);
  for (const w of words.filter(Boolean)) SOUND_TO_LETTER.set(w, letter);
}
const SOUND_LIST = [...SOUND_TO_LETTER.keys()].sort((a, b) => b.length - a.length);

// "A 艾克斯 比 二" -> ['A', 'X', 'B2']: letters and digits of a taxiway route
export function zhTaxiwayTokens(segment) {
  let s = String(segment || '').toUpperCase();
  for (const [letter, re] of CODE_RE) s = s.replace(re, letter);
  const items = [];
  for (let i = 0; i < s.length;) {
    const sound = SOUND_LIST.find((w) => s.startsWith(w, i));
    if (sound) { items.push({ l: SOUND_TO_LETTER.get(sound) }); i += sound.length; continue; }
    const c = s[i];
    if (/[A-Z]/.test(c)) items.push({ l: c });
    else if (/\d/.test(c)) {
      let j = i;
      while (j < s.length && /\d/.test(s[j])) j += 1;
      items.push({ d: s.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  const out = [];
  let cur = null;
  for (const it of items) {
    if (it.l) { if (cur) out.push(cur); cur = it.l; } else if (cur && !/\d/.test(cur)) { out.push(cur + it.d); cur = null; } else { if (cur) out.push(cur); out.push(it.d); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}

// airline names are found by sound, so a misheard 死川 still counts as 四川
function splitNames(s, names) {
  const cs = zhCanon(s);
  const owner = new Array(s.length).fill(-1);
  const list = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  list.forEach((name, k) => {
    const cn = zhCanon(name);
    for (let at = cs.indexOf(cn); at >= 0; at = cs.indexOf(cn, at + cn.length)) {
      if (owner.slice(at, at + cn.length).every((o) => o < 0)) owner.fill(k, at, at + cn.length);
    }
  });
  const parts = [];
  for (let i = 0; i < s.length;) {
    if (owner[i] >= 0) {
      const k = owner[i];
      let j = i;
      while (j < s.length && owner[j] === k) j += 1;
      parts.push({ name: list[k] });
      i = j;
    } else {
      let j = i;
      while (j < s.length && owner[j] < 0) j += 1;
      parts.push({ text: s.slice(i, j) });
      i = j;
    }
  }
  return parts;
}

// digit words, and sound-alikes that stand next to a digit
function foldDigits(s) {
  const a = [...s];
  const kind = a.map((c) => (c in NUM || /\d/.test(c) ? 2 : (c in WEAK ? 1 : 0)));
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < a.length; i += 1) {
      if (kind[i] !== 1) continue;
      let l = i - 1; while (l >= 0 && a[l] === ' ') l -= 1;
      let r = i + 1; while (r < a.length && a[r] === ' ') r += 1;
      if ((l >= 0 && kind[l] === 2) || (r < a.length && kind[r] === 2)) { kind[i] = 2; changed = true; }
    }
  }
  return a.map((c, i) => (kind[i] === 2 ? String(NUM[c] ?? WEAK[c] ?? c) : c)).join('');
}

// names: the airline names (Chinese) of the aircraft on frequency, protected from digit reading
// "南方三幺洞幺，跑道三五右可以落地" -> "南方3101 跑道35R可以落地"
export function zhNormalize(text, names = []) {
  const s = String(text || '').normalize('NFKC').toUpperCase();
  const out = splitNames(s, names).map((p) => {
    if (p.name) return p.name;
    let t = p.text;
    for (const [letter, re] of CODE_RE) t = t.replace(re, letter);
    t = foldDigits(t);
    t = t.replace(/(\d+)[,，](\d{3})(?!\d)/g, (m, a, b) => (a.length <= 3 ? a + b : m)); // 3,101
    return t.replace(/(\d)\s*(左|做|坐|座|佐)/g, '$1L').replace(/(\d)\s*(右|又|有|友|油|诱)/g, '$1R').replace(/(\d)\s*(中|钟|终|忠)/g, '$1C');
  }).join('');
  return out.replace(/[，。、,.\s]+/g, ' ').trim();
}

// readbacks may explain why a pilot can't comply; translate the common reasons
const REASONS = [
  [/^we are lined up for runway (\S+)$/, (m) => `我们对准的是跑道${m[1]}`],
  [/^runway (\S+) is not available$/, (m) => `跑道${m[1]}不可用`],
  [/^we can't find taxiway (.+)$/, (m) => `找不到滑行道${m[1]}`],
  [/^there is no stand (\S+)$/, (m) => `没有停机位${m[1]}`],
  [/^stand (\S+) is occupied$/, (m) => `停机位${m[1]}被占用`],
  [/^stand (\S+) is too small for us$/, (m) => `停机位${m[1]}太小`],
  [/^tailwind (\d+) knots is above our limit$/, (m) => `顺风${Math.round(m[1] / 1.943844)}米每秒，超出限制`],
  [/^crosswind (\d+) knots is above our limit$/, (m) => `侧风${Math.round(m[1] / 1.943844)}米每秒，超出限制`],
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
