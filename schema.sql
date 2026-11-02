-- 도 단위 모의고사 수집·분석 시스템 — D1(SQLite) 스키마
-- 적용: wrangler d1 execute mock-exam --remote --file=schema.sql
--
-- 채점 결과·통계는 저장하지 않는다. 원답안과 정답표만 두고 src/scoring.js가 매번 계산한다.
-- 권한(자기 학교만 보기)은 RLS 대신 src/worker.js가 모든 쿼리에 school_code를 붙여서 지킨다.

create table if not exists schools (
  school_code text primary key,            -- NEIS 표준학교코드
  school_name text not null,
  district    text,
  is_active   integer not null default 1
);

create table if not exists exams (
  exam_code text primary key,              -- '2026-09'
  exam_name text not null,
  exam_date text,                          -- 'YYYY-MM-DD'
  is_open   integer not null default 0     -- 0: 제출만 가능 / 1: 정답·리포트 열람 개방
);

-- 로그인 계정. 학교 하나에 ID 하나가 기본. 운영자가 admin.html에서 만든다 (첫 운영자는 account.js).
create table if not exists accounts (
  login_id      text primary key,          -- 영문·숫자·_·- 2~30자
  password_hash text not null,             -- 'salt:pbkdf2' (src/auth.js)
  school_code   text references schools(school_code),
  role          text not null default 'school' check (role in ('school','admin'))
);

-- 문항 수·배점의 유일한 진실의 원천. 같은 회차라도 학년마다 시험지가 다르므로 학년이 키에 들어간다.
create table if not exists answer_keys (
  exam_code text not null references exams(exam_code) on delete cascade,
  grade     integer not null check (grade in (1, 2, 3)),
  subject   text not null check (subject in ('국어','영어','수학','사회','과학','한국사')),
  q_no      integer not null,
  answer    text not null,                 -- '3' | '047' | '1|3'(복수정답) | '*'(전항정답)
  points    real not null check (points > 0),
  q_type    text not null default 'MC' check (q_type in ('MC','SA')),
  unit      text,
  primary key (exam_code, grade, subject, q_no)
);

create table if not exists submissions (
  id           text primary key,           -- uuid
  exam_code    text not null references exams(exam_code),
  school_code  text not null references schools(school_code),
  grade        integer not null check (grade in (1, 2, 3)),   -- 제출 파일의 학년 열로 자동 분할된다
  subject      text not null check (subject in ('국어','영어','수학','사회','과학','한국사')),
  submitted_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  submitted_by text,                       -- login_id
  row_count    integer,
  is_active    integer not null default 1
);

-- 재제출 시 이전 건을 먼저 내리지 않으면 INSERT가 거부된다 (조용한 덮어쓰기 방지)
create unique index if not exists submissions_one_active
  on submissions (exam_code, school_code, grade, subject) where is_active = 1;
create index if not exists submissions_exam on submissions (exam_code, is_active);

-- 원답안. school_code/exam_code/subject는 submission_id가 결정하므로 중복 저장하지 않는다.
create table if not exists responses (
  submission_id text not null references submissions(id) on delete cascade,
  grade         integer not null,
  class_no      integer not null,
  student_no    integer not null,
  q_no          integer not null,
  marked        text,                      -- NULL/'' = 무응답
  primary key (submission_id, grade, class_no, student_no, q_no)
) without rowid;

