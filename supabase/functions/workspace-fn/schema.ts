// workspace-fn 이 처음 살아날 때(콜드 스타트) 스스로 표를 만듭니다.
// supabase/migrations/202611140001_workspace_init.sql 과 같은 내용입니다 —
// 마이그레이션을 손으로 돌리지 않아도 앱이 바로 동작하게 하려는 안전장치예요.
// 함수는 표 주인 권한(workspace_fn ← workspace_dev)으로 접속하므로 만들 수 있습니다.

export const DDL: string[] = [
  `create table if not exists workspace.members (
    user_id uuid primary key,
    email text unique not null check (email = lower(email)),
    name text not null default '',
    role text not null default 'member' check (role in ('member', 'admin')),
    avatar_color text,
    created_at timestamptz not null default now(),
    last_seen_at timestamptz
  )`,

  `create table if not exists workspace.channels (
    id bigint generated always as identity primary key,
    slug text unique,
    name text not null check (char_length(name) between 1 and 60),
    kind text not null default 'channel' check (kind in ('channel', 'dm', 'ai')),
    description text not null default '' check (char_length(description) <= 300),
    dm_key text unique,
    created_by uuid,
    created_at timestamptz not null default now()
  )`,

  `create table if not exists workspace.channel_members (
    channel_id bigint not null references workspace.channels(id) on delete cascade,
    user_id uuid not null,
    primary key (channel_id, user_id)
  )`,

  `create table if not exists workspace.messages (
    id bigint generated always as identity primary key,
    channel_id bigint not null references workspace.channels(id) on delete cascade,
    parent_id bigint references workspace.messages(id) on delete cascade,
    user_id uuid,
    author_name text not null check (char_length(author_name) between 1 and 80),
    author_kind text not null default 'user' check (author_kind in ('user', 'ai')),
    content text not null default '' check (char_length(content) <= 8000),
    attachments jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now(),
    constraint messages_body_check check (char_length(content) > 0 or jsonb_array_length(attachments) > 0)
  )`,

  `create index if not exists messages_channel_idx on workspace.messages (channel_id, id)`,
  `create index if not exists messages_parent_idx on workspace.messages (parent_id, id) where parent_id is not null`,

  // ---------- 사진·파일 첨부 (이미 있는 표에도 더한다) ----------
  // 파일 자체는 Storage 버킷 'workspace' 에 <내 아이디>/<시각>-<무작위>.<확장자> 로 올리고,
  // 여기에는 [{ path, name, mime, size }] 만 적는다 (한글 파일 이름은 여기에만, 경로에는 쓰지 않는다).
  `alter table workspace.messages add column if not exists attachments jsonb not null default '[]'::jsonb`,
  // 글 없이 사진·파일만 보내는 메시지를 위해 '1자 이상' 조건을 '0자 이상'으로 바꾼다 (내용은 함수가 확인).
  // 조건 이름이 다를 수 있으니 **정의를 보고** 1자 이상을 요구하는 조건을 모두 지운 뒤 새로 건다.
  `do $$
   declare c record;
   begin
     for c in select conname from pg_constraint
               where conrelid = 'workspace.messages'::regclass and contype = 'c'
                 and pg_get_constraintdef(oid) like '%char_length(content)%'
                 and pg_get_constraintdef(oid) like '%>= 1%'
     loop
       execute format('alter table workspace.messages drop constraint %I', c.conname);
     end loop;
   end $$`,
  `do $$ begin
     if not exists (select 1 from pg_constraint
        where conrelid = 'workspace.messages'::regclass and conname = 'messages_content_check') then
       alter table workspace.messages add constraint messages_content_check check (char_length(content) <= 8000);
     end if;
   end $$`,
  `do $$ begin
     if not exists (select 1 from pg_constraint
        where conrelid = 'workspace.messages'::regclass and conname = 'messages_body_check') then
       alter table workspace.messages add constraint messages_body_check
         check (char_length(content) > 0 or jsonb_array_length(attachments) > 0);
     end if;
   end $$`,
  `comment on column workspace.messages.attachments is '첨부 목록 [{path,name,mime,size}]. path 는 Storage 버킷 workspace 안의 <올린 사람 아이디>/… 경로(영문), name 은 원래 파일 이름.'`,

  `create or replace function workspace.is_member() returns boolean
   language sql stable security definer set search_path = '' as $$
     select exists (select 1 from workspace.members m where m.user_id = (select bmr.uid()))
   $$`,

  `create or replace function workspace.is_channel_member(cid bigint) returns boolean
   language sql stable security definer set search_path = '' as $$
     select exists (select 1 from workspace.channel_members cm where cm.channel_id = cid and cm.user_id = (select bmr.uid()))
   $$`,

  `create or replace function workspace.can_read_channel(cid bigint) returns boolean
   language sql stable security definer set search_path = '' as $$
     select exists (
       select 1 from workspace.channels c
       where c.id = cid
         and exists (select 1 from workspace.members m where m.user_id = (select bmr.uid()))
         and (c.kind = 'channel'
           or exists (select 1 from workspace.channel_members cm where cm.channel_id = c.id and cm.user_id = (select bmr.uid())))
     )
   $$`,

  `alter table workspace.members enable row level security`,
  `alter table workspace.channels enable row level security`,
  `alter table workspace.channel_members enable row level security`,
  `alter table workspace.messages enable row level security`,

  `drop policy if exists "멤버끼리 보기" on workspace.members`,
  `create policy "멤버끼리 보기" on workspace.members for select to authenticated
     using ((select workspace.is_member()))`,

  `drop policy if exists "볼 수 있는 채널만" on workspace.channels`,
  `create policy "볼 수 있는 채널만" on workspace.channels for select to authenticated
     using ((select workspace.is_member()) and (kind = 'channel' or (select workspace.is_channel_member(id))))`,

  `drop policy if exists "내가 든 채널만" on workspace.channel_members`,
  `create policy "내가 든 채널만" on workspace.channel_members for select to authenticated
     using ((select workspace.is_member()) and user_id = (select bmr.uid()))`,

  `drop policy if exists "볼 수 있는 채널의 메시지만" on workspace.messages`,
  `create policy "볼 수 있는 채널의 메시지만" on workspace.messages for select to authenticated
     using ((select workspace.can_read_channel(channel_id)))`,

  `grant usage on schema workspace to authenticated, anon`,
  `grant select on workspace.members, workspace.channels, workspace.channel_members, workspace.messages to authenticated`,

  // ---------- 알림(Web Push) — 브라우저는 읽지도 쓰지도 않고, 함수만 다룬다 ----------
  `create table if not exists workspace.push_subscriptions (
    id bigint generated always as identity primary key,
    user_id uuid not null,
    endpoint text unique not null,
    p256dh text not null,
    auth text not null,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists push_subscriptions_user_idx on workspace.push_subscriptions (user_id)`,
  `create table if not exists workspace.push_config (
    id int primary key default 1,
    public_key text not null,
    private_jwk jsonb not null,
    subject text not null
  )`,
  `alter table workspace.push_subscriptions enable row level security`,
  `alter table workspace.push_config enable row level security`,

  // ---------- 읽음 표시 — 채널별로 마지막으로 본 메시지 번호 (함수만 읽고 쓴다) ----------
  `create table if not exists workspace.channel_reads (
    user_id uuid not null,
    channel_id bigint not null references workspace.channels(id) on delete cascade,
    last_read_id bigint not null default 0,
    updated_at timestamptz not null default now(),
    primary key (user_id, channel_id)
  )`,
  `alter table workspace.channel_reads enable row level security`,

  // ---------- 봇 API · MCP 연동 열쇠 — 함수만 읽고 쓴다 (브라우저에는 권한 없음) ----------
  // Alter(피클)·Cursor 같은 도구가 공개 채널을 읽고 쓰는 열쇠. 원문은 저장하지 않고 SHA-256 해시만 둔다.
  `create table if not exists workspace.bot_tokens (
    id bigint generated always as identity primary key,
    name text not null check (char_length(name) between 1 and 60),
    token_prefix text not null check (char_length(token_prefix) between 4 and 40),
    token_hash text unique not null check (char_length(token_hash) = 64),
    created_by uuid not null,
    created_at timestamptz not null default now(),
    last_used_at timestamptz,
    revoked_at timestamptz
  )`,
  `create index if not exists bot_tokens_hash_idx on workspace.bot_tokens (token_hash)`,
  `comment on table workspace.bot_tokens is '봇 API·MCP 연동 열쇠. 원문은 저장하지 않고 SHA-256 해시(token_hash)만 둡니다. 폐기는 revoked_at 을 채웁니다.'`,
  `alter table workspace.bot_tokens enable row level security`,
  `revoke all on workspace.bot_tokens from anon, authenticated`,

  // ---------- 관리자 콘솔 (멤버 차단 · 외부 초대 · 공지 고정) ----------
  // 화면 오른쪽 위 🛠️ 관리 에서 씁니다. 마이그레이션 202611150001_workspace_admin.sql 과 같은 내용입니다.
  `alter table workspace.members add column if not exists disabled_at timestamptz`,
  `comment on column workspace.members.disabled_at is '관리자가 접근을 막은 시각. 값이 있으면 함수가 403 으로 돌려보냅니다. 비우면 다시 들어올 수 있습니다.'`,
  // 바깥 선생님·강사는 이 표에 미리 넣어 두면 그 구글 계정으로 처음 로그인할 때 멤버가 됩니다 (한 번 쓰면 지움).
  `create table if not exists workspace.invites (
    email text primary key check (email = lower(email) and char_length(email) between 3 and 200),
    name text not null default '' check (char_length(name) <= 40),
    role text not null default 'member' check (role in ('member', 'admin')),
    invited_by uuid,
    created_at timestamptz not null default now()
  )`,
  `comment on table workspace.invites is '관리자가 미리 초대한 메일. 이 메일로 처음 로그인하면 workspace.members 에 초대한 역할로 등록하고 이 줄을 지웁니다.'`,
  // 초대 목록은 관리자 화면(함수)만 읽습니다 — 브라우저에는 권한을 주지 않는다.
  `alter table workspace.invites enable row level security`,
  `revoke all on workspace.invites from anon, authenticated`,
  // 공지 고정: 그 메시지가 지워지면 자동으로 비워진다 (on delete set null)
  `alter table workspace.channels
     add column if not exists pinned_message_id bigint references workspace.messages(id) on delete set null`,
  `comment on column workspace.channels.pinned_message_id is '채널 위에 공지로 고정한 메시지. 지워지면 자동으로 비워집니다. 공개 채널(kind=channel)만 씁니다.'`,
  `create index if not exists channels_pinned_idx on workspace.channels (pinned_message_id) where pinned_message_id is not null`,

  // 실시간 구독용 (프로젝트 설정에 따라 권한이 없을 수 있음 — 실패해도 앱은 폴링으로 동작)
  `do $$ begin
     alter publication supabase_realtime add table workspace.messages;
   exception when others then null; end $$`,
  `do $$ begin
     alter publication supabase_realtime add table workspace.channels;
   exception when others then null; end $$`,
];

// 기본 채널 — 콜드 스타트마다 한 번(이미 있으면 그대로 둠)
export const SEED_CHANNELS = `insert into workspace.channels (slug, name, kind, description) values
  ('general',     '일반',      'channel', '모두에게 알리는 이야기'),
  ('class-share', '수업-나눔', 'channel', '수업 아이디어와 자료를 나눠요'),
  ('ai-lounge',   'AI-라운지', 'channel', '@AI 를 부르면 Alter 가 답글을 달아 줘요')
on conflict (slug) do nothing`;

/** 빠른 확인: 핵심 표가 이미 있는지 (있으면 DDL 을 건너뛴다) */
export const CHECK_TABLES = `select
  to_regclass('workspace.members')            is not null as members,
  to_regclass('workspace.channels')           is not null as channels,
  to_regclass('workspace.messages')           is not null as messages,
  to_regclass('workspace.push_subscriptions') is not null as push,
  to_regclass('workspace.push_config')        is not null as push_config,
  to_regclass('workspace.channel_reads')      is not null as reads,
  exists (select 1 from information_schema.columns
     where table_schema = 'workspace' and table_name = 'messages' and column_name = 'attachments') as attachments,
  not exists (select 1 from pg_constraint
     where conrelid = 'workspace.messages'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%char_length(content)%'
       and pg_get_constraintdef(oid) like '%>= 1%') as attach_ok,
  exists (select 1 from pg_constraint
     where conrelid = 'workspace.messages'::regclass and conname = 'messages_body_check') as body_check,
  to_regclass('workspace.bot_tokens') is not null as bot_tokens,
  exists (select 1 from information_schema.columns
     where table_schema = 'workspace' and table_name = 'members' and column_name = 'disabled_at') as member_disabled,
  to_regclass('workspace.invites') is not null as invites,
  exists (select 1 from information_schema.columns
     where table_schema = 'workspace' and table_name = 'channels' and column_name = 'pinned_message_id') as channel_pin`;
