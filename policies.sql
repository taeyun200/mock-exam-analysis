-- RLS 정책. schema.sql 실행 후 붙여넣는다.
-- 원칙: 선생님은 자기 학교 것만, 정답표는 회차 개방 후에만, 운영자는 전부.

-- 재실행 가능하도록 기존 정책을 먼저 모두 제거한다.
-- 주의: public 스키마의 정책을 전부 지운다. 이 프로젝트 전용 DB에서만 쓸 것.
do $$
declare p record;
begin
  for p in select policyname, tablename from pg_policies where schemaname = 'public'
  loop execute format('drop policy %I on public.%I', p.policyname, p.tablename); end loop;
end $$;

-- security definer = RLS를 우회해 profiles를 읽는다. 정책 안에서 쓰므로 재귀가 없다.
create or replace function my_school() returns text
  language sql stable security definer set search_path = public as
  $$ select school_code from profiles where user_id = auth.uid() $$;

create or replace function is_admin() returns boolean
  language sql stable security definer set search_path = public as
  $$ select exists (select 1 from profiles where user_id = auth.uid() and role = 'admin') $$;

alter table schools     enable row level security;
alter table exams       enable row level security;
alter table profiles    enable row level security;
alter table answer_keys enable row level security;
alter table submissions enable row level security;
alter table responses   enable row level security;

-- 학교·회차 목록: 로그인한 사람은 읽기만. 쓰기는 운영자.
create policy read  on schools for select using (auth.role() = 'authenticated');
create policy admin on schools for all using (is_admin()) with check (is_admin());
create policy read  on exams   for select using (auth.role() = 'authenticated');
create policy admin on exams   for all using (is_admin()) with check (is_admin());

-- 자기 프로필만. 학교 배정 변경은 운영자만.
create policy self  on profiles for select using (user_id = auth.uid());
create policy admin on profiles for all using (is_admin()) with check (is_admin());

-- 정답표: 회차가 개방된 뒤에만 보인다. 시험 전 유출 차단.
create policy read_when_open on answer_keys for select using (
  exists (select 1 from exams e where e.exam_code = answer_keys.exam_code and e.is_open)
);
create policy admin on answer_keys for all using (is_admin()) with check (is_admin());

-- 제출: 자기 학교 것만 읽고, 마감 전(is_open = false)에만 새로 넣는다.
create policy read_own on submissions for select using (school_code = my_school());
create policy insert_own on submissions for insert with check (
  school_code = my_school()
  and exists (select 1 from exams e where e.exam_code = submissions.exam_code and not e.is_open)
);
-- 재제출 시 이전 건을 내리기 위한 UPDATE. 마감 전에만.
create policy update_own on submissions for update using (
  school_code = my_school()
  and exists (select 1 from exams e where e.exam_code = submissions.exam_code and not e.is_open)
);
create policy admin on submissions for all using (is_admin()) with check (is_admin());

-- 원답안: 소속 제출 건을 통해 권한을 판정한다.
-- ponytail: 행마다 서브쿼리. 수백 명 규모에선 문제없고, 만 명대로 커지면 적재를 RPC로 옮긴다.
create policy read_own on responses for select using (
  exists (select 1 from submissions s where s.id = responses.submission_id and s.school_code = my_school())
);
create policy insert_own on responses for insert with check (
  exists (
    select 1 from submissions s join exams e on e.exam_code = s.exam_code
    where s.id = responses.submission_id and s.school_code = my_school() and not e.is_open
  )
);
create policy admin on responses for all using (is_admin()) with check (is_admin());

-- 적용 확인: RLS가 안 걸린 테이블이 하나라도 있으면 실패한다.
do $$
declare unprotected text;
begin
  select string_agg(relname, ', ') into unprotected
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  assert unprotected is null, 'RLS 미적용 테이블: ' || unprotected;
  raise notice 'RLS OK — 모든 public 테이블 보호됨';
end $$;
