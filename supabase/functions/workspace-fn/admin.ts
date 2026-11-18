// workspace-fn — 관리자 콘솔 (화면 오른쪽 위 🛠️ 관리)
//
// 경로 (관리자만. 단 메시지 지우기는 쓴 사람도 할 수 있습니다):
//   GET    /admin/overview                          수 세기 · AI · 푸시 상태 (비밀값은 내보내지 않음)
//   GET    /admin/members                           멤버 목록 + 아직 들어오지 않은 초대
//   POST   /admin/invites {email,name?,role?,send_email?}   바깥 메일 초대 + 초대 메일 발송 (기본 발송, send_email:false 면 등록만)
//   POST   /admin/invites/resend {email}            대기 중인 초대의 메일 다시 보내기
//   DELETE /admin/invites/:email                    초대 취소
//   POST   /admin/invites/remove {email}            초대 취소 (같은 일, 본문으로)
//   POST|PATCH /admin/members/update {user_id, role?, disabled?}
//   PATCH  /admin/members/:id {role?, disabled?}    관리자 지정/해제 · 차단/해제 (내 계정은 못 바꿈)
//   POST   /channels/update {channel_id, name?, description?}   공개 채널 이름·설명 고치기
//   POST   /channels/delete {channel_id} · DELETE /channels/:id 공개 채널 지우기 (#일반은 못 지움)
//   POST   /messages/pin {channel_id, message_id|null}           공지 고정/해제
//   POST   /messages/delete {message_id} · DELETE /messages/:id  메시지 지우기 (쓴 사람 또는 관리자)
//
// 지키는 선
//   · DM·개인 AI 방은 관리자도 열어 보거나 지우지 않습니다. 관리자가 지울 수 있는 것은 공개 채널(kind='channel')의 메시지뿐입니다.
//   · 내 계정의 권한을 내리거나 나를 차단할 수 없습니다 (관리자가 하나도 남지 않는 일을 막습니다).
//   · 지운 메시지의 사진·파일은 버킷에 남습니다 — 버킷 규칙상 지우기는 올린 사람만 할 수 있어서,
//     화면(브라우저)이 내가 올린 파일만 함께 지웁니다(app.js 의 removeUploaded).
import type postgres from 'npm:postgres@3.4.5';
import { HttpError } from './http.ts';
import { hasKey as aiHasKey, hasHub as aiHasHub, aiVia, currentModel, lastAiResult } from './ai.ts';
import { pushAvailable } from './push.ts';
import { sendMail, inviteMail, mailReady, MAIL_FROM, MAIL_FROM_NAME } from './mail.ts';

type Sql = ReturnType<typeof postgres>;

export type AdminMe = { id: string; email: string; name: string; role: 'member' | 'admin' };
export type AdminReply = { status: number; body: unknown };

/** 초대 메일 발송 결과 — 초대 자체는 메일이 실패해도 등록된 상태로 남긴다 */
type MailOut = { sent: boolean; from?: string; id?: string; error?: string; skipped?: boolean };

const SCH = 'workspace';
const MAX_BODY = 16_384;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_RE = /^\d{1,19}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

/** 한 줄짜리 글 — 제어문자·겹친 공백을 없애고 길이를 자른다 */
const clean = (v: unknown, max: number) =>
  String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const emailOf = (v: unknown) => clean(v, 200).toLowerCase();

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const raw = await req.text();
  if (raw.length > MAX_BODY) throw new HttpError(413, '요청이 너무 큽니다.');
  let b: unknown;
  try { b = JSON.parse(raw || '{}'); } catch { throw new HttpError(400, 'JSON 형식이 아닙니다.'); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, '요청 내용이 올바르지 않습니다.');
  return b as Record<string, unknown>;
}

// ---------- 표 행 → 브라우저 모양 ----------
type Attachment = { path: string; name: string; mime: string; size: number };

function readAttachments(v: unknown): Attachment[] {
  let list: unknown = v;
  if (typeof v === 'string') { try { list = JSON.parse(v); } catch { return []; } }
  if (!Array.isArray(list)) return [];
  return list.slice(0, 5).map((a) => {
    const o = (a ?? {}) as Record<string, unknown>;
    return {
      path: String(o.path ?? ''),
      name: String(o.name ?? '').slice(0, 200) || '파일',
      mime: String(o.mime ?? 'application/octet-stream').slice(0, 100),
      size: Number(o.size) || 0,
    };
  }).filter((a) => a.path);
}

const messageOut = (r: Record<string, unknown>) => ({
  id: Number(r.id), channel_id: Number(r.channel_id),
  parent_id: r.parent_id == null ? null : Number(r.parent_id),
  user_id: r.user_id == null ? null : String(r.user_id),
  author_name: String(r.author_name ?? ''),
  author_kind: r.author_kind === 'ai' ? 'ai' as const : 'user' as const,
  content: String(r.content ?? ''),
  created_at: String(iso(r.created_at) ?? ''),
  attachments: readAttachments(r.attachments),
});

const memberOut = (r: Record<string, unknown>) => ({
  user_id: String(r.user_id), email: String(r.email ?? ''), name: String(r.name ?? ''),
  role: r.role === 'admin' ? 'admin' as const : 'member' as const,
  avatar_color: r.avatar_color == null ? null : String(r.avatar_color),
  disabled_at: iso(r.disabled_at), created_at: iso(r.created_at), last_seen_at: iso(r.last_seen_at),
});

const channelOut = (r: Record<string, unknown>, pinned: ReturnType<typeof messageOut> | null = null) => ({
  id: Number(r.id), slug: r.slug == null ? null : String(r.slug), name: String(r.name),
  kind: r.kind === 'dm' || r.kind === 'ai' ? r.kind : 'channel' as const,
  description: String(r.description ?? ''), dm_key: r.dm_key == null ? null : String(r.dm_key),
  created_at: String(iso(r.created_at) ?? ''),
  pinned_message_id: r.pinned_message_id == null ? null : Number(r.pinned_message_id),
  pinned_message: pinned,
});

const MSG_COLS = `m.id, m.channel_id, m.parent_id, m.user_id, m.author_name, m.author_kind, m.content, m.attachments, m.created_at`;

/** 채널 행 + 공지로 고정한 메시지 한 건 */
async function channelWithPin(sql: Sql, ch: Record<string, unknown>) {
  let pinned = null;
  if (ch.pinned_message_id != null) {
    const [m] = await sql.unsafe(
      `select ${MSG_COLS} from workspace.messages m where m.id = $1 and m.channel_id = $2`,
      [Number(ch.pinned_message_id), Number(ch.id)],
    ) as unknown as Record<string, unknown>[];
    pinned = m ? messageOut(m) : null;
  }
  return channelOut(ch, pinned);
}

async function channelRow(sql: Sql, id: number): Promise<Record<string, unknown>> {
  const [c] = await sql`select * from ${sql(SCH)}.channels where id = ${id}`;
  if (!c) throw new HttpError(404, '없는 채널입니다.', 'no_channel');
  return c as Record<string, unknown>;
}

// ---------- 라우팅 ----------
/**
 * 관리자·메시지 관리 경로만 맡는다. 그 밖의 경로면 null (index.ts 가 나머지를 이어서 처리).
 * 잘못된 요청은 HttpError 로 던지고 index.ts 의 공통 처리(상태 코드 + 한국어 안내)를 탄다.
 */
export async function adminRoute(sql: Sql, req: Request, path: string, me: AdminMe): Promise<AdminReply | null> {
  const isMsgDelete = path === '/messages/delete' || /^\/messages\/\d{1,19}$/.test(path);
  const isAdminPath = path.startsWith('/admin/') || path === '/channels/update' || path === '/channels/delete'
    || /^\/channels\/\d{1,19}$/.test(path) || path === '/messages/pin' || isMsgDelete;
  if (!isAdminPath) return null;
  // 메시지 지우기는 쓴 사람도 할 수 있으므로 아래에서 따로 확인한다.
  if (me.role !== 'admin' && !isMsgDelete) {
    return { status: 403, body: { error: '관리자만 쓸 수 있어요.', code: 'not_admin' } };
  }
  const M = req.method;

  // ---------- 시스템 현황 (비밀값 없이 숫자·상태만) ----------
  if (path === '/admin/overview' && M === 'GET') {
    const [c] = (await sql`select
      (select count(*)::int from ${sql(SCH)}.members) as members,
      (select count(*)::int from ${sql(SCH)}.members where disabled_at is not null) as disabled,
      (select count(*)::int from ${sql(SCH)}.members where role = 'admin') as admins,
      (select count(*)::int from ${sql(SCH)}.invites i
         where not exists (select 1 from ${sql(SCH)}.members m where m.email = i.email)) as invites,
      (select count(*)::int from ${sql(SCH)}.channels where kind = 'channel') as channels,
      (select count(*)::int from ${sql(SCH)}.channels where kind = 'dm') as dms,
      (select count(*)::int from ${sql(SCH)}.messages) as messages,
      (select max(created_at) from ${sql(SCH)}.messages) as last_message_at,
      (select count(*)::int from ${sql(SCH)}.push_subscriptions) as push_subs,
      (select count(*)::int from ${sql(SCH)}.bot_tokens where revoked_at is null) as bot_tokens`) as unknown as Record<string, unknown>[];
    const r = c ?? {};
    return {
      status: 200,
      body: {
        counts: {
          members: Number(r.members ?? 0), disabled: Number(r.disabled ?? 0), admins: Number(r.admins ?? 0),
          invites: Number(r.invites ?? 0), channels: Number(r.channels ?? 0), dms: Number(r.dms ?? 0),
          messages: Number(r.messages ?? 0), push_subs: Number(r.push_subs ?? 0), bot_tokens: Number(r.bot_tokens ?? 0),
        },
        last_message_at: iso(r.last_message_at),
        // AI — via: 'hub'(허브 hub-ai · WORKSPACE_AI_TOKEN) | 'gemini'(직접 호출) | 'none'
        ai: { via: aiVia(), hub: aiHasHub(), key_set: aiHasKey(), model: currentModel(), last: lastAiResult() },
        push: pushAvailable(),
        mail_ready: mailReady(),
        mail: { ready: mailReady(), from: MAIL_FROM },
        bot: { env_token: Boolean(Deno.env.get('WORKSPACE_BOT_TOKEN')) },
        now: new Date().toISOString(),
      },
    };
  }

  // ---------- 멤버 · 초대 ----------
  if (path === '/admin/members' && M === 'GET') {
    const rows = (await sql`select user_id, email, name, role, avatar_color, disabled_at, created_at, last_seen_at
      from ${sql(SCH)}.members
      order by (disabled_at is not null) asc, (role = 'admin') desc, name asc, email asc limit 500`) as unknown as Record<string, unknown>[];
    const inviteRows = await sql`select i.email, i.name, i.role, i.created_at
      from ${sql(SCH)}.invites i
      where not exists (select 1 from ${sql(SCH)}.members m where m.email = i.email)
      order by i.created_at desc limit 200` as unknown as Record<string, unknown>[];
    return {
      status: 200,
      body: {
        me: me.id,
        members: rows.map(memberOut),
        invites: inviteRows.map((r) => ({
          email: String(r.email ?? ''), name: String(r.name ?? ''),
          role: r.role === 'admin' ? 'admin' : 'member', created_at: iso(r.created_at),
        })),
      },
    };
  }

  if (path === '/admin/invites' && M === 'POST') {
    const b = await readBody(req);
    const email = emailOf(b.email);
    if (!EMAIL_RE.test(email)) throw new HttpError(400, '이메일 주소를 확인해 주세요.', 'bad_email');
    const role = b.role === 'admin' ? 'admin' : 'member';
    const name = clean(b.name, 40);
    // 기본은 메일도 함께. 관리자가 체크를 풀면(send_email:false) 초대만 등록한다.
    const wantMail = b.send_email !== false;
    const [already] = await sql`select 1 from ${sql(SCH)}.members where email = ${email}`;
    if (already) throw new HttpError(409, '이미 이 워크스페이스에 들어와 있는 메일이에요.', 'already_member');
    await sql`insert into ${sql(SCH)}.invites (email, name, role, invited_by)
      values (${email}, ${name}, ${role}, ${me.id})
      on conflict (email) do update set name = excluded.name, role = excluded.role,
        invited_by = excluded.invited_by, created_at = now()`;
    const invite = { email, name, role, created_at: new Date().toISOString() };
    const mail: MailOut = wantMail ? await sendInviteMail(me, email, role) : { sent: false, skipped: true };
    return { status: 201, body: { invite, mail } };
  }

  // ---------- 초대 메일 다시 보내기 ----------
  if (path === '/admin/invites/resend' && M === 'POST') {
    const b = await readBody(req);
    const email = emailOf(b.email);
    if (!EMAIL_RE.test(email)) throw new HttpError(400, '이메일 주소를 확인해 주세요.', 'bad_email');
    const [already] = await sql`select 1 from ${sql(SCH)}.members where email = ${email}`;
    if (already) throw new HttpError(409, '이미 이 워크스페이스에 들어와 있는 메일이에요. 초대 메일을 보낼 필요가 없습니다.', 'already_member');
    const [inv] = await sql`select email, name, role, created_at from ${sql(SCH)}.invites where email = ${email}`;
    if (!inv) throw new HttpError(404, '대기 중인 초대가 아니에요. 먼저 초대를 등록해 주세요.', 'no_invite');
    const role = inv.role === 'admin' ? 'admin' as const : 'member' as const;
    const mail = await sendInviteMail(me, email, role);
    return {
      status: 200,
      body: {
        ok: mail.sent, email, mail,
        invite: {
          email, name: String(inv.name ?? ''), role,
          created_at: iso(inv.created_at),
        },
      },
    };
  }

  if (path === '/admin/invites/remove' && (M === 'POST' || M === 'DELETE')) {
    const b = await readBody(req);
    return removeInvite(sql, emailOf(b.email));
  }

  const invitePath = /^\/admin\/invites\/(.+)$/.exec(path);
  if (invitePath && M === 'DELETE') {
    let email = invitePath[1];
    try { email = decodeURIComponent(email); } catch { /* 그대로 씀 */ }
    return removeInvite(sql, emailOf(email));
  }

  if ((path === '/admin/members/update' && (M === 'POST' || M === 'PATCH'))
    || (/^\/admin\/members\/[^/]+$/.test(path) && (M === 'POST' || M === 'PATCH'))) {
    const b = await readBody(req);
    const fromPath = path === '/admin/members/update' ? '' : path.slice('/admin/members/'.length);
    const userId = String(b.user_id ?? b.userId ?? fromPath);
    return updateMember(sql, me, userId, b);
  }

  // ---------- 채널 ----------
  if (path === '/channels/update' && (M === 'POST' || M === 'PATCH')) {
    const b = await readBody(req);
    const id = Number(b.channel_id ?? b.channelId);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'channel_id 가 필요합니다.', 'bad_channel');
    const ch = await channelRow(sql, id);
    if (ch.kind !== 'channel') throw new HttpError(400, '공개 채널만 고칠 수 있어요.', 'not_public');
    const name = b.name === undefined ? null : clean(b.name, 40).replace(/^#+/, '');
    const desc = b.description === undefined ? null : clean(b.description, 200);
    if (name === null && desc === null) throw new HttpError(400, '바꿀 이름이나 설명을 적어 주세요.', 'empty');
    if (name !== null) {
      if (!name) throw new HttpError(400, '채널 이름을 적어 주세요.', 'bad_name');
      await sql`update ${sql(SCH)}.channels set name = ${name} where id = ${id}`;
    }
    if (desc !== null) await sql`update ${sql(SCH)}.channels set description = ${desc} where id = ${id}`;
    return { status: 200, body: { channel: await channelWithPin(sql, await channelRow(sql, id)) } };
  }

  if ((path === '/channels/delete' && M === 'POST') || (M === 'DELETE' && /^\/channels\/\d{1,19}$/.test(path))) {
    const b = path === '/channels/delete' ? await readBody(req) : {};
    const raw = path === '/channels/delete' ? (b.channel_id ?? b.channelId) : path.slice('/channels/'.length);
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'channel_id 가 필요합니다.', 'bad_channel');
    const ch = await channelRow(sql, id);
    if (ch.kind !== 'channel') throw new HttpError(400, '공개 채널만 지울 수 있어요. DM 은 상대방과의 대화라 지우지 않습니다.', 'not_public');
    if (ch.slug === 'general') throw new HttpError(400, '#일반 채널은 지울 수 없어요. 기본 채널로 남겨 둡니다.', 'protected');
    const [{ n }] = await sql`select count(*)::int as n from ${sql(SCH)}.messages where channel_id = ${id}` as unknown as { n: number }[];
    await sql`delete from ${sql(SCH)}.channels where id = ${id}`;
    return { status: 200, body: { ok: true, id, name: String(ch.name), messages: Number(n ?? 0) } };
  }

  // ---------- 공지 고정 ----------
  if (path === '/messages/pin' && M === 'POST') {
    const b = await readBody(req);
    const channelId = Number(b.channel_id ?? b.channelId);
    if (!Number.isInteger(channelId) || channelId <= 0) throw new HttpError(400, 'channel_id 가 필요합니다.', 'bad_channel');
    const ch = await channelRow(sql, channelId);
    if (ch.kind !== 'channel') throw new HttpError(400, '공지 고정은 공개 채널에서만 쓸 수 있어요.', 'not_public');
    const raw = b.message_id ?? b.messageId;
    if (raw === null || raw === undefined || raw === '') {
      await sql`update ${sql(SCH)}.channels set pinned_message_id = null where id = ${channelId}`;
    } else {
      const msgId = Number(raw);
      if (!Number.isInteger(msgId) || msgId <= 0) throw new HttpError(400, 'message_id 가 올바르지 않습니다.', 'bad_message');
      const [m] = await sql`select id, parent_id from ${sql(SCH)}.messages where id = ${msgId} and channel_id = ${channelId}`;
      if (!m) throw new HttpError(404, '이 채널의 메시지가 아니에요.', 'no_message');
      if (m.parent_id != null) throw new HttpError(400, '스레드 답글은 고정할 수 없어요. 원래 메시지를 고정해 주세요.', 'is_reply');
      await sql`update ${sql(SCH)}.channels set pinned_message_id = ${msgId} where id = ${channelId}`;
    }
    return { status: 200, body: { channel: await channelWithPin(sql, await channelRow(sql, channelId)) } };
  }

  // ---------- 메시지 지우기 (쓴 사람 또는 관리자) ----------
  if (isMsgDelete && (M === 'POST' || M === 'DELETE')) {
    const b = path === '/messages/delete' ? await readBody(req) : {};
    const raw = path === '/messages/delete' ? (b.message_id ?? b.messageId) : path.slice('/messages/'.length);
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'message_id 가 필요합니다.', 'bad_message');
    const [m] = await sql`select id, channel_id, user_id, parent_id from ${sql(SCH)}.messages where id = ${id}`;
    if (!m) throw new HttpError(404, '이미 지워졌거나 없는 메시지예요.', 'no_message');
    const [ch] = await sql`select id, kind, name from ${sql(SCH)}.channels where id = ${Number(m.channel_id)}`;
    if (!ch) throw new HttpError(404, '없는 채널입니다.', 'no_channel');
    const mine = m.user_id != null && String(m.user_id) === me.id;
    const asAdmin = me.role === 'admin' && ch.kind === 'channel';
    if (!mine && !asAdmin) {
      throw new HttpError(403, '내가 쓴 메시지나 공개 채널의 메시지만 지울 수 있어요.', 'not_allowed');
    }
    const [{ n: replies }] = await sql`select count(*)::int as n from ${sql(SCH)}.messages where parent_id = ${id}` as unknown as { n: number }[];
    const pinnedRows = await sql`select id from ${sql(SCH)}.channels where pinned_message_id = ${id}` as unknown as Record<string, unknown>[];
    await sql`delete from ${sql(SCH)}.messages where id = ${id}`;
    return {
      status: 200,
      body: {
        ok: true, id, channel_id: Number(m.channel_id), parent_id: m.parent_id == null ? null : Number(m.parent_id),
        replies: Number(replies ?? 0), unpinned: pinnedRows.length > 0,
      },
    };
  }

  return null;
}

// ---------- 초대 메일 ----------
/**
 * 초대 메일을 보낸다. 무슨 일이 있어도 던지지 않고 결과만 돌려준다 —
 * 메일이 안 나가도 초대는 그대로 남아야 하기 때문. 실패 이유는 화면에 그대로 보여 준다.
 */
async function sendInviteMail(me: AdminMe, email: string, role: 'member' | 'admin'): Promise<MailOut> {
  if (!mailReady()) {
    return { sent: false, error: 'WORKSPACE_MAIL_TOKEN 미설정 — 허브에서 이 앱의 메일 토큰을 넣어야 발송됩니다.' };
  }
  try {
    const msg = inviteMail({ inviter: me.name || me.email || '관리자', email, role });
    const r = await sendMail({
      to: email, subject: msg.subject, html: msg.html, text: msg.text, from_name: MAIL_FROM_NAME,
    });
    return { sent: true, from: r.from || MAIL_FROM, id: r.id || undefined };
  } catch (e) {
    const raw = String((e as Error)?.message ?? e).replace(/\s+/g, ' ').trim();
    return { sent: false, error: (raw || '메일을 보내지 못했습니다.').slice(0, 300) };
  }
}

// ---------- 초대 취소 ----------
async function removeInvite(sql: Sql, email: string): Promise<AdminReply> {
  if (!EMAIL_RE.test(email)) throw new HttpError(400, '이메일 주소를 확인해 주세요.', 'bad_email');
  const rows = await sql`delete from ${sql(SCH)}.invites where email = ${email} returning email` as unknown as Record<string, unknown>[];
  if (!rows.length) throw new HttpError(404, '대기 중인 초대가 아니에요.', 'no_invite');
  return { status: 200, body: { ok: true, email } };
}

// ---------- 멤버 권한·차단 ----------
async function updateMember(sql: Sql, me: AdminMe, userId: string, b: Record<string, unknown>): Promise<AdminReply> {
  if (!UUID_RE.test(userId)) throw new HttpError(400, '멤버 아이디가 올바르지 않습니다.', 'bad_user');
  const role = b.role === undefined ? null : (b.role === 'admin' ? 'admin' : 'member');
  const disabled = b.disabled === undefined ? undefined : Boolean(b.disabled);
  if (role === null && disabled === undefined) throw new HttpError(400, '바꿀 권한이나 차단 상태가 필요합니다.', 'empty');
  const [target] = await sql`select user_id, name, role, disabled_at from ${sql(SCH)}.members where user_id = ${userId}`;
  if (!target) throw new HttpError(404, '이 워크스페이스의 멤버가 아니에요.', 'no_member');
  if (userId === me.id) {
    if (role === 'member') throw new HttpError(400, '내 관리자 권한은 내릴 수 없어요. 다른 관리자에게 맡겨 주세요.', 'self_demote');
    if (disabled === true) throw new HttpError(400, '내 계정은 차단할 수 없어요.', 'self_block');
  }
  if (role !== null) await sql`update ${sql(SCH)}.members set role = ${role} where user_id = ${userId}`;
  if (disabled !== undefined) {
    await sql`update ${sql(SCH)}.members set disabled_at = ${disabled ? new Date() : null} where user_id = ${userId}`;
  }
  const [row] = await sql`select user_id, email, name, role, avatar_color, disabled_at, created_at, last_seen_at
    from ${sql(SCH)}.members where user_id = ${userId}` as unknown as Record<string, unknown>[];
  return { status: 200, body: { member: memberOut(row ?? {}) } };
}
