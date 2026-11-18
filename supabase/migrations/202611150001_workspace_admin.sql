-- 별무리 워크스페이스 — 관리자 콘솔 (2026-11-15)
--
-- 화면 오른쪽 위 🛠️ 관리 에서 쓰는 표·칸입니다.
--   · 멤버 차단(disabled_at) · 외부 메일 초대(workspace.invites) · 채널 공지 고정(pinned_message_id)
-- 서버 함수 workspace-fn 이 처음 살아날 때 같은 내용을 스스로 만들기 때문에(schema.ts 의 DDL),
-- 이 파일을 꼭 실행하지 않아도 앱은 동작합니다. 손으로 돌릴 때는 npm run db:migrate.

-- ---------- 멤버: 관리자가 접근을 막은 시각 ----------
-- 값이 있으면 함수(memberFor)가 그 계정을 403 '관리자에 의해 접근이 제한된 계정입니다.' 로 돌려보냅니다.
-- 표에서 지우지 않고 이 칸만 채워서, 나중에 '차단 해제'로 되돌릴 수 있게 합니다.
alter table workspace.members add column if not exists disabled_at timestamptz;
comment on column workspace.members.disabled_at is '관리자가 접근을 막은 시각. 값이 있으면 함수가 403 으로 돌려보냅니다. 비우면 다시 들어올 수 있습니다.';

-- ---------- 초대: 아직 로그인하지 않은 메일 ----------
-- 학교 메일(@bmrschool.org/.net)은 처음 로그인할 때 자동으로 멤버가 되지만,
-- 바깥 선생님·강사는 이 표에 미리 넣어 두면 그 구글 계정으로 처음 로그인할 때 멤버로 등록됩니다.
-- 등록되면 이 줄은 지웁니다 (초대는 한 번만 쓰입니다).
create table if not exists workspace.invites (
  email text primary key check (email = lower(email) and char_length(email) between 3 and 200),
  name text not null default '' check (char_length(name) <= 40),
  role text not null default 'member' check (role in ('member', 'admin')),
  invited_by uuid,
  created_at timestamptz not null default now()
);
comment on table workspace.invites is '관리자가 미리 초대한 메일. 이 메일로 처음 로그인하면 workspace.members 에 초대한 역할로 등록하고 이 줄을 지웁니다.';

-- 초대 목록은 관리자 화면(함수)만 읽습니다 — 브라우저에는 권한을 주지 않습니다.
alter table workspace.invites enable row level security;
revoke all on workspace.invites from anon, authenticated;

-- ---------- 채널: 위에 공지로 고정한 메시지 ----------
-- 그 메시지가 지워지면 자동으로 비워집니다(on delete set null).
alter table workspace.channels
  add column if not exists pinned_message_id bigint references workspace.messages(id) on delete set null;
comment on column workspace.channels.pinned_message_id is '채널 위에 공지로 고정한 메시지. 지워지면 자동으로 비워집니다. 공개 채널(kind=channel)만 씁니다.';
create index if not exists channels_pinned_idx
  on workspace.channels (pinned_message_id) where pinned_message_id is not null;
