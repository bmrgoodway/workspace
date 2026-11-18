-- 별무리 워크스페이스 — 읽음 표시(채널별 마지막으로 본 메시지) (2026-11-14)
--
-- 채널·DM 목록의 안 읽은 개수 배지에 씁니다.
-- 브라우저는 읽지도 쓰지도 않고(권한 없음), 서버 함수 workspace-fn 이
--   GET  /messages  → 채널별 안 읽은 수
--   POST /channels/read → 지금 본 데까지 읽음 처리
-- 로만 다룹니다. 함수가 스스로 만들기 때문에 꼭 실행하지 않아도 됩니다.

create table if not exists workspace.channel_reads (
  user_id uuid not null,
  channel_id bigint not null references workspace.channels(id) on delete cascade,
  last_read_id bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, channel_id)
);
comment on table workspace.channel_reads is '사람×채널별 마지막으로 본 메시지 번호. 숫자보다 큰 메시지가 안 읽은 것이다.';

alter table workspace.channel_reads enable row level security;
revoke all on workspace.channel_reads from anon, authenticated;
