// workspace-fn — 봇 API · MCP (Streamable HTTP)
//
// Alter(피클)·Cursor·Claude Desktop 같은 바깥 도구가 이 워크스페이스와 일하는 길입니다.
// **공개 채널(kind='channel')만** 열립니다 — 1:1 DM·개인 AI 방은 봇에게도 열지 않습니다.
//
//   GET    /bot/channels                         채널 목록
//   GET    /bot/messages?channel_id=|slug=&…      메시지 읽기 (parent_id·since_id·limit)
//   POST   /bot/messages                         메시지·답글 쓰기 (+ Web Push 알림)
//   GET    /bot/search?q=&limit=                 채널 메시지 검색
//   POST   /mcp                                  MCP JSON-RPC 2.0 (initialize·tools/list·tools/call)
//   GET    /mcp                                  SSE 스트림 자리 — 보낼 말은 없어 첫 주석만 보내고 닫는다
//   DELETE /mcp                                  세션 정리(무상태라 그냥 204)
//
// 세션은 두지 않지만, 세션 아이디를 꼭 받아야 하는 엄격한 클라이언트(Grok 원격 커넥터 등)를 위해
// 모든 응답에 `Mcp-Session-Id` 를 되돌려주고, GET 은 405 대신 200 text/event-stream 으로 연다.
//
// 열쇠는 `Authorization: Bearer bmrws_…` 또는 `x-bot-token: bmrws_…` 로 옵니다.
// workspace.bot_tokens 에는 SHA-256 해시만 있고, 맞으면 last_used_at 을 1분에 한 번만 고칩니다.
// 서버 비밀값 WORKSPACE_BOT_TOKEN 이 있으면 그 값도 열쇠로 받습니다(관리자가 직접 넣는 비상용).
import type postgres from 'npm:postgres@3.4.5';

type Sql = ReturnType<typeof postgres>;

const API = '/bot';

// ---------- 바깥으로 돌려줄 모양 ----------
export type Reply = {
  status: number; body: unknown; headers?: Record<string, string>;
  /** 본문을 JSON 이 아니라 스트림으로 그대로 흘려보낼 때 (MCP GET 의 SSE) */
  stream?: ReadableStream<Uint8Array>;
};
/** 글을 남겼을 때 알림을 보내는 함수 (index.ts 가 Web Push 로 넘긴다) */
export type Notify = (channel: Record<string, unknown>, message: BotMessage) => void;

export type BotAttachment = { path: string; name: string; mime: string; size: number };
export const MAX_BOT_CONTENT = 4000;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 30;

type BotMessage = {
  id: number; channel_id: number; parent_id: number | null; user_id: string | null;
  author_name: string; author_kind: 'user' | 'ai'; content: string; created_at: string;
  reply_count: number; attachments: BotAttachment[];
};
type BotChannel = { id: number; slug: string | null; name: string; description: string; created_at: string };

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v == null ? null : String(v)));

/** DB 의 jsonb 값을 믿지 않고 모양을 맞춰 읽는다 */
function readAttachments(v: unknown): BotAttachment[] {
  let list: unknown = v;
  if (typeof v === 'string') { try { list = JSON.parse(v); } catch { return []; } }
  if (!Array.isArray(list)) return [];
  return list.slice(0, 10).map((a) => {
    const o = (a ?? {}) as Record<string, unknown>;
    return {
      path: String(o.path ?? ''),
      name: String(o.name ?? '').slice(0, 200) || '파일',
      mime: String(o.mime ?? 'application/octet-stream').slice(0, 100),
      size: Number(o.size) || 0,
    };
  }).filter((a) => a.path);
}

const asMessage = (r: Record<string, unknown>): BotMessage => ({
  id: Number(r.id), channel_id: Number(r.channel_id),
  parent_id: r.parent_id == null ? null : Number(r.parent_id),
  user_id: r.user_id == null ? null : String(r.user_id),
  author_name: String(r.author_name ?? ''),
  author_kind: r.author_kind === 'ai' ? 'ai' : 'user',
  content: String(r.content ?? ''), created_at: String(iso(r.created_at) ?? ''),
  reply_count: Number(r.reply_count ?? 0),
  attachments: readAttachments(r.attachments),
});

/** 바깥에 내보내는 모양 — 사람 아이디(내부 uuid)와 저장소 경로는 빼고 이름·종류·크기만 */
function publicMessage(m: BotMessage) {
  return {
    id: m.id, channel_id: m.channel_id, parent_id: m.parent_id,
    author_name: m.author_name, author_kind: m.author_kind, content: m.content,
    created_at: m.created_at, reply_count: m.reply_count,
    attachments: m.attachments.map((a) => ({ name: a.name, mime: a.mime, size: a.size })),
  };
}

const asChannel = (r: Record<string, unknown>): BotChannel => ({
  id: Number(r.id), slug: r.slug == null ? null : String(r.slug), name: String(r.name ?? ''),
  description: String(r.description ?? ''), created_at: String(iso(r.created_at) ?? ''),
});

const COLS = `m.id, m.channel_id, m.parent_id, m.user_id, m.author_name, m.author_kind, m.content, m.attachments, m.created_at,
  (select count(*)::int from workspace.messages r where r.parent_id = m.id) as reply_count`;

// ---------- 열쇠 확인 ----------
const sha256Hex = async (s: string) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** 길이가 같으면 끝까지 비교한다 (앞에서부터 빨리 끝나지 않게) */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export type BotAuth = { ok: true; id: number | null; name: string } | { ok: false };

/** 요청에서 봇 열쇠를 꺼내 확인한다. 맞으면 last_used_at 을 (1분에 한 번만) 갱신 */
export async function requireBotToken(req: Request, sql: Sql, envToken: string): Promise<BotAuth> {
  const h = req.headers.get('Authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  const token = String(req.headers.get('x-bot-token') ?? m?.[1] ?? '').trim();
  if (!token || token.length < 8 || token.length > 200) return { ok: false };
  if (envToken && sameSecret(token, envToken)) return { ok: true, id: null, name: '서버 비밀값' };

  const hash = await sha256Hex(token);
  const rows = await sql.unsafe(
    `select id, name, last_used_at from workspace.bot_tokens where token_hash = $1 and revoked_at is null`,
    [hash],
  ) as unknown as { id: number; name: string; last_used_at: unknown }[];
  const row = rows[0];
  if (!row) return { ok: false };

  const last = row.last_used_at ? new Date(String(iso(row.last_used_at))).getTime() : 0;
  if (!last || Date.now() - last > 60_000) {
    // 기다리지 않고 보낸다 — 열쇠 확인이 늦어지지 않게
    sql`update workspace.bot_tokens set last_used_at = now() where id = ${Number(row.id)}`
      .catch((e: unknown) => console.error('bot', 'last_used_at', String((e as Error)?.message ?? e)));
  }
  return { ok: true, id: Number(row.id), name: String(row.name) };
}

// ---------- 열쇠 발급·목록·폐기 (관리자 화면에서 부른다) ----------
export type TokenRow = {
  id: number; name: string; token_prefix: string;
  created_at: string; last_used_at: string | null; revoked_at: string | null;
};
const asToken = (r: Record<string, unknown>): TokenRow => ({
  id: Number(r.id), name: String(r.name ?? ''), token_prefix: String(r.token_prefix ?? ''),
  created_at: String(iso(r.created_at) ?? ''),
  last_used_at: iso(r.last_used_at) as string | null,
  revoked_at: iso(r.revoked_at) as string | null,
});

/** bmrws_ + 32자(무작위 24바이트를 base64url 로). 원문은 돌려줄 때 한 번만 쓰고 저장하지 않는다 */
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return 'bmrws_' + btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function listBotTokens(sql: Sql): Promise<TokenRow[]> {
  const rows = await sql.unsafe(
    `select id, name, token_prefix, created_at, last_used_at, revoked_at
       from workspace.bot_tokens order by id desc limit 100`,
  ) as unknown as Record<string, unknown>[];
  return rows.map(asToken);
}

export async function createBotToken(sql: Sql, name: string, createdBy: string):
Promise<{ id: number; name: string; token_prefix: string; token: string; created_at: string }> {
  const [{ active }] = await sql.unsafe(
    `select count(*)::int as active from workspace.bot_tokens where revoked_at is null`,
  ) as unknown as { active: number }[];
  if (Number(active) >= 20) throw new BotError(409, '쓸 수 있는 열쇠가 너무 많아요(20개). 쓰지 않는 열쇠를 먼저 폐기해 주세요.');

  const token = newToken();
  const hash = await sha256Hex(token);
  const prefix = token.slice(0, 12);
  const rows = await sql.unsafe(
    `insert into workspace.bot_tokens (name, token_prefix, token_hash, created_by)
       values ($1, $2, $3, $4) returning id, name, token_prefix, created_at`,
    [name, prefix, hash, createdBy],
  ) as unknown as Record<string, unknown>[];
  const row = rows[0];
  return {
    id: Number(row.id), name: String(row.name ?? name), token_prefix: String(row.token_prefix ?? prefix),
    token, created_at: String(iso(row.created_at) ?? ''),
  };
}

export async function revokeBotToken(sql: Sql, id: number): Promise<{ id: number; revoked_at: string }> {
  const rows = await sql.unsafe(
    `update workspace.bot_tokens set revoked_at = now()
       where id = $1 and revoked_at is null returning id, revoked_at`,
    [id],
  ) as unknown as Record<string, unknown>[];
  const row = rows[0];
  if (row) return { id: Number(row.id), revoked_at: String(iso(row.revoked_at) ?? '') };
  const exists = await sql.unsafe(`select revoked_at from workspace.bot_tokens where id = $1`, [id]) as unknown as Record<string, unknown>[];
  if (!exists[0]) throw new BotError(404, '없는 열쇠입니다.');
  throw new BotError(409, '이미 폐기된 열쇠입니다.');
}

export class BotError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

// ---------- 채널·메시지 (공개 채널만) ----------
async function channels(sql: Sql): Promise<BotChannel[]> {
  const rows = await sql.unsafe(
    `select id, slug, name, description, created_at from workspace.channels
       where kind = 'channel' order by id asc limit 200`,
  ) as unknown as Record<string, unknown>[];
  return rows.map(asChannel);
}

/** id 또는 slug 로 공개 채널 하나. DM·AI 방이면 못 찾은 것으로 친다 */
async function channelOf(sql: Sql, id: number | null, slug: string): Promise<BotChannel | null> {
  if (id == null && !slug) return null;
  const rows = id != null
    ? await sql.unsafe(
      `select id, slug, name, description, created_at from workspace.channels where id = $1 and kind = 'channel'`, [id],
    ) as unknown as Record<string, unknown>[]
    : await sql.unsafe(
      `select id, slug, name, description, created_at from workspace.channels where slug = $1 and kind = 'channel'`, [slug],
    ) as unknown as Record<string, unknown>[];
  return rows[0] ? asChannel(rows[0]) : null;
}

type ReadArgs = { channel_id: number | null; slug: string; parent_id: number | null; since_id: number | null; limit: number | null };

async function readMessages(sql: Sql, a: ReadArgs) {
  const ch = await channelOf(sql, a.channel_id, a.slug);
  if (!ch) return null;
  const limit = Math.min(Math.max(a.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  if (a.parent_id != null) {
    const rows = await sql.unsafe(
      `select ${COLS} from workspace.messages m
        where m.channel_id = $1 and m.parent_id = $2 order by m.id asc limit $3`,
      [ch.id, a.parent_id, limit],
    ) as unknown as Record<string, unknown>[];
    return { channel: ch, parent_id: a.parent_id, count: rows.length, messages: rows.map(asMessage).map(publicMessage) };
  }

  const since = a.since_id;
  const rows = since != null
    ? await sql.unsafe(
      `select ${COLS} from workspace.messages m
        where m.channel_id = $1 and m.parent_id is null and m.id > $2 order by m.id asc limit $3`,
      [ch.id, since, limit],
    ) as unknown as Record<string, unknown>[]
    : await sql.unsafe(
      `select ${COLS} from workspace.messages m
        where m.channel_id = $1 and m.parent_id is null order by m.id desc limit $2`,
      [ch.id, limit],
    ) as unknown as Record<string, unknown>[];
  const list = since != null ? rows.map(asMessage) : rows.map(asMessage).reverse();
  return { channel: ch, count: list.length, messages: list.map(publicMessage) };
}

async function search(sql: Sql, q: string, limitRaw: number | null) {
  const limit = Math.min(Math.max(limitRaw ?? 20, 1), MAX_LIMIT);
  // ilike 에서 % · _ · \ 는 뜻이 있으니 글자 그대로 찾게 막는다
  const pattern = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  const rows = await sql.unsafe(
    `select ${COLS}, c.slug as channel_slug, c.name as channel_name
       from workspace.messages m join workspace.channels c on c.id = m.channel_id
      where c.kind = 'channel' and m.content ilike $1
      order by m.id desc limit $2`,
    [pattern, limit],
  ) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    ...publicMessage(asMessage(r)),
    channel: { id: Number(r.channel_id), slug: iso(r.channel_slug), name: String(r.channel_name ?? '') },
  }));
}

const KNOWN_AI = /^alter/i;

/** 봇이 쓴 글. AI 답글은 부르지 않는다(봇끼리 끝없이 주고받지 않게) */
async function postMessage(
  sql: Sql, notify: Notify,
  a: { channel_id: number | null; slug: string; content: string; parent_id: number | null; author_name: string },
) {
  const ch = await channelOf(sql, a.channel_id, a.slug);
  if (!ch) throw new BotError(404, '채널을 찾지 못했습니다. list_channels 로 채널 목록을 먼저 확인하세요.');

  const content = String(a.content ?? '').replace(/\r\n/g, '\n').trim();
  if (!content) throw new BotError(400, '보낼 내용(content)이 비어 있습니다.');
  if (content.length > MAX_BOT_CONTENT) throw new BotError(413, `메시지가 너무 깁니다 (${MAX_BOT_CONTENT}자까지).`);

  const author = a.author_name.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Alter (AI)';

  let threadRoot: number | null = null;
  if (a.parent_id != null) {
    const p = await sql.unsafe(
      `select id, parent_id from workspace.messages where id = $1 and channel_id = $2`, [a.parent_id, ch.id],
    ) as unknown as Record<string, unknown>[];
    if (!p[0]) throw new BotError(404, '답글을 달 메시지를 찾지 못했습니다.');
    threadRoot = p[0].parent_id == null ? Number(p[0].id) : Number(p[0].parent_id);
  }

  const rows = await sql.unsafe(
    `insert into workspace.messages (channel_id, parent_id, user_id, author_name, author_kind, content)
       values ($1, $2, null, $3, 'ai', $4) returning *`,
    [ch.id, threadRoot, author, content],
  ) as unknown as Record<string, unknown>[];
  const message = asMessage(rows[0]);
  notify({ id: ch.id, name: ch.name, kind: 'channel' }, message);
  return { channel: ch, message: publicMessage(message) };
}

// ---------- /bot/* 라우팅 ----------
const q_int = (v: string | null): number | null => {
  const n = Number(v);
  return v != null && v !== '' && Number.isInteger(n) && n > 0 ? n : null;
};
const q_str = (v: string | null, max = 80) => String(v ?? '').trim().slice(0, max);

/** /bot/... 요청 하나를 처리한다. 열쇠 확인은 부르는 쪽(index.ts)이 먼저 한다 */
export async function botApi(sql: Sql, req: Request, path: string, notify: Notify): Promise<Reply> {
  const p = path.replace(/\/+$/, '') || API;
  const qs = new URL(req.url).searchParams;

  if (p === `${API}/channels` && req.method === 'GET') {
    const list = await channels(sql);
    return { status: 200, body: { count: list.length, channels: list } };
  }

  if (p === `${API}/messages` && req.method === 'GET') {
    const out = await readMessages(sql, {
      channel_id: q_int(qs.get('channel_id')),
      slug: q_str(qs.get('slug') ?? qs.get('channel_slug')),
      parent_id: q_int(qs.get('parent_id')),
      since_id: q_int(qs.get('since_id')),
      limit: q_int(qs.get('limit')),
    });
    if (!out) throw new BotError(404, '채널을 찾지 못했습니다. channel_id 또는 slug 를 확인하세요 (공개 채널만 열립니다).');
    return { status: 200, body: out };
  }

  if (p === `${API}/messages` && req.method === 'POST') {
    const raw = await req.text();
    if (raw.length > 32_000) throw new BotError(413, '요청이 너무 큽니다.');
    let b: Record<string, unknown>;
    try { b = JSON.parse(raw || '{}') as Record<string, unknown>; } catch { throw new BotError(400, 'JSON 형식이 아닙니다.'); }
    const out = await postMessage(sql, notify, {
      channel_id: q_int(b.channel_id == null ? null : String(b.channel_id)),
      slug: q_str(b.slug == null ? null : String(b.slug), 80),
      content: String(b.content ?? ''),
      parent_id: q_int(b.parent_id == null ? null : String(b.parent_id)),
      author_name: String(b.author_name ?? ''),
    });
    return { status: 201, body: out };
  }

  if (p === `${API}/search` && req.method === 'GET') {
    const query = q_str(qs.get('q') ?? qs.get('query'), 100);
    if (!query) throw new BotError(400, '찾을 말(q)이 필요합니다.');
    const results = await search(sql, query, q_int(qs.get('limit')));
    return { status: 200, body: { query, count: results.length, results } };
  }

  throw new BotError(404, '없는 경로입니다.');
}

// ---------- MCP ----------
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'bmr-workspace-mcp', version: '1.0.0' };
const INSTRUCTIONS =
  '별무리학교 교내 워크스페이스(슬랙형)의 공개 채널을 읽고 쓰는 도구입니다. DM 과 개인 AI 방은 열리지 않습니다. '
  + '먼저 list_channels 로 채널 목록을 보고, read_messages 로 최근 대화를 읽은 뒤 send_message 로 답하세요. '
  + '글은 선생님들이 실제로 보는 채널에 그대로 올라가니 꼭 필요할 때만 쓰세요.';

type ToolDef = { name: string; title: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> };

const CHANNEL_ARGS = {
  channel_slug: { type: 'string', description: '채널 주소 이름 (예: "general", "class-share"). channel_id 대신 쓸 수 있습니다.' },
  channel_id: { type: 'integer', minimum: 1, description: '채널 번호. list_channels 에서 확인합니다.' },
};

const TOOLS: ToolDef[] = [
  {
    name: 'list_channels',
    title: '채널 목록',
    description: '워크스페이스의 공개 채널(#채널) 목록을 돌려줍니다. DM·AI 방은 나오지 않습니다.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'read_messages',
    title: '메시지 읽기',
    description: '공개 채널의 메시지를 최근 것부터 읽습니다. parent_id 를 주면 그 글의 스레드 답글을, '
      + 'since_id 를 주면 그 번호보다 새 메시지를 오래된 순서로 돌려줍니다.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CHANNEL_ARGS,
        parent_id: { type: 'integer', minimum: 1, description: '스레드 원글 번호. 주면 그 답글만 읽습니다.' },
        since_id: { type: 'integer', minimum: 1, description: '이 번호보다 큰(새) 메시지만 읽습니다.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: '가져올 개수 (기본 30, 최대 100).' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'send_message',
    title: '메시지 보내기',
    description: '공개 채널에 메시지를 남기거나(parent_id 없이) 그 글의 스레드에 답글을 답니다. '
      + '보내면 채널 사람들에게 알림이 갑니다. 글은 실제 화면에 그대로 보이니 필요한 말만 쓰세요.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CHANNEL_ARGS,
        content: { type: 'string', minLength: 1, maxLength: MAX_BOT_CONTENT, description: '보낼 글 (4000자까지).' },
        parent_id: { type: 'integer', minimum: 1, description: '스레드에 달려면 원글 번호.' },
        author_name: { type: 'string', maxLength: 80, description: '보이는 이름 (기본 "Alter (AI)").' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'search_messages',
    title: '메시지 검색',
    description: '공개 채널의 메시지에서 말을 찾습니다 (대소문자 구분 없음). 최근 것부터 돌려줍니다.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 100, description: '찾을 말.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: '가져올 개수 (기본 20, 최대 100).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

class ToolError extends Error {}

const rpcError = (id: unknown, code: number, message: string) =>
  ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcOk = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });

const argInt = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const argStr = (v: unknown, max = 200): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** 도구 하나 실행. 잘못된 요청은 ToolError 로 던져 isError 결과로 돌려준다 */
async function callTool(sql: Sql, notify: Notify, name: string, rawArgs: unknown): Promise<string> {
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  switch (name) {
    case 'list_channels': {
      const list = await channels(sql);
      return JSON.stringify({ count: list.length, channels: list }, null, 2);
    }
    case 'read_messages': {
      const out = await readMessages(sql, {
        channel_id: argInt(args.channel_id),
        slug: argStr(args.channel_slug ?? args.slug),
        parent_id: argInt(args.parent_id),
        since_id: argInt(args.since_id),
        limit: argInt(args.limit),
      });
      if (!out) throw new ToolError('채널을 찾지 못했습니다. channel_slug 또는 channel_id 를 확인하세요 — list_channels 로 목록을 볼 수 있습니다.');
      return JSON.stringify(out, null, 2);
    }
    case 'send_message': {
      const content = argStr(args.content, MAX_BOT_CONTENT * 2);
      if (!content) throw new ToolError('보낼 내용(content)이 비어 있습니다.');
      const out = await postMessage(sql, notify, {
        channel_id: argInt(args.channel_id),
        slug: argStr(args.channel_slug ?? args.slug),
        content,
        parent_id: argInt(args.parent_id),
        author_name: argStr(args.author_name, 80),
      });
      return JSON.stringify({ ok: true, ...out }, null, 2);
    }
    case 'search_messages': {
      const query = argStr(args.query, 100);
      if (!query) throw new ToolError('찾을 말(query)이 필요합니다.');
      const results = await search(sql, query, argInt(args.limit));
      return JSON.stringify({ query, count: results.length, results }, null, 2);
    }
    default:
      throw new ToolError(`없는 도구입니다: ${name}`);
  }
}

type Rpc = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

/** JSON-RPC 한 건 처리. 알림(id 없음)이면 null 을 돌려준다(본문 없이 202) */
async function handleRpc(sql: Sql, notify: Notify, rpc: Rpc): Promise<Record<string, unknown> | null> {
  const id = rpc.id;
  const method = typeof rpc.method === 'string' ? rpc.method : '';
  const params = (rpc.params && typeof rpc.params === 'object' ? rpc.params : {}) as Record<string, unknown>;
  const isNotification = id === undefined || id === null;

  if (!method) return isNotification ? null : rpcError(id, -32600, 'method 가 없습니다.');

  switch (method) {
    case 'initialize': {
      // 모르는 판이 와도 우리가 아는 가장 새 판으로 답한다 (엄격한 클라이언트는 여기서 판을 맞춘다)
      const asked = String(params.protocolVersion ?? '').trim();
      const version = PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0];
      return rpcOk(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return rpcOk(id, {});
    case 'tools/list':
      return rpcOk(id, { tools: TOOLS });
    case 'tools/call': {
      const name = String(params.name ?? '');
      if (!name) return rpcError(id, -32602, '도구 이름(name)이 필요합니다.');
      try {
        const text = await callTool(sql, notify, name, params.arguments);
        return rpcOk(id, { content: [{ type: 'text', text }] });
      } catch (e) {
        const message = (e as Error)?.message ?? String(e);
        // 도구 실행 실패는 JSON-RPC 오류가 아니라 결과(isError)로 알린다 (MCP 규칙)
        return rpcOk(id, { content: [{ type: 'text', text: message }], isError: true });
      }
    }
    default:
      return isNotification ? null : rpcError(id, -32601, `지원하지 않는 method 입니다: ${method}`);
  }
}

export type McpCors = Record<string, string>;

/** 세션을 두지 않으므로 늘 같은 이름을 쓴다 — 세션 아이디를 꼭 받아야 하는 클라이언트용 */
const MCP_SESSION = 'bmrws-stateless-1';
const sessionId = (req: Request) => (req.headers.get('mcp-session-id') ?? '').trim() || MCP_SESSION;

const KEEPALIVE_MS = 15_000;
const MAX_KEEPALIVES = 4; // 60초품 뒤 조용히 닫는다 — 열어 둔 연결이 계속 쌓이지 않게

/**
 * GET /mcp 자리의 SSE 스트림.
 * 이 서버는 먼저 보낼 말이 없지만, 2025-03-26/2025-06-18 규격에서 GET 은 스트림을 여는 자리다.
 * 405 를 오류로 받아들이는 엄격한 클라이언트가 있어 200 text/event-stream 으로 열고
 * `: connected` 주석만 보낸 뒤 15초마다 keepalive 를 보내다가 스스로 닫는다.
 * 클라이언트가 끊으면 cancel() 에서 타이머를 정리한다.
 */
function sseStream(): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let done = false;
  const stop = () => {
    done = true;
    if (timer !== undefined) { clearInterval(timer); timer = undefined; }
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        if (done) return false;
        try { controller.enqueue(enc.encode(text)); return true; } catch { stop(); return false; }
      };
      send(': connected\n\n');
      let sent = 0;
      timer = setInterval(() => {
        if (done) return;
        sent += 1;
        if (sent > MAX_KEEPALIVES) {
          stop();
          try { controller.close(); } catch { /* 이미 닫힘 */ }
          return;
        }
        send(': keepalive\n\n');
      }, KEEPALIVE_MS);
    },
    cancel() { stop(); },
  });
}

/** /mcp 요청 하나. 열쇠 확인은 부르는 쪽이 먼저 하고, 여기서는 JSON-RPC 만 다룬다 */
export async function mcpApi(
  sql: Sql, req: Request, notify: Notify, cors: McpCors,
): Promise<Reply> {
  const sid = sessionId(req);
  const session: Record<string, string> = { ...cors, 'Mcp-Session-Id': sid, 'Cache-Control': 'no-store' };
  // 클라이언트가 아는 판을 보낸 경우에만 그 판을 되돌려준다 (모르는 값은 흉내내지 않는다)
  const asked = (req.headers.get('mcp-protocol-version') ?? '').trim();
  if (PROTOCOLS.includes(asked)) session['MCP-Protocol-Version'] = asked;

  const base = { ...session, 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };

  if (req.method === 'GET') {
    // 보낼 이벤트는 없지만 스트림 자리를 열어 준다 (405 는 엄격한 클라이언트가 연결 실패로 본다)
    return {
      status: 200, body: null,
      headers: { ...session, 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' },
      stream: sseStream(),
    };
  }
  if (req.method === 'DELETE') {
    // 무상태라 정리할 세션이 없다
    return { status: 204, body: null, headers: session };
  }
  if (req.method !== 'POST') {
    return { status: 405, body: rpcError(null, -32000, 'GET·POST·DELETE 만 받습니다.'), headers: { ...base, Allow: 'GET, POST, DELETE' } };
  }

  const raw = await req.text();
  if (raw.length > 64_000) return { status: 413, body: rpcError(null, -32600, '요청이 너무 큽니다.'), headers: base };

  let parsed: unknown;
  try { parsed = JSON.parse(raw || 'null'); } catch {
    return { status: 400, body: rpcError(null, -32700, 'JSON 형식이 아닙니다.'), headers: base };
  }

  // 여러 건을 한 번에 보내는 경우(JSON-RPC batch)도 받아 준다
  if (Array.isArray(parsed)) {
    if (!parsed.length) return { status: 400, body: rpcError(null, -32600, '빈 배열입니다.'), headers: base };
    const out: Record<string, unknown>[] = [];
    for (const one of parsed) {
      const r = await handleRpc(sql, notify, one as Rpc);
      if (r) out.push(r);
    }
    if (!out.length) return { status: 202, body: null, headers: session };
    return { status: 200, body: out, headers: base };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { status: 400, body: rpcError(null, -32600, 'JSON-RPC 요청이 아닙니다.'), headers: base };
  }
  const out = await handleRpc(sql, notify, parsed as Rpc);
  if (!out) return { status: 202, body: null, headers: session }; // 알림은 본문 없이 202
  return { status: 200, body: out, headers: base };
}

/** 봇이 쓴 글에 붙는 안내 — index.ts 의 push 제목·본문 만들기에서 이름을 알아보는 데 쓴다 */
export const botAuthorLooksLikeAi = (name: string) => KNOWN_AI.test(name) || /\(AI\)/i.test(name);
