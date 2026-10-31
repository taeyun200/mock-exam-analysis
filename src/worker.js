// API. 정적 페이지(public/)는 Workers Assets가 먼저 서빙하고, /api/* 만 여기로 온다.
// 로그인은 학교 ID + 비밀번호. 운영자가 admin.html에서 학교별 ID를 만들어 준다.
// 권한(자기 학교만 보기)은 RLS 대신 여기서 모든 쿼리에 school_code를 붙여서 지킨다.
import { SUBJECTS, score, itemStats, distractors, studentScores, schoolSummary } from './scoring.js';
import { hashPassword, verifyPassword, sign } from './auth.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const SESSION_SEC = 7 * 24 * 3600;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      const body = req.method === 'GET' ? null : await req.json().catch(() => fail(400, '본문이 JSON이 아닙니다'));
      if (url.pathname === '/api/login') return await login(req, body, env);   // await 없이는 거부가 catch를 비껴간다
      if (url.pathname === '/api/logout') return Response.json({}, { headers: { 'set-cookie': cookie('', 0) } });
      const me = await whoami(req, env);
      return Response.json(await route(req.method, url, body, me, env) ?? {});
    } catch (e) {
      return Response.json({ error: e.message }, { status: e.status ?? 500 });
    }
  },
};

// ── 인증 ────────────────────────────────────────────
const cookie = (v, maxAge) => `sid=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const ID_RE = /^[A-Za-z0-9_-]{2,30}$/;   // 쿠키 구분자 '.'가 못 들어오게

async function login(req, body, env) {
  const ip = req.headers.get('cf-connecting-ip') ?? 'local';
  if (env.LOGIN_LIMIT && !(await env.LOGIN_LIMIT.limit({ key: ip })).success) fail(429, '시도가 너무 많습니다. 1분 뒤에 다시 하세요.');
  const id = String(body?.login_id ?? ''), pw = String(body?.password ?? '');
  const acct = ID_RE.test(id) ? await env.DB.prepare('select login_id, password_hash from accounts where login_id = ?').bind(id).first() : null;
  if (!await verifyPassword(pw, acct?.password_hash)) fail(401, 'ID 또는 비밀번호가 맞지 않습니다');
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
async function route(method, url, body, me, env) {
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

  if (r === 'GET /exams') {
    const open = q.get('open');
    return rows(`select * from exams ${open == null ? '' : 'where is_open = ' + (open === '1' ? 1 : 0)} order by exam_code desc`);
  }
  if (r === 'POST /exams') {
    admin();
    await env.DB.prepare('insert into exams (exam_code, exam_name, exam_date) values (?, ?, ?)')
      .bind(str(body.exam_code, 20), str(body.exam_name, 50), body.exam_date || null).run();
    return;
  }
  if (method === 'PATCH' && path.startsWith('/exams/')) {
    admin();
    await env.DB.prepare('update exams set is_open = ? where exam_code = ?').bind(body.is_open ? 1 : 0, decodeURIComponent(path.slice(7))).run();
    return;
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
    const stmts = [...groups].map(g => env.DB.prepare('delete from answer_keys where exam_code = ? and grade = ? and subject = ?').bind(...g.split('|')));
    for (const chunk of chunks(keys, 12))   // D1: 문장당 바인딩 100개 → 8열 × 12행
      stmts.push(env.DB.prepare(`insert into answer_keys (exam_code, grade, subject, q_no, answer, points, q_type, unit) values ${vals(chunk.length, 8)}`)
        .bind(...chunk.flatMap(k => [k.exam_code, k.grade, k.subject, k.q_no, k.answer, k.points, k.q_type, k.unit])));
    await env.DB.batch(stmts);
    return { n: keys.length };
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
    return {
      summary: schoolSummary(scored, me.school_code),
      items: itemStats(scored, me.school_code),
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

// ── 입력 검증 ───────────────────────────────────────
const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max ? v : fail(400, `잘못된 값: ${JSON.stringify(v)}`);
const int = v => Number.isInteger(+v) ? +v : fail(400, `정수가 아님: ${JSON.stringify(v)}`);
const subject = v => SUBJECTS.includes(v) ? v : fail(400, `알 수 없는 과목: ${v}`);
const grade = v => [1, 2, 3].includes(+v) ? +v : fail(400, `학년은 1~3이어야 합니다: ${v}`);
const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const vals = (rows, cols) => Array(rows).fill(`(${Array(cols).fill('?').join(',')})`).join(',');
