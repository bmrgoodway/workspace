import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import './style.css';
import { applyAppInfo } from './app-info.js';
import { currentUser, onUserChange, loginWithGoogle, logout } from './auth.js';
import { liveApi } from './api.js';
import { previewApi } from './preview.js';
import { FN_URL } from './supabase.js';
import { Huddle } from './huddle.js';
import { renderMarkdown } from './markdown.js';
import { local } from './store.js';
import {
  MAX_FILES, MAX_FILE_BYTES, isImage, formatSize, previewAttachment, uploadAttachment, removeUploaded, fileUrl,
} from './files.js';

const $ = (id) => document.getElementById(id);
const TZ = 'Asia/Seoul';
const timeFmt = new Intl.DateTimeFormat('ko-KR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const fullFmt = new Intl.DateTimeFormat('ko-KR', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' });
const dayFmt = new Intl.DateTimeFormat('ko-KR', { timeZone: TZ, year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
const keyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const PALETTE = ['#ffdc1a', '#0abbee', '#02c245', '#ff614a', '#7e65c1', '#b0e7f8', '#fef1b8', '#a4e9bc'];
const BASE_PATH = import.meta.env.BASE_URL;

const S = {
  mode: null,          // 'live' | 'preview'
  api: null,
  me: null,
  members: [],
  channels: [],
  channelId: null,
  messages: [],
  threadOpen: false,
  threadParent: null,
  threadReplies: [],
  aiPending: false,
  aiPendingWhere: null,
  sending: false,
  starting: false,
  aiKeySet: true,
  hasSession: false,
  unread: {},
  pending: { channel: [], thread: [] }, // 아직 보내지 않은 첨부
  uploading: false,
  baseTitle: '별무리 워크스페이스 · BMR APPS',
  unsub: null,
  poll: null,
  reloadTimer: null,
  sig: '',
  tokens: [],
  newToken: '',
  adminTab: '',
  adminMembers: [],
  adminInvites: [],
  adminOverview: null,
  huddle: null,
  huddleChannelId: null,
  huddleBig: false,
  huddleCompact: false,
};

// ---------- 작은 도우미 ----------
const firstChar = (name) => {
  const s = String(name ?? '').trim();
  return s ? [...s][0] : '?';
};
const isSameDay = (a, b) => keyFmt.format(a) === keyFmt.format(b);
const dayKey = (iso) => keyFmt.format(new Date(iso));
const yesterday = () => new Date(Date.now() - 86_400_000);
function dayLabel(iso) {
  const d = new Date(iso);
  if (isSameDay(d, new Date())) return '오늘';
  if (isSameDay(d, yesterday())) return '어제';
  return dayFmt.format(d);
}
function colorOf(m) {
  const u = S.members.find((x) => x.id === m.user_id);
  if (u && u.avatar_color) return u.avatar_color;
  let h = 0;
  const s = String(m.author_name ?? '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
let toastTimer = null;
function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (kind === 'err' ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4600);
}
function showChatError(msg) {
  const e = $('chat-error');
  e.textContent = msg || '';
  e.hidden = !msg;
}

// ---------- 사진·파일 첨부 ----------
const pendingOf = (inThread) => (inThread ? S.pending.thread : S.pending.channel);

/** 텍스트 칸·화면에 고른 파일을 더한다 (한 번에 5개, 한 개 10MB 까지) */
function addFiles(fileList, inThread) {
  const list = pendingOf(inThread);
  let added = 0;
  for (const f of Array.from(fileList || [])) {
    if (!f) continue;
    if (list.length >= MAX_FILES) { toast(`첨부는 한 번에 ${MAX_FILES}개까지예요.`, 'err'); break; }
    if (f.size > MAX_FILE_BYTES) { toast(`«${f.name || '파일'}» 은(는) 10MB를 넘어 첨부할 수 없어요.`, 'err'); continue; }
    if (f.size === 0) { toast(`«${f.name || '파일'}» 이(가) 비어 있어요.`, 'err'); continue; }
    list.push({
      id: 'f-' + Math.random().toString(36).slice(2, 9),
      file: f, name: f.name || '파일', mime: f.type || '', size: f.size,
      preview: isImage(f.type) ? URL.createObjectURL(f) : '',
      state: 'ready', att: null,
    });
    added++;
  }
  if (!added) return;
  renderPending(inThread);
  updateComposer();
}

function dropPending(item, inThread) {
  const list = pendingOf(inThread);
  const i = list.indexOf(item);
  if (i >= 0) list.splice(i, 1);
  if (item.preview) { try { URL.revokeObjectURL(item.preview); } catch { /* 무시 */ } }
  renderPending(inThread);
  updateComposer();
}

function clearPending(inThread) {
  for (const item of pendingOf(inThread)) {
    if (item.preview) { try { URL.revokeObjectURL(item.preview); } catch { /* 무시 */ } }
  }
  S.pending[inThread ? 'thread' : 'channel'] = [];
  renderPending(inThread);
  updateComposer();
}

/** 보내기 전 고른 파일 미리보기 줄 */
function renderPending(inThread) {
  const box = $(inThread ? 'thread-files' : 'composer-files');
  if (!box) return;
  const list = pendingOf(inThread);
  box.textContent = '';
  box.hidden = list.length === 0;
  for (const item of list) {
    const chip = el('div', 'att-chip' + (item.state === 'uploading' ? ' busy' : ''));
    if (item.preview) {
      const im = document.createElement('img');
      im.className = 'att-chip-img';
      im.src = item.preview;
      im.alt = '';
      chip.appendChild(im);
    } else {
      chip.appendChild(el('span', 'att-chip-ico', '📄'));
    }
    const meta = el('div', 'att-chip-meta');
    meta.appendChild(el('b', 'att-chip-name', item.name));
    const state = item.state === 'uploading' ? '올리는 중…' : item.state === 'done' ? '올림' : formatSize(item.size);
    meta.appendChild(el('span', 'att-chip-size', state));
    chip.appendChild(meta);
    const x = el('button', 'att-chip-x', '✕');
    x.type = 'button';
    x.title = '첨부 빼기';
    x.setAttribute('aria-label', `${item.name} 첨부 빼기`);
    x.disabled = item.state === 'uploading';
    x.addEventListener('click', () => dropPending(item, inThread));
    chip.appendChild(x);
    box.appendChild(chip);
  }
}

// ---------- 사진 크게 보기 ----------
function openLightbox(url, att) {
  if (!url) return;
  const img = $('lightbox-img');
  img.src = url;
  img.alt = (att && att.name) || '사진';
  $('lightbox-name').textContent = (att && att.name) || '';
  $('lightbox-open').href = url;
  const dl = $('lightbox-download');
  dl.href = url;
  if (att && att.url) dl.download = att.name || '사진';
  else dl.removeAttribute('download');
  if (att && !att.url) {
    dl.href = '#';
    fileUrl(att, { download: true }).then((u) => { dl.href = u; }).catch(() => { dl.removeAttribute('href'); });
  }
  $('lightbox').hidden = false;
}
function closeLightbox() {
  const box = $('lightbox');
  if (!box || box.hidden) return;
  box.hidden = true;
  $('lightbox-img').src = '';
}

/** 메시지 안의 사진·파일 — 사진은 바로 보이고, 파일은 내려받는 카드 */
function attachmentsEl(atts) {
  const wrap = el('div', 'msg-atts');
  for (const att of atts) {
    if (!att || !att.path) continue;
    if (isImage(att.mime)) {
      const btn = el('button', 'att-img');
      btn.type = 'button';
      btn.setAttribute('aria-label', `${att.name || '사진'} — 크게 보기`);
      const ph = el('span', 'att-img-ph', '🖼️');
      const img = document.createElement('img');
      img.alt = att.name || '사진';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.hidden = true;
      btn.append(ph, img);
      const cap = el('span', 'att-img-cap', att.name || '');
      btn.appendChild(cap);
      btn.addEventListener('click', () => {
        if (img.src) { openLightbox(img.src, att); return; }
        toast('사진을 불러오는 중이에요. 잠시 뒤 다시 눌러 주세요.');
      });
      fileUrl(att).then((u) => { img.src = u; img.hidden = false; ph.hidden = true; })
        .catch(() => { ph.textContent = '🖼️ 사진을 불러오지 못했어요'; btn.disabled = true; });
      wrap.appendChild(btn);
    } else {
      const a = el('a', 'att-file');
      a.target = '_blank';
      a.rel = 'noreferrer noopener';
      if (att.url) a.download = att.name || '파일'; // 미리보기(blob 주소)는 새 탭을 못 열어 내려받기로 처리
      a.setAttribute('aria-label', `${att.name || '파일'} 내려받기 (${formatSize(att.size)})`);
      a.append(el('span', 'att-file-ico', '📄'));
      const meta = el('span', 'att-file-meta');
      meta.appendChild(el('b', 'att-file-name', att.name || '파일'));
      meta.appendChild(el('span', 'att-file-size', formatSize(att.size)));
      a.appendChild(meta);
      a.addEventListener('click', (e) => {
        if (a.href && a.getAttribute('href') !== '#') return;
        e.preventDefault();
        if (a.dataset.busy) return;
        a.dataset.busy = '1';
        fileUrl(att, { download: true }).then((u) => { a.href = u; a.dataset.busy = ''; a.click(); })
          .catch(() => { a.dataset.busy = ''; toast('첨부 파일을 열지 못했어요.', 'err'); });
      });
      fileUrl(att, { download: true }).then((u) => { a.href = u; }).catch(() => { /* 누를 때 다시 시도 */ });
      wrap.appendChild(a);
    }
  }
  return wrap;
}

// ---------- 안 읽은 배지(채널·DM·제목·메뉴) ----------
function totalUnread() {
  return Object.values(S.unread || {}).reduce((a, b) => a + (Number(b) || 0), 0);
}
function updateUnreadUi() {
  const total = totalUnread();
  document.title = total > 0 ? `(${total > 99 ? '99+' : total}) 별무리 워크스페이스` : S.baseTitle;
  const mb = $('menu-badge');
  if (mb) {
    mb.hidden = total === 0;
    mb.textContent = total > 99 ? '99+' : String(total);
  }
}
function setUnreadMap(list) {
  const map = {};
  for (const u of list || []) {
    if (!u || u.channel_id == null) continue;
    map[Number(u.channel_id)] = Number(u.unread || 0);
  }
  // 지금 보고 있는 채널은 안 읽은 것이 없다
  if (S.channelId && document.visibilityState === 'visible') map[S.channelId] = 0;
  const changed = JSON.stringify(map) !== JSON.stringify(S.unread);
  S.unread = map;
  if (changed) renderSidebar();
  updateUnreadUi();
}
function bumpUnread(channelId) {
  if (!channelId) return;
  S.unread[channelId] = (S.unread[channelId] || 0) + 1;
  renderSidebar();
  updateUnreadUi();
}
function incoming(msg) {
  if (!msg || (S.me && msg.user_id === S.me.id)) return;
  const cid = Number(msg.channel_id);
  if (!cid) return;
  if (document.visibilityState === 'visible' && cid === S.channelId) { scheduleMarkRead(); return; }
  bumpUnread(cid);
}

// ---------- 읽음 처리 ----------
let markTimer = null;
function scheduleMarkRead() {
  clearTimeout(markTimer);
  markTimer = setTimeout(() => { if (S.channelId) markRead(S.channelId); }, 400);
}
async function markRead(channelId) {
  if (!channelId) return;
  if (S.unread[channelId]) {
    S.unread[channelId] = 0;
    renderSidebar();
    updateUnreadUi();
  }
  if (S.mode !== 'live' || !S.api) return;
  try { await S.api.markRead(channelId); } catch { /* 다음 폴링에서 다시 맞춘다 */ }
}
const currentChannel = () => S.channels.find((c) => c.id === S.channelId) || null;

// ---------- 공지 고정 (채널 위 공지 띠) ----------
const pinnedOf = (ch) => (ch && ch.pinned_message ? ch.pinned_message : null);

function renderPin() {
  const box = $('pin-banner');
  if (!box) return;
  const c = currentChannel();
  const p = c && c.kind === 'channel' ? pinnedOf(c) : null;
  if (!p) { box.hidden = true; return; }
  $('pin-who').textContent = p.author_name || '공지';
  const text = String(p.content || '').replace(/\s+/g, ' ').trim();
  const files = (p.attachments || []).length;
  $('pin-text').textContent = text
    ? (text.length > 140 ? text.slice(0, 140) + '…' : text)
    : (files ? `📎 첨부 ${files}개` : '공지');
  $('pin-clear').hidden = !isAdmin();
  box.hidden = false;
}

/** 서버가 돌려준 채널 정보(이름·공지)를 화면 목록에 합친다 */
function mergeChannel(ch) {
  if (!ch || ch.id == null) return;
  const i = S.channels.findIndex((c) => c.id === Number(ch.id));
  if (i >= 0) S.channels[i] = { ...S.channels[i], ...ch };
  else S.channels.push(ch);
}

/** 지금 보고 있는 채널이면 머리줄·공지 띠·메시지까지 바로 다시 그린다 */
function applyChannel(ch) {
  if (!ch || ch.id == null) return;
  mergeChannel(ch);
  if (Number(ch.id) === S.channelId) {
    renderHeader();
    renderPin();
    S.sig = '';
    renderMessages();
  }
  renderSidebar();
}

async function setPin(channelId, messageId) {
  if (!S.api || !S.api.pinMessage || !channelId) return;
  try {
    const res = await S.api.pinMessage({ channelId, messageId });
    applyChannel(res.channel);
    toast(messageId ? '공지로 고정했어요. 채널 위에 모두 보입니다.' : '공지 고정을 해제했어요.');
  } catch (e) {
    toast(e.message || '고정하지 못했어요.', 'err');
  }
}

/** 공지·알림에서 그 메시지로 이동하며 잠깐 표시한다 */
function focusMessage(id) {
  const n = Number(id);
  const art = document.querySelector(`.messages .msg[data-id="${n}"]`);
  if (!art) {
    toast('그 메시지는 지금 목록(최근 200개)에 없어요. 스레드나 위쪽에서 찾아보세요.');
    return;
  }
  art.scrollIntoView({ block: 'center', behavior: 'smooth' });
  art.classList.remove('flash');
  void art.offsetWidth;
  art.classList.add('flash');
  setTimeout(() => art.classList.remove('flash'), 2000);
}

async function removeMessage(m, btn) {
  const own = Boolean(S.me && m.user_id === S.me.id);
  const ask = own
    ? '이 메시지를 지울까요? 되돌릴 수 없어요.'
    : '다른 사람이 쓴 메시지를 지울까요? 되돌릴 수 없어요.';
  if (!window.confirm(ask)) return;
  if (btn) btn.disabled = true;
  try {
    const res = await S.api.deleteMessage(m.id);
    // 내가 올린 사진·파일은 버킷에서도 지운다 (버킷 규칙상 남의 파일은 지울 수 없어 그대로 둔다)
    if (own && m.attachments && m.attachments.length) removeUploaded(m.attachments);
    if (S.threadParent && S.threadParent.id === m.id) closeThread();
    await reload();
    renderPin();
    S.sig = '';
    renderMessages();
    if (res && res.unpinned) toast('메시지를 지웠어요. 공지 고정도 함께 풀렸어요.');
    else toast('메시지를 지웠어요.');
  } catch (e) {
    if (btn) btn.disabled = false;
    toast(e.message || '지우지 못했어요.', 'err');
  }
}

// ---------- 그리기 ----------
function renderWho() {
  const w = $('who');
  w.textContent = '';
  if (!S.me) return;
  const av = el('span', 'who-av', firstChar(S.me.name));
  av.style.background = S.me.avatar_color || PALETTE[0];
  const nm = el('span', 'who-name', S.me.name);
  w.append(av, nm);
  w.title = S.me.email || '';
  w.hidden = false;
}

function sideItem({ label, hash, avatar, ai, active, onClick, title, unread }) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.type = 'button';
  const n = Number(unread || 0);
  b.className = 'side-item' + (active ? ' on' : '') + (n > 0 ? ' has-unread' : '');
  if (title) b.title = title + (n > 0 ? ` · 안 읽은 메시지 ${n}개` : '');
  if (avatar != null) {
    const a = el('span', 'side-av' + (ai ? ' ai' : ''), avatar);
    if (ai) a.style.background = '#ffdc1a';
    b.appendChild(a);
  } else {
    b.appendChild(el('span', 'hash', hash || '#'));
  }
  b.appendChild(el('span', 'nm', label));
  if (n > 0) b.appendChild(el('span', 'badge-n', n > 99 ? '99+' : String(n)));
  b.addEventListener('click', onClick);
  li.appendChild(b);
  return li;
}

function renderSidebar() {
  const chans = S.channels.filter((c) => c.kind === 'channel');
  const ais = S.channels.filter((c) => c.kind === 'ai');
  const dms = S.channels.filter((c) => c.kind === 'dm');

  const cl = $('channel-list');
  cl.textContent = '';
  for (const c of chans) {
    cl.appendChild(sideItem({
      label: c.name, hash: '#', active: c.id === S.channelId, unread: S.unread[c.id] || 0,
      onClick: () => selectChannel(c.id), title: c.description || '#' + c.name,
    }));
  }

  const al = $('ai-list');
  al.textContent = '';
  for (const c of ais) {
    al.appendChild(sideItem({
      label: 'Alter', avatar: 'AI', ai: true, active: c.id === S.channelId, unread: S.unread[c.id] || 0,
      onClick: () => selectChannel(c.id), title: 'Alter 와 1:1 대화',
    }));
  }

  const dl = $('dm-list');
  dl.textContent = '';
  const others = S.members.filter((m) => !S.me || m.id !== S.me.id);
  const used = new Set();
  for (const c of dms) {
    const who = others.find((m) => (c.dm_key || '').includes(m.id));
    if (who) used.add(who.id);
    dl.appendChild(sideItem({
      label: who ? who.name : c.name,
      avatar: firstChar(who ? who.name : c.name),
      active: c.id === S.channelId,
      unread: S.unread[c.id] || 0,
      onClick: () => selectChannel(c.id),
      title: who ? who.email : c.name,
    }));
  }
  for (const m of others) {
    if (used.has(m.id)) continue;
    dl.appendChild(sideItem({
      label: m.name, avatar: firstChar(m.name), active: false,
      onClick: () => openDmWith(m), title: (m.email || '') + ' · DM 열기',
    }));
  }
  if (!others.length) dl.appendChild(el('li', 'side-tip', '아직 함께하는 선생님이 없어요.'));

  $('preview-note').hidden = S.mode !== 'preview';
  $('side-tip').textContent = '';
  if (!S.aiKeySet && S.mode === 'live') {
    $('side-tip').textContent = '⚠️ AI 열쇠(WORKSPACE_AI_TOKEN)가 아직 없어 Alter 가 안내 문구로 답해요.';
  } else {
    const b = document.createElement('b');
    b.textContent = '@AI';
    $('side-tip').append('💡 메시지에서 ', b, ' 를 부르면 Alter 가 바로 답해요.');
  }
}

function renderHeader() {
  const c = currentChannel();
  const name = $('chan-name');
  const desc = $('chan-desc');
  name.textContent = '';
  if (!c) {
    name.textContent = '채널을 고르세요';
    desc.textContent = '';
    $('chan-kind').hidden = true;
    $('chan-count').textContent = '';
    return;
  }
  if (c.kind === 'channel') {
    name.append(el('span', 'hash', '#'), document.createTextNode(' ' + c.name));
    desc.textContent = c.description || '설명이 없는 채널이에요';
    $('chan-count').textContent = `${S.members.length}명`;
    $('chan-kind').hidden = true;
  } else if (c.kind === 'ai') {
    name.textContent = '🤖 Alter (AI)';
    desc.textContent = '나만의 AI 조력자 · 무엇이든 물어보세요';
    $('chan-kind').hidden = false;
    $('chan-kind').textContent = 'AI';
    $('chan-count').textContent = '';
  } else {
    name.textContent = c.name;
    desc.textContent = '1:1 다이렉트 메시지';
    $('chan-kind').hidden = true;
    $('chan-count').textContent = '';
  }
}

function messageEl(m, inThread = false) {
  const art = document.createElement('article');
  art.className = 'msg' + (m.pending ? ' pending' : '') + (S.me && m.user_id === S.me.id ? ' msg-mine' : '');
  art.dataset.id = String(m.id);

  const av = el('div', 'msg-av' + (m.author_kind === 'ai' ? ' ai' : ''), m.author_kind === 'ai' ? 'AI' : firstChar(m.author_name));
  if (m.author_kind !== 'ai') av.style.background = colorOf(m);

  const body = el('div', 'msg-body');
  const head = el('div', 'msg-head');
  head.appendChild(el('span', 'msg-name', m.author_name));
  const t = document.createElement('time');
  t.className = 'msg-time';
  t.dateTime = m.created_at;
  t.textContent = timeFmt.format(new Date(m.created_at));
  t.title = fullFmt.format(new Date(m.created_at));
  head.appendChild(t);
  if (m.author_kind === 'ai') head.appendChild(el('span', 'badge', 'AI'));
  if (m.source === 'preview') head.appendChild(el('span', 'msg-src', '예시 답변'));
  if (m.source === 'fallback') head.appendChild(el('span', 'msg-src', '안내'));
  if (m.pending) head.appendChild(el('span', 'msg-src', '보내는 중…'));
  const ch = currentChannel();
  const here = Boolean(ch && ch.id === m.channel_id);
  const pinned = here && ch.pinned_message_id != null && Number(ch.pinned_message_id) === Number(m.id);
  if (pinned) head.appendChild(el('span', 'msg-pin-tag', '📌 공지'));
  body.appendChild(head);

  const text = el('div', 'msg-text');
  if (m.content) text.appendChild(renderMarkdown(m.content));
  if (m.attachments && m.attachments.length) text.appendChild(attachmentsEl(m.attachments));
  if (m.content || (m.attachments && m.attachments.length)) body.appendChild(text);

  if (!inThread) {
    const n = Number(m.reply_count || 0);
    const btn = el('button', 'thread-btn' + (n > 0 ? ' has' : ''), n > 0 ? `💬 답글 ${n}개` : '↳ 스레드 열기');
    btn.type = 'button';
    btn.addEventListener('click', (e) => { e.stopPropagation(); openThread(m.id); });
    body.appendChild(btn);
  }

  art.append(av, body);

  // ---------- 메시지 잡기: 공지 고정(관리자) · 삭제(쓴 사람 또는 관리자) ----------
  const own = Boolean(S.me && m.user_id === S.me.id);
  const moderate = isAdmin() && here && ch.kind === 'channel';
  const canPin = !m.pending && moderate && m.parent_id == null;
  const canDelete = !m.pending && (own || moderate);
  if (canPin || canDelete) {
    const acts = el('div', 'msg-acts');
    if (canPin) {
      const b = el('button', 'msg-act' + (pinned ? ' on' : ''), pinned ? '📌 해제' : '📌 고정');
      b.type = 'button';
      b.title = pinned ? '공지 고정 해제' : '이 메시지를 채널 공지로 고정';
      b.setAttribute('aria-label', `${m.author_name} 메시지 ${pinned ? '공지 고정 해제' : '공지로 고정'}`);
      b.addEventListener('click', (e) => { e.stopPropagation(); setPin(m.channel_id, pinned ? null : m.id); });
      acts.appendChild(b);
    }
    if (canDelete) {
      const b = el('button', 'msg-act del', '🗑️ 삭제');
      b.type = 'button';
      b.title = own ? '내 메시지 삭제' : '관리자 권한으로 삭제';
      b.setAttribute('aria-label', `${m.author_name} 메시지 삭제`);
      b.addEventListener('click', (e) => { e.stopPropagation(); removeMessage(m, b); });
      acts.appendChild(b);
    }
    art.appendChild(acts);
  }
  return art;
}

function thinkingEl() {
  const art = el('article', 'msg-thinking');
  const av = el('div', 'msg-av ai', 'AI');
  const body = el('div', 'msg-body');
  const line = el('div', 'msg-thinking-line');
  const dots = el('span', 'dots');
  dots.append(el('i'), el('i'), el('i'));
  const lbl = el('span', 'lbl', currentChannel() && currentChannel().kind === 'ai' ? 'Alter 가 답을 쓰는 중…' : 'Alter 가 답글을 쓰는 중…');
  line.append(dots, lbl);
  body.appendChild(line);
  art.append(av, body);
  return art;
}

function dateSep(iso) {
  const d = el('div', 'date-sep');
  d.appendChild(el('span', null, dayLabel(iso)));
  return d;
}

function renderMessages(forceBottom = false) {
  const box = $('messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  box.textContent = '';
  let last = '';
  for (const m of S.messages) {
    const k = dayKey(m.created_at);
    if (k !== last) { box.appendChild(dateSep(m.created_at)); last = k; }
    box.appendChild(messageEl(m));
  }
  if (S.aiPending && S.aiPendingWhere === 'channel') box.appendChild(thinkingEl());
  const empty = S.messages.length === 0 && !S.aiPending;
  $('chat-empty').hidden = !empty;
  if (forceBottom || nearBottom) box.scrollTop = box.scrollHeight;
}

function renderThread() {
  const pane = $('thread');
  const ws = $('workspace');
  pane.hidden = !S.threadOpen;
  ws.classList.toggle('thread-open', S.threadOpen);
  if (!S.threadOpen) return;
  const p = $('thread-parent');
  p.textContent = '';
  if (S.threadParent) p.appendChild(messageEl(S.threadParent, true));
  const n = S.threadReplies.length;
  $('thread-count').textContent = n ? `답글 ${n}개` : '첫 답글을 남겨 보세요';
  const r = $('thread-replies');
  r.textContent = '';
  for (const m of S.threadReplies) r.appendChild(messageEl(m, true));
  if (S.aiPending && S.aiPendingWhere === 'thread') r.appendChild(thinkingEl());
  const body = document.querySelector('.thread-body');
  if (body) body.scrollTop = body.scrollHeight;
}

function renderAll() {
  renderWho();
  renderSidebar();
  renderHeader();
  renderMessages();
  renderThread();
}

// ---------- 데이터 ----------
function mergePending(list) {
  const pending = S.messages.filter((m) => m.pending);
  return pending.some((p) => p.parent_id === null) ? [...list, ...pending.filter((p) => p.parent_id === null)] : list;
}

function currentSig() {
  const a = S.messages.map((m) => m.id + ':' + (m.reply_count || 0) + (m.pending ? 'p' : '')).join(',');
  const t = S.threadOpen && S.threadParent ? S.threadReplies.map((m) => m.id + (m.pending ? 'p' : '')).join(',') : '';
  return a + '|' + t;
}

async function reload({ silent = true } = {}) {
  if (!S.channelId || !S.api) return;
  const id = S.channelId;
  try {
    const res = await S.api.messages(id);
    if (S.channelId !== id) return;
    S.messages = mergePending(res.messages || []);
    let t = null;
    if (S.threadOpen && S.threadParent && typeof S.threadParent.id === 'number') {
      t = await S.api.thread(id, S.threadParent.id);
      if (S.channelId !== id || !S.threadOpen) return;
      S.threadParent = t.parent;
      S.threadReplies = t.messages || [];
    }
    showChatError('');
    // 채널 머리 정보(이름·설명·공지 고정)도 함께 받는다 — 공지가 바뀌면 메시지 목록도 다시 그린다
    if (res.channel) {
      const prev = currentChannel();
      const prevPin = prev ? prev.pinned_message_id : null;
      const prevName = prev ? prev.name : '';
      const prevDesc = prev ? prev.description : '';
      mergeChannel(res.channel);
      renderPin();
      if (prevPin !== (res.channel.pinned_message_id ?? null)) S.sig = '';
      if (prevName !== res.channel.name || prevDesc !== res.channel.description) {
        renderHeader();
        renderSidebar();
      }
    }
    const sig = currentSig();
    if (sig !== S.sig) {
      S.sig = sig;
      renderMessages();
      if (t) renderThread();
    }
    if (Array.isArray(res.unread)) setUnreadMap(res.unread);
  } catch (e) {
    if (!silent) showChatError(e.message || '메시지를 불러오지 못했어요.');
  }
}

async function selectChannel(id) {
  if (!S.channels.some((c) => c.id === id)) return;
  if (S.huddle && S.huddleChannelId !== id) leaveHuddle('다른 채널로 옮겨서 회의에서 나왔어요.');
  if (S.channelId !== id) { clearPending(false); clearPending(true); }
  S.channelId = id;
  S.threadOpen = false;
  S.threadParent = null;
  S.threadReplies = [];
  S.aiPending = false;
  S.aiPendingWhere = null;
  S.messages = [];
  S.sig = '';
  local.set('last-channel', id);
  closeSidebar();
  renderSidebar();
  renderHeader();
  renderPin();
  updateComposer();
  renderThread();
  renderMessages(true);
  showChatError('');
  // 지금 채널을 보고 있으니 안 읽음 배지를 지우고 서버에도 기록
  S.unread[id] = 0;
  renderSidebar();
  updateUnreadUi();
  updateHuddleButtons();
  await reload({ silent: false });
  markRead(id);
}

async function openDmWith(member) {
  const existing = S.channels.find((c) => c.kind === 'dm' && (c.dm_key || '').includes(member.id));
  if (existing) { await selectChannel(existing.id); return; }
  try {
    const res = await S.api.openDm(member.id);
    if (!S.channels.some((c) => c.id === res.channel.id)) S.channels.push(res.channel);
    await selectChannel(res.channel.id);
    toast(`${member.name} 님과의 DM 을 열었어요.`);
  } catch (e) {
    toast(e.message || 'DM 을 열지 못했어요.', 'err');
  }
}

async function openThread(parentId) {
  if (typeof parentId !== 'number') return;
  const cached = S.messages.find((m) => m.id === parentId) || null;
  S.threadOpen = true;
  S.threadParent = cached;
  S.threadReplies = [];
  renderThread();
  try {
    const res = await S.api.thread(S.channelId, parentId);
    if (!S.threadOpen || !S.threadParent || S.threadParent.id !== parentId) return;
    S.threadParent = res.parent;
    S.threadReplies = res.messages || [];
    renderThread();
  } catch (e) {
    toast(e.message || '스레드를 불러오지 못했어요.', 'err');
  }
}

function closeThread() {
  if (!S.threadOpen) return;
  S.threadOpen = false;
  S.threadParent = null;
  S.threadReplies = [];
  renderThread();
}

// ---------- 보내기 ----------
function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
}
function updateComposer() {
  const ch = $('composer-input');
  const th = $('thread-input');
  const chFiles = S.pending.channel.length;
  const thFiles = S.pending.thread.length;
  $('send').disabled = S.sending || S.uploading || (!ch.value.trim() && !chFiles) || !S.channelId;
  $('thread-send').disabled = S.sending || S.uploading || (!th.value.trim() && !thFiles) || !S.threadParent;
  $('send').textContent = S.uploading ? '올리는 중…' : '보내기';
  $('thread-send').textContent = S.uploading ? '올리는 중…' : '답글';
  $('composer-input').placeholder = currentChannel()
    ? (currentChannel().kind === 'channel' ? `#${currentChannel().name} 에 메시지 보내기` : `${currentChannel().name} 에 메시지 보내기`)
    : '메시지 보내기';
}

async function send(inThread) {
  const ta = $(inThread ? 'thread-input' : 'composer-input');
  const text = ta.value.trim();
  const pending = pendingOf(inThread);
  if (S.sending || S.uploading || !S.channelId) return;
  if (!text && !pending.length) return;
  if (inThread && !S.threadParent) return;
  const channelId = S.channelId;
  const parentId = inThread ? S.threadParent.id : null;
  const ch = currentChannel();
  const aiExpected = (ch && ch.kind === 'ai') || /@\s?(ai|alter)\b/i.test(text);

  // 1) 고른 사진·파일을 먼저 올린다 (미리보기 모드는 이 브라우저 안에서만)
  const attachments = [];
  if (pending.length) {
    S.uploading = true;
    updateComposer();
    try {
      for (const item of [...pending]) {
        if (item.state === 'done' && item.att) { attachments.push(item.att); continue; }
        item.state = 'uploading';
        renderPending(inThread);
        item.att = S.mode === 'preview' ? previewAttachment(item.file) : await uploadAttachment(item.file);
        item.state = 'done';
        attachments.push(item.att);
        renderPending(inThread);
      }
    } catch (e) {
      S.uploading = false;
      updateComposer();
      renderPending(inThread);
      toast(e.message || '파일을 올리지 못했어요.', 'err');
      return;
    }
    S.uploading = false;
  }

  S.sending = true;
  updateComposer();
  ta.value = '';
  autoGrow(ta);

  const tmp = {
    id: 'tmp-' + Date.now(), channel_id: channelId, parent_id: parentId, user_id: S.me.id,
    author_name: S.me.name, author_kind: 'user', content: text, attachments: attachments.slice(),
    created_at: new Date().toISOString(), reply_count: 0, pending: true,
  };
  if (inThread) { S.threadReplies.push(tmp); renderThread(); }
  else { S.messages.push(tmp); renderMessages(true); }
  if (aiExpected) {
    S.aiPending = true;
    S.aiPendingWhere = inThread ? 'thread' : 'channel';
    if (inThread) renderThread(); else renderMessages();
  }
  S.sig = currentSig();

  try {
    const res = await S.api.post({ channelId, content: text, parentId, attachments });
    S.aiPending = false;
    S.aiPendingWhere = null;
    if (inThread) S.threadReplies = S.threadReplies.filter((m) => m !== tmp);
    else S.messages = S.messages.filter((m) => m !== tmp);
    clearPending(inThread);
    if (res.ai_error) toast(res.ai_error, 'err');
    if (res.ai && res.ai.source === 'fallback') toast('AI 열쇠가 아직 없어서 안내 문구로 답했어요. 허브 → 앱 정보 → 🤖 앱 AI 에서 WORKSPACE_AI_TOKEN 을 발급해 주세요.', 'err');
    await reload();
    if (inThread) renderThread();
  } catch (e) {
    S.aiPending = false;
    S.aiPendingWhere = null;
    if (inThread) S.threadReplies = S.threadReplies.filter((m) => m !== tmp);
    else S.messages = S.messages.filter((m) => m !== tmp);
    // 올린 파일은 지우고, 고른 목록은 그대로 둔어 다시 보낼 수 있게 한다
    if (attachments.length) {
      const keepPaths = new Set(attachments.map((a) => a.path));
      await removeUploaded(attachments);
      for (const item of pendingOf(inThread)) if (item.att && keepPaths.has(item.att.path)) { item.state = 'ready'; item.att = null; }
    }
    renderMessages();
    renderThread();
    renderPending(inThread);
    ta.value = text;
    autoGrow(ta);
    toast(e.message || '보내지 못했어요. 잠시 뒤 다시 시도해 주세요.', 'err');
    if (e.status === 401) showLogin('로그인이 만료되었습니다. 다시 로그인해 주세요.', true);
  } finally {
    S.sending = false;
    updateComposer();
    ta.focus();
  }
}

// ---------- 관리자 콘솔 (🛠️ 관리) ----------
const MCP_URL = FN_URL + '/mcp';
const tokenFmt = new Intl.DateTimeFormat('ko-KR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' });
const fmtWhen = (v) => (v ? tokenFmt.format(new Date(v)) : '');
const isAdmin = () => Boolean(S.me && S.me.role === 'admin');

/** Cursor · Claude Desktop 에 붙여 넣을 설정 — 새로 발급한 열쇠가 있으면 그 값을 바로 쓴다 */
function mcpJson(token) {
  return JSON.stringify({
    mcpServers: {
      'byeolmuri-workspace': {
        url: MCP_URL,
        headers: { Authorization: `Bearer ${token || '<발급받은 열쇠>'}` },
      },
    },
  }, null, 2);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

async function copyAndTell(text, label) {
  const ok = await copyText(text);
  toast(ok ? `${label} 복사했어요.` : '복사하지 못했어요. 직접 선택해 복사해 주세요.', ok ? '' : 'err');
}

function setAdminNote(msg, err = false) {
  const n = $('admin-note');
  if (!n) return;
  n.textContent = msg || '';
  n.hidden = !msg;
  n.classList.toggle('err', Boolean(err));
}

function setInviteNote(msg, err = false) {
  const n = $('invite-note');
  if (!n) return;
  n.textContent = msg || '';
  n.hidden = !msg;
  n.classList.toggle('err', Boolean(err));
}

// ---------- 창 · 탭 ----------
const ADMIN_TABS = ['members', 'channels', 'system'];

function setAdminTab(name) {
  const tab = ADMIN_TABS.includes(name) ? name : 'members';
  S.adminTab = tab;
  for (const t of ADMIN_TABS) {
    const b = $('tab-' + t);
    const panel = $('admin-panel-' + t);
    if (b) { b.classList.toggle('on', t === tab); b.setAttribute('aria-selected', t === tab ? 'true' : 'false'); }
    if (panel) panel.hidden = t !== tab;
  }
  if (tab === 'members') loadAdminMembers();
  else if (tab === 'channels') renderAdminChannels();
  else { loadOverview(); loadTokens(); }
}

function openAdmin(tab) {
  const box = $('admin-modal');
  if (!box || !isAdmin()) return;
  S.newToken = '';
  $('token-new').hidden = true;
  $('token-value').textContent = '';
  $('mcp-url').textContent = MCP_URL;
  $('mcp-json').textContent = mcpJson('');
  setAdminNote(S.mode === 'preview' ? '미리보기예요 — 여기서 만든 열쇠는 연습용이고 실제로는 동작하지 않습니다.' : '');
  setInviteNote('');
  box.hidden = false;
  setAdminTab(tab || S.adminTab || 'members');
}

function closeAdmin() {
  const box = $('admin-modal');
  if (box) box.hidden = true;
}

// ---------- 1. 멤버 · 초대 ----------
function tag(text, kind = '') {
  return el('span', 'tag' + (kind ? ' ' + kind : ''), text);
}

function loadAdminMembers() {
  if (!S.api || !S.api.adminMembers) return;
  const box = $('admin-member-list');
  if (box && !S.adminMembers.length) {
    box.textContent = '';
    box.appendChild(el('p', 'token-empty', '불러오는 중…'));
  }
  S.api.adminMembers().then((res) => {
    S.adminMembers = (res.members || []).map((m) => ({ ...m, id: m.id || m.user_id }));
    S.adminInvites = res.invites || [];
    renderAdminMembers();
    renderInvites();
  }).catch((e) => {
    const b = $('admin-member-list');
    if (!b) return;
    b.textContent = '';
    b.appendChild(el('p', 'token-empty bad', e.message || '멤버 목록을 불러오지 못했어요.'));
  });
}

function renderInvites() {
  const box = $('invite-list');
  if (!box) return;
  box.textContent = '';
  const list = S.adminInvites || [];
  if (!list.length) {
    box.appendChild(el('p', 'token-empty', '대기 중인 초대가 없어요.'));
    return;
  }
  for (const inv of list) {
    const row = el('div', 'admin-row');
    const main = el('div', 'admin-row-main');
    main.appendChild(el('b', 'admin-row-name', inv.name || inv.email));
    if (inv.name) main.appendChild(el('span', 'admin-row-sub', inv.email));
    const tags = el('div', 'admin-row-tags');
    tags.appendChild(tag(inv.role === 'admin' ? '관리자' : '멤버', inv.role === 'admin' ? 'admin' : ''));
    tags.appendChild(tag(`초대 ${fmtWhen(inv.created_at)}`, 'quiet'));
    main.appendChild(tags);
    row.appendChild(main);
    const mail = el('button', 'btn ghost small', '📧 재발송');
    mail.type = 'button';
    mail.title = `${inv.email} 로 초대 메일 다시 보내기`;
    mail.addEventListener('click', () => resendInvite(inv, mail));
    row.appendChild(mail);
    const b = el('button', 'btn ghost small', '초대 취소');
    b.type = 'button';
    b.title = `${inv.email} 초대를 취소`;
    b.addEventListener('click', () => cancelInvite(inv, b));
    row.appendChild(b);
    box.appendChild(row);
  }
}

function renderAdminMembers() {
  const box = $('admin-member-list');
  if (!box) return;
  box.textContent = '';
  const list = (S.adminMembers.length ? S.adminMembers : S.members.map((m) => ({ ...m, id: m.id })))
    // 서버와 같은 순서: 관리자 먼저, 차단된 사람은 맨 아래
    .slice().sort((a, b) => {
      const da = a.disabled_at ? 1 : 0;
      const db = b.disabled_at ? 1 : 0;
      if (da !== db) return da - db;
      const ra = a.role === 'admin' ? 0 : 1;
      const rb = b.role === 'admin' ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return String(a.name || a.email).localeCompare(String(b.name || b.email), 'ko');
    });
  if (!list.length) {
    box.appendChild(el('p', 'token-empty', '아직 멤버가 없어요.'));
    return;
  }
  for (const m of list) {
    const mine = Boolean(S.me && m.id === S.me.id);
    const row = el('div', 'admin-row' + (m.disabled_at ? ' off' : ''));
    const av = el('span', 'admin-av', firstChar(m.name || m.email));
    av.style.background = m.avatar_color || PALETTE[0];
    row.appendChild(av);
    const main = el('div', 'admin-row-main');
    main.appendChild(el('b', 'admin-row-name', m.name || m.email));
    main.appendChild(el('span', 'admin-row-sub', m.email));
    const tags = el('div', 'admin-row-tags');
    if (mine) tags.appendChild(tag('나', 'quiet'));
    tags.appendChild(tag(m.role === 'admin' ? '관리자' : '멤버', m.role === 'admin' ? 'admin' : ''));
    tags.appendChild(tag(m.disabled_at ? '차단됨' : '활성', m.disabled_at ? 'bad' : 'ok'));
    if (m.last_seen_at) tags.appendChild(tag(`최근 ${fmtWhen(m.last_seen_at)}`, 'quiet'));
    main.appendChild(tags);
    row.appendChild(main);

    const acts = el('div', 'admin-row-acts');
    const roleBtn = el('button', 'btn ghost small', m.role === 'admin' ? '관리자 해제' : '관리자 지정');
    roleBtn.type = 'button';
    roleBtn.disabled = mine;
    roleBtn.title = mine ? '내 계정의 권한은 바꿀 수 없어요.' : (m.role === 'admin' ? '관리자 권한 해제' : '관리자로 지정');
    roleBtn.addEventListener('click', () => changeMemberRole(m, roleBtn));
    acts.appendChild(roleBtn);
    const blockBtn = el('button', 'btn ghost small' + (m.disabled_at ? '' : ' warn'), m.disabled_at ? '차단 해제' : '차단');
    blockBtn.type = 'button';
    blockBtn.disabled = mine;
    blockBtn.title = mine ? '내 계정은 차단할 수 없어요.' : (m.disabled_at ? '다시 들어올 수 있게 풀기' : '이 계정의 접근 막기');
    blockBtn.addEventListener('click', () => toggleMemberBlock(m, blockBtn));
    acts.appendChild(blockBtn);
    row.appendChild(acts);
    box.appendChild(row);
  }
}

/** 멤버 한 명의 바뀐 정보를 화면 여러 곳에 반영 */
function applyMember(updated) {
  if (!updated || !updated.user_id) return;
  const merge = (list) => list.map((m) => ((m.id || m.user_id) === updated.user_id
    ? { ...m, ...updated, id: updated.user_id } : m));
  S.adminMembers = merge(S.adminMembers);
  S.members = S.members.map((m) => (m.id === updated.user_id
    ? { ...m, ...updated, id: updated.user_id } : m));
  if (S.me && S.me.id === updated.user_id) Object.assign(S.me, { role: updated.role });
  renderAdminMembers();
  renderSidebar();
  $('admin-open').hidden = !isAdmin();
}

async function changeMemberRole(m, btn) {
  const next = m.role === 'admin' ? 'member' : 'admin';
  const who = m.name || m.email;
  const ask = next === 'admin'
    ? `${who} 님을 관리자로 지정할까요?\n\n관리자는 멤버·채널을 관리하고 연동 열쇠를 만들 수 있어요.`
    : `${who} 님의 관리자 권한을 해제할까요?\n\n멤버로 돌아가고 관리 화면은 보이지 않게 됩니다.`;
  if (!window.confirm(ask)) return;
  if (btn) btn.disabled = true;
  try {
    const res = await S.api.updateMember({ userId: m.id, role: next });
    applyMember(res.member);
    toast(next === 'admin' ? '관리자로 지정했어요.' : '관리자 권한을 해제했어요.');
  } catch (e) {
    if (btn) btn.disabled = false;
    toast(e.message || '바꾸지 못했어요.', 'err');
  }
}

async function toggleMemberBlock(m, btn) {
  const who = m.name || m.email;
  const block = !m.disabled_at;
  const ask = block
    ? `${who} 님의 접근을 차단할까요?\n\n그 계정으로는 이 워크스페이스가 열리지 않습니다(나중에 풀 수 있어요).`
    : `${who} 님의 차단을 풀까요?\n\n다시 들어올 수 있게 됩니다.`;
  if (!window.confirm(ask)) return;
  if (btn) btn.disabled = true;
  try {
    const res = await S.api.updateMember({ userId: m.id, disabled: block });
    applyMember(res.member);
    toast(block ? '접근을 차단했어요.' : '차단을 풀었어요.');
  } catch (e) {
    if (btn) btn.disabled = false;
    toast(e.message || '바꾸지 못했어요.', 'err');
  }
}

async function sendInvite(e) {
  if (e) e.preventDefault();
  const emailIn = $('invite-email');
  const nameIn = $('invite-name');
  const roleIn = $('invite-role');
  const mailIn = $('invite-mail');
  const email = emailIn.value.trim();
  if (!email) { emailIn.focus(); return; }
  const sendEmail = mailIn ? mailIn.checked : true;
  const btn = $('invite-btn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = sendEmail ? '보내는 중…' : '등록 중…';
  setInviteNote('');
  try {
    const res = await S.api.inviteMember({ email, name: nameIn.value.trim(), role: roleIn.value, sendEmail });
    $('invite-form').reset();
    const m = (res && res.mail) || {};
    if (!sendEmail) {
      setInviteNote(`${email} 님을 초대했어요. 메일은 보내지 않았습니다 (목록에서 📧 재발송으로 언제든 보낼 수 있어요).`);
    } else if (m.sent) {
      setInviteNote(`초대 등록 & 이메일 발송 완료 (${m.from || 'workspace@mail.bmrschool.net'} → ${email})`);
    } else {
      setInviteNote(`초대는 등록됐어요 (메일 미발송: ${m.error || '알 수 없는 이유'})`, true);
    }
    loadAdminMembers();
  } catch (err) {
    setInviteNote(err.message || '초대하지 못했어요.', true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/** 대기 중인 초대의 메일을 다시 보낸다 — 초대 자체는 그대로 둔다 */
async function resendInvite(inv, btn) {
  if (btn) btn.disabled = true;
  const label = btn ? btn.textContent : '';
  if (btn) btn.textContent = '보내는 중…';
  try {
    const res = await S.api.resendInvite(inv.email);
    const m = (res && res.mail) || {};
    if (m.sent) {
      setInviteNote(`초대 메일을 다시 보냈어요 (${m.from || 'workspace@mail.bmrschool.net'} → ${inv.email})`);
      toast('📧 초대 메일을 다시 보냈어요.');
    } else {
      setInviteNote(`메일을 보내지 못했어요: ${m.error || '알 수 없는 이유'}`, true);
      toast('메일을 보내지 못했어요.', 'err');
    }
  } catch (e) {
    setInviteNote(e.message || '메일을 다시 보내지 못했어요.', true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

async function cancelInvite(inv, btn) {
  if (!window.confirm(`${inv.email} 님의 초대를 취소할까요?`)) return;
  if (btn) btn.disabled = true;
  try {
    await S.api.removeInvite(inv.email);
    S.adminInvites = S.adminInvites.filter((x) => x.email !== inv.email);
    renderInvites();
    toast('초대를 취소했어요.');
  } catch (e) {
    if (btn) btn.disabled = false;
    setInviteNote(e.message || '취소하지 못했어요.', true);
  }
}

// ---------- 2. 채널 관리 ----------
function renderAdminChannels() {
  const box = $('admin-channel-list');
  if (!box) return;
  box.textContent = '';
  const list = S.channels.filter((c) => c.kind === 'channel');
  if (!list.length) {
    box.appendChild(el('p', 'token-empty', '공개 채널이 없어요.'));
    return;
  }
  for (const c of list) {
    const row = el('div', 'admin-chan');
    const head = el('div', 'admin-chan-head');
    head.appendChild(el('span', 'hash', '#'));
    head.appendChild(el('b', 'admin-chan-name', c.name));
    if (c.slug === 'general') head.appendChild(tag('기본 채널', 'quiet'));
    if (c.pinned_message) head.appendChild(tag('📌 공지 있음', 'ok'));
    row.appendChild(head);

    const form = el('form', 'admin-chan-form');
    const nameIn = document.createElement('input');
    nameIn.value = c.name;
    nameIn.maxLength = 40;
    nameIn.required = true;
    nameIn.setAttribute('aria-label', `${c.name} 채널 이름`);
    const descIn = document.createElement('input');
    descIn.value = c.description || '';
    descIn.maxLength = 200;
    descIn.placeholder = '채널 설명';
    descIn.setAttribute('aria-label', `${c.name} 채널 설명`);
    const save = el('button', 'btn small', '저장');
    save.type = 'submit';
    save.disabled = true;
    const same = () => nameIn.value.trim().replace(/^#+/, '') === c.name
      && descIn.value.trim() === (c.description || '');
    const dirty = () => { save.disabled = same(); };
    nameIn.addEventListener('input', dirty);
    descIn.addEventListener('input', dirty);
    form.append(nameIn, descIn, save);
    form.addEventListener('submit', (e) => { e.preventDefault(); saveChannel(c, nameIn, descIn, save); });
    row.appendChild(form);

    const foot = el('div', 'admin-chan-foot');
    if (c.pinned_message) {
      const un = el('button', 'btn ghost small', '📌 공지 고정 해제');
      un.type = 'button';
      un.addEventListener('click', () => setPin(c.id, null));
      foot.appendChild(un);
    }
    const del = el('button', 'btn small danger', '채널 지우기');
    del.type = 'button';
    if (c.slug === 'general') {
      del.disabled = true;
      del.title = '#일반 은 기본 채널이라 지울 수 없어요.';
    }
    del.addEventListener('click', () => deleteChannel(c, del));
    foot.appendChild(del);
    row.appendChild(foot);
    box.appendChild(row);
  }
}

async function saveChannel(c, nameIn, descIn, btn) {
  const name = nameIn.value.trim().replace(/^#+/, '');
  const description = descIn.value.trim();
  if (!name) { nameIn.focus(); return; }
  if (btn) btn.disabled = true;
  try {
    const res = await S.api.updateChannel({ channelId: c.id, name, description });
    applyChannel(res.channel);
    renderAdminChannels();
    toast(`#${name} 채널을 고쳤어요.`);
  } catch (e) {
    if (btn) btn.disabled = false;
    toast(e.message || '고치지 못했어요.', 'err');
  }
}

async function deleteChannel(c, btn) {
  const ask = `#${c.name} 채널을 지울까요?\n\n채널의 메시지·사진도 함께 사라지고 되돌릴 수 없어요.`;
  if (!window.confirm(ask)) return;
  if (btn) btn.disabled = true;
  try {
    await S.api.deleteChannel(c.id);
    S.channels = S.channels.filter((x) => x.id !== c.id);
    delete S.unread[c.id];
    renderAdminChannels();
    renderSidebar();
    updateUnreadUi();
    if (S.channelId === c.id) {
      const next = S.channels.find((x) => x.kind === 'channel') || S.channels[0] || null;
      S.channelId = null;
      if (next) await selectChannel(next.id);
      else { S.messages = []; renderHeader(); renderMessages(true); }
    }
    toast(`#${c.name} 채널을 지웠어요.`);
  } catch (e) {
    if (btn) btn.disabled = false;
    toast(e.message || '지우지 못했어요.', 'err');
  }
}

// ---------- 3. 연동 · 시스템 ----------
function sysCard(k, v, sub) {
  const card = el('div', 'sys-card');
  card.appendChild(el('span', 'sys-k', k));
  card.appendChild(el('b', 'sys-v', v));
  if (sub) card.appendChild(el('span', 'sys-sub', sub));
  return card;
}

function renderOverview(o) {
  const box = $('sys-cards');
  if (!box) return;
  box.textContent = '';
  const c = (o && o.counts) || {};
  const ai = (o && o.ai) || {};
  const last = ai.last || null;
  const aiSrc = last
    ? (last.source === 'hub' ? '성공 · hub-ai' : last.source === 'gemini' ? '성공 · Gemini' : last.source === 'fallback' ? '안내 문구' : '오류')
    : '아직 없음';
  // via 가 없는 옛 응답이면 열쇠 상태로 짐작한다
  const via = ai.via || (ai.key_set ? 'gemini' : 'none');
  const previewing = Boolean(o && o.preview);
  const viaLabel = previewing ? '미리보기' : via === 'hub' ? 'hub-ai (허브 공용)' : via === 'gemini' ? 'Gemini 직접' : '아직 없음';
  const viaSub = previewing ? '예시 답변으로 보여 줍니다'
    : via === 'hub' ? `모델 ${ai.model || '허브 기본 모델'}`
      : via === 'gemini' ? `모델 ${ai.model || '—'}` : 'AI 열쇠 없음';
  box.appendChild(sysCard('AI 연결', viaLabel, viaSub));
  box.appendChild(sysCard('AI 마지막 답', aiSrc, last ? `${fmtWhen(last.at)}${last.model ? ` · ${last.model}` : ''}` : '메시지에서 @AI 를 불러 보세요'));
  box.appendChild(sysCard('✉️ 초대 메일', o && o.mail_ready ? '연결됨' : '토큰 필요', o && o.mail_ready ? 'workspace@mail.bmrschool.net' : '허브에서 메일 토큰 설정'));
  box.appendChild(sysCard('푸시 알림', o && o.push ? '켜짐' : '꺼짐', `구독 ${c.push_subs ?? 0}개`));
  box.appendChild(sysCard('봇 열쇠', `${c.bot_tokens ?? 0}개 사용 중`, o && o.bot && o.bot.env_token ? '서버 열쇠도 켜져 있음' : ''));
  box.appendChild(sysCard('멤버', `${c.members ?? 0}명`, `관리자 ${c.admins ?? 0} · 차단 ${c.disabled ?? 0}`));
  box.appendChild(sysCard('초대 대기', `${c.invites ?? 0}명`, '아직 로그인하지 않은 초대'));
  box.appendChild(sysCard('채널', `${c.channels ?? 0}개`, `DM ${c.dms ?? 0}개`));
  box.appendChild(sysCard('메시지', `${c.messages ?? 0}개`, o && o.last_message_at ? `마지막 ${fmtWhen(o.last_message_at)}` : ''));
  const note = $('ai-note');
  if (note) {
    note.textContent = previewing
      ? '미리보기 모드에서는 Alter 답변이 예시로 나옵니다. 학교 공용 AI(hub-ai) 연결 상태는 로그인한 관리 화면에서 볼 수 있어요.'
      : via === 'hub'
        ? 'AI 는 학교 공용 게이트웨이(hub-ai)로 부릅니다. 업체 키는 허브만 갖고, 이 워크스페이스는 WORKSPACE_AI_TOKEN 으로 신분만 증명합니다. 모델·허용 목록·한도는 허브 → 내 서비스 → 앱 정보 → 🤖 앱 AI 에서 바꾸면 바로 적용됩니다.'
        : via === 'gemini'
          ? 'AI 는 예비 경로로 Gemini 를 직접 부릅니다(WORKSPACE_GEMINI_API_KEY). 허브 → 내 서비스 → 앱 정보 → 🤖 앱 AI 에서 AI 토큰을 발급하면(WORKSPACE_AI_TOKEN) 공용 게이트웨이(hub-ai)로 바뀝니다.'
          : 'AI 열쇠가 아직 없습니다. 허브 → 내 서비스 → 앱 정보 → 🤖 앱 AI 에서 AI 토큰을 발급하면 Alter 가 바로 답합니다.';
  }
}

async function loadOverview() {
  const box = $('sys-cards');
  if (!box || !S.api || !S.api.adminOverview) return;
  box.textContent = '';
  box.appendChild(el('p', 'token-empty', '불러오는 중…'));
  try {
    const o = await S.api.adminOverview();
    S.adminOverview = o;
    renderOverview(o);
  } catch (e) {
    box.textContent = '';
    box.appendChild(el('p', 'token-empty bad', e.message || '현황을 불러오지 못했어요.'));
  }
}

// ---------- 연동 열쇠 ----------
function renderTokens() {
  const box = $('token-list');
  box.textContent = '';
  const list = S.tokens || [];
  if (!list.length) {
    box.appendChild(el('p', 'token-empty', '아직 발급한 열쇠가 없어요. 위에서 하나 발급해 주세요.'));
    return;
  }
  for (const t of list) {
    const row = el('div', 'token-row' + (t.revoked_at ? ' off' : ''));
    const main = el('div', 'token-main');
    main.appendChild(el('b', 'token-name', t.name));
    main.appendChild(el('code', 'token-prefix', `${t.token_prefix}…`));
    const meta = el('span', 'token-meta');
    meta.textContent = [
      t.created_at ? `발급 ${fmtWhen(t.created_at)}` : '',
      t.last_used_at ? `마지막 사용 ${fmtWhen(t.last_used_at)}` : '아직 안 씀',
      t.revoked_at ? `폐기 ${fmtWhen(t.revoked_at)}` : '',
    ].filter(Boolean).join(' · ');
    main.appendChild(meta);
    row.appendChild(main);
    if (!t.revoked_at) {
      const b = el('button', 'btn ghost small', '폐기');
      b.type = 'button';
      b.addEventListener('click', () => revokeToken(t, b));
      row.appendChild(b);
    } else {
      row.appendChild(el('span', 'token-tag', '폐기됨'));
    }
    box.appendChild(row);
  }
}

async function loadTokens() {
  if (!S.api || !S.api.botTokens) return;
  try {
    const res = await S.api.botTokens();
    S.tokens = res.tokens || [];
    renderTokens();
    if (res.env_token) setAdminNote('서버 비밀값(WORKSPACE_BOT_TOKEN)으로 넣은 열쇠도 함께 쓰이고 있어요.');
    else if (S.mode === 'preview') setAdminNote('미리보기예요 — 진짜 열쇠는 만들어지지 않고 어디에도 저장되지 않습니다.');
    else setAdminNote('');
  } catch (e) {
    setAdminNote(e.message || '열쇠 목록을 불러오지 못했어요.', true);
  }
}

async function issueToken(e) {
  e.preventDefault();
  const input = $('token-name');
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  const btn = $('token-issue');
  btn.disabled = true;
  try {
    const res = await S.api.issueBotToken(name);
    S.newToken = res.token || '';
    $('token-value').textContent = S.newToken;
    $('token-new').hidden = false;
    $('mcp-json').textContent = mcpJson(S.newToken);
    input.value = '';
    await loadTokens();
    if (S.mode === 'preview') setAdminNote('미리보기예요 — 진짜 열쇠는 만들어지지 않고 어디에도 저장되지 않습니다.');
    else setAdminNote("열쇠를 발급했어요. 아래 '복사'로 지금 바로 옮겨 두세요.");
  } catch (err) {
    setAdminNote(err.message || '열쇠를 발급하지 못했어요.', true);
  } finally {
    btn.disabled = false;
  }
}

async function revokeToken(t, btn) {
  if (!window.confirm(`«${t.name}» 열쇠를 폐기할까요? 이 열쇠로는 더 이상 읽거나 쓸 수 없습니다.`)) return;
  btn.disabled = true;
  try {
    await S.api.revokeBotToken(t.id);
    await loadTokens();
    setAdminNote(`«${t.name}» 열쇠를 폐기했어요.`);
  } catch (e) {
    btn.disabled = false;
    setAdminNote(e.message || '폐기하지 못했어요.', true);
  }
}

// ---------- 음성·화상 회의(허들) ----------
const huddleTiles = new Map(); // 참가자 id → { el, video, audio }

function huddleAllowed(ch) {
  return Boolean(ch && (ch.kind === 'channel' || ch.kind === 'dm'));
}

function updateHuddleButtons() {
  const ch = currentChannel();
  const can = huddleAllowed(ch);
  const inHere = Boolean(S.huddle && S.huddleChannelId === (ch && ch.id));
  for (const [id, verb] of [['huddle-audio', '음성'], ['huddle-video', '화상']]) {
    const b = $(id);
    if (!b) continue;
    b.hidden = !can;
    b.classList.toggle('on', inHere);
    b.setAttribute('aria-pressed', inHere ? 'true' : 'false');
    b.title = inHere ? `${verb} 회의 중 — 누르면 회의 창을 펼침` : `${verb} 회의 시작`;
  }
}

function tileColor(id) {
  let h = 0;
  const s = String(id || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function buildTile(p) {
  const el2 = el('div', 'hd-tile' + (p.local ? ' me' : ''));
  el2.setAttribute('role', 'listitem');
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  // 영상은 늘 소리 없이 — 남의 소리는 아래 audio 가 낸다 (화상이 꺼져 있어도 소리가 나야 하므로)
  video.muted = true;
  video.setAttribute('playsinline', '');
  const av = el('div', 'hd-av', firstChar(p.name));
  av.style.background = tileColor(p.id);
  const bar = el('div', 'hd-bar');
  const nm = el('span', 'hd-name', p.local ? `${p.name} (나)` : p.name);
  const mic = el('span', 'hd-mic');
  const scr = el('span', 'hd-scr', '🖥️');
  bar.append(nm, mic, scr);
  el2.append(video, av, bar);
  // 남의 소리 전용 <audio> — 음성 회의(영상 없음)에서도 이 요소로 들린다.
  // 화면에서 숨기려고 display:none 을 주지 않는다(controls 가 없으면 원래 자리를 차지하지 않는다).
  let audio = null;
  if (!p.local) {
    audio = document.createElement('audio');
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    el2.appendChild(audio);
  }
  return { el: el2, video, audio, av, mic, scr };
}

// 자동재생이 막힌 소리 — 다음 손짓(누르기·키)에 다시 틀어 본다 (나중에 들어온 참가자의 소리)
const pendingAudio = new Set();

/** 타일을 화면에서 거둘 때 — 붙여 둔 스트림을 놓아 소리·영상이 남지 않게 */
function disposeTile(tile) {
  pendingAudio.delete(tile);
  try { tile.video.srcObject = null; } catch { /* 무시 */ }
  if (tile.audio) {
    try { tile.audio.pause(); tile.audio.srcObject = null; } catch { /* 무시 */ }
  }
  tile.el.remove();
}

const playQuietly = (node, tile = null) => {
  const pr = node.play();
  if (!pr || !pr.catch) return;
  pr.catch(() => { if (tile) pendingAudio.add(tile); });
};
function retryPendingAudio() {
  for (const tile of [...pendingAudio]) {
    const a = tile.audio;
    if (!a || !a.srcObject) { pendingAudio.delete(tile); continue; }
    const pr = a.play();
    if (pr && pr.then) pr.then(() => pendingAudio.delete(tile)).catch(() => { /* 다음 손짓에 또 */ });
  }
}
document.addEventListener('pointerdown', retryPendingAudio, true);
document.addEventListener('keydown', retryPendingAudio, true);

function updateTile(tile, p) {
  // 남의 소리는 영상 유무·compact 모드와 상관없이 늘 audio 로 붙인다 (음성 회의가 들리게)
  if (tile.audio) {
    const sound = p.stream || null;
    if (tile.audio.srcObject !== sound) {
      tile.audio.srcObject = sound;
      if (!sound) pendingAudio.delete(tile);
      else if (tile.audio.paused) playQuietly(tile.audio, tile);
    }
  }
  const stream = p.video && p.stream ? p.stream : null;
  if (tile.video.srcObject !== stream) {
    tile.video.srcObject = stream;
    if (stream) playQuietly(tile.video);
  }
  tile.el.classList.toggle('video-off', !stream);
  tile.el.classList.toggle('speaking', Boolean(p.speaking));
  tile.el.classList.toggle('mic-off', !p.micOn);
  tile.mic.textContent = p.micOn ? '🎙️' : '🔇';
  tile.scr.hidden = !p.screen;
}

function renderHuddle() {
  const box = $('huddle');
  if (!box) return;
  const h = S.huddle;
  if (!h) {
    box.hidden = true;
    for (const [, t] of huddleTiles) disposeTile(t);
    huddleTiles.clear();
    updateHuddleButtons();
    return;
  }
  box.hidden = false;
  box.classList.toggle('compact', S.huddleCompact);
  box.classList.toggle('big', S.huddleBig);

  const ch = S.channels.find((c) => c.id === S.huddleChannelId) || null;
  $('huddle-title').textContent = ch ? (ch.kind === 'channel' ? '#' + ch.name : ch.name) : '';
  const people = h.view();
  $('huddle-count').textContent = `${people.length}명`;

  const wrap = $('huddle-tiles');
  const seen = new Set();
  for (const p of people) {
    const key = String(p.id);
    seen.add(key);
    let tile = huddleTiles.get(key);
    if (!tile) { tile = buildTile(p); huddleTiles.set(key, tile); wrap.appendChild(tile.el); }
    updateTile(tile, p);
  }
  for (const [id, t] of [...huddleTiles]) if (!seen.has(id)) { disposeTile(t); huddleTiles.delete(id); }

  const l = h.local;
  const micBtn = $('huddle-mic');
  micBtn.classList.toggle('off', !l.micOn);
  micBtn.setAttribute('aria-pressed', l.micOn ? 'true' : 'false');
  micBtn.querySelector('span').textContent = l.micOn ? '마이크' : '마이크 꺼짐';
  const camBtn = $('huddle-cam');
  camBtn.classList.toggle('off', !l.camOn);
  camBtn.setAttribute('aria-pressed', l.camOn ? 'true' : 'false');
  camBtn.querySelector('span').textContent = l.camOn ? '카메라' : '카메라 꺼짐';
  const scrBtn = $('huddle-screen');
  scrBtn.classList.toggle('on', l.screenOn);
  scrBtn.setAttribute('aria-pressed', l.screenOn ? 'true' : 'false');
  scrBtn.querySelector('span').textContent = l.screenOn ? '공유 중' : '화면';
  $('huddle-collapse').querySelector('span').textContent = S.huddleCompact ? '펼치기' : '접기';
  $('huddle-big').textContent = S.huddleBig ? '작게 보기' : '크게 보기';
  $('huddle-big').setAttribute('aria-pressed', S.huddleBig ? 'true' : 'false');
  const note = $('huddle-note');
  if (note) {
    const text = S.mode === 'preview' ? '미리보기예요 — 실제 마이크·카메라 없이 화면만 연습합니다.' : '';
    note.textContent = text;
    note.hidden = !text;
  }
  updateHuddleButtons();
}

async function startHuddle(video) {
  const ch = currentChannel();
  if (!huddleAllowed(ch)) return;
  if (S.huddle) { S.huddleBig = false; S.huddleCompact = false; renderHuddle(); return; }
  S.huddleChannelId = ch.id;
  S.huddleBig = false;
  S.huddleCompact = false;
  const h = new Huddle({
    channelId: ch.id,
    me: { id: S.me.id, name: S.me.name },
    preview: S.mode === 'preview',
    onChange: () => renderHuddle(),
    onNotice: (m) => toast(m),
  });
  S.huddle = h;
  renderHuddle();
  try {
    await h.join({ video });
  } catch (e) {
    toast(e.message || '회의에 들어가지 못했어요.', 'err');
    leaveHuddle();
  }
}

function leaveHuddle(msg = '') {
  const h = S.huddle;
  S.huddle = null;
  S.huddleChannelId = null;
  S.huddleBig = false;
  S.huddleCompact = false;
  renderHuddle();
  if (h) h.leave().catch(() => { /* 나가기는 실패해도 그만 */ });
  if (msg) toast(msg);
}

// ---------- 화면 전환 ----------
function showBoot() {
  $('boot').hidden = false;
  $('login').hidden = true;
  $('workspace').hidden = true;
}
function showLogin(msg = '', isErr = false) {
  $('boot').hidden = true;
  $('workspace').hidden = true;
  $('login').hidden = false;
  const m = $('login-msg');
  if (msg) {
    m.textContent = msg;
    m.hidden = false;
    m.classList.toggle('err', !!isErr);
  } else {
    m.hidden = true;
    m.textContent = '';
  }
  $('who').hidden = true;
  $('logout').hidden = true;
  $('conn').hidden = true;
  $('open-sidebar').hidden = true;
  $('bell').hidden = true;
  $('admin-open').hidden = true;
  closeAdmin();
  $('login-logout').hidden = !S.hasSession;
}

function teardown() {
  leaveHuddle();
  if (S.unsub) { try { S.unsub(); } catch { /* 무시 */ } S.unsub = null; }
  if (S.poll) { clearInterval(S.poll); S.poll = null; }
  if (S.reloadTimer) { clearTimeout(S.reloadTimer); S.reloadTimer = null; }
  S.mode = null;
  S.api = null;
  S.me = null;
  S.members = [];
  S.channels = [];
  S.channelId = null;
  S.messages = [];
  S.threadOpen = false;
  S.threadParent = null;
  S.threadReplies = [];
  S.aiPending = false;
  S.aiPendingWhere = null;
  S.sending = false;
  S.uploading = false;
  clearPending(false);
  clearPending(true);
  closeLightbox();
  S.aiKeySet = true;
  S.starting = false;
  S.sig = '';
  S.hasSession = false;
  S.unread = {};
  S.tokens = [];
  S.newToken = '';
  S.adminMembers = [];
  S.adminInvites = [];
  S.adminOverview = null;
  S.adminTab = '';
  closeAdmin();
  updateUnreadUi();
}

function enter(data, mode) {
  S.mode = mode;
  S.me = data.me;
  S.members = data.members || [];
  S.channels = data.channels || [];
  S.aiKeySet = data.ai_ready !== undefined ? data.ai_ready !== false : data.gemini_key_set !== false;
  S.hasSession = mode === 'live';
  S.sig = '';
  S.unread = {};
  for (const c of S.channels) if (c.unread) S.unread[c.id] = Number(c.unread);
  $('boot').hidden = true;
  $('login').hidden = true;
  $('workspace').hidden = false;
  $('logout').hidden = false;
  $('open-sidebar').hidden = false;
  $('bell').hidden = mode !== 'live';
  $('admin-open').hidden = !(S.me && S.me.role === 'admin');
  if (mode === 'live') refreshBell();
  $('logout').textContent = mode === 'preview' && !narrowScreen() ? '미리보기 끝내기' : (mode === 'preview' ? '나가기' : '로그아웃');
  $('conn').hidden = false;
  $('conn').classList.toggle('preview', mode === 'preview');
  $('conn-text').textContent = mode === 'preview' ? '미리보기' : '연결됨';
  renderWho();
  renderSidebar();
  updateComposer();
  updateUnreadUi();

  const saved = Number(local.get('last-channel', 0));
  const first = S.channels.find((c) => c.kind === 'channel') || S.channels[0];
  const pick = S.channels.find((c) => c.id === saved) || first;
  if (pick) selectChannel(pick.id);
  else renderHeader();

  if (mode === 'live') {
    S.unsub = S.api.subscribe((msg) => {
      incoming(msg);
      clearTimeout(S.reloadTimer);
      S.reloadTimer = setTimeout(() => { reload(); }, 350);
    });
    S.poll = setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, 5000);
  }
  updateUnreadUi();
}

async function startLive() {
  if (S.starting || S.mode === 'live') return;
  S.starting = true;
  showBoot();
  S.api = liveApi;
  S.hasSession = true;
  try {
    const data = await liveApi.bootstrap();
    S.mode = 'live';
    enter(data, 'live');
  } catch (e) {
    S.api = null;
    let msg = e.message || '워크스페이스를 열지 못했어요.';
    if (e.status === 404 || e.status === 500 || e.status === 503 || e.status === 0) {
      msg = `서버 함수가 아직 준비되지 않았어요. (${msg}) 아래 '미리보기로 둘러보기' 로 화면을 먼저 확인하실 수 있어요.`;
    }
    showLogin(msg, true);
  } finally {
    S.starting = false;
  }
}

async function startPreview() {
  if (S.starting) return;
  S.starting = true;
  showBoot();
  S.api = previewApi;
  try {
    const data = await previewApi.bootstrap();
    enter(data, 'preview');
  } catch (e) {
    showLogin(e.message || '미리보기를 열지 못했어요.', true);
  } finally {
    S.starting = false;
  }
}

function exitPreview() {
  previewApi.reset();
  teardown();
  showLogin();
}

// ---------- 서비스 워커 · 알림 ----------
let swReg = null;
async function registerSw() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    swReg = await navigator.serviceWorker.register(BASE_PATH + 'sw.js', { scope: '/workspace/' });
    return swReg;
  } catch (e) {
    console.warn('서비스 워커를 등록하지 못했습니다.', e);
    return null;
  }
}

function urlB64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

const narrowScreen = () => window.matchMedia('(max-width: 860px)').matches;

async function currentPushSub() {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? await reg.pushManager.getSubscription() : null;
  } catch {
    return null;
  }
}

async function refreshBell() {
  const b = $('bell');
  if (!b) return;
  if (S.mode !== 'live' || !pushSupported()) { b.hidden = true; return; }
  b.hidden = false;
  const perm = Notification.permission;
  const sub = await currentPushSub();
  b.classList.toggle('on', Boolean(sub));
  b.setAttribute('aria-pressed', sub ? 'true' : 'false');
  if (perm === 'denied') {
    b.textContent = '🔕 알림 차단됨';
    b.title = '브라우저 설정에서 이 사이트의 알림을 허용해 주세요';
  } else if (sub) {
    b.textContent = '🔔 알림 켬';
    b.title = '새 메시지가 오면 알려 드려요. 누르면 끕니다.';
  } else {
    b.textContent = '🔔 알림';
    b.title = '앱을 닫아도 새 메시지를 알려 드려요. 눌러서 켜세요.';
  }
}

async function toggleBell() {
  if (S.mode !== 'live') { toast('미리보기에서는 실제 알림을 켤 수 없어요.'); return; }
  if (!pushSupported()) { toast('이 브라우저는 알림을 지원하지 않아요.', 'err'); return; }
  const b = $('bell');
  b.disabled = true;
  try {
    const reg = (await navigator.serviceWorker.getRegistration()) || (await registerSw());
    if (!reg) throw new Error('서비스 워커를 준비하지 못했어요. 페이지를 새로 고쳐 보세요.');
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      try { await S.api.pushUnsubscribe(existing.endpoint); } catch { /* 서버에 없어도 아래에서 끈다 */ }
      await existing.unsubscribe();
      toast('알림을 껐어요.');
    } else {
      const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (perm !== 'granted') {
        toast(perm === 'denied' ? '브라우저 설정에서 알림을 허용해 주세요.' : '알림을 켜려면 권한이 필요해요.', 'err');
        return;
      }
      const { publicKey } = await S.api.pushKey();
      if (!publicKey) throw new Error('서버에 알림 열쇠가 아직 없어요. 잠시 뒤 다시 시도해 주세요.');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(publicKey) });
      await S.api.pushSubscribe(sub.toJSON());
      toast('알림을 켰어요. 앱을 닫아도 새 메시지를 알려 드려요.');
    }
  } catch (e) {
    toast(e.message || '알림 설정에 실패했어요.', 'err');
  } finally {
    b.disabled = false;
    refreshBell();
  }
}

// ---------- 사이드바(모바일) ----------
function openSidebar() {
  $('sidebar').classList.add('open');
  $('backdrop').hidden = false;
  $('open-sidebar').setAttribute('aria-expanded', 'true');
}
function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('backdrop').hidden = true;
  $('open-sidebar').setAttribute('aria-expanded', 'false');
}

// ---------- 이벤트 ----------
function bind() {
  $('google-login').addEventListener('click', async () => {
    try {
      const { error } = await loginWithGoogle();
      if (error) toast(error.message || '구글 로그인을 열지 못했어요.', 'err');
    } catch (e) {
      toast(e.message || '구글 로그인을 열지 못했어요.', 'err');
    }
  });
  $('preview-login').addEventListener('click', () => startPreview());
  $('bell').addEventListener('click', toggleBell);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (S.mode === 'live') { reload(); refreshBell(); }
    if (S.channelId) markRead(S.channelId);
  });

  $('login-logout').addEventListener('click', async () => {
    try { await logout(); } catch { /* 무시 */ }
    teardown();
    showLogin();
  });

  $('logout').addEventListener('click', async () => {
    if (S.mode === 'preview') { exitPreview(); return; }
    try {
      await logout();
    } catch (e) {
      toast(e.message || '로그아웃하지 못했어요.', 'err');
    }
    teardown();
    showLogin();
  });

  $('open-sidebar').addEventListener('click', openSidebar);
  $('backdrop').addEventListener('click', closeSidebar);
  $('close-thread').addEventListener('click', closeThread);

  // ---------- 연동 열쇠 · MCP 창 ----------
  // ---------- 관리자 콘솔 창 ----------
  $('admin-open').addEventListener('click', () => openAdmin());
  $('admin-close').addEventListener('click', closeAdmin);
  $('admin-modal').addEventListener('click', (e) => { if (e.target === $('admin-modal')) closeAdmin(); });
  for (const t of ADMIN_TABS) {
    const b = $('tab-' + t);
    if (b) b.addEventListener('click', () => setAdminTab(t));
  }
  $('invite-form').addEventListener('submit', sendInvite);

  // ---------- 공지 띠 ----------
  $('pin-jump').addEventListener('click', () => {
    const p = pinnedOf(currentChannel());
    if (p) focusMessage(p.id);
  });
  $('pin-clear').addEventListener('click', () => { if (S.channelId) setPin(S.channelId, null); });

  $('token-form').addEventListener('submit', issueToken);
  $('token-copy').addEventListener('click', () => copyAndTell(S.newToken, '열쇠를'));
  $('mcp-url-copy').addEventListener('click', () => copyAndTell(MCP_URL, 'MCP 서버 주소를'));
  $('mcp-json-copy').addEventListener('click', () => copyAndTell(mcpJson(S.newToken), 'MCP 설정을'));

  // ---------- 음성·화상 회의(허들) ----------
  $('huddle-audio').addEventListener('click', () => startHuddle(false));
  $('huddle-video').addEventListener('click', () => startHuddle(true));
  $('huddle-leave').addEventListener('click', () => leaveHuddle('회의에서 나왔어요.'));
  $('huddle-leave2').addEventListener('click', () => leaveHuddle('회의에서 나왔어요.'));
  $('huddle-mic').addEventListener('click', () => { if (S.huddle) S.huddle.toggleMic(); });
  $('huddle-cam').addEventListener('click', () => { if (S.huddle) S.huddle.toggleCam(); });
  $('huddle-screen').addEventListener('click', () => { if (S.huddle) S.huddle.toggleScreen(); });
  $('huddle-collapse').addEventListener('click', () => {
    S.huddleCompact = !S.huddleCompact;
    if (S.huddleCompact) S.huddleBig = false;
    renderHuddle();
  });
  $('huddle-big').addEventListener('click', () => {
    S.huddleBig = !S.huddleBig;
    if (S.huddleBig) S.huddleCompact = false;
    renderHuddle();
  });
  window.addEventListener('beforeunload', () => { if (S.huddle) S.huddle.leave(); });

  $('new-channel').addEventListener('click', () => {
    const form = $('new-channel-form');
    form.hidden = false;
    $('new-channel-name').focus();
  });
  $('new-channel-cancel').addEventListener('click', () => {
    $('new-channel-form').hidden = true;
    $('new-channel-form').reset();
  });
  $('new-channel-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('new-channel-name').value.trim();
    const description = $('new-channel-desc').value.trim();
    if (!name) return;
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const res = await S.api.createChannel({ name, description });
      if (!S.channels.some((c) => c.id === res.channel.id)) S.channels.push(res.channel);
      $('new-channel-form').hidden = true;
      $('new-channel-form').reset();
      renderSidebar();
      await selectChannel(res.channel.id);
      toast(`#${res.channel.name} 채널을 만들었어요.`);
    } catch (err) {
      toast(err.message || '채널을 만들지 못했어요.', 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $('composer').addEventListener('submit', (e) => { e.preventDefault(); send(false); });
  $('thread-composer').addEventListener('submit', (e) => { e.preventDefault(); send(true); });

  for (const [id, isThread] of [['composer-input', false], ['thread-input', true]]) {
    const ta = $(id);
    ta.addEventListener('input', () => { autoGrow(ta); updateComposer(); });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send(isThread);
      }
    });
    ta.addEventListener('paste', (e) => {
      const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
      if (!files.length) return;
      e.preventDefault();
      addFiles(files, isThread);
    });
  }

  // ---------- 사진·파일 버튼·끌어다 놓기 ----------
  for (const [btnId, inputId, isThread] of [['attach', 'composer-file', false], ['thread-attach', 'thread-file', true]]) {
    const b = $(btnId);
    const inp = $(inputId);
    if (!b || !inp) continue;
    b.addEventListener('click', () => inp.click());
    inp.addEventListener('change', () => {
      addFiles(inp.files, isThread);
      inp.value = '';
    });
  }
  const hasFiles = (e) => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes('Files');
  const bindDrop = (zone, inThread) => {
    if (!zone) return;
    let depth = 0;
    zone.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      zone.classList.add('drop-on');
    });
    zone.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    zone.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) zone.classList.remove('drop-on');
    });
    zone.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      zone.classList.remove('drop-on');
      addFiles(e.dataTransfer.files, inThread);
      const ta = $(inThread ? 'thread-input' : 'composer-input');
      if (ta) ta.focus();
    });
  };
  bindDrop($('chat-body'), false);
  bindDrop(document.querySelector('.thread-body'), true);

  // 사진 크게 보기 닫기
  $('lightbox-close').addEventListener('click', closeLightbox);
  $('lightbox').addEventListener('click', (e) => { if (e.target === $('lightbox')) closeLightbox(); });

  const insertMention = (ta) => {
    const at = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, at);
    const need = before && !/\s$/.test(before) ? ' ' : '';
    ta.value = before + need + '@AI ' + ta.value.slice(ta.selectionEnd ?? at);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    autoGrow(ta);
    updateComposer();
  };
  $('insert-ai').addEventListener('click', () => insertMention($('composer-input')));
  $('thread-insert-ai').addEventListener('click', () => insertMention($('thread-input')));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('admin-modal').hidden) closeAdmin();
    else if (!$('lightbox').hidden) closeLightbox();
    else if (S.threadOpen) closeThread();
    else if ($('sidebar').classList.contains('open')) closeSidebar();
  });
  window.addEventListener('online', () => { $('conn').classList.remove('off'); reload(); });
  window.addEventListener('offline', () => { $('conn').classList.add('off'); });
}

function authRedirectError() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  const d = h.get('error_description') || h.get('error');
  if (!d) return '';
  history.replaceState(null, '', location.pathname + location.search);
  return `로그인에 실패했어요: ${d}`;
}

// ---------- 시작 ----------
async function boot() {
  applyAppInfo(' · BMR APPS').then(() => {
    S.baseTitle = document.title || S.baseTitle;
    updateUnreadUi();
  }).catch(() => { /* 허브 이름을 못 읽어도 그대로 */ });
  bind();
  registerSw();
  const err = authRedirectError();
  if (err) showLogin(err, true);
  let user = null;
  try { user = await currentUser(); } catch { user = null; }
  if (user) await startLive();
  else if (!err) showLogin();

  onUserChange((u) => {
    if (S.mode === 'preview') return;
    if (u) {
      if (S.mode !== 'live' || !S.me) startLive();
    } else if (S.mode === 'live') {
      teardown();
      showLogin('로그아웃되었습니다.');
    }
  });
}

boot();
