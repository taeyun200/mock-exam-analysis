// 정답표 검증 로직 self-check.  실행: node test_validate.js
// admin.html에서 validate()를 그대로 꺼내 돌린다 (복사본을 두면 원본과 갈라진다).
const assert = require('assert');
const src = require('fs').readFileSync(require('path').join(__dirname, 'admin.html'), 'utf8');

const SUBJECTS = ['국어', '영어', '수학', '사회', '과학', '한국사'];
const body = src.match(/function validate\(rows\) \{[\s\S]*?\n\}/);
assert(body, 'admin.html에서 validate()를 찾지 못했습니다');
const validate = new Function('SUBJECTS', body[0] + '\nreturn validate;')(SUBJECTS);

const row = (o = {}) => ({ exam_code: '2026-09', subject: '국어', q_no: 1, answer: '3', points: 2, q_type: 'MC', ...o });
const errs = rows => validate(rows).errors;
const has = (rows, needle) => errs(rows).some(e => e.includes(needle));

// 정상 — 부록 A의 네 형태가 모두 통과해야 한다
assert.deepStrictEqual(errs([
  row({ q_no: 1, answer: '3' }),
  row({ q_no: 2, answer: '1|3' }),            // 복수정답
  row({ q_no: 3, answer: '*' }),              // 전항정답
  row({ q_no: 1, subject: '수학', answer: '047', q_type: 'SA', points: 4 }),  // 앞자리 0 단답형
]), [], '정상 정답표가 거부됨');

assert(has([{ subject: '국어' }], '헤더 누락'));
assert(has([row({ subject: '물리' })], '알 수 없는 과목'));
assert(has([row({ q_no: 0 })], '문항번호가 잘못됨'));
assert(has([row({ points: 0 })], '배점이 잘못됨'));
assert(has([row({ q_type: 'X' })], 'q_type'));
assert(has([row({ answer: '' })], '정답이 비어 있음'));
assert(has([row({ q_type: 'SA', answer: '가나다' })], '단답형 정답은 숫자'));
assert(has([row({ answer: '6' })], '객관식 정답은 1~5'));
assert(has([row({ q_no: 1 }), row({ q_no: 1 })], '중복'));
assert(has([row({ q_no: 1 }), row({ q_no: 3 })], '빠짐'));

// 과목이 다르면 문항번호가 겹쳐도 정상 (그룹이 분리되어야 한다)
assert.deepStrictEqual(errs([row({ q_no: 1 }), row({ q_no: 1, subject: '영어' })]), []);

// 회차가 다르면 역시 분리
assert.deepStrictEqual(errs([row({ q_no: 1 }), row({ q_no: 1, exam_code: '2026-06' })]), []);

console.log('validate() 통과 — 13개 케이스');
