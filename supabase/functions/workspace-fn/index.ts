// workspace-fn — 별무리 워크스페이스 서버 함수
//
// 주소: https://wjvqavianqceeyyxonfg.supabase.co/functions/v1/workspace-fn/<경로>
//   GET  /health                                  DB·표 연결 확인 · 메일 토큰 준비 여부(mail_ready) · AI 경로(ai_hub·ai_via)
//   GET  /hello                                   부른 사람, AI 열쇠 설정 여부(ai_hub·ai_ready)
//   GET  /bootstrap                               나·멤버·채널 목록 (기본 채널과 내 AI 방을 만들어 줌)
//   POST /channels      {kind:'channel', name, description} | {kind:'dm', target_user_id}
//   GET  /messages?channel_id=…[&parent_id=…]     채널 메시지 / 스레드 답글 (attachments 포함) + 채널(공지 고정)
//   POST /messages      {channel_id, content, parent_id?, attachments?}  메시지 쓰기 (+ @AI 면 Alter 답글)
//
// 관리자 콘솔 (자세한 것은 admin.ts):
//   GET  /admin/overview · GET /admin/members · POST /admin/invites (+ 초대 메일) · POST /admin/invites/resend · DELETE /admin/invites/:email
//   POST /admin/members/update {user_id, role?, disabled?}    관리자 지정·해제 · 차단·해제
//   POST /channels/update · DELETE /channels/:id              공개 채널 이름·설명 고치기 · 지우기
//   POST /messages/pin {channel_id, message_id|null}          공지 고정·해제
//   DELETE /messages/:id                                      메시지 지우기 (쓴 사람 또는 관리자)
//
// 봇 연동 (자세한 것은 bot.ts):
//   GET  /bot/channels · GET|POST /bot/messages · GET /bot/search   (열쇠: Authorization: Bearer bmrws_…)
//   POST /mcp   표준 MCP(Streamable HTTP) — Alter·Cursor 같은 도구가 공개 채널을 읽고 쓴다
//   GET|POST /bot/tokens, /bot/tokens/revoke, DELETE /bot/tokens/:id   관리자 화면의 열쇠 발급·폐기
//
// 사진·파일: 브라우저가 Storage 버킷 'workspace' 의 <내 아이디>/… 에 직접 올리고,
// 이 함수에는 [{path,name,mime,size}] 만 받아 messages.attachments 에 적습니다.
// 볼 때는 브라우저가 createSignedUrl 로 1시간짜리 주소를 만들어 씁니다(로그인한 사람은 이 버킷을 읽을 수 있음).
//
// 함수는 이 앱 전용 DB 계정(workspace_fn, 개발자 계정 권한을 물려받음)으로 접속해 RLS 를 거치지 않습니다.
// 그래서 누가 무엇을 볼 수 있는지는 이 파일에서 직접 확인합니다 (memberFor / channelFor).
// 비밀값: WORKSPACE_DB_URL, WORKSPACE_AI_TOKEN(허브 hub-ai 신분증 · 권장), WORKSPACE_AI_MODEL(선택),
//        WORKSPACE_GEMINI_API_KEY(AI 토큰이 없을 때만 쓰는 예비 길), WORKSPACE_GEMINI_MODEL(선택)
import postgres from 'npm:postgres@3.4.5';
import { HttpError } from './http.ts';
import { adminRoute } from './admin.ts';
import { DDL, SEED_CHANNELS, CHECK_TABLES } from './schema.ts';
import { ask, hasKey as aiHasKey, hasHub as aiHasHub, aiVia, currentModel, lastAiResult, type Turn } from './ai.ts';
import { getVapid, pushAvailable, sendPush } from './push.ts';
import {
  botApi, mcpApi, requireBotToken, listBotTokens, createBotToken, revokeBotToken, BotError,
  type Notify, type Reply,
} from './bot.ts';

const FN = 'workspace-fn';
const SCHEMA = 'workspace';
const PREFIX = 'WORKSPACE_';
const ORIGINS = ['https://bmrgoodway.github.io', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://127.0.0.1:4173'];
const METHODS = 'GET, POST, PATCH, DELETE, OPTIONS';
// 봇 API·MCP 는 화면이 아니라 바깥 도구(서버·데스크톱 앱)가 부른다 — 출처를 가리지 않고 열쇠로만 가린다
const OPEN_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-bot-token, content-type, accept, mcp-session-id, mcp-protocol-version',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Max-Age': '600',
  'Access-Control-Expose-Headers': 'mcp-session-id, mcp-protocol-version',
};

const secret = (name: string) => Deno.env.get(PREFIX + name) ?? '';
const DB_URL = secret('DB_URL');
// 처음 로그인할 때 초대 없이 멤버가 되는 메일 도메인. 개인용 배포에서는 함수 비밀값
// WORKSPACE_JOIN_DOMAINS='gmail.com,myteam.com' 처럼 바꿀 수 있다 (비우면 학교 메일 그대로).
const JOIN_DOMAINS = (secret('JOIN_DOMAINS') || 'bmrschool.org,bmrschool.net')
  .split(',').map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
const isJoinDomain = (email: string) => JOIN_DOMAINS.some((d) => email.toLowerCase().endsWith('@' + d));
// 서버리스라 연결을 적게: 최대 2개, 20초 쉬면 닫음. 트랜잭션 풀러(6543)라 prepare 끔
const db = DB_URL ? postgres(DB_URL, { prepare: false, max: 2, idle_timeout: 20, connect_timeout: 10, onnotice: () => {} }) : null;
type Sql = ReturnType<typeof postgres>;

function cors(req: Request): Record<string, string> {
  const o = req.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ORIGINS.includes(o) ? o : ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': METHODS,
    'Access-Control-Max-Age': '600', Vary: 'Origin',
  };
}
const json = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });

/** 봇·MCP 응답 — 열려 있는 CORS 머리글을 그대로 쓰고 본문만 싣는다 */
const jsonOpen = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: {
      ...OPEN_HEADERS, 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers,
    },
  });

// ---------- 로그인한 사람 ----------
type User = { id: string; email: string; name: string; confirmed: boolean };
/** Authorization: Bearer <사용자 토큰> 을 Supabase Auth 에 물어 확인. 공개 키·잘못된 토큰이면 null */
async function getUser(req: Request): Promise<User | null> {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('Authorization') ?? '');
  const token = m?.[1] ?? '';
  if (!token || token.startsWith('sb_') || token.split('.').length !== 3) return null;
  const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, {
    headers: { apikey: Deno.env.get('SUPABASE_ANON_KEY') ?? '', Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const u = await r.json() as {
    id?: string; email?: string; email_confirmed_at?: string;
    app_metadata?: { provider?: string; providers?: string[] };
    user_metadata?: { full_name?: string; name?: string };
  };
  if (!u?.id) return null;
  const meta = u.user_metadata ?? {};
  const providers = u.app_metadata?.providers ?? (u.app_metadata?.provider ? [u.app_metadata.provider] : []);
  const name = String(meta.full_name ?? meta.name ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 40);
  return {
    id: u.id,
    email: String(u.email ?? '').toLowerCase(),
    name,
    confirmed: Boolean(u.email_confirmed_at) || providers.includes('google'),
  };
}

// ---------- 표가 없으면 만들기 (콜드 스타트 1회) ----------
let schemaReady: Promise<void> | null = null;
type TableFlags = {
  members?: boolean; channels?: boolean; messages?: boolean; push?: boolean;
  push_config?: boolean; reads?: boolean; attachments?: boolean; attach_ok?: boolean; body_check?: boolean;
  bot_tokens?: boolean; member_disabled?: boolean; invites?: boolean; channel_pin?: boolean;
};
/** 표·칸·첨부 조건이 다 준비됐는가 (하나라도 빠지면 DDL 을 다시 건다) */
const coreOk = (t: TableFlags) =>
  Boolean(t.members && t.channels && t.messages && t.push && t.push_config && t.reads);
const attachOk = (t: TableFlags) => Boolean(t.attachments && t.attach_ok && t.body_check);
const botOk = (t: TableFlags) => Boolean(t.bot_tokens);
/** 관리자 콘솔에 필요한 칸·표 (차단 · 초대 · 공지 고정) */
const adminOk = (t: TableFlags) => Boolean(t.member_disabled && t.invites && t.channel_pin);
const schemaOk = (t: TableFlags) => coreOk(t) && attachOk(t) && botOk(t) && adminOk(t);
function ensureSchema(sql: Sql): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const t0 = Date.now();
      let fresh = false;
      try {
        const rows = await sql.unsafe(CHECK_TABLES) as unknown as TableFlags[];
        fresh = !schemaOk(rows?.[0] ?? {});
      } catch (e) {
        fresh = true;
        console.error(FN, 'check tables', (e as Error)?.message ?? e);
      }
      if (fresh) {
        for (const st of DDL) {
          try { await sql.unsafe(st); } catch (e) {
            console.error(FN, 'ddl', (e as Error)?.message ?? e, '|', st.replace(/\s+/g, ' ').slice(0, 80));
          }
        }
      }
      try { await sql.unsafe(SEED_CHANNELS); } catch (e) { console.error(FN, 'seed', (e as Error)?.message ?? e); }
      // 마지막 확인: 핵심 표가 정말 있는지 (하나라도 없으면 이번 요청은 실패로 알린다)
      const rows = await sql.unsafe(CHECK_TABLES) as unknown as TableFlags[];
      const t = rows?.[0] ?? {};
      if (!coreOk(t)) throw new Error('표를 만들지 못했습니다');
      // 첨부 조건이 아직 안 맞아도 글 메시지는 그대로 쓸 수 있게 한다 (health 에 attach_ok 로 보임)
      if (!attachOk(t)) console.error(FN, 'attachments not ready', JSON.stringify(t));
      // 봇·MCP 열쇠 표가 없으면 연동 기능만 쉰다 (나머지 화면은 그대로)
      if (!botOk(t)) console.error(FN, 'bot tokens not ready', JSON.stringify(t));
      // 관리자 콘솔 칸(차단·초대·공지 고정)이 없으면 관리 화면만 쉰다
      if (!adminOk(t)) console.error(FN, 'admin columns not ready', JSON.stringify(t));
      console.log(FN, 'schema ready', Date.now() - t0, 'ms', fresh ? '(created)' : '(existing)');
    })().catch((e) => {
      schemaReady = null; // 다음 요청에서 다시 시도
      throw e;
    });
  }
  return schemaReady;
}

// ---------- 표 행 → 브라우저 모양 ----------
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v == null ? null : String(v)));
const COLORS = ['#ffdc1a', '#0abbee', '#02c245', '#ff614a', '#7e65c1', '#b0e7f8', '#fef1b8', '#a4e9bc'];
function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

type Member = {
  id: string; email: string; name: string; role: 'member' | 'admin';
  avatar_color: string; last_seen_at: string | null; disabled_at: string | null;
};
type Channel = {
  id: number; slug: string | null; name: string; kind: 'channel' | 'dm' | 'ai'; description: string;
  dm_key: string | null; created_at: string; unread: number;
  pinned_message_id: number | null; pinned_message: Message | null;
};
type Attachment = { path: string; name: string; mime: string; size: number };
type Message = {
  id: number; channel_id: number; parent_id: number | null; user_id: string | null;
  author_name: string; author_kind: 'user' | 'ai'; content: string; created_at: string; reply_count: number;
  attachments: Attachment[];
};

const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 버킷 한도와 같음
const isImage = (mime: string) => /^image\//i.test(mime);

/** DB 의 jsonb 값을 믿지 않고 모양을 맞춰 읽는다 (예전 메시지·잘못된 값은 빈 목록) */
function readAttachments(v: unknown): Attachment[] {
  let list: unknown = v;
  if (typeof v === 'string') { try { list = JSON.parse(v); } catch { return []; } }
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_FILES).map((a) => {
    const o = (a ?? {}) as Record<string, unknown>;
    return {
      path: String(o.path ?? ''),
      name: String(o.name ?? '').slice(0, 200) || '파일',
      mime: String(o.mime ?? 'application/octet-stream').slice(0, 100),
      size: Number(o.size) || 0,
    };
  }).filter((a) => a.path);
}

/** 브라우저가 보낸 첨부 목록을 확인한다 — 내 폴더(<내 아이디>/…) 안의 영문 경로만 */
function normAttachments(raw: unknown, meId: string): Attachment[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, '첨부 목록이 올바르지 않습니다.', 'bad_attachment');
  if (raw.length > MAX_FILES) throw new HttpError(400, `첨부는 한 번에 ${MAX_FILES}개까지 보낼 수 있어요.`, 'too_many_files');
  const out: Attachment[] = [];
  for (const a of raw) {
    const o = (a ?? {}) as Record<string, unknown>;
    const path = String(o.path ?? '');
    const seg = path.split('/');
    const okPath = seg.length === 2 && seg[0] === meId
      && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(seg[1]) && seg[1] !== '.' && seg[1] !== '..';
    if (!okPath) throw new HttpError(400, '첨부 파일 정보가 올바르지 않습니다.', 'bad_attachment');
    const name = String(o.name ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || '파일';
    const mimeRaw = String(o.mime ?? '');
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(mimeRaw) ? mimeRaw.slice(0, 100) : 'application/octet-stream';
    const size = Number(o.size);
    if (!Number.isFinite(size) || size < 0) throw new HttpError(400, '첨부 파일 크기가 올바르지 않습니다.', 'bad_attachment');
    if (size > MAX_FILE_BYTES) throw new HttpError(400, '한 파일은 10MB까지 보낼 수 있어요.', 'file_too_large');
    out.push({ path, name, mime, size: Math.round(size) });
  }
  return out;
}

/** 알림 본문 — 글이 없으면 첨부만으로 짧게 */
function pushBody(m: Message): string {
  const files = m.attachments ?? [];
  const text = m.content.replace(/\s+/g, ' ').trim();
  if (text) return (files.length ? '📎 ' : '') + text.slice(0, 160);
  if (!files.length) return '';
  const first = files[0];
  if (files.length === 1) return (isImage(first.mime) ? '🖼️ 사진' : `📎 파일: ${first.name}`).slice(0, 160);
  const images = files.filter((f) => isImage(f.mime)).length;
  if (images === files.length) return `🖼️ 사진 ${files.length}장`;
  return `📎 파일 ${files.length}개: ${first.name}`.slice(0, 160);
}

/** AI 에게 알려 줄 첨부 설명 — 이름·종류만 (내용은 볼 수 없음) */
const fileNotes = (files: Attachment[]) =>
  files.map((f) => `${isImage(f.mime) ? '사진' : '파일'} ${f.name} (${f.mime}, ${Math.max(1, Math.round(f.size / 1024))}KB)`);

const asMember = (r: Record<string, unknown>): Member => ({
  id: String(r.user_id), email: String(r.email ?? ''), name: String(r.name ?? ''),
  role: r.role === 'admin' ? 'admin' : 'member',
  avatar_color: String(r.avatar_color || colorFor(String(r.user_id))),
  last_seen_at: iso(r.last_seen_at),
  disabled_at: iso(r.disabled_at),
});
const asChannel = (r: Record<string, unknown>): Channel => ({
  id: Number(r.id), slug: r.slug == null ? null : String(r.slug), name: String(r.name),
  kind: r.kind === 'dm' || r.kind === 'ai' ? r.kind : 'channel',
  description: String(r.description ?? ''), dm_key: r.dm_key == null ? null : String(r.dm_key),
  created_at: String(iso(r.created_at) ?? ''),
  unread: Number(r.unread_count ?? 0),
  pinned_message_id: r.pinned_message_id == null ? null : Number(r.pinned_message_id),
  pinned_message: null,
});
const asMessage = (r: Record<string, unknown>): Message => ({
  id: Number(r.id), channel_id: Number(r.channel_id),
  parent_id: r.parent_id == null ? null : Number(r.parent_id),
  user_id: r.user_id == null ? null : String(r.user_id),
  author_name: String(r.author_name ?? ''), author_kind: r.author_kind === 'ai' ? 'ai' : 'user',
  content: String(r.content ?? ''), created_at: String(iso(r.created_at) ?? ''),
  reply_count: Number(r.reply_count ?? 0),
  attachments: readAttachments(r.attachments),
});

// ---------- 멤버 확인 (처음 로그인하면 등록) ----------
async function memberFor(sql: Sql, u: User): Promise<Member> {
  const [found] = await sql`select * from ${sql(SCHEMA)}.members where user_id = ${u.id}`;
  if (found) {
    // 관리자가 차단한 계정 — 로그인은 되어도 이 앱은 열리지 않는다
    if (found.disabled_at != null) {
      throw new HttpError(403, '관리자에 의해 접근이 제한된 계정입니다. 관리자에게 문의해 주세요.', 'disabled');
    }
    const name = u.name && u.name !== found.name ? u.name : String(found.name ?? '');
    const [row] = await sql`update ${sql(SCHEMA)}.members
      set last_seen_at = now(), name = ${name || String(found.name ?? '')}, email = ${u.email}
      where user_id = ${u.id} returning *`;
    return asMember(row ?? found);
  }
  if (!u.confirmed) throw new HttpError(403, '메일 확인이 끝나지 않은 계정입니다. 메일함의 확인 링크를 눌러 주세요.', 'unconfirmed');

  const [{ n }] = await sql`select count(*)::int as n from ${sql(SCHEMA)}.members` as unknown as { n: number }[];
  const school = isJoinDomain(u.email);
  // 관리자가 미리 넣어 둔 초대 — 학교 메일이 아니어도 이 줄이 있으면 들어올 수 있다 (역할·이름도 초대한 대로)
  const [invite] = await sql`select name, role from ${sql(SCHEMA)}.invites where email = ${u.email}`;
  if (n > 0 && !school && !invite) {
    throw new HttpError(403, '이 워크스페이스에 아직 초대되지 않은 계정입니다. 관리자에게 초대를 요청해 주세요.', 'not_invited');
  }
  const role = invite ? (invite.role === 'admin' ? 'admin' : 'member') : (n === 0 ? 'admin' : 'member');
  const name = (u.name || String(invite?.name ?? '') || u.email.split('@')[0] || '선생님').slice(0, 40);
  const [row] = await sql`insert into ${sql(SCHEMA)}.members (user_id, email, name, role, avatar_color, last_seen_at)
    values (${u.id}, ${u.email}, ${name}, ${role}, ${colorFor(u.id)}, now())
    on conflict (user_id) do update set last_seen_at = now(), name = excluded.name, email = excluded.email
    returning *`;
  // 초대는 한 번만 — 등록되면 지운다 (같은 메일로 다시 들어와도 이제는 멤버)
  if (invite) {
    try { await sql`delete from ${sql(SCHEMA)}.invites where email = ${u.email}`; }
    catch (e) { console.error(FN, 'invite cleanup', (e as Error)?.message ?? e); }
  }
  console.log(FN, 'member registered', invite ? '(invited)' : school ? '(school)' : '(first)', role);
  return asMember(row);
}

/** 내 Alter 방이 없으면 만든다 */
async function ensureAiChannel(sql: Sql, me: Member): Promise<void> {
  const dmKey = 'ai:' + me.id;
  const [ch] = await sql`insert into ${sql(SCHEMA)}.channels (slug, name, kind, description, dm_key, created_by)
    values (${'ai-' + me.id}, ${'🤖 Alter (AI)'}, ${'ai'}, ${'Alter 와 1:1로 묻고 답하는 나만의 방'}, ${dmKey}, ${me.id})
    on conflict (dm_key) do update set name = excluded.name
    returning id`;
  if (ch?.id) {
    await sql`insert into ${sql(SCHEMA)}.channel_members (channel_id, user_id)
      values (${Number(ch.id)}, ${me.id}) on conflict do nothing`;
  }
}

/** 볼 수 있는 채널인지 확인하고 채널 행을 돌려준다 */
async function channelFor(sql: Sql, meId: string, channelId: number): Promise<Record<string, unknown>> {
  const [c] = await sql`select * from ${sql(SCHEMA)}.channels where id = ${channelId}`;
  if (!c) throw new HttpError(404, '없는 채널입니다.', 'no_channel');
  if (c.kind !== 'channel') {
    const [m] = await sql`select 1 from ${sql(SCHEMA)}.channel_members where channel_id = ${channelId} and user_id = ${meId}`;
    if (!m) throw new HttpError(403, '이 채널에 들어갈 수 없습니다.', 'no_access');
  }
  return c as Record<string, unknown>;
}

// ---------- 메시지 ----------
const MSG_COLS = `m.id, m.channel_id, m.parent_id, m.user_id, m.author_name, m.author_kind, m.content, m.attachments, m.created_at,
  (select count(*)::int from workspace.messages r where r.parent_id = m.id) as reply_count`;

/** 채널들의 공지로 고정한 메시지를 한 번에 채운다 (표는 한 번만 읽는다) */
async function attachPins(sql: Sql, channels: Channel[]): Promise<Channel[]> {
  const ids = [...new Set(channels.map((c) => c.pinned_message_id).filter((v): v is number => typeof v === 'number' && v > 0))];
  if (!ids.length) return channels;
  const holes = ids.map((_, i) => '$' + (i + 1)).join(',');
  const rows = await sql.unsafe(
    `select ${MSG_COLS} from workspace.messages m where m.id in (${holes})`,
    ids,
  ) as unknown as Record<string, unknown>[];
  const byId = new Map<number, Message>();
  for (const r of rows) { const m = asMessage(r); byId.set(m.id, m); }
  for (const c of channels) {
    c.pinned_message = c.pinned_message_id == null ? null : (byId.get(c.pinned_message_id) ?? null);
  }
  return channels;
}

async function topMessages(sql: Sql, channelId: number): Promise<Message[]> {
  const rows = await sql.unsafe(
    `select ${MSG_COLS} from workspace.messages m
     where m.channel_id = $1 and m.parent_id is null
     order by m.id desc limit 200`,
    [channelId],
  ) as unknown as Record<string, unknown>[];
  return rows.map(asMessage).reverse();
}

/** 채널별 안 읽은 메시지 수 + 그 채널의 마지막 메시지 번호 */
async function unreadFor(sql: Sql, meId: string): Promise<{ channel_id: number; unread: number; last_id: number }[]> {
  const rows = await sql`select c.id,
      (select count(*)::int from ${sql(SCHEMA)}.messages m
        where m.channel_id = c.id and m.id > coalesce(r.last_read_id, 0)
          and (m.user_id is null or m.user_id <> ${meId})) as unread,
      coalesce((select max(m2.id) from ${sql(SCHEMA)}.messages m2 where m2.channel_id = c.id), 0) as last_id
    from ${sql(SCHEMA)}.channels c
    left join ${sql(SCHEMA)}.channel_reads r on r.channel_id = c.id and r.user_id = ${meId}
    where c.kind = 'channel'
       or exists (select 1 from ${sql(SCHEMA)}.channel_members cm where cm.channel_id = c.id and cm.user_id = ${meId})`;
  return (rows as Record<string, unknown>[]).map((r) => ({
    channel_id: Number(r.id), unread: Number(r.unread ?? 0), last_id: Number(r.last_id ?? 0),
  }));
}

async function threadMessages(sql: Sql, channelId: number, parentId: number): Promise<{ parent: Message; replies: Message[] }> {
  const [p] = await sql.unsafe(
    `select ${MSG_COLS} from workspace.messages m where m.id = $1 and m.channel_id = $2`,
    [parentId, channelId],
  ) as unknown as Record<string, unknown>[];
  if (!p) throw new HttpError(404, '스레드의 원래 메시지를 찾지 못했습니다.', 'no_parent');
  const rows = await sql.unsafe(
    `select ${MSG_COLS} from workspace.messages m where m.parent_id = $1 order by m.id asc limit 300`,
    [parentId],
  ) as unknown as Record<string, unknown>[];
  return { parent: asMessage(p), replies: rows.map(asMessage) };
}

/** Gemini 에 보낼 최근 대화 (스레드면 그 스레드만, 아니면 채널 전체) */
async function contextTurns(sql: Sql, channelId: number, parentId: number | null): Promise<Turn[]> {
  const rows = parentId == null
    ? await sql.unsafe(
      `select author_name, author_kind, content, attachments from workspace.messages
       where channel_id = $1 and parent_id is null order by id desc limit 12`, [channelId],
    ) as unknown as Record<string, unknown>[]
    : await sql.unsafe(
      `select author_name, author_kind, content, attachments from workspace.messages
       where parent_id = $1 order by id desc limit 12`, [parentId],
    ) as unknown as Record<string, unknown>[];
  return rows.reverse().map((r) => ({
    author: String(r.author_name ?? ''),
    kind: r.author_kind === 'ai' ? 'ai' as const : 'user' as const,
    content: String(r.content ?? ''),
    files: fileNotes(readAttachments(r.attachments)),
  }));
}

const MAX_CONTENT = 4000;
const mentionRe = /@\s?(ai|alter)\b/i;

// ---------- 알림 보내기 (응답을 막지 않게 백그라운드로) ----------
const bg = (p: Promise<unknown>) => {
  const er = (globalThis as { EdgeRuntime?: { waitUntil?: (q: Promise<unknown>) => void } }).EdgeRuntime;
  if (er?.waitUntil) { try { er.waitUntil(p); return; } catch { /* 아래로 */ } }
  p.catch(() => { /* notifyPush 안에서 이미 기록 */ });
};

async function notifyPush(sql: Sql, ch: Record<string, unknown>, m: Message) {
  if (!pushAvailable()) return;
  const cid = m.channel_id;
  const kind = String(ch.kind ?? 'channel');
  try {
    // 받는 사람: 보낸 사람을 뺀 구독자. 공개 채널은 구독한 모든 멤버, DM·AI 방은 그 채널의 멤버만.
    const rows = kind === 'channel'
      ? (m.user_id
        ? await sql`select endpoint, p256dh, auth from ${sql(SCHEMA)}.push_subscriptions where user_id <> ${m.user_id} limit 50`
        : await sql`select endpoint, p256dh, auth from ${sql(SCHEMA)}.push_subscriptions limit 50`)
      : (m.user_id
        ? await sql`select ps.endpoint, ps.p256dh, ps.auth from ${sql(SCHEMA)}.push_subscriptions ps
            join ${sql(SCHEMA)}.channel_members cm on cm.user_id = ps.user_id and cm.channel_id = ${cid}
            where ps.user_id <> ${m.user_id} limit 50`
        : await sql`select ps.endpoint, ps.p256dh, ps.auth from ${sql(SCHEMA)}.push_subscriptions ps
            join ${sql(SCHEMA)}.channel_members cm on cm.user_id = ps.user_id and cm.channel_id = ${cid} limit 50`);
    const subs = (rows as Record<string, unknown>[]).map((r) => ({
      endpoint: String(r.endpoint), p256dh: String(r.p256dh), auth: String(r.auth),
    }));
    if (!subs.length) return;
    const title = kind === 'channel'
      ? `#${String(ch.name)} · ${m.author_name}`
      : (kind === 'ai' ? 'Alter' : `${m.author_name} · DM`);
    const body = pushBody(m);
    const out = await sendPush(sql, subs, { title, body, tag: `workspace-${cid}`, url: '/workspace/' });
    console.log(FN, 'push', kind, cid, JSON.stringify(out));
  } catch (e) {
    console.error(FN, 'push', (e as Error)?.message ?? e);
  }
}

async function postMessage(sql: Sql, me: Member, ch: Record<string, unknown>, channelId: number, raw: string, parentId: number | null, rawAttachments: unknown = null) {
  const content = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  const attachments = normAttachments(rawAttachments, me.id);
  if (!content && !attachments.length) throw new HttpError(400, '메시지 내용을 적거나 사진·파일을 붙여 주세요.', 'empty');
  if (content.length > MAX_CONTENT) throw new HttpError(413, `메시지가 너무 깁니다 (${MAX_CONTENT}자까지).`, 'too_long');

  let threadRoot: number | null = null;
  if (parentId != null) {
    const [p] = await sql`select id, parent_id from ${sql(SCHEMA)}.messages where id = ${parentId} and channel_id = ${channelId}`;
    if (!p) throw new HttpError(404, '답글을 달 메시지를 찾지 못했습니다.', 'no_parent');
    // 답글의 답글은 같은 스레드에 붙인다 (Slack 처럼 1단계 스레드)
    threadRoot = p.parent_id == null ? Number(p.id) : Number(p.parent_id);
  }

  const [row] = await sql`insert into ${sql(SCHEMA)}.messages (channel_id, parent_id, user_id, author_name, author_kind, content, attachments)
    values (${channelId}, ${threadRoot}, ${me.id}, ${me.name || '선생님'}, ${'user'}, ${content}, ${sql.json(attachments)}) returning *`;
  const message = asMessage(row);
  bg(notifyPush(sql, ch, message));

  const kind = String(ch.kind ?? 'channel');
  const wantsAi = kind === 'ai' || mentionRe.test(content);
  if (!wantsAi) return { message, ai: null };

  // AI 답글이 붙을 자리: AI 방의 최상위 글은 그 채널에, 그 밖에는 스레드에
  const aiParent: number | null = threadRoot != null ? threadRoot : (kind === 'ai' ? null : message.id);
  const turns = await contextTurns(sql, channelId, threadRoot);
  const channelName = kind === 'channel' ? '#' + String(ch.name) : String(ch.name);
  const res = await ask({ channel: channelName, turns, message: content, files: fileNotes(attachments) });
  try {
    const [aiRow] = await sql`insert into ${sql(SCHEMA)}.messages (channel_id, parent_id, user_id, author_name, author_kind, content)
      values (${channelId}, ${aiParent}, ${null}, ${'Alter'}, ${'ai'}, ${res.text}) returning *`;
    const ai = asMessage(aiRow);
    bg(notifyPush(sql, ch, ai));
    return { message, ai: { ...ai, source: res.source, model: res.source === 'hub' || res.source === 'gemini' ? (res.model ?? currentModel()) : null } };
  } catch (e) {
    console.error(FN, 'ai insert', (e as Error)?.message ?? e);
    return { message, ai: null, ai_error: 'Alter 의 답글을 저장하지 못했어요.' };
  }
}

// ---------- 라우팅 ----------
const route = (req: Request) => {
  const p = new URL(req.url).pathname; const i = p.indexOf('/' + FN);
  return (i < 0 ? '/' : p.slice(i + FN.length + 1)).replace(/\/+$/, '') || '/';
};

Deno.serve(async (req) => {
  const path = route(req);
  // 봇 API·MCP 는 화면이 아니라 바깥 도구가 부르므로 출처를 가리지 않는다 (열쇠로만 가린다)
  const openPath = path === '/mcp' || (path.startsWith('/bot/') && !path.startsWith('/bot/tokens'));
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: openPath ? OPEN_HEADERS : cors(req) });
  const o = req.headers.get('Origin');
  if (o && !ORIGINS.includes(o) && !openPath) return json(req, 403, { error: '허용되지 않은 출처입니다.' });
  const sql = db;
  try {
    if (path === '/health') {
      if (!sql) return json(req, 503, { ok: false, db: false });
      await sql`select 1`;
      let schema = false;
      let counts: { channels?: number; members?: number; messages?: number } | null = null;
      try {
        await ensureSchema(sql);
        const rows = await sql.unsafe(`select
          (select count(*)::int from workspace.channels) as channels,
          (select count(*)::int from workspace.members) as members,
          (select count(*)::int from workspace.messages) as messages,
          (select count(*)::int from workspace.push_subscriptions) as push_subs,
          (select exists (select 1 from pg_constraint c
             where c.conrelid = 'workspace.messages'::regclass
               and c.conname = 'messages_content_check'
               and pg_get_constraintdef(c.oid) not like '%>= 1%')) as attach_ok,
          (select exists (select 1 from information_schema.columns
             where table_schema = 'workspace' and table_name = 'members' and column_name = 'disabled_at')
            and to_regclass('workspace.invites') is not null
            and exists (select 1 from information_schema.columns
             where table_schema = 'workspace' and table_name = 'channels' and column_name = 'pinned_message_id')) as admin_ready`) as unknown as { channels: number; members: number; messages: number; push_subs: number; attach_ok: boolean; admin_ready: boolean }[];
        counts = rows?.[0] ?? null;
        schema = true;
      } catch (e) {
        console.error(FN, 'schema', (e as Error)?.message ?? e);
      }
      let bot: { tokens: number; env_token: boolean } | null = null;
      try {
        const [r] = await sql.unsafe(`select count(*)::int as n from workspace.bot_tokens where revoked_at is null`) as unknown as { n: number }[];
        bot = { tokens: Number(r?.n ?? 0), env_token: Boolean(secret('BOT_TOKEN')) };
      } catch { bot = null; }
      return json(req, 200, {
        ok: true, db: true, schema, ...(counts || {}),
        // AI — ai_hub: 허브 공용 게이트웨이(hub-ai)를 WORKSPACE_AI_TOKEN 으로 부르는가 · ai_ready: AI 를 부를 수 있는가
        ai_hub: aiHasHub(), ai_ready: aiHasKey(), ai_via: aiVia(), ai_model: currentModel(), ai_last: lastAiResult(),
        push: pushAvailable(),
        mail_ready: Boolean(secret('MAIL_TOKEN')), mcp: true, bot_api: true, bot, function: FN,
      });
    }

    const user = await getUser(req);
    if (path === '/hello') {
      return json(req, 200, {
        app: SCHEMA, user: user ? { id: user.id, email: user.email, name: user.name } : null,
        db: Boolean(sql), ai_hub: aiHasHub(), ai_ready: aiHasKey(), ai_via: aiVia(),
        gemini_key_set: aiHasKey(), gemini_model: currentModel(), time: new Date().toISOString(),
      });
    }
    if (!sql) return json(req, 503, { error: '서버 설정이 아직 끝나지 않았습니다 (DB 연결 정보 없음).' });
    await ensureSchema(sql);

    // ---------- 연동 열쇠 발급·목록·폐기 (이 앱 관리자만) ----------
    if (path === '/bot/tokens' || path.startsWith('/bot/tokens/')) {
      if (!user) return json(req, 401, { error: '로그인이 필요합니다. 다시 로그인해 주세요.' });
      const admin = await memberFor(sql, user);
      if (admin.role !== 'admin') return json(req, 403, { error: '관리자만 연동 열쇠를 다룰 수 있어요.' });
      const envTokenSet = Boolean(secret('BOT_TOKEN'));

      if (path === '/bot/tokens' && req.method === 'GET') {
        return json(req, 200, { tokens: await listBotTokens(sql), env_token: envTokenSet });
      }

      if (path === '/bot/tokens' && req.method === 'POST') {
        const raw = await req.text();
        if (raw.length > 4096) return json(req, 413, { error: '요청이 너무 큽니다.' });
        let b: { name?: unknown };
        try { b = JSON.parse(raw || '{}'); } catch { return json(req, 400, { error: 'JSON 형식이 아닙니다.' }); }
        const name = String(b.name ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (!name) return json(req, 400, { error: '열쇠 이름을 적어 주세요.' });
        try {
          return json(req, 201, await createBotToken(sql, name, admin.id));
        } catch (e) {
          if (e instanceof BotError) return json(req, e.status, { error: e.message });
          throw e;
        }
      }

      // 폐기: DELETE /bot/tokens/:id  또는  POST /bot/tokens/revoke {id}
      const byPath = /^\/bot\/tokens\/(\d{1,19})$/.exec(path);
      if (byPath && (req.method === 'DELETE' || req.method === 'POST')) {
        try {
          return json(req, 200, { ok: true, ...(await revokeBotToken(sql, Number(byPath[1]))) });
        } catch (e) {
          if (e instanceof BotError) return json(req, e.status, { error: e.message });
          throw e;
        }
      }
      if (path === '/bot/tokens/revoke' && req.method === 'POST') {
        const raw = await req.text();
        if (raw.length > 4096) return json(req, 413, { error: '요청이 너무 큽니다.' });
        let b: { id?: unknown };
        try { b = JSON.parse(raw || '{}'); } catch { return json(req, 400, { error: 'JSON 형식이 아닙니다.' }); }
        const id = Number(b.id);
        if (!Number.isInteger(id) || id <= 0) return json(req, 400, { error: '열쇠 번호(id)가 필요합니다.' });
        try {
          return json(req, 200, { ok: true, ...(await revokeBotToken(sql, id)) });
        } catch (e) {
          if (e instanceof BotError) return json(req, e.status, { error: e.message });
          throw e;
        }
      }

      return json(req, 404, { error: '없는 경로입니다.' });
    }

    // ---------- 봇 API · MCP (열쇠로 확인) ----------
    if (openPath) {
      const auth = await requireBotToken(req, sql, secret('BOT_TOKEN'));
      if (!auth.ok) {
        const message = '봇 열쇠가 필요합니다. Authorization: Bearer bmrws_… (또는 x-bot-token) 헤더를 붙여 주세요.';
        if (path === '/mcp') {
          return jsonOpen(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message } }, {
            'WWW-Authenticate': 'Bearer',
            'Mcp-Session-Id': (req.headers.get('mcp-session-id') ?? '').trim() || 'bmrws-stateless-1',
          });
        }
        return jsonOpen(401, { error: message, code: 'bot_unauthorized' });
      }
      const notifyBot: Notify = (ch, m) => bg(notifyPush(sql as Sql, ch, m));
      try {
        const r: Reply = path === '/mcp'
          ? await mcpApi(sql, req, notifyBot, OPEN_HEADERS)
          : await botApi(sql, req, path, notifyBot);
        // GET /mcp 의 SSE 처럼 본문을 스트림으로 흘려보내는 응답
        if (r.stream) {
          return new Response(r.stream, {
            status: r.status,
            headers: { ...OPEN_HEADERS, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(r.headers ?? {}) },
          });
        }
        return jsonOpen(r.status, r.body, r.headers ?? {});
      } catch (e) {
        if (e instanceof BotError) return jsonOpen(e.status, { error: e.message, code: 'bot_error' });
        console.error(FN, 'bot', (e as { code?: string })?.code ?? '', (e as Error)?.message ?? e);
        return jsonOpen(500, { error: '서버 오류가 났습니다. 잠시 뒤 다시 시도해 주세요.', code: 'bot_error' });
      }
    }

    // 여기부터는 로그인 + 이 앱 멤버만
    if (!user) return json(req, 401, { error: '로그인이 필요합니다. 다시 로그인해 주세요.' });
    const me = await memberFor(sql, user);

    // ---------- 관리자 콘솔 (admin.ts) — 멤버·초대 · 채널 · 공지 고정 · 메시지 지우기 ----------
    // 메시지 지우기만은 쓴 사람도 할 수 있어서 admin.ts 안에서 따로 권한을 본다.
    const adminReply = await adminRoute(sql, req, path, me);
    if (adminReply) return json(req, adminReply.status, adminReply.body);

    if (path === '/bootstrap' && req.method === 'GET') {
      await ensureAiChannel(sql, me);
      const memberRows = await sql`select user_id, email, name, role, avatar_color, disabled_at, last_seen_at
        from ${sql(SCHEMA)}.members order by name asc, email asc limit 300`;
      const channelRows = await sql`select c.id, c.slug, c.name, c.kind, c.description, c.dm_key, c.created_at, c.pinned_message_id,
          (select count(*)::int from ${sql(SCHEMA)}.messages m
            where m.channel_id = c.id and m.id > coalesce(r.last_read_id, 0)
              and (m.user_id is null or m.user_id <> ${me.id})) as unread_count
        from ${sql(SCHEMA)}.channels c
        left join ${sql(SCHEMA)}.channel_reads r on r.channel_id = c.id and r.user_id = ${me.id}
        where c.kind = 'channel'
           or exists (select 1 from ${sql(SCHEMA)}.channel_members cm where cm.channel_id = c.id and cm.user_id = ${me.id})
        order by case c.kind when 'channel' then 0 when 'ai' then 2 else 1 end, c.id asc`;
      return json(req, 200, {
        me,
        members: (memberRows as Record<string, unknown>[]).map(asMember),
        channels: await attachPins(sql, (channelRows as Record<string, unknown>[]).map(asChannel)),
        gemini_key_set: aiHasKey(), ai_ready: aiHasKey(), ai_hub: aiHasHub(), ai_via: aiVia(),
      });
    }

    if (path === '/push/key' && req.method === 'GET') {
      try {
        const v = await getVapid(sql);
        return json(req, 200, { publicKey: v.publicKey, subject: v.subject, available: pushAvailable() });
      } catch (e) {
        console.error(FN, 'vapid', (e as Error)?.message ?? e);
        return json(req, 500, { error: '알림 열쇠를 준비하지 못했어요. 잠시 뒤 다시 시도해 주세요.' });
      }
    }

    if (path === '/push/subscribe' && req.method === 'POST') {
      const raw = await req.text();
      if (raw.length > 8192) return json(req, 413, { error: '요청이 너무 큽니다.' });
      let b: { subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } };
      try { b = JSON.parse(raw || '{}'); } catch { return json(req, 400, { error: 'JSON 형식이 아닙니다.' }); }
      const sub = b.subscription ?? {};
      const endpoint = String(sub.endpoint ?? '');
      const p256dh = String(sub.keys?.p256dh ?? '');
      const auth = String(sub.keys?.auth ?? '');
      if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || p256dh.length > 200 || !auth || auth.length > 100) {
        return json(req, 400, { error: '알림 구독 정보가 올바르지 않습니다.' });
      }
      await sql`insert into ${sql(SCHEMA)}.push_subscriptions (user_id, endpoint, p256dh, auth)
        values (${me.id}, ${endpoint}, ${p256dh}, ${auth})
        on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = now()`;
      return json(req, 201, { ok: true });
    }

    if (path === '/push/unsubscribe' && req.method === 'POST') {
      const raw = await req.text();
      if (raw.length > 4096) return json(req, 413, { error: '요청이 너무 큽니다.' });
      let b: { endpoint?: unknown };
      try { b = JSON.parse(raw || '{}'); } catch { return json(req, 400, { error: 'JSON 형식이 아닙니다.' }); }
      const endpoint = String(b.endpoint ?? '');
      if (!endpoint) return json(req, 400, { error: 'endpoint 가 필요합니다.' });
      await sql`delete from ${sql(SCHEMA)}.push_subscriptions where endpoint = ${endpoint} and user_id = ${me.id}`;
      return json(req, 200, { ok: true });
    }

    if (path === '/channels/read' && req.method === 'POST') {
      const raw = await req.text();
      if (raw.length > 4096) return json(req, 413, { error: '요청이 너무 큽니다.' });
      let b: { channel_id?: unknown };
      try { b = JSON.parse(raw || '{}'); } catch { return json(req, 400, { error: 'JSON 형식이 아닙니다.' }); }
      const channelId = Number(b.channel_id);
      if (!Number.isInteger(channelId) || channelId <= 0) return json(req, 400, { error: 'channel_id 가 필요합니다.' });
      await channelFor(sql, me.id, channelId);
      const [row] = await sql`select coalesce(max(id), 0) as last_id from ${sql(SCHEMA)}.messages where channel_id = ${channelId}`;
      const lastId = Number((row as Record<string, unknown> | undefined)?.last_id ?? 0);
      await sql`insert into ${sql(SCHEMA)}.channel_reads (user_id, channel_id, last_read_id, updated_at)
        values (${me.id}, ${channelId}, ${lastId}, now())
        on conflict (user_id, channel_id) do update
          set last_read_id = greatest(channel_reads.last_read_id, excluded.last_read_id), updated_at = now()`;
      return json(req, 200, { ok: true, channel_id: channelId, last_read_id: lastId });
    }

    if (path === '/channels' && req.method === 'POST') {
      const raw = await req.text();
      if (raw.length > 8192) return json(req, 413, { error: '요청이 너무 큽니다.' });
      let b: { kind?: unknown; name?: unknown; description?: unknown; target_user_id?: unknown };
      try { b = JSON.parse(raw || '{}'); } catch { return json(req, 400, { error: 'JSON 형식이 아닙니다.' }); }
      const kind = b.kind === 'dm' ? 'dm' : 'channel';

      if (kind === 'channel') {
        const name = String(b.name ?? '').replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, 40);
        if (!name) return json(req, 400, { error: '채널 이름을 적어 주세요.' });
        const desc = String(b.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
        const slug = 'c-' + crypto.randomUUID().slice(0, 8);
        const [row] = await sql`insert into ${sql(SCHEMA)}.channels (slug, name, kind, description, created_by)
          values (${slug}, ${name}, ${'channel'}, ${desc}, ${me.id}) returning *`;
        return json(req, 201, { channel: asChannel(row) });
      }

      const target = String(b.target_user_id ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(target)) return json(req, 400, { error: '상대를 고르지 않았습니다.' });
      if (target === me.id) return json(req, 400, { error: '나와의 DM 은 AI 방을 쓰면 됩니다.' });
      const [other] = await sql`select user_id, name, email from ${sql(SCHEMA)}.members where user_id = ${target}`;
      if (!other) return json(req, 404, { error: '상대를 찾지 못했습니다.' });
      const key = [me.id, target].sort().join(':');
      const [created] = await sql`insert into ${sql(SCHEMA)}.channels (slug, name, kind, dm_key, created_by)
        values (${'dm-' + key.slice(0, 8) + '-' + crypto.randomUUID().slice(0, 4)}, ${String(other.name || other.email)}, ${'dm'}, ${key}, ${me.id})
        on conflict (dm_key) do nothing returning *`;
      let row = created as Record<string, unknown> | undefined;
      if (!row) {
        const [existing] = await sql`select * from ${sql(SCHEMA)}.channels where dm_key = ${key}`;
        row = existing as Record<string, unknown>;
      }
      if (!row) return json(req, 500, { error: 'DM 을 열지 못했습니다.' });
      await sql`insert into ${sql(SCHEMA)}.channel_members (channel_id, user_id)
        values (${Number(row.id)}, ${me.id}), (${Number(row.id)}, ${target}) on conflict do nothing`;
      return json(req, 201, { channel: asChannel(row) });
    }

    if (path === '/messages' && req.method === 'GET') {
      const q = new URL(req.url).searchParams;
      const channelId = Number(q.get('channel_id'));
      if (!Number.isInteger(channelId) || channelId <= 0) return json(req, 400, { error: 'channel_id 가 필요합니다.' });
      const ch = await channelFor(sql, me.id, channelId);
      const [channel] = await attachPins(sql, [asChannel(ch)]);
      const parent = q.get('parent_id');
      if (parent) {
        const parentId = Number(parent);
        if (!Number.isInteger(parentId) || parentId <= 0) return json(req, 400, { error: 'parent_id 가 올바르지 않습니다.' });
        const t = await threadMessages(sql, channelId, parentId);
        return json(req, 200, { channel_id: channelId, channel, parent: t.parent, messages: t.replies, unread: await unreadFor(sql, me.id) });
      }
      const messages = await topMessages(sql, channelId);
      return json(req, 200, { channel_id: channelId, channel, messages, unread: await unreadFor(sql, me.id) });
    }

    if (path === '/messages' && req.method === 'POST') {
      const raw = await req.text();
      if (raw.length > 64_000) return json(req, 413, { error: '요청이 너무 큽니다.' });
      let b: { channel_id?: unknown; content?: unknown; parent_id?: unknown; attachments?: unknown };
      try { b = JSON.parse(raw || '{}'); } catch { return json(req, 400, { error: 'JSON 형식이 아닙니다.' }); }
      const channelId = Number(b.channel_id);
      if (!Number.isInteger(channelId) || channelId <= 0) return json(req, 400, { error: 'channel_id 가 필요합니다.' });
      const parentRaw = b.parent_id == null ? null : Number(b.parent_id);
      if (parentRaw != null && (!Number.isInteger(parentRaw) || parentRaw <= 0)) return json(req, 400, { error: 'parent_id 가 올바르지 않습니다.' });
      const ch = await channelFor(sql, me.id, channelId);
      const out = await postMessage(sql, me, ch, channelId, String(b.content ?? ''), parentRaw, b.attachments);
      return json(req, 201, out);
    }

    return json(req, 404, { error: '없는 경로입니다.' });
  } catch (e) {
    if (e instanceof HttpError) return json(req, e.status, { error: e.message, code: e.code });
    console.error(FN, (e as { code?: string })?.code ?? '', (e as Error)?.message ?? e);
    return json(req, 500, { error: '서버 오류가 났습니다. 잠시 뒤 다시 시도해 주세요.' });
  }
});
