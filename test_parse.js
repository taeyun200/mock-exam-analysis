// collect.html의 열 자동 인식 self-check.  실행: node test_parse.js [파일경로]
// 실물 OMR 파일이 없으면 합성 시트로 돌린다.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';

const src = fs.readFileSync(path.join(import.meta.dirname, 'public/index.html'), 'utf8');
const norm = s => String(s ?? '').replace(/\s/g, '');
const body = src.match(/function detect\(\) \{[\s\S]*?\n\}/);
assert(body, 'collect.html에서 detect()를 찾지 못했습니다');
const mk = sheet => new Function('sheet', 'norm', body[0] + '\nreturn detect();')(sheet, norm);

// 실물과 같은 모양: 1행 그룹헤더, 2행 문항번호, 3행부터 데이터
const synthetic = [
  ['계\n열', '학\n년', '반', '번\n호', '이름', '과목', '문항별 표기', ...Array(4).fill(''), '문항별 OX', '', ''],
  ['', '', '', '', '', '', 1, 2, 3, 4, 5, 1, 2, 3],
  ['1', '2', '1', '1', '홍길동', '국어', '4', '4', '3', '1', '1', 'O', 'O', 'X'],
  ['1', '2', '1', '1', '홍길동', '수학', '2', '5', '4', ' 15', '047', 'O', 'X', 'O'],
];
let d = mk(synthetic);
assert.strictEqual(d.hdr, 0, '헤더 행');
assert.strictEqual(d.grade, 1, '학년 열');
assert.strictEqual(d.cls, 2, '반 열');
assert.strictEqual(d.no, 3, '번호 열');
assert.strictEqual(d.subject, 5, '과목 열');
assert.strictEqual(d.firstQ, 6, '첫 문항 열');
assert.strictEqual(d.firstRow, 2, '데이터 시작행 — 문항번호 행을 건너뛰어야 함');

// 그룹 헤더가 없는 형식이어도 과목 열 다음을 첫 문항으로 잡아야 한다
const noGroup = [
  ['학년', '반', '번호', '과목', '', '', ''],
  ['2', '1', '1', '국어', '4', '3', '1'],
];
d = mk(noGroup);
assert.strictEqual(d.firstQ, 4, '그룹 헤더 없을 때 첫 문항 열');
assert.strictEqual(d.firstRow, 1, '그룹 헤더 없을 때 데이터 시작행');

console.log('detect() 합성 시트 통과');

// ── 실물 파일이 있으면 함께 검증 ──
const real = process.argv[2] || path.join(process.env.USERPROFILE || '', 'Desktop', '통합 문서1.xlsx');
if (!fs.existsSync(real)) { console.log('실물 파일 없음 — 건너뜀:', real); process.exit(0); }

const wb = XLSX.read(fs.readFileSync(real), { type: 'buffer', raw: false });
const sheet = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', blankrows: false });
d = mk(sheet);
assert.deepStrictEqual(
  { hdr: d.hdr, grade: d.grade, cls: d.cls, no: d.no, subject: d.subject, firstQ: d.firstQ, firstRow: d.firstRow },
  { hdr: 0, grade: 1, cls: 2, no: 3, subject: 5, firstQ: 6, firstRow: 2 },
  '실물 파일 열 인식');

// 파싱 결과가 실제와 맞는지 — 159명 × 6과목
const SUBJ = ['국어', '영어', '수학', '사회', '과학', '한국사'];
const students = new Set(), bySubject = {};
for (let r = d.firstRow; r < sheet.length; r++) {
  const line = sheet[r], subject = String(line[d.subject] ?? '').trim();
  if (!SUBJ.includes(subject)) continue;
  students.add([line[d.grade], line[d.cls], line[d.no]].join('-'));
  bySubject[subject] = (bySubject[subject] ?? 0) + 1;
}
assert.strictEqual(students.size, 159, '학생 수');
assert.deepStrictEqual(Object.keys(bySubject).sort(), SUBJ.slice().sort(), '과목 구성');

// 수학 단답형은 공백 패딩으로 들어온다 — trim 후에도 값이 남아야 한다
const mathRow = sheet.find((r, i) => i >= d.firstRow && String(r[d.subject]).trim() === '수학');
const q22 = String(mathRow[d.firstQ + 21] ?? '');
assert(q22 !== q22.trim() || /^\d+$/.test(q22.trim()), `수학 22번이 단답형 형태가 아님: '${q22}'`);
assert(/^\d+$/.test(q22.trim()), '단답형 trim 후 숫자여야 함');

console.log(`실물 파일 통과 — ${students.size}명, ${Object.entries(bySubject).map(([k, v]) => k + ' ' + v).join(', ')}`);

// 비정상 마킹 판정: 객관식은 한 자리 1~5, 단답형(수학 22~30)은 숫자면 정상.
// 그 밖('45' 복수 마킹, '1 3' 자리 누락, '*2' 리더 중복표시)은 경고 대상이며 오답으로 채점된다.
const SA = { 수학: new Set([22, 23, 24, 25, 26, 27, 28, 29, 30]) };
const NQ = { 국어: 45, 영어: 45, 수학: 30, 사회: 25, 과학: 25, 한국사: 20 };
const OX_COL = d.firstQ + 50;   // 실물 파일은 문항 50칸 뒤에 OX 채점 결과가 붙어 있다
const abnormal = [];
for (let r = d.firstRow; r < sheet.length; r++) {
  const line = sheet[r], subject = String(line[d.subject] ?? '').trim();
  if (!SUBJ.includes(subject)) continue;
  for (let q = 1; q <= NQ[subject]; q++) {
    const cell = String(line[d.firstQ + q - 1] ?? '');
    if (!cell.trim()) continue;
    const marked = cell.replace(/^\s+/, '');   // collect.html이 저장하는 형태
    const okay = SA[subject]?.has(q) ? /^\d+$/.test(marked) : /^[1-5]$/.test(cell.trim());
    if (!okay) abnormal.push({ subject, q, raw: cell, ox: String(line[OX_COL + q - 1] ?? '').trim() });
  }
}
assert.strictEqual(abnormal.length, 29, `비정상 마킹은 29건이어야 함 (실제 ${abnormal.length})`);
// 뒤 공백('26 ', '1  ')은 단답형 마지막 자리 미마킹 — trim하면 정답으로 오채점될 수 있다
assert.strictEqual(abnormal.filter(a => /\s$/.test(a.raw)).length, 6, '뒤 공백 케이스 6건');
assert(!abnormal.some(a => a.subject === '수학' && /^\s*\d+$/.test(a.raw) && a.raw.trim().length > 1),
  '정상적인 단답형 값이 오탐됨: ' + JSON.stringify(abnormal.filter(a => a.subject === '수학')));
// 리딩 업체도 이 값들을 전부 오답 처리했다 — 우리 방침과 일치하는지 확인
assert(abnormal.every(a => a.ox === 'X'), '리딩 업체가 정답 처리한 비정상 마킹이 있음');
console.log(`비정상 마킹 ${abnormal.length}건 — 전부 리딩 업체도 오답(X) 처리, 방침 일치`);

// ── 두 번째 리딩 프로그램 형식 (CP949 CSV, '1번'~'60번' 헤더, 과목명 '사회탐구'/'과학탐구') ──
const real2 = process.argv[3] || 'D:/blsm omr리딩 결과.csv';
if (!fs.existsSync(real2)) { console.log('실물 CSV(2) 없음 — 건너뜀:', real2); process.exit(0); }
const buf = fs.readFileSync(real2);
assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(buf), 'CP949 파일은 UTF-8로 읽히면 안 된다');
const csvText = new TextDecoder('euc-kr').decode(buf);
const sheet2 = XLSX.utils.sheet_to_json(XLSX.read(csvText, { type: 'string', raw: false }).Sheets.Sheet1, { header: 1, defval: '', blankrows: false });
const d2 = mk(sheet2);
assert.deepStrictEqual(
  { hdr: d2.hdr, grade: d2.grade, cls: d2.cls, no: d2.no, subject: d2.subject, firstQ: d2.firstQ, firstRow: d2.firstRow },
  { hdr: 0, grade: 1, cls: 2, no: 3, subject: 5, firstQ: 6, firstRow: 1 }, 'CSV(2) 열 인식');
const aliasSrc = src.match(/const SUBJECT_ALIAS = [\s\S]*?\nconst canonSubject = .*\n/);
assert(aliasSrc, 'index.html에서 canonSubject를 찾지 못했습니다');
const canonSubject = new Function(aliasSrc[0] + 'return canonSubject;')();
const subs2 = new Set(sheet2.slice(d2.firstRow).map(r => canonSubject(r[d2.subject])).filter(Boolean));
assert.deepStrictEqual([...subs2].sort(), SUBJ.slice().sort(), '과목명 정규화 (사회탐구→사회, 과학탐구→과학)');
const stu2 = new Set(sheet2.slice(d2.firstRow).map(r => [r[d2.grade], r[d2.cls], r[d2.no]].join('-')));
assert.strictEqual(stu2.size, 190, 'CSV(2) 학생 수');
// 미완성 단답('12N')과 복수 마킹('25')은 비정상으로 잡혀 오답 처리돼야 한다
const bad2 = [];
for (const r of sheet2.slice(d2.firstRow)) {
  const sub = canonSubject(r[d2.subject]);
  for (let q = 1; q <= NQ[sub]; q++) {
    const v = String(r[d2.firstQ + q - 1] ?? '').trim();
    if (v && !(SA[sub]?.has(q) ? /^\d+$/.test(v) : /^[1-5]$/.test(v))) bad2.push(v);
  }
}
assert(bad2.includes('12N') && bad2.includes('25'), '비정상 마킹 검출: ' + bad2.join(','));
console.log(`실물 CSV(2) 통과 — CP949 디코딩, ${stu2.size}명, 과목 정규화, 비정상 마킹 ${bad2.length}건 검출`);
