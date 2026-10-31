// 문항분석 self-check.  실행: node test_stats.js
// 손으로 계산한 작은 표본과 src/scoring.js 결과를 대조한다 (Supabase 시절 SQL 함수와 같은 정의).
import assert from 'node:assert';
import { score, itemStats, distractors, studentScores, schoolSummary } from './src/scoring.js';

const keys = [
  { subject: '국어', q_no: 1, answer: '1',  points: 2, q_type: 'MC' },
  { subject: '국어', q_no: 2, answer: '2',  points: 3, q_type: 'MC' },
  { subject: '국어', q_no: 3, answer: '47', points: 4, q_type: 'SA' },
];
const stu = (school, no, marks) => marks.map((m, i) =>
  ({ school_code: school, subject: '국어', grade: 2, class_no: 1, student_no: no, q_no: i + 1, marked: m }));
const rows = [
  ...stu('A', 1, ['1', '2', '47']),     // 9점
  ...stu('A', 2, ['1', '3', '26 ']),    // 2점 — 뒤 공백 단답형은 오답
  ...stu('A', 3, ['', '', '']),         // 결시
  ...stu('B', 1, ['2', '2', '047']),    // 7점 — 앞자리 0은 정답
  ...stu('B', 2, ['1', '', null]),      // 2점
];

const scored = score(rows, keys);
assert.strictEqual(scored.length, 12, '결시자는 빠져야 한다');
assert(!scored.some(c => c.student_no === 3 && c.school_code === 'A'));

const items = itemStats(scored, 'A');
const q = n => items.find(i => i.q_no === n);
assert.deepStrictEqual(
  [q(1).n_takers, q(1).n_correct, q(1).p_value, q(1).blank_rate, q(1).discrimination, q(1).d_index, q(1).my_takers, q(1).my_p_value],
  [4, 3, 0.75, 0, -0.3746, 0, 2, 1], '1번 문항 통계');
assert.deepStrictEqual([q(2).p_value, q(2).blank_rate, q(2).d_index], [0.5, 0.25, 1], '2번 문항 통계');
assert.deepStrictEqual([q(3).p_value, q(3).blank_rate], [0.5, 0.25], '3번 단답형 통계');

const [sm] = schoolSummary(scored, 'A');
assert.deepStrictEqual([sm.my_takers, sm.my_mean, sm.my_sd, sm.all_takers, sm.all_mean, sm.all_sd, sm.gap],
  [2, 5.5, 4.95, 4, 5, 3.56, 0.5], '학교 요약');

const d = distractors(scored, '국어');
const pick = (no, ch) => { const x = d.find(v => v.q_no === no && v.choice === ch); return [x.is_answer, x.rate_all, x.rate_high, x.rate_low]; };
assert.deepStrictEqual(pick(1, '1'), [true, 0.75, 1, 1]);
assert.deepStrictEqual(pick(1, '2'), [false, 0.25, 0, 0]);
assert.deepStrictEqual(pick(2, '3'), [false, 0.25, 0, 0.5]);
assert.deepStrictEqual(pick(2, '무응답'), [false, 0.25, 0, 0.5]);
assert.strictEqual(d.some(v => v.q_no === 3), false, '단답형은 오답지 분석에서 제외');

const ss = studentScores(scored.filter(c => c.school_code === 'A')).sort((a, b) => a.student_no - b.student_no);
assert.deepStrictEqual(ss.map(s => [s.raw_score, s.n_correct, s.n_items]), [[9, 3, 3], [2, 1, 3]], '학생 원점수');

console.log('문항분석 통과 — 손계산 표본과 일치');
