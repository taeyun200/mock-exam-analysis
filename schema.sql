-- 도 단위 모의고사 수집·분석 시스템 — 스키마
-- Supabase SQL Editor에 통째로 붙여넣어 실행.

create table schools (
  school_code text primary key,            -- NEIS 표준학교코드
  school_name text not null,
  district    text,
  is_active   boolean not null default true
);

create table exams (
  exam_code text primary key,              -- '2026-09'
  exam_name text not null,
  exam_date date,
  grade     int,
  is_open   boolean not null default false -- false: 제출만 가능 / true: 정답·리포트 열람 개방
);

-- auth.users ↔ 학교 매핑. 운영자가 대시보드에서 계정 생성 후 여기에 한 줄 넣는다.
create table profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  school_code  text references schools(school_code),
  role         text not null default 'teacher' check (role in ('teacher','admin')),
  display_name text
);

-- 문항 수·배점의 유일한 진실의 원천
create table answer_keys (
  exam_code text not null references exams(exam_code) on delete cascade,
  subject   text not null,
  q_no      int  not null,
  answer    text not null,                 -- '3' | '047' | '1|3'(복수정답) | '*'(전항정답)
  points    numeric not null check (points > 0),
  q_type    text not null default 'MC' check (q_type in ('MC','SA')),
  unit      text,
  primary key (exam_code, subject, q_no)
);

create table submissions (
  id           uuid primary key default gen_random_uuid(),
  exam_code    text not null references exams(exam_code),
  school_code  text not null references schools(school_code),
  subject      text not null,
  submitted_at timestamptz not null default now(),
  submitted_by uuid references auth.users(id) default auth.uid(),
  row_count    int,
  is_active    boolean not null default true
);

-- 재제출 시 이전 건을 먼저 내리지 않으면 INSERT가 거부된다 (조용한 덮어쓰기 방지)
create unique index submissions_one_active
  on submissions (exam_code, school_code, subject) where is_active;

-- 원답안. school_code/exam_code/subject는 submission_id가 결정하므로 중복 저장하지 않는다.
create table responses (
  submission_id uuid not null references submissions(id) on delete cascade,
  grade         int  not null,
  class_no      int  not null,
  student_no    int  not null,
  q_no          int  not null,
  marked        text,                      -- NULL/'' = 무응답
  primary key (submission_id, grade, class_no, student_no, q_no)
);

-- 과목명은 6과목 고정(2022 개정, 선택과목 없음). 오타 유입 차단.
alter table answer_keys add constraint answer_keys_subject_chk
  check (subject in ('국어','영어','수학','사회','과학','한국사'));
alter table submissions add constraint submissions_subject_chk
  check (subject in ('국어','영어','수학','사회','과학','한국사'));
