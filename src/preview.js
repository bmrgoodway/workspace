// 미리보기(연습)용 백엔드 — 서버 함수가 아직 배포되지 않았거나 AI 열쇠가 없을 때도
// 화면 전체를 그대로 써 볼 수 있게, 이 브라우저 안에서만 도는 가짜 데이터로 같은 모양의 답을 돌려줍니다.
// 아무것도 저장하지 않습니다(새로 고치면 처음 상태로 돌아갑니다).

const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 1000;

const ME = {
  // 미리보기에서는 관리자로 둔다 — 🛠️ 관리 창(멤버·채널·연동)을 그대로 둘러볼 수 있게 (실제 열쇠는 만들지 않음)
  id: 'u-me', email: 'preview@bmrschool.net', name: '나 (미리보기)', role: 'admin',
  avatar_color: '#ffdc1a', last_seen_at: iso(Date.now()), disabled_at: null,
};
const MEMBERS = [
  { id: 'u-haneul', email: 'haneul@bmrschool.org', name: '김하늘', role: 'member', avatar_color: '#0abbee', last_seen_at: iso(Date.now() - 40 * MIN), disabled_at: null },
  { id: 'u-seoyun', email: 'seoyun@bmrschool.org', name: '이서윤', role: 'member', avatar_color: '#02c245', last_seen_at: iso(Date.now() - 95 * MIN), disabled_at: null },
  { id: 'u-junho', email: 'junho@bmrschool.org', name: '박준호', role: 'member', avatar_color: '#7e65c1', last_seen_at: iso(Date.now() - 300 * MIN), disabled_at: null },
  { id: 'u-minji', email: 'minji@bmrschool.org', name: '최민지', role: 'member', avatar_color: '#ff614a', last_seen_at: iso(Date.now() - 26 * 60 * MIN), disabled_at: null },
  { id: 'u-sujin', email: 'sujin@bmrschool.net', name: '한수진', role: 'admin', avatar_color: '#b0e7f8', last_seen_at: iso(Date.now() - 12 * MIN), disabled_at: null },
  ME,
];

const CHANNELS = [
  { id: 1, slug: 'general', name: '일반', kind: 'channel', description: '모두에게 알리는 이야기', dm_key: null, created_at: iso(Date.now() - 3 * 24 * 60 * MIN) },
  { id: 2, slug: 'class-share', name: '수업-나눔', kind: 'channel', description: '수업 아이디어와 자료를 나눠요', dm_key: null, created_at: iso(Date.now() - 3 * 24 * 60 * MIN) },
  { id: 3, slug: 'ai-lounge', name: 'AI-라운지', kind: 'channel', description: '@AI 를 부르면 Alter 가 답글을 달아 줘요', dm_key: null, created_at: iso(Date.now() - 3 * 24 * 60 * MIN) },
  { id: 4, slug: 'ai-u-me', name: '🤖 Alter (AI)', kind: 'ai', description: 'Alter 와 1:1로 묻고 답하는 나만의 방', dm_key: 'ai:u-me', created_at: iso(Date.now() - 3 * 24 * 60 * MIN) },
  { id: 5, slug: 'dm-u-haneul', name: '김하늘', kind: 'dm', description: '', dm_key: 'dm:u-haneul:u-me', created_at: iso(Date.now() - 2 * 24 * 60 * MIN) },
];

function seedMessages() {
  const t = (mins) => iso(Date.now() - mins * MIN);
  const m = (channel_id, author, content, mins, parent_id = null, kind = 'user') => ({
    id: ++seq, channel_id, parent_id, user_id: kind === 'ai' ? null : (MEMBERS.find((x) => x.name === author) || ME).id,
    author_name: author, author_kind: kind, content, created_at: t(mins), reply_count: 0,
  });
  const list = [
    m(1, '김하늘', '이번 주 금요일 6교시에 전체 자율활동 시간이 있어요. 각 반에서 안내 부탁드립니다.', 320),
    m(1, '이서윤', '확인했습니다. 2학년은 진로 활동으로 잡아 두었어요.', 306),
    m(1, '나 (미리보기)', '10학년은 별드림관에서 독서 토론으로 진행하겠습니다.', 240),
    m(1, '박준호', '이번 주 과학실 정리 도와주실 분 계실까요? 금요일 방과 후면 좋겠습니다.', 120),
    m(1, '최민지', '제가 금요일 4시에 갈 수 있어요. 실험 기구는 어디에 모아 둘까요?', 62),
    m(2, '이서윤', '중핵 수업 3차시에서 "질문 만들기" 활동을 넣어 봤는데 반응이 좋았어요.', 180),
    m(2, '김하늘', '질문 카드 템플릿 공유해 주실 수 있나요? 수학에도 써 보고 싶어요.', 150),
    m(2, '나 (미리보기)', '저도 다음 주에 비슷한 활동을 해 보려고 합니다. @AI 도움 받아 루브릭을 다듬어 볼게요.', 95),
    m(3, '나 (미리보기)', '국어 수업에서 짧은 글쓰기 피드백을 효율적으로 주는 방법이 있을까요?', 200),
    m(3, 'Alter', '**세 단계로 나눠 보세요.**\n\n- **1단계(즉시)**: 맞춤법·문장부호만 표시 (기호 3개 이내)\n- **2단계(수업 중)**: "좋은 점 1 + 고칠 점 1"을 쪽지로\n- **3단계(다음 시간)**: 모둠에서 서로 읽고 한 줄 코멘트\n\n한 번에 다 고치려 하면 선생님도 지치고 학생도 문장만 보게 됩니다. 오늘은 1단계만 해 보시고, 다음 시간에 3단계를 붙여 보세요.', 192, null, 'ai'),
    m(4, 'Alter', '안녕하세요, Alter 입니다. 수업 준비, 문서 정리, 일정 확인처럼 손이 가는 일을 도와드려요. 편하게 물어보세요. 🙂', 260, null, 'ai'),
    m(5, '김하늘', '선생님, 내일 3교시 자료 출력실에 맡겨 둘까요?', 80),
  ];
  // 스레드 예시: 수업-나눔의 질문 카드 글에 답글 2개
  const parent = list.find((x) => x.content.startsWith('중핵 수업 3차시'));
  list.push(m(2, '김하늘', '좋아요! 템플릿 감사합니다. 수학은 "왜 그렇게 생각했나요?" 카드로 바꿔 써 볼게요.', 140, parent.id));
  list.push(m(2, '이서윤', '그 표현 좋네요. 다음 주 공유 때 같이 이야기해요.', 130, parent.id));
  for (const p of list) if (p.parent_id) { const par = list.find((x) => x.id === p.parent_id); if (par) par.reply_count += 1; }
  return list.sort((a, b) => a.id - b.id);
}

let db = null;
let unreadState = {};
let tokenState = [];
let inviteState = [];
function reset() {
  db = {
    members: MEMBERS.map((m) => ({ ...m })),
    channels: CHANNELS.map((c) => ({ ...c, pinned_message_id: null })),
    messages: seedMessages(),
  };
  // 연습용 안 읽은 배지 (2번 #수업-나눔 2개, 5번 김하늘 DM 1개)
  unreadState = { 2: 2, 5: 1 };
  // 관리자 화면 연습용: 대기 중인 초대 하나 + 차단된 멤버 하나
  inviteState = [{ email: 'guest.teacher@gmail.com', name: '외부 강사', role: 'member', created_at: iso(Date.now() - 90 * MIN) }];
  const blocked = db.members.find((m) => m.id === 'u-junho');
  if (blocked) blocked.disabled_at = iso(Date.now() - 30 * MIN);
  // #일반 의 첫 메시지를 공지로 고정해 둔 상태 (공지 띠 연습)
  const noted = db.messages.find((m) => m.channel_id === 1 && m.parent_id == null);
  const general = db.channels.find((c) => c.slug === 'general');
  if (noted && general) general.pinned_message_id = noted.id;
  tokenState = [{
    id: 1, name: '피클 (Alter)', token_prefix: 'bmrws_Pr3v1w',
    created_at: iso(Date.now() - 6 * 60 * MIN), last_used_at: iso(Date.now() - 2 * MIN), revoked_at: null,
  }];
}

function unreadList() {
  return Object.entries(unreadState).map(([id, n]) => ({ channel_id: Number(id), unread: Number(n), last_id: 0 }));
}

function aiReply(text, channelName, attachments = []) {
  const t = text.replace(/@\s?(ai|alter)/gi, '').trim();
  const files = Array.isArray(attachments) ? attachments : [];
  if (files.length && !t) {
    const names = files.map((f) => f.name).join(', ');
    return [
      `첨부해 주신 **${files.length}개 파일**(${names})을 받았어요.`,
      '',
      '실제 워크스페이스에서는 사진·파일도 이 채널 사람들이 함께 보고 내려받을 수 있고, 저는 **파일 이름과 종류만** 알 수 있어(내용은 볼 수 없어요) 내용에 대한 설명은 글로 남겨 주시면 좋아요.',
      '',
      '지금은 **미리보기**라 예시로만 답하고 있어요. (미리보기 예시 답변)',
    ].join('\n');
  }
  const hello = /^(안녕|하이|hello|hi)/i.test(t);
  const askEval = /(평가|루브릭|채점|피드백)/.test(t);
  const askPlan = /(수업|차시|활동|아이디어|설계)/.test(t);
  const askWhen = /(일정|언제|날짜|시간)/.test(t);
  const askSummary = /(요약|정리)/.test(t);

  if (hello) {
    return '안녕하세요! 지금은 **미리보기**라 정해진 예시로 답하고 있어요.\n\n실제 대화에서는 이 워크스페이스의 흐름을 읽고 답합니다. 오른쪽 아래 `@AI` 버튼으로 불러 보세요.';
  }
  if (askEval) {
    return [
      '평가 기준은 **관찰 가능한 행동**으로 세 문장만 만들어 보세요.',
      '',
      '1. **내용** — 주제에 맞는 근거를 2가지 이상 댄다.',
      '2. **구성** — 처음·가운데·끝이 드러나게 쓴다.',
      '3. **태도** — 동료의 글을 읽고 한 줄 이상 반응한다.',
      '',
      `> "${t.slice(0, 40)}" 에 맞춰 4단계(상·중·하·노력 필요)로만 나누면 채점이 빨라집니다.`,
      '',
      '원하시면 이 기준으로 학생용 체크리스트 문장까지 만들어 드릴게요. (미리보기 예시 답변)',
    ].join('\n');
  }
  if (askPlan) {
    return [
      '**한 차시로 줄여 보는 구성**을 제안합니다.',
      '',
      '- **도입 5분** — 지난 시간 결과물 한 장을 보여 주고 "무엇이 달라졌나" 묻기',
      '- **전개 30분** — 모둠별 질문 카드 3장 만들기 → 서로 바꿔 답하기',
      '- **정리 10분** — 가장 좋은 질문 1개를 칠판에 붙이고 이유 말하기',
      '',
      '준비물은 A5 카드와 마커면 충분합니다. 학생 수가 많으면 카드 수를 2장으로 줄이세요. (미리보기 예시 답변)',
    ].join('\n');
  }
  if (askWhen) {
    return [
      '학교 일정은 제가 임의로 말씀드리면 안 되는 부분이라, **캘린더나 학사일정표**로 확인해 주세요.',
      '',
      '- 이번 주 일정은 BMR APPS 캘린더에서 확인',
      '- 변경된 일정은 이 채널에 공지로 남기기',
      '',
      '원하시면 공지 문장 초안은 만들어 드릴 수 있어요. (미리보기 예시 답변)',
    ].join('\n');
  }
  if (askSummary) {
    return [
      `**${channelName} 요약 (예시)**`,
      '',
      '- 금요일 자율활동 시간 안내 — 반별 진행 확인 필요',
      '- 과학실 정리 도움 요청 — 금요일 방과 후',
      '- 수업 나눔: 질문 카드 활동 공유',
      '',
      '실제 모드에서는 이 채널의 최근 대화 12개를 읽고 정리합니다. (미리보기 예시 답변)',
    ].join('\n');
  }
  return [
    `"${t.slice(0, 60)}" 에 대해 정리해 봤어요.`,
    '',
    '- **먼저 확인할 것** — 지금 상황에서 꼭 필요한 자료가 무엇인지 한 가지로 좁히기',
    '- **바로 할 수 있는 일** — 10분 안에 끝나는 작은 단계 하나 정하기',
    '- **다음 사람에게 넘길 것** — 공유가 필요한 부분은 이 채널에 한 줄로 남기기',
    '',
    '이 답변은 **미리보기용 예시**입니다. 실제 모드에서는 대화 맥락을 읽고 더 구체적으로 답해요.',
  ].join('\n');
}

function channelOf(id) { return db.channels.find((c) => c.id === Number(id)); }
function findMessage(id) { return db.messages.find((m) => m.id === Number(id)); }
function publicMessage(m) { return { ...m, reply_count: db.messages.filter((r) => r.parent_id === m.id).length }; }
/** 채널 + 공지로 고정한 메시지 (실제 서버 응답과 같은 모양) */
function channelOut(c) {
  const pin = c.pinned_message_id ? findMessage(c.pinned_message_id) : null;
  return {
    ...c,
    pinned_message_id: c.pinned_message_id == null ? null : Number(c.pinned_message_id),
    pinned_message: pin ? publicMessage(pin) : null,
    unread: unreadState[c.id] || 0,
  };
}
const emailOk = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

export const previewApi = {
  mode: 'preview',
  label: '미리보기',

  async bootstrap() {
    reset();
    const me = db.members.find((m) => m.id === ME.id) || ME;
    return {
      me: { ...me },
      members: db.members.map((m) => ({ ...m })),
      channels: db.channels.map(channelOut),
      gemini_key_set: false,
      preview: true,
    };
  },

  async messages(channelId) {
    const ch = channelOf(channelId);
    if (!ch) throw new Error('없는 채널입니다.');
    return {
      channel_id: Number(channelId),
      channel: channelOut(ch),
      messages: db.messages.filter((m) => m.channel_id === Number(channelId) && m.parent_id == null)
        .sort((a, b) => a.id - b.id).map(publicMessage),
      unread: unreadList(),
    };
  },

  async thread(channelId, parentId) {
    const parent = findMessage(parentId);
    if (!parent) throw new Error('스레드의 원래 메시지를 찾지 못했습니다.');
    const ch = channelOf(channelId);
    return {
      channel_id: Number(channelId),
      channel: ch ? channelOut(ch) : null,
      parent: publicMessage(parent),
      messages: db.messages.filter((m) => m.parent_id === Number(parentId)).sort((a, b) => a.id - b.id).map(publicMessage),
      unread: unreadList(),
    };
  },

  async markRead(channelId) {
    delete unreadState[Number(channelId)];
    return { ok: true, channel_id: Number(channelId), last_read_id: 0 };
  },

  async post({ channelId, content, parentId, attachments }) {
    const ch = channelOf(channelId);
    if (!ch) throw new Error('없는 채널입니다.');
    const text = String(content || '').trim();
    const atts = (Array.isArray(attachments) ? attachments : []).slice(0, 5).map((a) => ({
      path: String(a.path || ''), name: String(a.name || '파일'),
      mime: String(a.mime || 'application/octet-stream'), size: Number(a.size) || 0,
      ...(a.url ? { url: a.url } : {}),
    })).filter((a) => a.path);
    if (!text && !atts.length) throw new Error('메시지 내용을 적거나 사진·파일을 붙여 주세요.');
    let root = null;
    if (parentId != null) root = findMessage(parentId) ? (findMessage(parentId).parent_id ?? Number(parentId)) : null;

    const msg = {
      id: ++seq, channel_id: Number(channelId), parent_id: root, user_id: ME.id,
      author_name: ME.name, author_kind: 'user', content: text, attachments: atts,
      created_at: iso(Date.now()), reply_count: 0,
    };
    db.messages.push(msg);

    const wantsAi = ch.kind === 'ai' || /@\s?(ai|alter)\b/i.test(text);
    if (!wantsAi) return { message: publicMessage(msg), ai: null };

    await sleep(700);
    const aiParent = root != null ? root : (ch.kind === 'ai' ? null : msg.id);
    const ai = {
      id: ++seq, channel_id: Number(channelId), parent_id: aiParent, user_id: null,
      author_name: 'Alter', author_kind: 'ai', content: aiReply(text, ch.kind === 'channel' ? '#' + ch.name : ch.name, atts),
      created_at: iso(Date.now()), reply_count: 0, source: 'preview',
    };
    db.messages.push(ai);
    return { message: publicMessage(msg), ai: publicMessage(ai) };
  },

  async createChannel({ name, description }) {
    const clean = String(name || '').replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!clean) throw new Error('채널 이름을 적어 주세요.');
    const ch = {
      id: ++seq, slug: 'c-' + seq, name: clean, kind: 'channel',
      description: String(description || '').trim().slice(0, 200), dm_key: null, created_at: iso(Date.now()),
      pinned_message_id: null,
    };
    db.channels.push(ch);
    return { channel: channelOut(ch) };
  },

  async openDm(targetUserId) {
    const other = db.members.find((m) => m.id === targetUserId);
    if (!other) throw new Error('상대를 찾지 못했습니다.');
    const key = ['dm', ME.id, other.id].sort().join(':');
    const found = db.channels.find((c) => c.dm_key === key || c.dm_key === `dm:${other.id}:${ME.id}`);
    if (found) return { channel: channelOut(found) };
    const ch = { id: ++seq, slug: 'dm-' + seq, name: other.name, kind: 'dm', description: '', dm_key: key, created_at: iso(Date.now()), pinned_message_id: null };
    db.channels.push(ch);
    return { channel: channelOut(ch) };
  },

  // 미리보기는 실시간 구독이 없습니다 (5초 폴링도 필요 없음)
  subscribe() { return () => {}; },

  // ---------- 연동 열쇠 (미리보기: 실제로는 만들지 않고 모양만) ----------
  async botTokens() {
    return { tokens: tokenState.map((t) => ({ ...t })), env_token: false, preview: true };
  },

  async issueBotToken(name) {
    const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!clean) throw new Error('열쇠 이름을 적어 주세요.');
    const token = 'bmrws_preview_' + Math.random().toString(36).slice(2, 12);
    const row = {
      id: ++seq, name: clean, token_prefix: token.slice(0, 12),
      created_at: iso(Date.now()), last_used_at: null, revoked_at: null,
    };
    tokenState.unshift(row);
    return { ...row, token, preview: true };
  },

  async revokeBotToken(id) {
    const row = tokenState.find((t) => t.id === Number(id));
    if (!row) throw new Error('없는 열쇠입니다.');
    if (row.revoked_at) throw new Error('이미 폐기된 열쇠입니다.');
    row.revoked_at = iso(Date.now());
    return { ok: true, id: row.id, revoked_at: row.revoked_at };
  },

  // ---------- 관리자 콘솔 (미리보기: 이 브라우저 안에서만 바뀌고 새로 고치면 처음 상태) ----------
  async adminMembers() {
    return {
      me: ME.id,
      members: db.members.map((m) => ({ ...m, user_id: m.id })),
      invites: inviteState.map((i) => ({ ...i })),
    };
  },

  async adminOverview() {
    const c = {
      members: db.members.length,
      disabled: db.members.filter((m) => m.disabled_at).length,
      admins: db.members.filter((m) => m.role === 'admin').length,
      invites: inviteState.length,
      channels: db.channels.filter((x) => x.kind === 'channel').length,
      dms: db.channels.filter((x) => x.kind === 'dm').length,
      messages: db.messages.length,
      push_subs: 0,
      bot_tokens: tokenState.filter((t) => !t.revoked_at).length,
    };
    return {
      counts: c,
      last_message_at: db.messages.length ? db.messages[db.messages.length - 1].created_at : null,
      ai: { key_set: false, model: 'gemini (미리보기)', last: null },
      push: false,
      mail_ready: true,
      mail: { ready: true, from: 'workspace@mail.bmrschool.net' },
      bot: { env_token: false },
      preview: true,
    };
  },

  async inviteMember({ email, name, role, sendEmail }) {
    const clean = String(email || '').trim().toLowerCase();
    if (!emailOk(clean)) throw new Error('이메일 주소를 확인해 주세요.');
    if (db.members.some((m) => m.email === clean)) throw new Error('이미 이 워크스페이스에 들어와 있는 메일이에요.');
    const row = {
      email: clean, name: String(name || '').trim().slice(0, 40),
      role: role === 'admin' ? 'admin' : 'member', created_at: iso(Date.now()),
    };
    const i = inviteState.findIndex((x) => x.email === clean);
    if (i >= 0) inviteState[i] = row; else inviteState.unshift(row);
    return {
      invite: { ...row },
      mail: sendEmail === false
        ? { sent: false, skipped: true }
        : { sent: true, from: 'workspace@mail.bmrschool.net', id: `preview-mail-${Date.now()}` },
    };
  },

  async resendInvite(email) {
    const clean = String(email || '').trim().toLowerCase();
    if (db.members.some((m) => m.email === clean)) throw new Error('이미 이 워크스페이스에 들어와 있는 메일이에요. 초대 메일을 보낼 필요가 없습니다.');
    const inv = inviteState.find((x) => x.email === clean);
    if (!inv) throw new Error('대기 중인 초대가 아니에요. 먼저 초대를 등록해 주세요.');
    return {
      ok: true, email: clean, invite: { ...inv },
      mail: { sent: true, from: 'workspace@mail.bmrschool.net', id: `preview-mail-${Date.now()}` },
    };
  },

  async removeInvite(email) {
    const clean = String(email || '').trim().toLowerCase();
    const i = inviteState.findIndex((x) => x.email === clean);
    if (i < 0) throw new Error('대기 중인 초대가 아니에요.');
    inviteState.splice(i, 1);
    return { ok: true, email: clean };
  },

  async updateMember({ userId, role, disabled }) {
    const m = db.members.find((x) => x.id === userId);
    if (!m) throw new Error('이 워크스페이스의 멤버가 아니에요.');
    if (userId === ME.id && (role === 'member' || disabled === true)) throw new Error('내 계정의 권한은 바꿀 수 없어요.');
    if (role === 'admin' || role === 'member') m.role = role;
    if (disabled !== undefined) m.disabled_at = disabled ? iso(Date.now()) : null;
    return { member: { ...m, user_id: m.id } };
  },

  async updateChannel({ channelId, name, description }) {
    const ch = channelOf(channelId);
    if (!ch || ch.kind !== 'channel') throw new Error('공개 채널만 고칠 수 있어요.');
    if (name !== undefined) {
      const clean = String(name || '').replace(/^#+/, '').trim().slice(0, 40);
      if (!clean) throw new Error('채널 이름을 적어 주세요.');
      ch.name = clean;
    }
    if (description !== undefined) ch.description = String(description || '').trim().slice(0, 200);
    return { channel: channelOut(ch) };
  },

  async deleteChannel(channelId) {
    const ch = channelOf(channelId);
    if (!ch || ch.kind !== 'channel') throw new Error('공개 채널만 지울 수 있어요.');
    if (ch.slug === 'general') throw new Error('#일반 채널은 지울 수 없어요.');
    const n = db.messages.filter((m) => m.channel_id === ch.id).length;
    db.messages = db.messages.filter((m) => m.channel_id !== ch.id);
    db.channels = db.channels.filter((x) => x.id !== ch.id);
    delete unreadState[ch.id];
    return { ok: true, id: ch.id, name: ch.name, messages: n };
  },

  async pinMessage({ channelId, messageId }) {
    const ch = channelOf(channelId);
    if (!ch) throw new Error('없는 채널입니다.');
    if (ch.kind !== 'channel') throw new Error('공지 고정은 공개 채널에서만 쓸 수 있어요.');
    if (messageId == null) {
      ch.pinned_message_id = null;
    } else {
      const m = findMessage(messageId);
      if (!m || m.channel_id !== ch.id) throw new Error('이 채널의 메시지가 아니에요.');
      if (m.parent_id != null) throw new Error('스레드 답글은 고정할 수 없어요.');
      ch.pinned_message_id = m.id;
    }
    return { channel: channelOut(ch) };
  },

  async deleteMessage(messageId) {
    const m = findMessage(messageId);
    if (!m) throw new Error('이미 지워졌거나 없는 메시지예요.');
    const replies = db.messages.filter((x) => x.parent_id === m.id).length;
    const unpinned = db.channels.some((c) => Number(c.pinned_message_id) === m.id);
    db.messages = db.messages.filter((x) => x.id !== m.id && x.parent_id !== m.id);
    for (const c of db.channels) if (Number(c.pinned_message_id) === m.id) c.pinned_message_id = null;
    return { ok: true, id: m.id, channel_id: m.channel_id, parent_id: m.parent_id, replies, unpinned };
  },

  reset,
};
