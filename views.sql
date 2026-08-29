-- 채점 뷰 + 문항분석.  schema.sql, policies.sql 실행 후 붙여넣는다.
--
-- 채점 결과는 저장하지 않는다. 정답표 한 줄을 고치면 전체가 자동 재채점된다.
-- 아래 채점 규칙은 실물 데이터 29,950문항으로 리딩 업체 채점과 대조해 검증했다 (test_scoring.js).

-- ── 채점 ────────────────────────────────────────────
-- security_invoker: Postgres 15부터 뷰는 기본이 소유자 권한이라 RLS를 우회한다.
-- 이 옵션이 없으면 선생님이 다른 학교 답안을 전부 볼 수 있다.
create or replace view scored with (security_invoker = true) as
select
  s.school_code || '-' || r.grade || '-' || r.class_no || '-' || r.student_no as student_key,
  s.school_code, s.exam_code, s.subject,
  r.grade, r.class_no, r.student_no, r.q_no, r.marked,
  k.answer, k.points, k.q_type, k.unit,
  case
    when k.answer = '*' then true                                  -- 전항정답
    when btrim(coalesce(r.marked, '')) = '' then false             -- 무응답
    when k.q_type = 'SA' then
      -- 단답형: 숫자만 유효하다. 앞 공백은 적재할 때 지웠고, 뒤 공백이 남아 있으면
      -- 마지막 자리를 안 칠한 무효 답('26 ')이므로 여기서 걸러진다.
      r.marked ~ '^[0-9]+$'
      and r.marked::int in (select x::int from unnest(string_to_array(k.answer, '|')) x)
    else btrim(r.marked) in (select x from unnest(string_to_array(k.answer, '|')) x)
  end as is_correct
from responses r
join submissions s on s.id = r.submission_id and s.is_active
join answer_keys k on k.exam_code = s.exam_code and k.subject = s.subject and k.q_no = r.q_no;

-- 결시자(해당 과목 전 문항 무응답)를 뺀 실제 응시자. 원본은 지우지 않고 여기서만 거른다.
create or replace view attempted with (security_invoker = true) as
select student_key, school_code, exam_code, subject
from scored
group by 1, 2, 3, 4
having count(*) filter (where btrim(coalesce(marked, '')) <> '') > 0;

create or replace view student_scores with (security_invoker = true) as
select c.student_key, c.school_code, c.exam_code, c.subject, c.grade, c.class_no, c.student_no,
       sum(case when c.is_correct then c.points else 0 end) as raw_score,
       count(*) filter (where c.is_correct)                 as n_correct,
       count(*)                                             as n_items
from scored c
join attempted a using (student_key, exam_code, subject)
group by 1, 2, 3, 4, 5, 6, 7;

-- ── 문항분석 ────────────────────────────────────────
-- responses는 자기 학교만 읽히므로(RLS), 전체 통계는 함수로 감싼다.
-- 개별 답안은 노출하지 않고 집계만 돌려주며, 회차가 개방된 뒤에만 동작한다.
-- 상·하위 27%는 참여교 전체 기준으로 자른다(학교 내 27%는 표본이 작아 요동친다).
create or replace function exam_item_stats(p_exam text)
returns table (
  subject text, q_no int, q_type text, points numeric, unit text,
  n_takers int, n_correct int, p_value numeric, blank_rate numeric,
  discrimination numeric, d_index numeric,
  my_takers int, my_correct int, my_p_value numeric
)
language sql stable security definer set search_path = public as $$
with guard as (
  select 1 from exams e where e.exam_code = p_exam and e.is_open and auth.uid() is not null
),
base as (   -- 결시자를 뺀 전체 응답
  select c.* from scored c
  join attempted a using (student_key, exam_code, subject)
  where c.exam_code = p_exam and exists (select 1 from guard)
),
totals as (  -- 과목별 총점과 전체 집단 내 순위
  select student_key, subject,
         sum(case when is_correct then points else 0 end) as total,
         percent_rank() over (partition by subject
                              order by sum(case when is_correct then points else 0 end)) as pr
  from base group by student_key, subject
),
joined as (
  select b.*, t.total, t.pr from base b join totals t using (student_key, subject)
)
select
  j.subject, j.q_no, max(j.q_type), max(j.points), max(j.unit),
  count(*)::int,
  count(*) filter (where j.is_correct)::int,
  round(avg(j.is_correct::int)::numeric, 4),
  round(avg((btrim(coalesce(j.marked, '')) = '')::int)::numeric, 4),
  round(corr(j.is_correct::int, j.total)::numeric, 4),          -- 점이연상관
  round((avg(j.is_correct::int) filter (where j.pr >= 0.73)
       - avg(j.is_correct::int) filter (where j.pr <= 0.27))::numeric, 4),
  count(*) filter (where j.school_code = my_school())::int,
  count(*) filter (where j.school_code = my_school() and j.is_correct)::int,
  round(avg(j.is_correct::int) filter (where j.school_code = my_school())::numeric, 4)
from joined j
group by j.subject, j.q_no
order by j.subject, j.q_no
$$;
revoke execute on function exam_item_stats(text) from anon;

-- 오답지 매력도. 상위 집단이 특정 오답에 몰리는 문항이 출제·수업 개선에서 가장 값지다.
create or replace function exam_distractors(p_exam text, p_subject text)
returns table (
  q_no int, choice text, is_answer boolean,
  n_all int, rate_all numeric, rate_high numeric, rate_low numeric
)
language sql stable security definer set search_path = public as $$
with guard as (
  select 1 from exams e where e.exam_code = p_exam and e.is_open and auth.uid() is not null
),
base as (
  select c.* from scored c
  join attempted a using (student_key, exam_code, subject)
  where c.exam_code = p_exam and c.subject = p_subject
    and c.q_type = 'MC' and exists (select 1 from guard)
),
totals as (
  select student_key,
         percent_rank() over (order by sum(case when is_correct then points else 0 end)) as pr
  from base group by student_key
),
joined as (select b.*, t.pr from base b join totals t using (student_key)),
per_q as (select q_no, count(*) as n, count(*) filter (where pr >= 0.73) as n_hi,
                 count(*) filter (where pr <= 0.27) as n_lo
          from joined group by q_no)
select
  j.q_no,
  coalesce(nullif(btrim(j.marked), ''), '무응답'),
  bool_or(j.is_correct),
  count(*)::int,
  round(count(*)::numeric / max(p.n), 4),
  round(count(*) filter (where j.pr >= 0.73)::numeric / nullif(max(p.n_hi), 0), 4),
  round(count(*) filter (where j.pr <= 0.27)::numeric / nullif(max(p.n_lo), 0), 4)
from joined j join per_q p using (q_no)
group by j.q_no, coalesce(nullif(btrim(j.marked), ''), '무응답')
order by j.q_no, 2
$$;
revoke execute on function exam_distractors(text, text) from anon;

-- 학교 요약: 과목별 평균과 전체 평균 대비 위치
create or replace function exam_school_summary(p_exam text)
returns table (
  subject text, my_takers int, my_mean numeric, my_sd numeric,
  all_takers int, all_mean numeric, all_sd numeric, gap numeric
)
language sql stable security definer set search_path = public as $$
with guard as (
  select 1 from exams e where e.exam_code = p_exam and e.is_open and auth.uid() is not null
),
s as (
  select ss.* from student_scores ss
  where ss.exam_code = p_exam and exists (select 1 from guard)
)
select
  subject,
  count(*) filter (where school_code = my_school())::int,
  round(avg(raw_score) filter (where school_code = my_school()), 2),
  round(stddev_samp(raw_score) filter (where school_code = my_school()), 2),
  count(*)::int,
  round(avg(raw_score), 2),
  round(stddev_samp(raw_score), 2),
  round(avg(raw_score) filter (where school_code = my_school()) - avg(raw_score), 2)  -- 전체 평균 대비
from s group by subject order by subject
$$;
revoke execute on function exam_school_summary(text) from anon;

-- student_scores / scored 는 뷰이므로 RLS는 밑단 테이블에서 그대로 적용된다.
-- (security_invoker=true 확인용)
do $$
declare bad text;
begin
  select string_agg(c.relname, ', ') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'v'
    and coalesce((select option_value from pg_options_to_table(c.reloptions)
                  where option_name = 'security_invoker'), 'false') <> 'true';
  assert bad is null, 'security_invoker가 꺼진 뷰: ' || bad;
  raise notice '뷰 OK — 모든 뷰가 호출자 권한으로 동작';
end $$;

-- ── 우리 학교 상세 (리포트용) ───────────────────────
-- 뷰를 브라우저에서 직접 조회하면 행마다 RLS가 걸려 3만 행에서 타임아웃이 난다.
-- 함수로 감싸 학교 필터를 한 번만 적용한다. 반환은 여전히 자기 학교 것뿐이다.
create index if not exists submissions_school_exam on submissions (school_code, exam_code, subject) where is_active;

create or replace function my_scores(p_exam text)
returns table (grade int, class_no int, student_no int, subject text,
               raw_score numeric, n_correct int, n_items int)
language sql stable security definer set search_path = public as $$
  select ss.grade, ss.class_no, ss.student_no, ss.subject,
         ss.raw_score, ss.n_correct::int, ss.n_items::int
  from student_scores ss
  where ss.exam_code = p_exam and ss.school_code = (select my_school())
    and exists (select 1 from exams e where e.exam_code = p_exam and e.is_open and auth.uid() is not null)
  order by ss.grade, ss.class_no, ss.student_no, ss.subject
$$;
revoke execute on function my_scores(text) from anon;

create or replace function my_marks(p_exam text)
returns table (subject text, grade int, class_no int, student_no int, q_no int,
               marked text, is_correct boolean)
language sql stable security definer set search_path = public as $$
  select c.subject, c.grade, c.class_no, c.student_no, c.q_no, c.marked, c.is_correct
  from scored c
  join attempted a using (student_key, exam_code, subject)
  where c.exam_code = p_exam and c.school_code = (select my_school())
    and exists (select 1 from exams e where e.exam_code = p_exam and e.is_open and auth.uid() is not null)
  order by c.subject, c.grade, c.class_no, c.student_no, c.q_no
$$;
revoke execute on function my_marks(text) from anon;
