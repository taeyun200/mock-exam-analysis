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

// ── 정답일람표(.xls) 파서 ────────────────────────────
// 실행: node test_validate.js [정답표경로]
const path = require('path'), fs = require('fs');
const pBody = src.match(/function parseSheet\(sheet, exam_code\) \{[\s\S]*?\n\}/);
assert(pBody, 'admin.html에서 parseSheet()를 찾지 못했습니다');
const parseSheet = new Function('SUBJECTS', pBody[0] + '\nreturn parseSheet;')(SUBJECTS);

// 합성: 객관식 2문항 + 주관식 1문항 → 주관식은 3번이 되어야 한다
const synth = parseSheet([
  ['수학 정답일람표 [08]'], ['객관식 문항수 : 2'], ['[ 객관식 정답/배점 ]'], ['번호', '정답', '배점'],
  [1, 4, 2], [2, 3, 2],
  ['[ 주관식 정답/배점 ]'], ['번호', '정답', '배점'], [1, 47, 4],
], '2026-03');
assert.deepStrictEqual(synth, [
  { exam_code: '2026-03', subject: '수학', q_no: 1, answer: '4', points: 2, q_type: 'MC', unit: null },
  { exam_code: '2026-03', subject: '수학', q_no: 2, answer: '3', points: 2, q_type: 'MC', unit: null },
  { exam_code: '2026-03', subject: '수학', q_no: 3, answer: '47', points: 4, q_type: 'SA', unit: null },
], '주관식 번호는 객관식 문항수만큼 밀려야 한다');

const keyFile = process.argv[2] || 'D:/자료/USB 드라이브/업무/0. 오창고/성적/모의고사/3월/2학년 정답.xls';
if (!fs.existsSync(keyFile)) { console.log('실물 정답표 없음 — 건너뜀:', keyFile); process.exit(0); }

const XLSX = require('xlsx');
const wb = XLSX.read(fs.readFileSync(keyFile), { type: 'buffer', raw: false });
const keys = parseSheet(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', blankrows: false }), '2026-03');

const by = {};
keys.forEach(k => (by[k.subject] ??= []).push(k));
const shape = Object.fromEntries(Object.entries(by).map(([s, v]) =>
  [s, { n: v.length, pts: +v.reduce((a, b) => a + b.points, 0).toFixed(1) }]));
assert.deepStrictEqual(shape, {
  국어: { n: 45, pts: 100 }, 영어: { n: 45, pts: 100 }, 수학: { n: 30, pts: 100 },
  사회: { n: 25, pts: 50 }, 과학: { n: 25, pts: 50 }, 한국사: { n: 20, pts: 50 },
}, '과목별 문항 수·배점 합계');

// 수학 주관식은 22~30번, 정답은 OMR 파일의 ' 15','  4',' 26' 과 일치해야 한다
const sa = by.수학.filter(k => k.q_type === 'SA').sort((a, b) => a.q_no - b.q_no);
assert.deepStrictEqual(sa.map(k => k.q_no), [22, 23, 24, 25, 26, 27, 28, 29, 30], '수학 단답형 문항번호');
assert.deepStrictEqual(sa.map(k => k.answer), ['15', '4', '26', '3', '153', '150', '11', '45', '24'], '수학 단답형 정답');
assert(by.수학.filter(k => k.q_type === 'MC').every(k => k.q_no <= 21), '객관식은 21번 이하');

// 파싱 결과가 업로드 검증도 통과해야 한다
assert.deepStrictEqual(validate(keys).errors, [], '파싱 결과가 검증을 통과하지 못함');

console.log('정답일람표 파서 통과 — ' + Object.entries(shape).map(([s, v]) => `${s} ${v.n}문항 ${v.pts}점`).join(', '));
