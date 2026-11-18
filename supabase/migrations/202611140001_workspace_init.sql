-- 별무리 워크스페이스 — 표·권한·RLS (2026-11-14)
--
-- 슬랙처럼 쓰는 교내 워크스페이스입니다. 브라우저는 **읽기만** 하고,
-- 쓰기(메시지·채널)는 서버 함수 workspace-fn 이 표 주인 권한으로 합니다.
-- 누가 무엇을 쓸 수 있는지는 함수 코드에서 직접 확인합니다.
-- 그래서 RLS 는 "볼 수 있는 행"만 정합니다.
--
-- · 로그인 계정(auth.users)은 BMR APPS 전체가 함께 쓰므로, 이 앱 사람은 workspace.members 로 따로 관리합니다.
-- · auth.uid() 대신 bmr.uid() 를 씁니다 (개발자 DB 계정은 auth 스키마 권한이 없음).
-- · 서버 함수가 처음 살아날 때 같은 구조를 스스로 만들기 때문에(ensureSchema),
--   이 파일을 꼭 실행하지 않아도 앱은 동작합니다. 손으로 돌릴 때는 npm run db:migrate.

-- ---------- 멤버 ----------
create table if not exists workspace.members (
  user_id uuid primary key,
  email text unique not null check (email = lower(email)),
  name text not null default '',
  role text not null default 'member' check (role in ('member', 'admin')),
  avatar_color text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);
comment on table workspace.members is '이 워크스페이스를 쓰는 사람. @bmrschool.* 메일로 로그인하면 서버 함수가 자동 등록합니다.';

-- ---------- 채널 (#채널 · 1:1 DM · 나만의 AI 방) ----------
create table if not exists workspace.channels (
  id bigint generated always as identity primary key,
  slug text unique,
  name text not null check (char_length(name) between 1 and 60),
  kind text not null default 'channel' check (kind in ('channel', 'dm', 'ai')),
  description text not null default '' check (char_length(description) <= 300),
  dm_key text unique,
  created_by uuid,
  created_at timestamptz not null default now()
);
comment on table workspace.channels is 'kind: channel(누구나) · dm(둘만) · ai(나만의 Alter 방)';

create table if not exists workspace.channel_members (
  channel_id bigint not null references workspace.channels(id) on delete cascade,
  user_id uuid not null,
  primary key (channel_id, user_id)
);

-- ---------- 메시지 (parent_id 가 있으면 스레드 답글) ----------
create table if not exists workspace.messages (
  id bigint generated always as identity primary key,
  channel_id bigint not null references workspace.channels(id) on delete cascade,
  parent_id bigint references workspace.messages(id) on delete cascade,
  user_id uuid,
  author_name text not null check (char_length(author_name) between 1 and 80),
  author_kind text not null default 'user' check (author_kind in ('user', 'ai')),
  content text not null check (char_length(content) between 1 and 8000),
  created_at timestamptz not null default now()
);
create index if not exists messages_channel_idx on workspace.messages (channel_id, id);
create index if not exists messages_parent_idx on workspace.messages (parent_id, id) where parent_id is not null;

-- ---------- 권한 도우미 (참/거짓만 돌려주는 security definer) ----------
create or replace function workspace.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from workspace.members m where m.user_id = (select bmr.uid()))
$$;

create or replace function workspace.is_channel_member(cid bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from workspace.channel_members cm where cm.channel_id = cid and cm.user_id = (select bmr.uid()))
$$;

create or replace function workspace.can_read_channel(cid bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from workspace.channels c
    where c.id = cid
      and exists (select 1 from workspace.members m where m.user_id = (select bmr.uid()))
      and (c.kind = 'channel'
        or exists (select 1 from workspace.channel_members cm where cm.channel_id = c.id and cm.user_id = (select bmr.uid())))
  )
$$;

-- ---------- RLS: 볼 수 있는 행만 ----------
alter table workspace.members enable row level security;
alter table workspace.channels enable row level security;
alter table workspace.channel_members enable row level security;
alter table workspace.messages enable row level security;

drop policy if exists "멤버끼리 보기" on workspace.members;
create policy "멤버끼리 보기" on workspace.members for select to authenticated
  using ((select workspace.is_member()));

drop policy if exists "볼 수 있는 채널만" on workspace.channels;
create policy "볼 수 있는 채널만" on workspace.channels for select to authenticated
  using ((select workspace.is_member()) and (kind = 'channel' or (select workspace.is_channel_member(id))));

drop policy if exists "내가 든 채널만" on workspace.channel_members;
create policy "내가 든 채널만" on workspace.channel_members for select to authenticated
  using ((select workspace.is_member()) and user_id = (select bmr.uid()));

drop policy if exists "볼 수 있는 채널의 메시지만" on workspace.messages;
create policy "볼 수 있는 채널의 메시지만" on workspace.messages for select to authenticated
  using ((select workspace.can_read_channel(channel_id)));

-- ---------- 브라우저 권한: 읽기만 ----------
grant usage on schema workspace to authenticated, anon;
grant select on workspace.members, workspace.channels, workspace.channel_members, workspace.messages to authenticated;

-- ---------- 기본 채널 ----------
insert into workspace.channels (slug, name, kind, description) values
  ('general',     '일반',      'channel', '모두에게 알리는 이야기'),
  ('class-share', '수업-나눔', 'channel', '수업 아이디어와 자료를 나눠요'),
  ('ai-lounge',   'AI-라운지', 'channel', '@AI 를 부르면 Alter 가 답글을 달아 줘요')
on conflict (slug) do nothing;

-- ---------- 실시간(Realtime): 프로젝트 설정에 따라 실패할 수 있어 안전하게 감쌉니다 ----------
-- 실패해도 앱은 5초 폴링으로 새 메시지를 받아옵니다.
do $$ begin
  alter publication supabase_realtime add table workspace.messages;
exception when others then null; end $$;
do $$ begin
  alter publication supabase_realtime add table workspace.channels;
exception when others then null; end $$;
