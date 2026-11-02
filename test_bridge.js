// 정답 DB 서버(엑셀 공용) 다리의 표기 변환 self-check.  실행: node test_bridge.js
import assert from 'node:assert';
import { toExcelExam, fromExcelExam, toOfficialAnswer, fromOfficial } from './src/worker.js';

assert.strictEqual(toExcelExam('2026-09'), '2026_9');
assert.strictEqual(toExcelExam('2026-10'), '2026_10');
assert.strictEqual(fromExcelExam('2026_9'), '2026-09');
assert.strictEqual(fromExcelExam('2026_10'), '2026-10');
assert.throws(() => fromExcelExam('2026-09'), /YYYY_M/);

// 우리 → 그쪽: 객관식은 ①~⑤, 복수정답은 쉼표, 단답형·전항정답은 그대로
assert.strictEqual(toOfficialAnswer('3', 'MC'), '③');
assert.strictEqual(toOfficialAnswer('1|3', 'MC'), '①,③');
assert.strictEqual(toOfficialAnswer('047', 'SA'), '047');
assert.strictEqual(toOfficialAnswer('*', 'MC'), '*');

// 그쪽 → 우리: ①→'1', ①,③→'1|3', 숫자 문자열은 단답형. 왕복해도 같아야 한다.
const row = (answer, extra = {}) => ({ exam: '2026_3', grade: 2, subject: '수학', q_no: 1, answer, points: 2, ...extra });
assert.deepStrictEqual(fromOfficial(row('③')), { exam_code: '2026-03', grade: 2, subject: '수학', q_no: 1, answer: '3', points: 2, q_type: 'MC' });
assert.deepStrictEqual(fromOfficial(row('①,③')).answer, '1|3');
assert.deepStrictEqual([fromOfficial(row('132')).answer, fromOfficial(row('132')).q_type], ['132', 'SA']);
assert.deepStrictEqual([fromOfficial(row('4')).answer, fromOfficial(row('4')).q_type], ['4', 'SA'], '숫자만 오면 단답형');
assert.strictEqual(fromOfficial(row('4', { q_type: 'MC' })).q_type, 'MC', 'q_type이 오면 그대로');
for (const [a, t] of [['3', 'MC'], ['1|3', 'MC'], ['047', 'SA'], ['15', 'SA']])
  assert.strictEqual(fromOfficial(row(toOfficialAnswer(a, t))).answer, a, '왕복 ' + a);
assert.throws(() => fromOfficial(row('')), /정답 비어/);
assert.throws(() => fromOfficial(row('③', { grade: 4 })), /학년/);

console.log('다리 변환 통과 — 회차 코드·정답 표기 왕복 일치');
