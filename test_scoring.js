// 채점 로직 self-check.  실행: node test_scoring.js [OMR파일] [정답표]
// 정답표로 직접 채점한 결과를, OMR 리딩 파일에 이미 들어 있는 업체 채점(OX)과 대조한다.
// Worker가 쓰는 src/scoring.js의 isCorrect를 그대로 가져다 쓰므로, 여기가 통과하면 서비스 채점도 맞다.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import { isCorrect } from './src/scoring.js';

const SUBJECTS = ['국어', '영어', '수학', '사회', '과학', '한국사'];
const OMR = process.argv[2] || path.join(process.env.USERPROFILE || '', 'Desktop', '통합 문서1.xlsx');
const KEY = process.argv[3] || 'D:/자료/USB 드라이브/업무/0. 오창고/성적/모의고사/3월/2학년 정답.xls';
for (const f of [OMR, KEY]) if (!fs.existsSync(f)) { console.log('실물 파일 없음 — 건너뜀:', f); process.exit(0); }

const read = p => {
  const wb = XLSX.read(fs.readFileSync(p), { type: 'buffer', raw: false });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', blankrows: false });
};

// 정답표 파서와 열 인식은 실제 페이지에서 그대로 꺼내 쓴다
const pick = (file, re, args, vals) => {
  const m = fs.readFileSync(path.join(import.meta.dirname, 'public', 'index.html'), 'utf8').match(re);
  assert(m, `${file}에서 함수를 찾지 못했습니다`);
  return new Function(...args, m[0] + `\nreturn ${m[0].match(/function (\w+)/)[1]};`)(...vals);
};
const parseSheet = pick('admin.html', /function parseSheet\(sheet, exam_code, grade\) \{[\s\S]*?\n\}/, ['SUBJECTS'], [SUBJECTS]);
const detect = sheet => pick('collect.html', /function detect\(\) \{[\s\S]*?\n\}/,
  ['sheet', 'norm'], [sheet, s => String(s ?? '').replace(/\s/g, '')])();

const keys = {};
parseSheet(read(KEY), 'x', 2).forEach(k => keys[`${k.subject}-${k.q_no}`] = k);
assert(Object.keys(keys).length === 190, `정답표 문항 수가 190이 아님: ${Object.keys(keys).length}`);

const sheet = read(OMR), d = detect(sheet);
const OX = d.firstQ + 50;
let n = 0, agree = 0;
const diff = [];
for (let r = d.firstRow; r < sheet.length; r++) {
  const line = sheet[r], subject = String(line[d.subject] ?? '').trim();
  if (!SUBJECTS.includes(subject)) continue;
  for (let q = 1; q <= 50; q++) {
    const ox = String(line[OX + q - 1] ?? '').trim();
    if (ox !== 'O' && ox !== 'X') continue;                   // 그 과목에 없는 문항
    const key = keys[`${subject}-${q}`];
    assert(key, `정답표에 없는 문항: ${subject} ${q}번`);
    // collect.html이 저장하는 형태와 똑같이 만든다 — 앞 공백만 제거, 뒤 공백은 보존
    const marked = String(line[d.firstQ + q - 1] ?? '').replace(/^\s+/, '');
    n++;
    if (isCorrect(key, marked) === (ox === 'O')) agree++;
    else if (diff.length < 10) diff.push(
      `${line[d.grade]}-${line[d.cls]}-${line[d.no]} ${subject} ${q}번: 마킹 ${JSON.stringify(marked)} / 정답 '${key.answer}'(${key.q_type}) → 우리 ${isCorrect(key, marked) ? 'O' : 'X'}, 파일 ${ox}`);
  }
}

if (diff.length) { console.error('불일치:\n  ' + diff.join('\n  ')); }
assert.strictEqual(agree, n, `${n - agree}건 불일치 (${n}문항 대조)`);
console.log(`채점 로직 통과 — ${n.toLocaleString()}문항 전부 리딩 업체 채점과 일치`);
