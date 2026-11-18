-- 별무리 워크스페이스 — 사진·파일 첨부 (2026-11-14)
--
-- 파일 자체는 Storage 버킷 'workspace' 에 올리고, 메시지에는 목록만 적습니다.
--   올리는 경로: <내 아이디>/<시각>-<무작위 8자>.<확장자>   ← 한글·공백 없이 (경로 규칙)
--   원래 파일 이름·종류·크기는 여기(attachments)에만 적습니다.
--   [{ "path": "3f2a…/1763…-a1b2c3d4.png", "name": "수업 사진.png", "mime": "image/png", "size": 48213 }]
--
-- 버킷 정책(BMR APPS 가 앱을 만들 때 넣어 둔 것):
--   workspace: 로그인 사용자 읽기 → 로그인한 사람은 이 버킷의 파일을 모두 읽을 수 있다(비공개 버킷, 서명 주소 필요)
--   workspace: 내 폴더에 올리기 → <내 아이디>/… 에만 올릴 수 있다
--   workspace: 내 파일 바꾸기·지우기 → 자기가 올린 파일만
-- 그래서 채널 멤버는 다른 사람이 올린 사진도 createSignedUrl 로 볼 수 있습니다 (서명 주소는 1시간).
-- 파일 정책 자체는 개발자 계정으로 바꿀 수 없습니다(관리자 권한).
--
-- 서버 함수가 처음 살아날 때 같은 내용을 스스로 확인·적용하기 때문에(ensureSchema),
-- 이 파일을 꼭 실행하지 않아도 앱은 동작합니다. 손으로 돌릴 때는 npm run db:migrate.

alter table workspace.messages
  add column if not exists attachments jsonb not null default '[]'::jsonb;

comment on column workspace.messages.attachments is
  '첨부 목록 [{path,name,mime,size}]. path 는 Storage 버킷 workspace 안의 <올린 사람 아이디>/… 경로(영문), name 은 원래 파일 이름.';

-- 글 없이 사진·파일만 보내는 메시지도 허용한다.
-- (원래 inline 조건 char_length(content) between 1 and 8000 → 0자 이상으로 바꾸고,
--  '글이 있거나 첨부가 있거나'는 표 수준 조건으로 확인한다. 조건 이름이 다를 수 있어
--  정의를 보고 1자 이상을 요구하는 조건을 모두 지운 뒤 다시 건다.)
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'workspace.messages'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%char_length(content)%'
              and pg_get_constraintdef(oid) like '%>= 1%'
  loop
    execute format('alter table workspace.messages drop constraint %I', c.conname);
  end loop;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint
     where conrelid = 'workspace.messages'::regclass and conname = 'messages_content_check') then
    alter table workspace.messages add constraint messages_content_check check (char_length(content) <= 8000);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint
     where conrelid = 'workspace.messages'::regclass and conname = 'messages_body_check') then
    alter table workspace.messages add constraint messages_body_check
      check (char_length(content) > 0 or jsonb_array_length(attachments) > 0);
  end if;
end $$;
