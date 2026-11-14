// 채점 + 문항분석. 순수 함수만 있어 Worker와 테스트(test_scoring.js, test_stats.js)가 같이 쓴다.
// 채점 규칙은 실물 데이터 29,950문항으로 리딩 업체 채점과 대조해 검증했다.

export const SUBJECTS = ['국어', '영어', '수학', '사회', '과학', '한국사'];

export function isCorrect(key, marked) {
  if (key.answer === '*') return true;                       // 전항정답
  const m = String(marked ?? '');
  if (!m.trim()) return false;                               // 무응답
  const list = String(key.answer).split('|');
  if (key.q_type === 'SA')
    // 단답형: 숫자만 유효. 앞 공백은 적재 때 지웠고, 뒤 공백이 남은 '26 '는 마지막 자리를
    // 안 칠한 미완성 답이므로 여기서 오답이 된다.
    return /^[0-9]+$/.test(m) && list.some(a => parseInt(a, 10) === parseInt(m, 10));
  return list.includes(m.trim());                            // 객관식: 문자열 비교(복수정답 허용)
}

const blank = m => String(m ?? '').trim() === '';
const sum = a => a.reduce((x, y) => x + y, 0);
const mean = a => a.length ? sum(a) / a.length : null;
const sd = a => a.length < 2 ? null : Math.sqrt(sum(a.map(x => (x - mean(a)) ** 2)) / (a.length - 1));
const round = (v, d) => v == null || Number.isNaN(v) ? null : +v.toFixed(d);
const groupBy = (arr, f) => {
  const m = new Map();
  for (const x of arr) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
};
// 점이연상관 = 정오(0/1)와 총점의 피어슨 상관
function corr(xs, ys) {
  const n = xs.length, sx = sum(xs), sy = sum(ys);
  const sxx = sum(xs.map(x => x * x)), syy = sum(ys.map(y => y * y)), sxy = sum(xs.map((x, i) => x * ys[i]));
  const d = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  return d ? (n * sxy - sx * sy) / d : null;
}

// rows: {school_code, subject, grade, class_no, student_no, q_no, marked}
// keys: {subject, q_no, answer, points, q_type, unit}
// → 채점된 행. 결시자(그 과목 전 문항 무응답)는 뺀다. 원본은 지우지 않고 여기서만 거른다.
export function score(rows, keys) {
  const K = new Map(keys.map(k => [`${k.subject}|${k.q_no}`, k]));
  const scored = [];
  for (const r of rows) {
    const k = K.get(`${r.subject}|${r.q_no}`);
    if (!k) continue;
    scored.push({ ...r, student_key: `${r.school_code}-${r.grade}-${r.class_no}-${r.student_no}`,
      answer: k.answer, points: +k.points, q_type: k.q_type, unit: k.unit ?? null, is_correct: isCorrect(k, r.marked) });
  }
  const attempted = new Set(scored.filter(c => !blank(c.marked)).map(c => c.student_key + '|' + c.subject));
  return scored.filter(c => attempted.has(c.student_key + '|' + c.subject));
}

// 학생·과목별 총점과 과목 안 백분위 순위 (Postgres percent_rank = (순위-1)/(n-1)).
// 상·하위 27%는 참여교 전체 기준으로 자른다 — 학교 내 27%는 표본이 작아 요동친다.
function ranks(scored) {
  const total = new Map();
  for (const c of scored) {
    const k = c.student_key + '|' + c.subject;
    total.set(k, (total.get(k) ?? 0) + (c.is_correct ? c.points : 0));
  }
  const pr = new Map();
  for (const [subject, ks] of groupBy([...total.keys()], k => k.split('|')[1])) {
    const vals = ks.map(k => total.get(k)).sort((a, b) => a - b), n = vals.length;
    for (const k of ks) {
      let lo = 0, hi = n;                                      // 자기보다 작은 값의 수
      while (lo < hi) { const m = (lo + hi) >> 1; if (vals[m] < total.get(k)) lo = m + 1; else hi = m; }
      pr.set(k, n > 1 ? lo / (n - 1) : 0);
    }
  }
  return { total, pr };
}

export function itemStats(scored, mySchool) {
  const { total, pr } = ranks(scored);
  const ok = c => c.is_correct ? 1 : 0, sk = c => c.student_key + '|' + c.subject;
  const out = [];
  for (const rows of groupBy(scored, c => `${c.subject}|${c.q_no}`).values()) {
    const { subject, q_no, q_type, points, unit } = rows[0];
    const hi = rows.filter(c => pr.get(sk(c)) >= 0.73), lo = rows.filter(c => pr.get(sk(c)) <= 0.27);
    const mine = rows.filter(c => c.school_code === mySchool);
    out.push({
      subject, q_no, q_type, points, unit,
      n_takers: rows.length, n_correct: sum(rows.map(ok)),
      p_value: round(mean(rows.map(ok)), 4),
      blank_rate: round(mean(rows.map(c => blank(c.marked) ? 1 : 0)), 4),
      discrimination: round(corr(rows.map(ok), rows.map(c => total.get(sk(c)))), 4),
      d_index: hi.length && lo.length ? round(mean(hi.map(ok)) - mean(lo.map(ok)), 4) : null,
      my_takers: mine.length, my_correct: sum(mine.map(ok)), my_p_value: round(mean(mine.map(ok)), 4),
    });
  }
  return out.sort((a, b) => a.subject.localeCompare(b.subject) || a.q_no - b.q_no);
}

// 오답지 매력도. 상위 집단이 특정 오답에 몰리는 문항이 출제·수업 개선에서 가장 값지다.
// 객관식 문항만으로 총점·순위를 매긴다 (Supabase 시절 exam_distractors와 동일).
export function distractors(scored, subject) {
  const base = scored.filter(c => c.subject === subject && c.q_type === 'MC');
  const { pr } = ranks(base);
  const out = [];
  for (const rows of groupBy(base, c => c.q_no).values()) {
    const isHi = c => pr.get(c.student_key + '|' + c.subject) >= 0.73, isLo = c => pr.get(c.student_key + '|' + c.subject) <= 0.27;
    const nHi = rows.filter(isHi).length, nLo = rows.filter(isLo).length;
    for (const [choice, rs] of groupBy(rows, c => blank(c.marked) ? '무응답' : String(c.marked).trim())) {
      out.push({
        q_no: rows[0].q_no, choice, is_answer: rs.some(c => c.is_correct),
        n_all: rs.length, rate_all: round(rs.length / rows.length, 4),
        rate_high: nHi ? round(rs.filter(isHi).length / nHi, 4) : null,
        rate_low: nLo ? round(rs.filter(isLo).length / nLo, 4) : null,
      });
    }
  }
  return out.sort((a, b) => a.q_no - b.q_no || (a.choice < b.choice ? -1 : a.choice > b.choice ? 1 : 0));
}

// 학생·과목별 원점수 (student_scores 뷰)
export function studentScores(scored) {
  return [...groupBy(scored, c => c.student_key + '|' + c.subject).values()].map(rows => ({
    student_key: rows[0].student_key, school_code: rows[0].school_code, subject: rows[0].subject,
    grade: rows[0].grade, class_no: rows[0].class_no, student_no: rows[0].student_no,
    raw_score: sum(rows.map(c => c.is_correct ? c.points : 0)),
    n_correct: rows.filter(c => c.is_correct).length, n_items: rows.length,
  }));
}

// 학교 요약: 과목별 평균과 전체 평균 대비 위치
export function schoolSummary(scored, mySchool) {
  const out = [];
  for (const [subject, rows] of groupBy(studentScores(scored), s => s.subject)) {
    const all = rows.map(s => s.raw_score), my = rows.filter(s => s.school_code === mySchool).map(s => s.raw_score);
    out.push({
      subject, my_takers: my.length, my_mean: round(mean(my), 2), my_sd: round(sd(my), 2),
      all_takers: all.length, all_mean: round(mean(all), 2), all_sd: round(sd(all), 2),
      gap: my.length ? round(mean(my) - mean(all), 2) : null,
    });
  }
  return out.sort((a, b) => a.subject.localeCompare(b.subject));
}

// ── 등급·도약 문항 (학평 분석 엑셀 M_개인성적표 ■6 / M_종합분석 ■1(b) 규칙 그대로) ──
// cuts: {1: 93, 2: 86, …} 원점수 등급컷(EBS grade_cuts). 등급 = 점수 ≥ 컷인 첫 등급, 없으면 9.
export function gradeOf(score, cuts) {
  for (let g = 1; g <= 9; g++) if (cuts[g] != null && score >= cuts[g]) return g;
  return 9;
}

// 한 학생의 "1등급 업" 문항: 내가 틀렸는데 바로 위 등급 집단(없으면 더 위, 내가 1등급이면 1등급)은 맞히는 문항.
// 기준 집단은 참여교 전체(scored 안의 모든 학생). 기준 집단 정답률 내림차순 상위 n개. 영어는 듣기(1~17번) 제외.
export function leapItems(scored, studentKey, subject, cuts, n = 6) {
  const rows = scored.filter(c => c.subject === subject);
  const byStu = new Map();
  for (const c of rows) {
    const s = byStu.get(c.student_key) ?? { score: 0, right: new Set(), marks: new Map() };
    if (c.is_correct) { s.score += c.points; s.right.add(c.q_no); }
    s.marks.set(c.q_no, c.marked);
    byStu.set(c.student_key, s);
  }
  const me = byStu.get(studentKey);
  if (!me) return null;
  const grades = new Map([...byStu].map(([k, s]) => [k, gradeOf(s.score, cuts)]));
  const myGrade = grades.get(studentKey);
  let target = myGrade === 1 ? 1 : myGrade - 1;
  while (target > 1 && ![...grades.values()].some(g => g === target)) target--;   // 그 등급이 비어 있으면 더 위 등급
  const ref = [...byStu].filter(([k, s]) => grades.get(k) === target && k !== studentKey);
  const qnos = [...new Set(rows.map(c => c.q_no))].filter(q => !(subject === '영어' && q <= 17));
  const items = qnos.filter(q => !me.right.has(q) && me.marks.has(q)).map(q => ({
    q_no: q, marked: me.marks.get(q),
    ref_rate: ref.length ? +(ref.filter(([, s]) => s.right.has(q)).length / ref.length).toFixed(4) : null,
    all_rate: +([...byStu.values()].filter(s => s.right.has(q)).length / byStu.size).toFixed(4),
  })).sort((a, b) => (b.ref_rate ?? -1) - (a.ref_rate ?? -1) || a.q_no - b.q_no);
  return { my_score: me.score, my_grade: myGrade, target_grade: target, ref_n: ref.length, items: items.slice(0, n), wrong: items.map(i => i.q_no).sort((a, b) => a - b) };
}

// ── 등급별 문항 정답률 표 (회차·학년·과목당 한 번 계산해 두고, 오답노트·히트맵이 읽는다) ──
// 결과: { cuts, n_students, bands: {등급: 인원}, items: {q_no: {all: [응시, 정답], 1: [응시, 정답], …, 9: […]}} }
export function bandStats(scored, subject, cuts) {
  const rows = scored.filter(c => c.subject === subject);
  const score = new Map(), right = new Map();
  for (const c of rows) {
    score.set(c.student_key, (score.get(c.student_key) ?? 0) + (c.is_correct ? c.points : 0));
    if (c.is_correct) (right.get(c.student_key) ?? right.set(c.student_key, new Set()).get(c.student_key)).add(c.q_no);
  }
  const band = new Map([...score].map(([k, s]) => [k, gradeOf(s, cuts)]));
  const bands = {}, items = {};
  for (const g of band.values()) bands[g] = (bands[g] ?? 0) + 1;
  for (const c of rows) {
    const it = items[c.q_no] ??= { all: [0, 0] }, g = band.get(c.student_key);
    const b = it[g] ??= [0, 0];
    it.all[0]++; b[0]++;
    if (c.is_correct) { it.all[1]++; b[1]++; }
  }
  return { cuts, n_students: score.size, bands, items };
}

// 저장된 표 + 학생 본인의 채점 행만으로 도약 문항을 뽑는다 (leapItems 와 같은 규칙, 전체 응답을 다시 읽지 않음).
export function leapFromStats(stats, myRows, subject, n = 6) {
  if (!myRows.length) return null;
  const my_score = myRows.reduce((a, c) => a + (c.is_correct ? c.points : 0), 0);
  const myGrade = gradeOf(my_score, stats.cuts);
  let target = myGrade === 1 ? 1 : myGrade - 1;
  while (target > 1 && !stats.bands[target]) target--;
  const mine = target === myGrade;   // 1등급이면 기준 집단에 내가 포함되므로 내 몫을 뺀다
  const items = myRows.filter(c => !c.is_correct && !(subject === '영어' && c.q_no <= 17)).map(c => {
    const it = stats.items[c.q_no] ?? {}, b = it[target] ?? [0, 0];
    const bn = b[0] - (mine ? 1 : 0), bc = b[1];
    return { q_no: c.q_no, marked: c.marked, ref_rate: bn > 0 ? +(bc / bn).toFixed(4) : null, all_rate: it.all ? +(it.all[1] / it.all[0]).toFixed(4) : null };
  }).sort((a, b) => (b.ref_rate ?? -1) - (a.ref_rate ?? -1) || a.q_no - b.q_no);
  return { my_score, my_grade: myGrade, target_grade: target, ref_n: (stats.bands[target] ?? 0) - (mine ? 1 : 0), items: items.slice(0, n), wrong: items.map(i => i.q_no).sort((a, b) => a - b) };
}
