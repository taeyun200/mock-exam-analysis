// API. 정적 페이지(public/)는 Workers Assets가 먼저 서빙하고, /api/* 만 여기로 온다.
// 로그인은 학교 ID + 비밀번호. 운영자가 admin.html에서 학교별 ID를 만들어 준다.
// 권한(자기 학교만 보기)은 RLS 대신 여기서 모든 쿼리에 school_code를 붙여서 지킨다.
import { SUBJECTS, score, itemStats, distractors, studentScores, schoolSummary } from './scoring.js';
import { hashPassword, verifyPassword, sign } from './auth.js';
import { crawlEbs } from './ebs.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const SESSION_SEC = 7 * 24 * 3600;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      const body = req.method === 'GET' ? null : await req.json().catch(() => fail(400, '본문이 JSON이 아닙니다'));
      if (url.pathname === '/api/login') return await login(req, body, env);   // await 없이는 거부가 catch를 비껴간다
      if (url.pathname === '/api/logout') return Response.json({}, { headers: { 'set-cookie': cookie('', 0) } });
      const me = await whoami(req, env);
      return Response.json(await route(req.method, url, body, me, env, ctx) ?? {});
    } catch (e) {
      return Response.json({ error: e.message }, { status: e.status ?? 500 });
    }
  },
};

// ── 인증 ────────────────────────────────────────────
const cookie = (v, maxAge) => `sid=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const ID_RE = /^[A-Za-z0-9_-]{2,30}$/;   // 쿠키 구분자 '.'가 못 들어오게

// ID·비밀번호 확인 (시도 제한 포함)
async function authenticate(req, env, id, pw) {
  const ip = req.headers.get('cf-connecting-ip') ?? 'local';
  if (env.LOGIN_LIMIT && !(await env.LOGIN_LIMIT.limit({ key: ip })).success) fail(429, '시도가 너무 많습니다. 1분 뒤에 다시 하세요.');
  const acct = ID_RE.test(id) ? await env.DB.prepare('select login_id, password_hash from accounts where login_id = ?').bind(id).first() : null;
  if (!await verifyPassword(pw, acct?.password_hash)) fail(401, 'ID 또는 비밀번호가 맞지 않습니다');
  return id;
}

async function login(req, body, env) {
  const id = await authenticate(req, env, String(body?.login_id ?? ''), String(body?.password ?? ''));
  const exp = Math.floor(Date.now() / 1000) + SESSION_SEC;
  const sid = `${id}.${exp}.${await sign(env.SESSION_SECRET, `${id}.${exp}`)}`;
  return Response.json({ ok: true }, { headers: { 'set-cookie': cookie(sid, SESSION_SEC) } });
}

async function whoami(req, env) {
  const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.get('Cookie') ?? '')?.[1];
  const [id, exp, sig] = (sid ?? '').split('.');
  if (!id || !(+exp > Date.now() / 1000) || sig !== await sign(env.SESSION_SECRET, `${id}.${exp}`)) fail(401, '로그인이 필요합니다');
  const a = await env.DB.prepare(
    'select a.login_id, a.school_code, a.role, s.school_name from accounts a left join schools s using (school_code) where a.login_id = ?')
    .bind(id).first();
  return a ?? fail(401, '삭제된 계정입니다');
}

// ── 라우팅 ──────────────────────────────────────────
async function route(method, url, body, me, env, ctx) {
  const path = url.pathname.slice(4), q = url.searchParams;
  const admin = () => me.role === 'admin' || fail(403, '운영자만 가능합니다');
  const exam = async code => (await env.DB.prepare('select * from exams where exam_code = ?').bind(code).first())
    ?? fail(404, '없는 회차입니다');
  const rows = async (sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results;
  const r = `${method} ${path}`;

  if (r === 'GET /me') return me;

  if (r === 'GET /schools') return rows('select * from schools order by school_code');
  if (r === 'POST /schools') {
    admin();
    await env.DB.prepare('insert into schools (school_code, school_name, district) values (?, ?, ?)')
      .bind(str(body.school_code, 20), str(body.school_name, 50), body.district ? str(body.district, 30) : null).run();
    return;
  }

  // 회차. 코드는 '연도-월'(예 2026-10)로 고정 — 정답 DB 서버의 회차(2026_10)와 자동으로 맞는다.
  // 상태 2개: is_open=0 수집 중(학교 제출 가능) / is_open=1 수집 닫힘(분석 열람 가능).
  if (r === 'GET /exams') {
    const open = q.get('open');
    const list = await rows(`select * from exams ${open == null ? '' : 'where is_open = ' + (open === '1' ? 1 : 0)} order by exam_code desc`);
    const kc = await rows('select exam_code, grade, count(*) as n from answer_keys group by exam_code, grade');
    const jobs = await rows('select exam_code, grade, status, finished_at, summary, warnings from ebs_jobs');
    const out = list.map(x => ({ ...x, opened: true,
      keys: Object.fromEntries(kc.filter(k => k.exam_code === x.exam_code).map(k => [k.grade, k.n])),
      ebs: Object.fromEntries(jobs.filter(j => j.exam_code === x.exam_code).map(j => [j.grade, { status: j.status, finished_at: j.finished_at, summary: j.summary, warnings: j.warnings }])) }));
    if (!q.get('status')) return out;
    // status=1 (운영자 현황): 기준은 정답 DB 서버. 회차·학년별 건수를 센다.
    //   가채점(EBS): items = 오답률 TOP15 문항(기대 90), cuts = 등급컷(54), units = 단원 분류(190)
    //   실채점: subjects = 정답표 과목 수(6), diff = 전국 정답률(A~E) 문항 수(190), freq = 도수분포, cutpts = 등급구분점수
    // 여기서 아직 안 연 회차도 줄로 보여 준다(opened: false) — '회차 열기' 한 번이면 정답표를 받아온다.
    const sbInfo = {};
    const at = (code, g) => (sbInfo[code] ??= {})[g] ??= { subjects: 0, items: 0, cuts: 0, units: 0, diff: 0, freq: false, cutpts: false };
    try {
      const fetchAll = p => sbAll(env, p);
      const [off, diff, items, cuts, units, freq, cutpts] = await Promise.all([
        fetchAll('official_items?select=exam,grade&q_no=eq.1&order=exam,grade'),
        fetchAll('official_items?select=exam,grade&difficulty=not.is.null&order=exam,grade,subject,q_no'),
        fetchAll('answer_items?select=exam,grade&wrong_rate=not.is.null&order=exam,grade,subject,q_no'),
        fetchAll('grade_cuts?select=exam,grade&order=exam,grade,subject,rank'),
        fetchAll('item_units?select=exam,grade&order=exam,grade,subject,q_no'),
        fetchAll('freq_dist?select=exam,grade&row_type=eq.표준점수&idx=eq.1&subject=eq.국어&order=exam,grade'),
        fetchAll('freq_dist?select=exam,grade&row_type=eq.점수&idx=eq.1&subject=eq.국어&order=exam,grade'),
      ]);
      const code = e => { try { return fromExcelExam(e); } catch { return null; } };
      for (const [list2, k] of [[off, 'subjects'], [diff, 'diff'], [items, 'items'], [cuts, 'cuts'], [units, 'units']])
        for (const r of list2) { const c = code(r.exam); if (c) at(c, r.grade)[k]++; }
      for (const [list2, k] of [[freq, 'freq'], [cutpts, 'cutpts']])
        for (const r of list2) { const c = code(r.exam); if (c) at(c, r.grade)[k] = true; }
    } catch (e) { return out.map(x => ({ ...x, sb: null, sb_error: e.message })); }
    const ours = new Set(out.map(x => x.exam_code));
    for (const code of Object.keys(sbInfo)) if (!ours.has(code))
      out.push({ exam_code: code, exam_name: `${code.slice(0, 4)}년 ${+code.slice(5)}월 학평`, exam_date: null, is_open: 0, opened: false, keys: {}, ebs: {} });
    return out.map(x => ({ ...x, sb: sbInfo[x.exam_code] ?? {} })).sort((a, b) => b.exam_code.localeCompare(a.exam_code));
  }
  if (r === 'POST /exams') {   // 회차 열기 = 수집 시작 + 정답 DB 서버에서 정답표 자동 가져오기
    admin();
    const year = int(body.year), month = int(body.month);
    if (year < 2020 || year > 2100 || month < 1 || month > 12) fail(400, '연도·월이 잘못됨');
    const exam_code = `${year}-${String(month).padStart(2, '0')}`;
    if (await env.DB.prepare('select 1 from exams where exam_code = ?').bind(exam_code).first()) fail(400, `${exam_code} 회차가 이미 있습니다`);
    await env.DB.prepare('insert into exams (exam_code, exam_name, exam_date) values (?, ?, ?)')
      .bind(exam_code, body.exam_name ? str(body.exam_name, 50) : `${year}년 ${month}월 학평`, body.exam_date || null).run();
    let pulled = null, pull_error = null;
    try { pulled = await pullKeys(env, exam_code); } catch (e) { pull_error = e.message; }
    // 정답표가 있는 학년은 EBS 자료도 바로 가져온다 (뒤에서 실행)
    const ebs_started = [];
    for (const g of [1, 2, 3]) if (pulled?.[g] && await startEbs(env, ctx, exam_code, g) === 'started') ebs_started.push(g);
    return { exam_code, pulled, pull_error, ebs_started };
  }
  // EBS 자료(오답률·등급컷·단원) 가져오기를 뒤에서 시작한다. 학년을 안 주면 정답표가 있는 학년 전부.
  if (r === 'POST /ebs/run') {
    admin();
    const x = await exam(body.exam_code);
    const grades = body.grade ? [grade(body.grade)]
      : (await rows('select distinct grade from answer_keys where exam_code = ?', x.exam_code)).map(k => k.grade);
    if (!grades.length) fail(400, '정답표가 있는 학년이 없습니다. 정답표를 먼저 올리세요.');
    const started = [];
    for (const g of grades) if (await startEbs(env, ctx, x.exam_code, g) === 'started') started.push(g);
    return { started };
  }
  // 전국 정답률(A~E, 성적통지표 문항표) → 정답 DB 서버 official_items.difficulty. 다른 열(정답·배점)은 그대로 둔다.
  if (r === 'POST /difficulty') {
    admin();
    const list = (body.rows ?? []).map(v => ({ exam: toExcelExam(fromExcelExam(v.exam)), grade: grade(v.grade), subject: subject(v.subject), q_no: int(v.q_no),
      difficulty: /^[A-E]$/.test(String(v.difficulty ?? '').trim().toUpperCase()) ? String(v.difficulty).trim().toUpperCase() : fail(400, `정답률은 A~E: ${v.subject} ${v.q_no} '${v.difficulty}'`) }));
    if (!list.length) fail(400, '빈 파일입니다');
    if (!env.SUPABASE_SERVICE_KEY) fail(500, '정답 DB 서버 쓰기 키(SUPABASE_SERVICE_KEY)가 없습니다');
    await sb(env, 'official_items', { method: 'POST', body: JSON.stringify(list), headers: { Prefer: 'resolution=merge-duplicates' } }, env.SUPABASE_SERVICE_KEY);
    return { n: list.length, exams: [...new Set(list.map(v => `${v.exam} ${v.grade}학년`))] };
  }
  // 도수분포(교육청 성적 자료) → 정답 DB 서버 freq_dist. 올리던 long 형식 그대로: exam,grade,subject,row_type,idx,value
  if (r === 'POST /freq-dist') {
    admin();
    const list = (body.rows ?? []).map(v => ({ exam: toExcelExam(fromExcelExam(v.exam)), grade: grade(v.grade), subject: subject(v.subject),
      row_type: str(v.row_type, 30), idx: int(v.idx), value: v.value === '' || v.value == null ? null : +v.value }));
    if (!list.length) fail(400, '빈 파일입니다');
    if (!env.SUPABASE_SERVICE_KEY) fail(500, '정답 DB 서버 쓰기 키(SUPABASE_SERVICE_KEY)가 없습니다');
    for (const c of chunks(list, 2000))
      await sb(env, 'freq_dist', { method: 'POST', body: JSON.stringify(c), headers: { Prefer: 'resolution=merge-duplicates' } }, env.SUPABASE_SERVICE_KEY);
    const keys = [...new Set(list.map(v => `${v.exam} ${v.grade}학년`))];
    return { n: list.length, exams: keys };
  }
  if (method === 'PATCH' && path.startsWith('/exams/')) {   // 수집 닫기(=분석 열기) 전에 정답표를 한 번 더 받아 정정을 반영
    admin();
    const x = await exam(decodeURIComponent(path.slice(7)));
    let pulled = null, pull_error = null;
    if (body.is_open) { try { pulled = await pullKeys(env, x.exam_code); } catch (e) { pull_error = e.message; } }
    await env.DB.prepare('update exams set is_open = ? where exam_code = ?').bind(body.is_open ? 1 : 0, x.exam_code).run();
    return { pulled, pull_error };
  }

  // 수집 단계 검증용. 정답은 감추고 학년·과목별 문항 수만 준다 (회차 개방 전에도 가능).
  if (r === 'GET /item-counts') {
    const out = await rows(`select grade, subject, count(*) as n_items, max(q_no) as max_q,
      group_concat(case when q_type = 'SA' then q_no end) as sa from answer_keys where exam_code = ? group by grade, subject`, q.get('exam'));
    return out.map(({ sa, ...o }) => ({ ...o, sa_items: sa ? sa.split(',').map(Number) : [] }));
  }

  // 정답표: 같은 (회차·학년·과목)을 통째로 교체한다 (정답 정정용)
  if (r === 'PUT /answer-keys') {
    admin();
    const keys = (body.rows ?? []).map(k => ({
      exam_code: str(k.exam_code, 20), grade: grade(k.grade), subject: subject(k.subject), q_no: int(k.q_no),
      answer: str(k.answer, 20), points: +k.points > 0 ? +k.points : fail(400, '배점이 잘못됨'),
      q_type: ['MC', 'SA'].includes(k.q_type) ? k.q_type : fail(400, 'q_type은 MC 또는 SA'), unit: k.unit ? str(k.unit, 50) : null,
    }));
    if (!keys.length) fail(400, '빈 정답표입니다');
    const groups = new Set(keys.map(k => `${k.exam_code}|${k.grade}|${k.subject}`));
    // 정답표가 먼저 와도 되게 회차는 없으면 만든다 (= 수집 열림). 코드는 YYYY-MM 이어야 정답 DB 서버와 맞는다.
    const stmts = [...new Set(keys.map(k => k.exam_code))].map(e => {
      const m = /^(\d{4})-(\d{2})$/.exec(e) ?? fail(400, `회차 코드는 YYYY-MM 형식이어야 합니다: ${e}`);
      return env.DB.prepare('insert or ignore into exams (exam_code, exam_name) values (?, ?)').bind(e, `${m[1]}년 ${+m[2]}월 학평`);
    });
    stmts.push(...[...groups].map(g => env.DB.prepare('delete from answer_keys where exam_code = ? and grade = ? and subject = ?').bind(...g.split('|'))));
    for (const chunk of chunks(keys, 12))   // D1: 문장당 바인딩 100개 → 8열 × 12행
      stmts.push(env.DB.prepare(`insert into answer_keys (exam_code, grade, subject, q_no, answer, points, q_type, unit) values ${vals(chunk.length, 8)}`)
        .bind(...chunk.flatMap(k => [k.exam_code, k.grade, k.subject, k.q_no, k.answer, k.points, k.q_type, k.unit])));
    await env.DB.batch(stmts);
    let pushed = null, push_error = null;   // 정답 DB 서버(엑셀 공용)에도 보낸다. 실패해도 우리 저장은 유지된다.
    try { pushed = await pushOfficial(keys, env); } catch (e) { push_error = e.message; }
    const ebs_started = [];   // 정답표가 올라온 회차·학년은 EBS 자료도 바로 가져온다
    for (const g of groups) {
      const [exam_code, gr] = g.split('|');
      if (await startEbs(env, ctx, exam_code, +gr) === 'started' && !ebs_started.includes(`${exam_code} ${gr}학년`)) ebs_started.push(`${exam_code} ${gr}학년`);
    }
    return { n: keys.length, pushed, push_error, ebs_started };
  }

  // 계정: 학교 하나에 ID 하나. 비밀번호를 비우면 학교·권한만 바꾼다 (재설정은 새 비밀번호를 넣는다).
  if (r === 'GET /accounts') { admin(); return rows('select login_id, school_code, role from accounts order by role, school_code, login_id'); }
  if (r === 'POST /accounts') {
    admin();
    const id = ID_RE.test(body.login_id ?? '') ? body.login_id : fail(400, 'ID는 영문·숫자·_·- 2~30자');
    const role = body.role === 'admin' ? 'admin' : 'school', school = body.school_code ? str(body.school_code, 20) : null;
    const pw = body.password ? str(body.password, 100) : null;
    if (pw && pw.length < 6) fail(400, '비밀번호는 6자 이상');
    if (pw) await env.DB.prepare(`insert into accounts (login_id, password_hash, school_code, role) values (?, ?, ?, ?)
        on conflict (login_id) do update set password_hash = excluded.password_hash, school_code = excluded.school_code, role = excluded.role`)
      .bind(id, await hashPassword(pw), school, role).run();
    else {
      const { meta } = await env.DB.prepare('update accounts set school_code = ?, role = ? where login_id = ?').bind(school, role, id).run();
      if (!meta.changes) fail(400, '새 계정에는 비밀번호가 필요합니다');
    }
    return;
  }
  if (method === 'DELETE' && path.startsWith('/accounts/')) {
    admin();
    const id = decodeURIComponent(path.slice(10));
    if (id === me.login_id) fail(400, '자기 계정은 지울 수 없습니다');
    await env.DB.prepare('delete from accounts where login_id = ?').bind(id).run();
    return;
  }

  // 제출: 자기 학교 것만 읽고, 마감 전(is_open = 0)에만 새로 넣는다.
  if (r === 'GET /submissions') {
    me.school_code || fail(403, '학교가 배정되지 않은 계정입니다');
    return rows('select grade, subject, submitted_at, row_count from submissions where exam_code = ? and school_code = ? and is_active = 1 order by grade, subject',
      q.get('exam'), me.school_code);
  }
  if (r === 'POST /submit') return submit(body, me, env, exam);

  // 리포트: 회차·학년 단위. 회차가 개방된 뒤에만. 개별 답안은 자기 학교 것만, 통계는 전체 기준.
  if (r === 'GET /report') {
    const x = await exam(q.get('exam')), g = grade(q.get('grade'));
    if (!x.is_open) fail(403, '아직 개방되지 않은 회차입니다');
    const keys = await rows('select subject, q_no, answer, points, q_type, unit from answer_keys where exam_code = ? and grade = ?', x.exam_code, g);
    // ponytail: 학년 전체를 한 번에 읽는다(3만 행 ≈ 2MB). 10만 행을 넘기면 과목별로 나눠 읽을 것.
    const raw = await rows(`select s.school_code, s.subject, r.grade, r.class_no, r.student_no, r.q_no, r.marked
      from responses r join submissions s on s.id = r.submission_id where s.exam_code = ? and s.grade = ? and s.is_active = 1`, x.exam_code, g);
    const scored = score(raw, keys);
    const mine = scored.filter(c => c.school_code === me.school_code);
    const subs = [...new Set(scored.map(c => c.subject))];
    // 문항 분류(영역·단원, EBSi)와 전국 정답률 등급(A~E, 성적통지표)은 정답 DB 서버에서 — 없으면 null로 둔다
    const ex = encodeURIComponent(toExcelExam(x.exam_code));
    const [units, nat] = await Promise.all([
      sbAll(env, `item_units?select=subject,q_no,unit,area&exam=eq.${ex}&grade=eq.${g}`).catch(() => []),
      sbAll(env, `official_items?select=subject,q_no,difficulty&exam=eq.${ex}&grade=eq.${g}&difficulty=not.is.null`).catch(() => []),
    ]);
    const U = new Map(units.map(u => [`${subject(u.subject)}|${u.q_no}`, u])), N = new Map(nat.map(n => [`${subject(n.subject)}|${n.q_no}`, n.difficulty]));
    return {
      summary: schoolSummary(scored, me.school_code),
      items: itemStats(scored, me.school_code).map(i => ({ ...i, area: U.get(`${i.subject}|${i.q_no}`)?.area ?? null,
        unit: U.get(`${i.subject}|${i.q_no}`)?.unit ?? i.unit ?? null, nat: N.get(`${i.subject}|${i.q_no}`) ?? null })),
      dists: Object.fromEntries(subs.map(s => [s, distractors(scored, s)])),
      scores: studentScores(mine).map(({ student_key, school_code, ...s }) => s),
      marks: mine.map(c => ({ subject: c.subject, grade: c.grade, class_no: c.class_no, student_no: c.student_no, q_no: c.q_no, marked: c.marked, is_correct: c.is_correct })),
    };
  }

  fail(404, '없는 API입니다: ' + r);
}

// body: { exam, groups: [{ grade, subject, row_count, rows: [{grade, class_no, student_no, q_no, marked}] }] }
// 학교 계정 하나로 여러 학년을 한 파일에 올린다. 브라우저가 학년 열로 나눠 보내고, 여기서는 학년·과목 단위로 적재한다.
async function submit(body, me, env, exam) {
  me.school_code || fail(403, '학교가 배정되지 않은 계정입니다');
  const x = await exam(body.exam);
  if (x.is_open) fail(403, '개방된 회차에는 제출할 수 없습니다');
  const created = [];
  try {
    for (const grp of body.groups ?? []) {
      const g = grade(grp.grade), sub = subject(grp.subject), rows = grp.rows;
      if (!rows?.length) fail(400, `${g}학년 ${sub}: 응답이 없습니다`);
      if (rows.some(r => +r.grade !== g)) fail(400, `${g}학년 ${sub}: 다른 학년 행이 섞여 있습니다`);
      const id = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare('update submissions set is_active = 0 where exam_code = ? and school_code = ? and grade = ? and subject = ? and is_active = 1')
          .bind(x.exam_code, me.school_code, g, sub),
        env.DB.prepare('insert into submissions (id, exam_code, school_code, grade, subject, submitted_by, row_count) values (?, ?, ?, ?, ?, ?, ?)')
          .bind(id, x.exam_code, me.school_code, g, sub, me.login_id, int(grp.row_count)),
      ]);
      created.push({ grade: g, subject: sub, id });
      const stmts = chunks(rows, 16).map(c =>   // 6열 × 16행 = 96 바인딩
        env.DB.prepare(`insert into responses (submission_id, grade, class_no, student_no, q_no, marked) values ${vals(c.length, 6)}`)
          .bind(...c.flatMap(r => [id, g, int(r.class_no), int(r.student_no), int(r.q_no), r.marked == null ? null : str(r.marked, 10)])));
      for (const batch of chunks(stmts, 500)) await env.DB.batch(batch);
    }
  } catch (e) {
    // 부분 적재를 남기지 않는다. submissions를 지우면 responses도 cascade로 사라진다.
    for (const c of created) await env.DB.prepare('delete from submissions where id = ?').bind(c.id).run();
    throw e;
  }
  return created;
}

// ── 정답 DB 서버(Supabase, 엑셀 '학평 분석 시스템'과 공용) 다리 ──────────────
// 엑셀(M_자료수신.bas)은 그 서버를 그대로 읽는다. 여기서는 그 서버의 official_items를 가져오고(pull),
// 운영자가 여기 올린 정답표를 그쪽에도 보낸다(push). 두 쪽 정답표가 같게 유지된다.
// 회차 코드: 우리 '2026-09' ↔ 그쪽 '2026_9'. 정답 표기: 우리 '1' / '1|3' / '047' ↔ 그쪽 '①' / '①,③' / '047'.
export const toExcelExam = c => { const m = /^(\d{4})-(\d{2})$/.exec(c); return m ? `${m[1]}_${+m[2]}` : c; };
export const fromExcelExam = c => { const m = /^(\d{4})_(\d{1,2})$/.exec(String(c)); return m ? `${m[1]}-${m[2].padStart(2, '0')}` : fail(400, `회차 형식은 YYYY_M: ${c}`); };
const CIRCLED = '①②③④⑤';
export const toOfficialAnswer = (answer, q_type) =>
  q_type === 'MC' && answer !== '*' ? String(answer).split('|').map(a => CIRCLED[+a - 1] ?? a).join(',') : String(answer);
// 그쪽 행 → 우리 answer_keys 행. 유형: q_type이 있으면 그대로, 없으면 ①~⑤ 표기 = 객관식, 숫자 문자열 = 단답형.
export function fromOfficial(r) {
  const raw = String(r.answer ?? '').replace(/\s/g, '');
  const parts = raw.replace(/[①②③④⑤]/g, c => CIRCLED.indexOf(c) + 1).split(/[,|/]/).filter(Boolean);
  if (!parts.length) fail(400, `정답 비어 있음: ${r.subject} ${r.q_no}`);
  const mc = ['MC', 'SA'].includes(r.q_type) ? r.q_type === 'MC' : /[①②③④⑤]/.test(raw);
  return { exam_code: fromExcelExam(r.exam), grade: grade(r.grade), subject: subject(r.subject), q_no: int(r.q_no),
    answer: parts.join('|'), points: +r.points > 0 ? +r.points : fail(400, `배점 잘못됨: ${r.subject} ${r.q_no}`), q_type: mc ? 'MC' : 'SA' };
}

// PostgREST 호출. 읽기는 anon 키(공개용), 쓰기는 SUPABASE_SERVICE_KEY 비밀(없으면 push 생략).
async function sb(env, path, init = {}, key = env.SUPABASE_ANON_KEY) {
  if (!env.SUPABASE_URL || !key) fail(500, '정답 DB 서버 접속 정보가 설정되지 않았습니다 (wrangler.jsonc vars)');
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { ...init,
    // Supabase는 브라우저 User-Agent로 오는 secret key 요청을 거부한다 → 스크립트 UA를 명시
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json', 'user-agent': 'mock-exam-worker', ...(init.headers ?? {}) } });
  if (!r.ok) fail(502, `정답 DB 서버 응답 ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;   // 쓰기 응답(201)은 본문이 비어 있다
}
async function sbAll(env, path) {   // PostgREST는 요청당 최대 1,000행 → 끝까지 받는다
  const out = [];
  for (let off = 0; ; off += 1000) {
    const page = await sb(env, `${path}&limit=1000&offset=${off}`);
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

// 그쪽 정답표(1~3학년 전부) → 우리 answer_keys. 같은 키는 덮어쓴다(정답 정정 반영). 반환 = {학년: 문항 수}.
// 회차를 열 때와 수집을 닫을 때 자동으로 부른다 — 운영자가 손으로 가져올 일이 없게.
async function pullKeys(env, exam_code) {
  const rows = await sbAll(env, `official_items?select=exam,grade,subject,q_no,answer,points,q_type&exam=eq.${encodeURIComponent(toExcelExam(exam_code))}&order=grade,subject,q_no`);
  const keys = rows.map(fromOfficial), pulled = { 1: 0, 2: 0, 3: 0 };
  for (const k of keys) pulled[k.grade]++;
  const stmts = keys.map(k => env.DB.prepare(`insert into answer_keys (exam_code, grade, subject, q_no, answer, points, q_type) values (?, ?, ?, ?, ?, ?, ?)
      on conflict (exam_code, grade, subject, q_no) do update set answer = excluded.answer, points = excluded.points, q_type = excluded.q_type`)
    .bind(k.exam_code, k.grade, k.subject, k.q_no, k.answer, k.points, k.q_type));
  for (const c of chunks(stmts, 500)) await env.DB.batch(c);
  return pulled;
}

// ── EBS 자료 가져오기 (뒤에서 실행) ─────────────────
// 트리거: 회차 열기(정답표 받아진 학년), 정답표 업로드, 회차 줄의 '다시 가져오기' 버튼.
// 결과는 정답 DB 서버 answer_items / grade_cuts / item_units 에 쓰고, 진행 상태는 ebs_jobs 에 남긴다.
async function startEbs(env, ctx, exam_code, g) {
  const cur = await env.DB.prepare('select status, started_at from ebs_jobs where exam_code = ? and grade = ?').bind(exam_code, g).first();
  if (cur?.status === 'running' && Date.now() - Date.parse(cur.started_at) < 10 * 60e3) return 'already';   // 10분 넘긴 running은 죽은 것으로 보고 다시 돈다
  await env.DB.prepare(`insert into ebs_jobs (exam_code, grade, status, started_at) values (?, ?, 'running', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    on conflict (exam_code, grade) do update set status = 'running', started_at = excluded.started_at, finished_at = null, summary = null, warnings = null`)
    .bind(exam_code, g).run();
  ctx.waitUntil(runEbs(env, exam_code, g));
  return 'started';
}
async function runEbs(env, exam_code, g) {
  const [year, month] = exam_code.split('-').map(Number);
  let status = 'done', summary, warnings = [];
  try {
    const r = await crawlEbs(year, g, month);
    warnings = r.warnings;
    if (!env.SUPABASE_SERVICE_KEY) throw new Error('정답 DB 서버 쓰기 키(SUPABASE_SERVICE_KEY)가 없어 저장하지 못했습니다');
    for (const [table, list] of [['answer_items', r.items], ['grade_cuts', r.cuts], ['item_units', r.units]])
      if (list.length) await sb(env, table, { method: 'POST', body: JSON.stringify(list), headers: { Prefer: 'resolution=merge-duplicates' } }, env.SUPABASE_SERVICE_KEY);
    summary = `오답률 ${r.items.length} · 등급컷 ${r.cuts.length} · 단원 ${r.units.length}`;
  } catch (e) { status = 'error'; summary = e.message; }
  await env.DB.prepare(`update ebs_jobs set status = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), summary = ?, warnings = ? where exam_code = ? and grade = ?`)
    .bind(status, summary, warnings.join('\n') || null, exam_code, g).run();
}

// 우리 정답표 → 그쪽 official_items (같은 키는 덮어쓴다). 서비스 키가 없으면 null을 돌려주고 넘어간다.
async function pushOfficial(keys, env) {
  if (!env.SUPABASE_SERVICE_KEY) return null;
  const rows = keys.map(k => ({ exam: toExcelExam(k.exam_code), grade: k.grade, subject: k.subject, q_no: k.q_no,
    answer: toOfficialAnswer(k.answer, k.q_type), points: k.points }));
  await sb(env, 'official_items', { method: 'POST', body: JSON.stringify(rows), headers: { Prefer: 'resolution=merge-duplicates' } }, env.SUPABASE_SERVICE_KEY);
  return rows.length;
}

// ── 입력 검증 ───────────────────────────────────────
export const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max ? v : fail(400, `잘못된 값: ${JSON.stringify(v)}`);
export const int = v => Number.isInteger(+v) ? +v : fail(400, `정수가 아님: ${JSON.stringify(v)}`);
export const subject = v => SUBJECTS.includes(v) ? v : fail(400, `알 수 없는 과목: ${v}`);
export const grade = v => [1, 2, 3].includes(+v) ? +v : fail(400, `학년은 1~3이어야 합니다: ${v}`);
const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const vals = (rows, cols) => Array(rows).fill(`(${Array(cols).fill('?').join(',')})`).join(',');
