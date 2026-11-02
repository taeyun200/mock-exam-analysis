// EBSi 크롤러 파서 self-check.  실행: node test_ebs.js   (EBS_LIVE=1 이면 실제 EBSi 2026_10 고2를 받아 기존 CSV와 대조)
import assert from 'node:assert';
import fs from 'node:fs';
import { parseWrongRate, parseUnits, parseCuts, unitArea, num, crawlEbs } from './src/ebs.js';

// 오답률 표: 객관식(선택률 있음)은 ①~⑤, 주관식(선택률 없음)은 숫자 그대로. '서비스 준비중'·머리글 행은 무시.
const wr = `<table><tr><th>순위</th><th>번호</th><th>오답률</th><th>배점</th><th>정답</th><th>①</th><th>②</th><th>③</th><th>④</th><th>⑤</th></tr>
<tr><td>1</td><td>7</td><td>52.4</td><td>3</td><td>1</td><td>47.6</td><td>11.1</td><td>22.7</td><td>13.1</td><td>5.5</td></tr>
<tr><td>2</td><td>29</td><td>88.0</td><td>4</td><td>132</td><td></td><td></td><td></td><td></td><td></td></tr>
<tr><td>3</td><td>22</td><td>80.0</td><td>4</td><td>4</td><td></td><td></td><td></td><td></td><td></td></tr></table>`;
assert.deepStrictEqual(parseWrongRate(wr), [
  { q_no: 7, wrong_rate: 52.4, points: 3, answer: '①', c: [47.6, 11.1, 22.7, 13.1, 5.5] },
  { q_no: 29, wrong_rate: 88, points: 4, answer: '132', c: [null, null, null, null, null] },
  { q_no: 22, wrong_rate: 80, points: 4, answer: '4', c: [null, null, null, null, null] },   // 주관식 답 4는 ④가 아니다
]);

// 단원: key="16,18" 두 문항이 한 분류. 같은 문항이 다른 분류에 또 나오면 오류.
const un = `<div><button class="btn_accodi" key="16,18" type="button"><span>2문항</span></button><a href="#">화법의 원리와 실제 &gt; 발표</a></div>
<div><button class="btn_accodi" key="1" type="button"></button><a href="#">문학 &gt; 현대시</a></div>`;
assert.deepStrictEqual(parseUnits(un), { 16: '화법의 원리와 실제 > 발표', 18: '화법의 원리와 실제 > 발표', 1: '문학 > 현대시' });
assert.throws(() => parseUnits(un + `<button class="btn_accodi" key="1"></button><a>문학 > 고전 산문</a>`), /중복/);

// 등급컷: '작년컷' 열이 있는 표와 없는 표에서 모두 '원점수' 열을 읽어야 한다. 통합사회→사회. 모르는 과목은 건너뜀.
const cutsHtml = `<h3>국어</h3><table><tr><th>등급</th><th>작년컷</th><th>원점수</th><th>표준점수</th></tr>
<tr><td>최고점</td><td>100</td><td>100</td><td>142</td></tr><tr><td>1</td><td>89</td><td>91</td><td>134</td></tr><tr><td>2</td><td>80</td><td>81</td><td>126</td></tr></table>
<h3>통합사회</h3><table><!-- <tr><th>숨김</th></tr> --><tr><th>등급</th><th>원점수</th></tr><tr><td>1</td><td>44.5</td></tr></table>
<h3>생활과 윤리</h3><table><tr><th>등급</th><th>원점수</th></tr><tr><td>1</td><td>50</td></tr></table>`;
assert.deepStrictEqual(parseCuts(cutsHtml), { 국어: { 1: 91, 2: 81 }, 사회: { 1: 44.5 } });

// 영역 대응
assert.strictEqual(unitArea('국어', '화법의 원리와 실제 > 발표'), '화법·작문');
assert.strictEqual(unitArea('국어', '담화의 이해 > 담화'), '문법');
assert.strictEqual(unitArea('사회', '세계화와 평화 > 세계화의 양상과 문제의 해결'), '윤리');
assert.strictEqual(unitArea('수학', '함수 > 이차함수'), '함수');
assert.strictEqual(unitArea('과학', '없는 분류 > 소분류'), null);
assert.deepStrictEqual([num('1,234'), num(' 2.5 '), num(''), num('abc')], [1234, 2.5, null, null]);
console.log('EBSi 파서 통과 — 오답률·단원·등급컷·영역 대응');

// ── 실제 EBSi 대조 (선택) ──
if (process.env.EBS_LIVE) {
  const csvPath = 'C:/Users/벼리오빵/Claude/Projects/hakpyeong-analysis/연구대회_제출준비/upload/ebs_answer_items_2학년_2026_10.csv';
  const t0 = Date.now();
  const r = await crawlEbs(2026, 2, 10);
  console.log(`실제 크롤링 ${((Date.now() - t0) / 1000).toFixed(1)}초 — 오답률 ${r.items.length} · 등급컷 ${r.cuts.length} · 단원 ${r.units.length} · 경고 ${r.warnings.length}`);
  r.log.forEach(l => console.log('   ', l)); r.warnings.forEach(w => console.log('   ⚠', w));
  assert.strictEqual(r.items.length, 90); assert.strictEqual(r.cuts.length, 54); assert.strictEqual(r.units.length, 190);
  if (fs.existsSync(csvPath)) {   // 파이썬 크롤러 결과와 값까지 같은지
    const [h, ...lines] = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    const cols = h.split(','), py = lines.map(l => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
    for (const p of py) {
      const j = r.items.find(x => x.subject === p.subject && x.q_no === +p.q_no);
      assert(j, `JS 결과에 없음: ${p.subject} ${p.q_no}`);
      assert.strictEqual(j.answer, p.answer); assert.strictEqual(j.points, +p.points); assert.strictEqual(j.wrong_rate, +p.wrong_rate);   // 파이썬은 60.0, 여기는 60
    }
    console.log('파이썬 크롤러 CSV와 90문항 정답·배점·오답률 일치');
  }
}
