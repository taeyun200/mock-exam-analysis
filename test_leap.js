// 등급 산출·도약 문항(1등급 업) self-check. 실행: node test_leap.js
import assert from 'node:assert';
import { gradeOf, leapItems, score } from './src/scoring.js';

const cuts = { 1: 90, 2: 80, 3: 70, 4: 60, 5: 50, 6: 40, 7: 30, 8: 20, 9: 0 };
assert.equal(gradeOf(95, cuts), 1); assert.equal(gradeOf(90, cuts), 1); assert.equal(gradeOf(89, cuts), 2); assert.equal(gradeOf(5, cuts), 9);
assert.equal(gradeOf(50, { 1: 93 }), 9, '컷이 1등급만 있으면 나머지는 9등급');

// 5문항 × 20점, 학생 6명. keys: 정답 전부 '1'
const keys = [1, 2, 3, 4, 5].map(q => ({ subject: '국어', q_no: q, answer: '1', points: 20, q_type: 'MC' }));
const stu = (school, no, marks) => marks.map((m, i) => ({ school_code: school, subject: '국어', grade: 2, class_no: 1, student_no: no, q_no: i + 1, marked: m }));
const rows = [
  ...stu('A', 1, ['1', '1', '1', '1', '1']),   // 100 → 1등급
  ...stu('A', 2, ['1', '1', '1', '1', '2']),   // 80 → 2등급
  ...stu('A', 3, ['1', '1', '1', '2', '1']),   // 80 → 2등급
  ...stu('B', 4, ['1', '1', '1', '2', '2']),   // 60 → 4등급 (나)
  ...stu('B', 5, ['1', '2', '2', '2', '2']),   // 20 → 8등급
  ...stu('B', 6, ['2', '2', '2', '2', '2']),   // 0  → 9등급
];
const scored = score(rows, keys);
const r = leapItems(scored, 'B-2-1-4', '국어', cuts, 6);
assert.equal(r.my_score, 60); assert.equal(r.my_grade, 4);
assert.equal(r.target_grade, 2, '3등급이 비어 있으면 그 위 2등급이 기준');
assert.equal(r.ref_n, 2);
assert.deepEqual(r.items.map(i => i.q_no), [4, 5], '틀린 4·5번을 기준 집단 정답률 순으로');
assert.deepEqual(r.items.map(i => i.ref_rate), [0.5, 0.5], '4·5번은 2등급 두 명 중 한 명씩 맞힘');
assert.deepEqual(r.wrong, [4, 5]);
const top = leapItems(scored, 'A-2-1-1', '국어', cuts);
assert.equal(top.target_grade, 1); assert.equal(top.items.length, 0, '1등급은 1등급 집단 기준, 틀린 게 없으면 빈 목록');
// 영어는 듣기(1~17) 제외
const ekeys = [...Array(20)].map((_, i) => ({ subject: '영어', q_no: i + 1, answer: '1', points: 5, q_type: 'MC' }));
const erows = [...stu('A', 1, Array(20).fill('1')), ...stu('A', 2, Array(20).fill('2'))].map(r => ({ ...r, subject: '영어' }));
const e = leapItems(score(erows, ekeys), 'A-2-1-2', '영어', cuts);
assert.deepEqual(e.items.map(i => i.q_no), [18, 19, 20]);
console.log('test_leap 통과: 등급 산출, 기준 집단(빈 등급 건너뜀), 정렬, 영어 듣기 제외');

// 저장된 표(bandStats)로 계산해도 전체 응답으로 계산한 것과 같아야 한다
import { bandStats, leapFromStats } from './src/scoring.js';
const st = bandStats(scored, '국어', cuts);
assert.equal(st.n_students, 6); assert.deepEqual(st.bands, { 1: 1, 2: 2, 4: 1, 8: 1, 9: 1 });
assert.deepEqual(st.items[4][2], [2, 1], '4번: 2등급 2명 중 1명 정답');
const mine = scored.filter(c => c.student_key === 'B-2-1-4');
const r2 = leapFromStats(st, mine, '국어', 6);
assert.deepEqual({ s: r2.my_score, g: r2.my_grade, t: r2.target_grade, n: r2.ref_n, q: r2.items.map(i => i.q_no), rr: r2.items.map(i => i.ref_rate) },
  { s: r.my_score, g: r.my_grade, t: r.target_grade, n: r.ref_n, q: r.items.map(i => i.q_no), rr: r.items.map(i => i.ref_rate) }, '표 기반 결과 = 전체 응답 기반 결과');
const top2 = leapFromStats(st, scored.filter(c => c.student_key === 'A-2-1-1'), '국어');
assert.equal(top2.ref_n, 0, '1등급이 기준이면 내 몫을 뺀다');
console.log('test_leap 통과: 등급별 정답률 표 캐시와 전체 계산 일치');
