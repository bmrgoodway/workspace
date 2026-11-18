// 서버 함수(workspace-fn)와 이야기하는 클라이언트.
// 로그인 토큰을 붙여 부르고, 실패는 ApiError 로 감싸 화면에서 그대로 보여 줍니다.
import { supabase, FN_URL } from './supabase.js';

export class ApiError extends Error {
  constructor(message, status = 0, code = '') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function call(path, { method = 'GET', body } = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  const headers = { 'Content-Type': 'application/json' };
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
  let r;
  try {
    r = await fetch(FN_URL + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(75_000),
    });
  } catch {
    throw new ApiError('서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.', 0, 'network');
  }
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!r.ok) throw new ApiError((data && data.error) || `서버 오류 (${r.status})`, r.status, (data && data.code) || '');
  return data;
}

const q = (v) => encodeURIComponent(String(v));

export const liveApi = {
  mode: 'live',
  label: '연결됨',

  bootstrap: () => call('/bootstrap'),

  messages: (channelId) => call(`/messages?channel_id=${q(channelId)}`),

  thread: (channelId, parentId) => call(`/messages?channel_id=${q(channelId)}&parent_id=${q(parentId)}`),

  post: ({ channelId, content, parentId, attachments }) => call('/messages', {
    method: 'POST',
    body: { channel_id: channelId, content, parent_id: parentId ?? null, attachments: attachments ?? [] },
  }),

  createChannel: ({ name, description }) => call('/channels', {
    method: 'POST',
    body: { kind: 'channel', name, description },
  }),

  openDm: (targetUserId) => call('/channels', {
    method: 'POST',
    body: { kind: 'dm', target_user_id: targetUserId },
  }),

  /** 새 메시지 알림 (Realtime). 실패해도 폴링이 받아 줍니다. */
  subscribe(onInsert) {
    let ch = null;
    try {
      ch = supabase.channel('workspace:messages');
      ch.on('postgres_changes', { event: 'INSERT', schema: 'workspace', table: 'messages' }, (payload) => {
        onInsert((payload && payload.new) || null);
      }).subscribe();
    } catch (e) {
      console.warn('실시간 구독을 열지 못했습니다. 5초마다 새로 받아 옵니다.', e);
    }
    return () => { if (ch) { try { supabase.removeChannel(ch); } catch { /* 무시 */ } } };
  },

  // ---------- 알림(Web Push) ----------
  pushKey: () => call('/push/key'),

  pushSubscribe: (subscription) => call('/push/subscribe', {
    method: 'POST',
    body: { subscription },
  }),

  pushUnsubscribe: (endpoint) => call('/push/unsubscribe', {
    method: 'POST',
    body: { endpoint },
  }),

  // 지금 본 데까지 읽음 처리 (채널 배지 지우기)
  markRead: (channelId) => call('/channels/read', {
    method: 'POST',
    body: { channel_id: channelId },
  }),

  // ---------- 연동 열쇠 (관리자만) ----------
  botTokens: () => call('/bot/tokens'),

  issueBotToken: (name) => call('/bot/tokens', {
    method: 'POST',
    body: { name },
  }),

  revokeBotToken: (id) => call(`/bot/tokens/${q(id)}`, { method: 'DELETE' }),

  // ---------- 관리자 콘솔 (🛠️ 관리) ----------
  adminOverview: () => call('/admin/overview'),

  adminMembers: () => call('/admin/members'),

  inviteMember: ({ email, name, role, sendEmail }) => call('/admin/invites', {
    method: 'POST',
    // send_email 을 생략하면 서버가 '보냄'으로 본다. 체크를 푼 경우에만 false 로 보낸다.
    body: { email, name, role, ...(sendEmail === false ? { send_email: false } : {}) },
  }),

  resendInvite: (email) => call('/admin/invites/resend', {
    method: 'POST',
    body: { email },
  }),

  removeInvite: (email) => call(`/admin/invites/${q(email)}`, { method: 'DELETE' }),

  updateMember: ({ userId, role, disabled }) => call('/admin/members/update', {
    method: 'POST',
    body: { user_id: userId, role, disabled },
  }),

  updateChannel: ({ channelId, name, description }) => call('/channels/update', {
    method: 'POST',
    body: { channel_id: channelId, name, description },
  }),

  deleteChannel: (channelId) => call(`/channels/${q(channelId)}`, { method: 'DELETE' }),

  // 공지 고정 (messageId 가 null 이면 해제)
  pinMessage: ({ channelId, messageId }) => call('/messages/pin', {
    method: 'POST',
    body: { channel_id: channelId, message_id: messageId ?? null },
  }),

  deleteMessage: (messageId) => call(`/messages/${q(messageId)}`, { method: 'DELETE' }),
};
