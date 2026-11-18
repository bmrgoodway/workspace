-- 별무리 워크스페이스 — 알림(Web Push) 표 (2026-11-14)
--
-- 브라우저(authenticated)는 이 두 표를 읽지도 쓰지도 않습니다. 권한을 주지 않습니다.
-- 구독 등록·해지는 서버 함수 workspace-fn(/push/subscribe, /push/unsubscribe)이 하고,
-- VAPID 비밀 열쇠는 push_config 에만 있으며 함수만 읽습니다.
-- (함수는 처음 필요할 때 Web Crypto 로 열쇠쌍을 만들어 이 표에 한 번 저장합니다.)
--
-- 서버 함수가 스스로도 만들기 때문에(ensureSchema) 꼭 실행하지 않아도 됩니다.

create table if not exists workspace.push_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  endpoint text unique not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on workspace.push_subscriptions (user_id);
comment on table workspace.push_subscriptions is '브라우저 푸시 구독. 만료(404·410)되면 함수가 지웁니다.';

create table if not exists workspace.push_config (
  id int primary key default 1,
  public_key text not null,
  private_jwk jsonb not null,
  subject text not null
);
comment on table workspace.push_config is 'VAPID 열쇠. 비밀키(private_jwk)는 함수만 읽습니다. 브라우저에 권한을 주지 마세요.';

alter table workspace.push_subscriptions enable row level security;
alter table workspace.push_config enable row level security;

-- 권한을 주지 않으므로 정책이 없으면 브라우저에서는 아무것도 보이지 않고 쓸 수 없습니다 (의도한 대로).
revoke all on workspace.push_subscriptions from anon, authenticated;
revoke all on workspace.push_config from anon, authenticated;
