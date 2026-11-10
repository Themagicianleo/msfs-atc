// Mandarin tower calls as controllers say them (CAAC phraseology) and as speech recognisers write them: Chinese or Arabic
// numerals, code words or letters, homophones (退出 for 推出, 其飞 for 起飞), spaces or none. Each must give the aircraft and
// the action. Add a line here whenever the game mishears something.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { understand } from '../js/commands.js';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const PHR = json('../data/phraseology.json');
const ZH = json('../data/phraseology-zh.json');
const prof=json('../data/traffic/ZBAD.json');
const ac=prof.airlines.filter(a=>a.lang==='zh').map((a,i)=>({id:i,code:a.code,tel:a.callsign,telZh:a.callsign_zh,num:String(a.numbers[0]+5),callsign:a.code+(a.numbers[0]+5)}));
const cs=Object.fromEntries(ac.map(a=>[a.telZh,a]));
const known=new Set(['A','B','C','G','H','J','K','Y5','Y6','Z1','T6','C1','W1','E','F2']);
const N=(a)=>a.num; const S=cs['南方'], E=cs['东方'], X=cs['白鹭'], U=cs['联航'], C=cs['首都'], D=cs['山东'], SC=cs['四川'], J=cs['吉祥'];
const z=(n)=>[...String(n)].map(c=>'洞幺两三四五六拐八九'[c]).join('');
const cases=[
 // [say, code, type, extra]
 [`南方${N(S)}，可以推出开车，跑道17右`, 'CSN','push'],
 [`南方${z(N(S))}，同意推出`, 'CSN','push'],
 [`南方${N(S)}，推出开车许可`, 'CSN','push'],
 [`东方${N(E)}，允许推出，机头朝南`, 'CES','push'],
 [`东方${N(E)}，可以开车推出`, 'CES','push'],
 [`白鹭${N(X)}，滑行到跑道17右等待点，经由A、B`, 'CXA','taxi',{via:['A','B'],runway:'17R'}],
 [`白鹭${N(X)}，沿A滑行，跑道17右外等待`, 'CXA','taxi',{via:['A']}],
 [`联航${N(U)}，经Z1、T6、G、C1滑行至跑道35右等待点`, 'CUA','taxi',{via:['Z1','T6','G','C1'],runway:'35R'}],
 [`联航${N(U)}，继续沿Y5滑行`, 'CUA','taxi',{via:['Y5']}],
 [`联航${N(U)}，滑到机位166`, 'CUA','taxi',{gate:'166'}],
 [`联航${N(U)}，滑行到停机位幺六六`, 'CUA','taxi',{gate:'166'}],
 [`首都${N(C)}，经G、H滑回机位201`, 'CBJ','taxi',{via:['G','H'],gate:'201'}],
 [`首都${N(C)}，原地等待`, 'CBJ','hold_position'],
 [`首都${N(C)}，等待`, 'CBJ','hold_position'],
 [`首都${N(C)}，停止滑行`, 'CBJ','hold_position'],
 [`山东${N(D)}，继续滑行`, 'CDG','continue_taxi'],
 [`山东${N(D)}，可以继续滑行`, 'CDG','continue_taxi'],
 [`山东${N(D)}，穿越跑道17左`, 'CDG','cross',{runway:'17L'}],
 [`山东${N(D)}，可以穿越跑道17左`, 'CDG','cross',{runway:'17L'}],
 [`山东${N(D)}，跑道17左外等待`, 'CDG','hold_short',{runway:'17L'}],
 [`山东${N(D)}，在跑道17左外等`, 'CDG','hold_short',{runway:'17L'}],
 [`四川${N(SC)}，进跑道17右等待`, 'CSC','lineup'],
 [`四川${N(SC)}，进跑道等待，跑道17右`, 'CSC','lineup'],
 [`四川${N(SC)}，跑道17右，对正跑道等待`, 'CSC','lineup'],
 [`四川${N(SC)}，进入跑道17右`, 'CSC','lineup'],
 [`吉祥${N(J)}，跑道17右，可以起飞`, 'DKH','takeoff'],
 [`吉祥${N(J)}，地面风170度3米秒，跑道17右，可以起飞`, 'DKH','takeoff'],
 [`吉祥${N(J)}，跑道17右，起飞许可`, 'DKH','takeoff'],
 [`吉祥${N(J)}，跑道幺拐右，可以起飞`, 'DKH','takeoff',{runway:'17R'}],
 [`吉祥${N(J)}，取消起飞许可`, 'DKH','cancel_takeoff'],
 [`吉祥${N(J)}，联系离场121.6，再见`, 'DKH','contact'],
 [`吉祥${N(J)}，联系离场幺两幺点六`, 'DKH','contact'],
 [`吉祥${N(J)}，换频离场`, 'DKH','contact'],
 [`南方${N(S)}，跑道17左，可以落地`, 'CSN','land'],
 [`南方${N(S)}，地面风静风，跑道17左，可以落地`, 'CSN','land'],
 [`南方${N(S)}，跑道幺拐左，可以着陆`, 'CSN','land',{runway:'17L'}],
 [`南方${N(S)}，继续进近`, 'CSN','continue'],
 [`南方${N(S)}，继续进近，前方有落地飞机`, 'CSN','continue'],
 [`南方${N(S)}，复飞`, 'CSN','go_around'],
 [`南方${N(S)}，立即复飞`, 'CSN','go_around'],
 [`南方${N(S)}，拉升复飞`, 'CSN','go_around'],
 // recogniser mishearings
 [`南方${N(S)}可以退出`, 'CSN','push'],
 [`男方${N(S)}，可以推出`, 'CSN','push'],
 [`东方${N(E)}，跑到17右，可以起飞`, 'CES','takeoff'],
 [`东方${N(E)}，跑道17右，可以其飞`, 'CES','takeoff'],
 [`东方${N(E)}，跑道17左，可以落的`, 'CES','land'],
 [`东方${N(E)}，跑道17左，可以罗地`, 'CES','land'],
 [`白路${N(X)}，原地等待`, 'CXA','hold_position'],
 [`连航${N(U)}，继续滑行`, 'CUA','continue_taxi'],
 [`联行${N(U)}，继续华行`, 'CUA','continue_taxi'],
 [`手都${N(C)}，复飞`, 'CBJ','go_around'],
 [`首都${N(C)}，付飞`, 'CBJ','go_around'],
 [`四川${N(SC)}，近跑道等待`, 'CSC','lineup'],
 [`吉祥${N(J)}，联系里场`, 'DKH','contact'],
 [`吉祥${N(J)}，穿月跑道17左`, 'DKH','cross'],
 [`吉祥${N(J)}，传越跑道17左`, 'DKH','cross'],
 [`山东${N(D)}，经A B 滑到跑道17右外等待点`, 'CDG','taxi',{via:['A','B'],runway:'17R'}],
 [`山东${N(D)}，经阿尔法布拉沃滑到跑道17右外等待点`, 'CDG','taxi',{via:['A','B']}],
 [`山东${N(D)}，经alpha bravo滑到跑道17右外等待点`, 'CDG','taxi',{via:['A','B']}],
 [`山东${N(D)}，经Alpha、Kilo、Whiskey 1滑到跑道17右外等待点`, 'CDG','taxi',{via:['A','K','W1']}],
 // traditional (after toSimplified in the app); spaces; no punctuation
 [`南方 ${N(S)} 跑道 17 左 可以 落地`, 'CSN','land',{runway:'17L'}],
 [`南方${N(S)}跑道17左可以落地`, 'CSN','land',{runway:'17L'}],
 [`南方${String(N(S)).split('').join(' ')}，跑道17左，可以落地`, 'CSN','land'],
];

for (const [say, code, type, extra = {}] of cases) {
  test(`中文: ${say}`, () => {
    const u = understand(say, ac, PHR.commands, null, known, ZH.commands);
    assert.equal(u.ac?.code, code, `callsign (${u.error || ''})`);
    assert.equal(u.cmd.type, type, JSON.stringify(u.cmd));
    for (const [k, v] of Object.entries(extra)) assert.deepEqual(u.cmd[k], v, k);
  });
}

test('every Chinese airline at Daxing is found by its Chinese callsign, with digits said the aviation way', () => {
  for (const a of ac) {
    const said = `${a.telZh}${z(a.num)}，原地等待`;
    const u = understand(said, ac, PHR.commands, null, known, ZH.commands);
    assert.equal(u.ac?.callsign, a.callsign, said);
    assert.equal(u.cmd.type, 'hold_position');
  }
});
