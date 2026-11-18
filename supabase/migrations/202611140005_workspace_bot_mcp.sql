-- 별무리 워크스페이스 — 봇 API · MCP 연동 열쇠 (2026-11-14)
--
-- Alter(피클)·Cursor 같은 바깥 도구가 이 워크스페이스의 **공개 채널(kind='channel')** 을 읽고 글을 쓸 수 있게
-- 열쇠를 발급합니다. DM·AI 방은 열지 않습니다(1:1 대화 보호).
--
-- 열쇠 원문은 어디에도 저장하지 않습니다. SHA-256 해시만 두고, 발급할 때 한 번만 화면에 보여 줍니다.
--   예) bmrws_2f9c…  →  token_prefix = 'bmrws_2f9c1a' (화면 표시용),  token_hash = sha256(원문)
--
-- 이 표는 서버 함수(workspace_fn)만 읽고 씁니다. 브라우저(anon·authenticated)에는 아무 권한도 주지 않습니다.
-- (아래 revoke 는 혹시 예전에 권한이 붙어 있어도 확실히 떼기 위한 것입니다.)
--
-- 서버 함수가 처음 살아날 때 같은 내용을 스스로 확인·적용하기 때문에(ensureSchema, schema.ts),
-- 이 파일을 꼭 실행하지 않아도 앱은 동작합니다. 손으로 돌릴 때는 npm run db:migrate.

create table if not exists workspace.bot_tokens (
  id bigint generated always as identity primary key,
  name text not null check (char_length(name) between 1 and 60),
  token_prefix text not null check (char_length(token_prefix) between 4 and 40),
  token_hash text unique not null check (char_length(token_hash) = 64),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index if not exists bot_tokens_hash_idx on workspace.bot_tokens (token_hash);

comment on table workspace.bot_tokens is
  '봇 API·MCP 연동 열쇠. 원문은 저장하지 않고 SHA-256 해시(token_hash)만 둡니다. 폐기는 revoked_at 을 채웁니다.';

alter table workspace.bot_tokens enable row level security;
revoke all on workspace.bot_tokens from anon, authenticated;
