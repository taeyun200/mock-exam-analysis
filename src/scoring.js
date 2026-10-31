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
