// EBSi 학력평가 공개 자료 크롤링 — hakpyeong-analysis/연구대회_제출준비/ebs_crawl.py 를 Worker용으로 옮긴 것.
// 한 회차·학년에 대해 ① 오답률 TOP15(정답·배점·선택지 비율) ② 역대(확정) 등급컷, 없으면 실시간(가채점) 등급컷
// ③ 전 문항 단원 분류(+영역)를 가져와 정답 DB 서버 표(answer_items / grade_cuts / item_units) 행으로 만든다.
// 출처: EBSi(www.ebsi.co.kr) 풀서비스 공개 자료 — 활용 시 출처 명시. 요청 사이 0.3초 쉰다.
import UNIT_AREA from './ebs_units.js';

const BASE = 'https://www.ebsi.co.kr/ebs/xip/xipa';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36';
export const AREA2SUBJ = { 1: '국어', 2: '수학', 3: '영어', 4: '한국사', 5: '사회', 6: '과학' };
export const N_ITEMS = { 국어: 45, 수학: 30, 영어: 45, 한국사: 20, 사회: 25, 과학: 25 };
const CIRCLED = '①②③④⑤';
const NAME_MAP = { 통합사회: '사회', 통합과학: '과학', 사회탐구: '사회', 과학탐구: '과학' };
// 실시간 등급컷 subjectId — 학년당 고정(통합사회, 통합과학, 국·수·영·한 묶음). 역대 서비스에 없는 과목 보충용.
const LIVE_SIDS = { 1: ['140072', '140073', '17012,17014,17020,110001'], 2: ['140220', '140221', '17022,50612,120013,140111'] };
const ABS_CUT = { 영어: [90, 80, 70, 60, 50, 40, 30, 20, 0], 한국사: [40, 35, 30, 25, 20, 15, 10, 5, 0] };

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function post(path, data, asJson = true) {
  const r = await fetch(BASE + path, { method: 'POST', body: new URLSearchParams(data).toString(),
    headers: { 'User-Agent': UA, 'content-type': 'application/x-www-form-urlencoded' } });
  if (!r.ok) throw new Error(`EBSi 응답 ${r.status} (${path})`);
  const txt = await r.text();
  await sleep(300);
  return asJson ? JSON.parse(txt) : txt;
}

// ── HTML 조각 파서 (테스트에서 직접 부른다) ──
const strip = s => s.replace(/<[^>]+>|&nbsp;|\s+/g, ' ').trim();
export const tableRows = html => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
  .map(m => [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(c => strip(c[1])));
// '' 또는 숫자가 아니면 null (파이썬의 "" 와 같은 뜻)
export const num = s => { const t = String(s ?? '').replace(/,/g, '').trim(); const v = Number(t); return t !== '' && Number.isFinite(v) ? v : null; };

// 오답률 표: [순위, 문항번호, 오답률, 배점, 정답, ①~⑤ 선택률…]. 선택률이 있는 객관식만 ①~⑤ 표기.
export function parseWrongRate(html) {
  const items = [];
  for (const c of tableRows(html)) {
    if (c.length < 5 || !/^\d+$/.test(c[0]) || !/^\d+$/.test(c[1])) continue;
    const sel = [0, 1, 2, 3, 4].map(i => num(c[5 + i]));
    const objective = sel.some(v => v != null), raw = c[4].trim();
    items.push({ q_no: +c[1], wrong_rate: num(c[2]), points: num(c[3]),
      answer: objective && /^[1-5]$/.test(raw) ? CIRCLED[+raw - 1] : raw, c: sel });
  }
  return items;
}

// 분류별 분석: <button class="btn_accodi" key="16,18">(문항번호들) … <a>대분류 &gt; 소분류</a>
export function parseUnits(html) {
  const units = {};
  for (const m of html.matchAll(/class="btn_accodi"[^>]*key="([\d,]+)"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/g)) {
    const name = m[2].replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
    for (const q of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
      if (units[+q] && units[+q] !== name) throw new Error(`${q}번이 두 분류에 중복: ${units[+q]} / ${name}`);
      units[+q] = name;
    }
  }
  return units;
}

// 등급컷 표 머리글에서 '원점수' 열 위치. '작년컷' 열이 있다 없다 하므로 고정 위치로 읽으면 안 된다.
function cutCol(seg) {
  const head = seg.replace(/<!--[\s\S]*?-->/g, '');
  const m = /<tr[^>]*>([\s\S]*?)<\/tr>/.exec(head);
  const ths = m ? [...m[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(c => c[1].replace(/<[^>]+>|\s+/g, '')) : [];
  const i = ths.indexOf('원점수');
  return i < 0 ? null : i;
}
// <h3>과목</h3> 블록마다 {등급: 원점수컷}. 모르는 과목명(선택과목 등)은 건너뛴다.
export function parseCuts(html) {
  const cuts = {};
  for (const m of html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h3|$)/g)) {
    const name = strip(m[1]), subj = NAME_MAP[name] ?? name;
    if (!Object.values(AREA2SUBJ).includes(subj)) continue;
    const idx = cutCol(m[2]);
    if (idx == null) continue;
    for (const c of tableRows(m[2]))
      if (c.length > idx && /^[1-9]$/.test(c[0])) (cuts[subj] ??= {})[+c[0]] = num(c[idx]);
  }
  return cuts;
}

// 단원 → 영역. 사회·과학은 "대 > 소" 전체, 국어는 대분류로 표를 찾고, 나머지는 대분류가 곧 영역.
// 표에 없으면 null (작업은 멈추지 않고 경고로 남긴다 — 운영자가 표에 한 줄 추가하면 다음부터 채워진다).
export function unitArea(subject, unit) {
  const big = unit.split(' > ')[0];
  if (!['사회', '과학', '국어'].includes(subject)) return big;
  return UNIT_AREA[subject]?.[subject === '국어' ? big : unit] ?? null;
}

// ── 본체 ──
// year = 시행연도, month = 3/6/9/10/11. 반환: 정답 DB 서버 표 행 + 경고 목록 + 진행 로그.
export async function crawlEbs(year, grade, month) {
  const exam = `${year}_${+month}`, mm = String(month).padStart(2, '0'), log = [], warnings = [];
  const target = `D${grade}00`;

  // ① 오답률 TOP15 (+ 과목별 paperId)
  const months = (await post('/retrieveWrongAnswerRateMonthList.ajax', { year, targetCd: target })).result ?? [];
  const rec = months.find(m => m.value === mm)?.code;
  if (!rec) throw new Error(`[오답률] ${year}년 고${grade} ${month}월 미공개. 공개된 월: ${months.map(m => m.value).join(', ') || '없음'}`);
  const war = {}, papers = {};
  for (const [ar, subj] of Object.entries(AREA2SUBJ)) {
    const subs = (await post('/retrieveWrongAnswerRateSubjList.ajax', { year, targetCd: target, irecord: rec, arOrd: ar })).result ?? [];
    if (!subs.length) continue;
    papers[subj] = subs[0].code;   // 고1·2는 영역당 과목 1개
    const html = await post('/retrieveWrongAnswerRateList.ajax', { paperId: subs[0].code }, false);
    if (html.includes('서비스 준비중')) { log.push(`[오답률] ${subj}: 서비스 준비중`); continue; }
    const items = parseWrongRate(html);
    if (items.length) { war[subj] = items; log.push(`[오답률] ${subj}: ${items.length}문항`); }
  }

  // ② 단원 분류 (전 문항)
  const units = {};
  for (const [subj, pid] of Object.entries(papers)) {
    const u = parseUnits(await post('/retrieveAnlyEaClsfnList.ajax', { order: 'odrStqestCo', paperId: pid }, false));
    const got = Object.keys(u).length;
    if (got) units[subj] = u;
    log.push(`[단원] ${subj}: ${got}/${N_ITEMS[subj]}문항`);
  }

  // ③ 등급컷: 역대(확정, 학년도=시행연도+1, 10월은 11월 칸) → 없는 과목은 실시간(가채점)으로 보충
  const sy = year + 1, pm = +month === 10 ? '11' : mm;
  let cuts = {};
  const tabs = (await post('/retrievePastGrdCutTabList.ajax', { year: sy, stdntGrd: grade, month: pm })).result ?? [];
  if (!tabs.length) log.push(`[등급컷] 역대(확정) ${year}년 고${grade} ${month}월 미공개`);
  for (const tab of tabs)
    Object.assign(cuts, parseCuts(await post('/retrievePastGrdCutList.ajax', { year: sy, stdntGrd: grade, month: pm, subjCd: tab.code }, false)));
  const missing = Object.values(AREA2SUBJ).filter(s => !cuts[s]);
  if (missing.length) {
    for (const sid of LIVE_SIDS[grade] ?? []) {
      let live = {};
      try { live = parseCuts(await post('/retrieveGrdCutList.ajax', { subjectId: sid, irecord: rec, ord: 1 }, false)); }
      catch (e) { log.push(`[등급컷/실시간] ${sid} 실패: ${e.message}`); }
      for (const [s, d] of Object.entries(live)) if (!cuts[s]) { cuts[s] = d; log.push(`[등급컷] ${s}: 실시간(가채점) 컷 사용`); }
    }
  }
  for (const [s, expect] of Object.entries(ABS_CUT)) {
    const got = [1, 2, 3, 4, 5, 6, 7, 8].map(r => cuts[s]?.[r]);
    if (cuts[s] && got.some((v, i) => v !== expect[i])) warnings.push(`${s}는 절대평가 고정컷이어야 하는데 다름: ${got.join('/')}`);
  }
  for (const s of Object.values(AREA2SUBJ)) {
    if (!cuts[s]) { warnings.push(`${s} 등급컷 미확보 (수기 입력 필요)`); continue; }
    if (cuts[s][8] != null && cuts[s][9] == null) cuts[s][9] = 0;   // 실시간 표는 9등급 미표기 → 0점
  }

  // ── 정답 DB 서버 표 행으로 ──
  const items = Object.entries(war).flatMap(([subject, list]) => list.map(it => ({
    exam, grade, subject, q_no: it.q_no, answer: it.answer, points: it.points, wrong_rate: it.wrong_rate,
    c1: it.c[0], c2: it.c[1], c3: it.c[2], c4: it.c[3], c5: it.c[4], difficulty: null, q_type: null })));
  const cutRows = Object.entries(cuts).flatMap(([subject, d]) =>
    Object.keys(d).map(Number).sort((a, b) => a - b).map(rank => ({ exam, grade, subject, rank, cut: d[rank] })));
  const unknown = new Set(), unitRows = [];
  for (const [subject, d] of Object.entries(units))
    for (const q of Object.keys(d).map(Number).sort((a, b) => a - b)) {
      const area = unitArea(subject, d[q]);
      if (area == null) unknown.add(`${subject}: ${subject === '국어' ? d[q].split(' > ')[0] : d[q]}`);
      unitRows.push({ exam, grade, subject, q_no: q, unit: d[q], area });
    }
  if (unknown.size) warnings.push(`영역 대응표에 없는 분류 (src/ebs_units.js에 추가): ${[...unknown].join(' | ')}`);
  return { items, cuts: cutRows, units: unitRows, warnings, log };
}
