// src/huddle.js — 채널·DM 음성·화상 회의(허들)
//
//  · 신호(SDP·ICE)는 Supabase Realtime 의 presence + broadcast 로 주고받습니다. 서버 함수가 필요 없습니다.
//  · 소리·영상은 화면끼리 P2P(mesh)로 오갑니다. 한 방에 n명이면 각자 n-1개 연결을 가집니다.
//  · 연결은 **한쪽만** 만듭니다: user_id 문자열을 비교해 작은 쪽이 offer 를 냅니다. 둘이 동시에 offer 해
//    부딪히는 일(glare)이 없습니다.
//  · 마이크·카메라가 없거나 권한이 거부돼도 '듣기만' 으로 들어갈 수 있습니다.
//  · 화면 공유·카메라 켜기는 트랜시버를 다시 협상하지 않고 replaceTrack 으로 바꿉니다(끊김 없음).
//
// 미리보기(preview) 모드에서는 getUserMedia 없이 가짜 참가자·가짜 화면으로 UI 만 돌려 봅니다.
import { supabase } from './supabase.js';

const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }],
};

/** 말하는 소리 크기로 테두리를 켜는 기준 (0~1) */
const SPEAK_LEVEL = 0.035;

export class Huddle {
  constructor({ channelId, me, preview = false, onChange = () => {}, onNotice = () => {} }) {
    this.channelId = channelId;
    this.me = { id: String(me.id), name: String(me.name || '선생님') };
    this.preview = preview;
    this.onChange = onChange;
    this.onNotice = onNotice;

    this.joined = false;
    this.left = false;
    this.local = { name: this.me.name, stream: null, micOn: false, camOn: false, screenOn: false, speaking: false };
    this.stream = null;        // 내 마이크·카메라 (MediaStream)
    this.screenStream = null;  // 화면 공유 (따로)
    this.screenTrack = null;
    this.peers = new Map();    // id → { id, name, micOn, camOn, screenOn, stream, speaking }
    this.pcs = new Map();      // id → { pc, audioTx, videoTx, stream }
    this.pendingIce = new Map();
    this.ch = null;
    this.analysers = new Map();
    this.meterTimer = null;
    this.timers = [];
  }

  // ---------- 바깥에서 보는 모양 ----------
  /** 화면에 그릴 참가자 목록 — 내부 객체를 그대로 넘기지 않고 필요한 것만 추린다 */
  view() {
    const out = [{
      id: this.me.id, name: this.local.name || '나', local: true,
      stream: this.screenTrack ? this.screenStream : this.local.stream,
      video: Boolean(this.local.screenOn || this.local.camOn),
      micOn: Boolean(this.local.micOn), screen: Boolean(this.local.screenOn),
      speaking: Boolean(this.local.speaking),
    }];
    for (const p of this.peers.values()) {
      out.push({
        id: p.id, name: p.name || '선생님', local: false, stream: p.stream || null,
        video: Boolean(p.camOn || p.screenOn), micOn: Boolean(p.micOn),
        screen: Boolean(p.screenOn), speaking: Boolean(p.speaking),
      });
    }
    return out;
  }

  get count() { return 1 + this.peers.size; }

  changed() {
    try { this.onChange(this); } catch (e) { console.error('huddle onChange', e); }
  }

  notice(msg) { try { this.onNotice(msg); } catch { /* 무시 */ } }

  // ---------- 들어가기 / 나가기 ----------
  async join({ video = false } = {}) {
    if (this.joined) return;
    this.joined = true;
    this.left = false;
    if (this.preview) { await this.joinPreview(video); return; }
    await this.joinLive(video);
  }

  async joinLive(wantVideo) {
    const media = await this.acquire(wantVideo);
    this.stream = media.stream;
    this.local.stream = media.stream;
    this.local.micOn = media.audio;
    this.local.camOn = media.video;
    if (media.listenOnly) this.notice('마이크·카메라를 쓸 수 없어 듣기만 합니다. 권한을 허용하면 다시 켤 수 있어요.');
    else if (!media.audio) this.notice('마이크를 쓸 수 없어 듣기만 합니다.');
    else if (wantVideo && !media.video) this.notice('카메라를 켜지 못해 음성으로만 들어갑니다.');
    this.changed();

    // 신호방: 채널 이름으로 모인다 (presence key = 내 아이디 → 같은 사람이 두 번 들어가도 하나로 보임)
    const ch = supabase.channel('workspace-huddle:' + this.channelId, {
      config: { presence: { key: this.me.id }, broadcast: { self: false } },
    });
    this.ch = ch;
    ch.on('presence', { event: 'sync' }, () => this.syncPeers());
    ch.on('presence', { event: 'join' }, () => this.syncPeers());
    ch.on('presence', { event: 'leave' }, () => this.syncPeers());
    ch.on('broadcast', { event: 'huddle-signal' }, (msg) => { this.onSignal(msg && msg.payload); });

    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      ch.subscribe((status) => {
        if (status === 'SUBSCRIBED') { ch.track(this.presenceMeta()).catch(() => {}); finish(); }
      });
      this.timers.push(setTimeout(() => {
        if (!done) { this.notice('회의 연결이 늦어지고 있어요. 잠시 뒤 다시 시도해 주세요.'); finish(); }
      }, 6000));
    });

    this.startMeters();
    this.changed();
  }

  /** 마이크·카메라 얻기 — 하나씩 실패해도 되는 것만 챙긴다. 모두 실패하면 듣기만 */
  async acquire(wantVideo) {
    const tries = [];
    if (wantVideo) tries.push({ audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
    tries.push({ audio: true, video: false });
    if (wantVideo) tries.push({ audio: false, video: true });
    for (const c of tries) {
      try {
        const s = await navigator.mediaDevices.getUserMedia(c);
        return {
          stream: s,
          audio: s.getAudioTracks().length > 0,
          video: s.getVideoTracks().length > 0,
          listenOnly: false,
        };
      } catch { /* 다음 시도 */ }
    }
    return { stream: new MediaStream(), audio: false, video: false, listenOnly: true };
  }

  async leave() {
    if (this.left) return;
    this.left = true;
    this.joined = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.meterTimer) { clearInterval(this.meterTimer); this.meterTimer = null; }
    for (const m of this.analysers.values()) { try { m.ctx.close(); } catch { /* 무시 */ } }
    this.analysers.clear();
    this.stopScreen();
    for (const id of [...this.pcs.keys()]) this.dropPeer(id);
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch { /* 무시 */ }
    this.stream = null;
    this.peers.clear();
    const ch = this.ch;
    this.ch = null;
    if (ch) {
      try { await ch.untrack(); } catch { /* 무시 */ }
      try { await supabase.removeChannel(ch); } catch { /* 무시 */ }
    }
    this.local = { name: this.me.name, stream: null, micOn: false, camOn: false, screenOn: false, speaking: false };
    this.changed();
  }

  // ---------- 신호 ----------
  presenceMeta() {
    return {
      user_id: this.me.id,
      name: this.me.name,
      audio: Boolean(this.local.micOn),
      video: Boolean(this.local.camOn),
      screen: Boolean(this.local.screenOn),
    };
  }

  async updatePresence() {
    if (this.preview || !this.ch) return;
    try { await this.ch.track(this.presenceMeta()); } catch { /* 다음 신호에서 다시 */ }
  }

  signal(to, data) {
    if (this.preview || !this.ch) return;
    try {
      this.ch.send({
        type: 'broadcast',
        event: 'huddle-signal',
        payload: { from: this.me.id, to: String(to), ...data },
      });
    } catch (e) { console.error('huddle signal', e); }
  }

  peerOf(id) { return this.peers.get(String(id)) || null; }

  addPeer(id, name, extra = {}) {
    const key = String(id);
    const p = {
      id: key, name: name || '선생님', micOn: false, camOn: false, screenOn: false,
      stream: null, speaking: false, ...extra,
    };
    this.peers.set(key, p);
    return p;
  }

  /** 접속자 목록이 바뀔 때마다 — 새 사람과의 연결(작은 id 쪽이 offer)과 사라진 사람 정리 */
  syncPeers() {
    if (!this.ch) return;
    const state = (this.ch.presenceState && this.ch.presenceState()) || {};
    const seen = new Set();
    for (const id of Object.keys(state)) {
      if (id === this.me.id) continue;
      seen.add(id);
      const meta = (state[id] && state[id][0]) || {};
      const p = this.peerOf(id) || this.addPeer(id, String(meta.name || ''));
      if (meta.name) p.name = String(meta.name);
      p.micOn = Boolean(meta.audio);
      p.camOn = Boolean(meta.video);
      p.screenOn = Boolean(meta.screen);
    }
    for (const id of [...this.peers.keys()]) if (!seen.has(id)) this.dropPeer(id);
    for (const id of seen) {
      if (!this.pcs.has(id) && this.me.id < id) this.offer(id).catch((e) => console.error('huddle offer', e));
    }
    this.changed();
  }

  createPeer(id) {
    const key = String(id);
    if (this.pcs.has(key)) return this.pcs.get(key);
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const entry = { pc, audioTx: null, videoTx: null, stream: new MediaStream() };
    this.pcs.set(key, entry);
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const c = e.candidate.toJSON ? e.candidate.toJSON() : e.candidate;
      this.signal(key, { type: 'ice', candidate: c });
    };
    pc.ontrack = (e) => {
      try { entry.stream.addTrack(e.track); } catch { /* 이미 있음 */ }
      const p = this.peerOf(key);
      if (p) { p.stream = entry.stream; this.addMeter('r:' + key, entry.stream); this.changed(); }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') this.dropPeer(key);
    };
    return entry;
  }

  async offer(id) {
    const entry = this.createPeer(id);
    if (entry.audioTx) return; // 이미 협상 시작
    entry.audioTx = entry.pc.addTransceiver('audio', { direction: 'sendrecv' });
    entry.videoTx = entry.pc.addTransceiver('video', { direction: 'sendrecv' });
    await entry.audioTx.sender.replaceTrack(this.audioTrack());
    await entry.videoTx.sender.replaceTrack(this.sendVideoTrack());
    const offer = await entry.pc.createOffer();
    await entry.pc.setLocalDescription(offer);
    this.signal(id, { type: 'offer', sdp: entry.pc.localDescription });
  }

  async answer(id, sdp) {
    const entry = this.createPeer(id);
    await entry.pc.setRemoteDescription(sdp);
    for (const tx of entry.pc.getTransceivers()) {
      const kind = (tx.receiver && tx.receiver.track && tx.receiver.track.kind)
        || (tx.sender && tx.sender.track && tx.sender.track.kind) || '';
      if (kind === 'audio' && !entry.audioTx) entry.audioTx = tx;
      if (kind === 'video' && !entry.videoTx) entry.videoTx = tx;
    }
    try { if (entry.audioTx) await entry.audioTx.sender.replaceTrack(this.audioTrack()); } catch { /* 무시 */ }
    try { if (entry.videoTx) await entry.videoTx.sender.replaceTrack(this.sendVideoTrack()); } catch { /* 무시 */ }
    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);
    this.signal(id, { type: 'answer', sdp: entry.pc.localDescription });
    await this.flushIce(id);
  }

  async onSignal(payload) {
    if (!payload || !payload.to || String(payload.to) !== this.me.id) return;
    const from = String(payload.from || '');
    if (!from || from === this.me.id) return;
    try {
      if (payload.type === 'offer') {
        await this.answer(from, payload.sdp);
      } else if (payload.type === 'answer') {
        const entry = this.pcs.get(from);
        if (entry && entry.pc.signalingState === 'have-local-offer') {
          await entry.pc.setRemoteDescription(payload.sdp);
          await this.flushIce(from);
        }
      } else if (payload.type === 'ice' && payload.candidate) {
        const entry = this.pcs.get(from);
        if (!entry || !entry.pc.remoteDescription) {
          if (!this.pendingIce.has(from)) this.pendingIce.set(from, []);
          this.pendingIce.get(from).push(payload.candidate);
        } else {
          try { await entry.pc.addIceCandidate(payload.candidate); } catch { /* 늦게 온 후보는 버린다 */ }
        }
      }
    } catch (e) {
      console.error('huddle signal', payload.type, e);
    }
  }

  async flushIce(id) {
    const list = this.pendingIce.get(id);
    const entry = this.pcs.get(id);
    if (!list || !entry) return;
    this.pendingIce.delete(id);
    for (const c of list) {
      try { await entry.pc.addIceCandidate(c); } catch { /* 무시 */ }
    }
  }

  dropPeer(id) {
    const key = String(id);
    const entry = this.pcs.get(key);
    if (entry) {
      // 받고 있던 소리·영상 트랙을 먼저 끊어 소리가 남지 않게 (pc.close 만 믿지 않는다)
      try { entry.stream.getTracks().forEach((t) => t.stop()); } catch { /* 무시 */ }
      try { entry.pc.close(); } catch { /* 무시 */ }
      this.pcs.delete(key);
    }
    this.pendingIce.delete(key);
    this.peers.delete(key);
    const m = this.analysers.get('r:' + key);
    if (m) { try { m.ctx.close(); } catch { /* 무시 */ } this.analysers.delete('r:' + key); }
    this.changed();
  }

  // ---------- 내 장치 ----------
  audioTrack() { return this.stream ? (this.stream.getAudioTracks()[0] || null) : null; }
  camTrack() { return this.stream ? (this.stream.getVideoTracks()[0] || null) : null; }
  sendVideoTrack() { return this.screenTrack || this.camTrack(); }

  async attach(kind, track) {
    for (const entry of this.pcs.values()) {
      const tx = kind === 'audio' ? entry.audioTx : entry.videoTx;
      if (!tx) continue;
      try { await tx.sender.replaceTrack(track); } catch { /* 무시 */ }
    }
  }

  async toggleMic() {
    if (this.preview) {
      this.local.micOn = !this.local.micOn;
      this.local.speaking = false;
      await this.updatePresence();
      this.changed();
      return;
    }
    let t = this.audioTrack();
    if (this.local.micOn && t) {
      t.enabled = false;
      this.local.micOn = false;
      this.local.speaking = false;
    } else {
      if (!t) {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true });
          t = s.getAudioTracks()[0];
          if (!this.stream) this.stream = new MediaStream();
          this.stream.addTrack(t);
          this.local.stream = this.stream;
          await this.attach('audio', t);
          this.addMeter('me', this.stream);
        } catch {
          this.notice('마이크를 켤 수 없어요. 브라우저의 마이크 권한을 확인해 주세요.');
          return;
        }
      } else {
        t.enabled = true;
      }
      this.local.micOn = true;
    }
    await this.updatePresence();
    this.changed();
  }

  async toggleCam() {
    if (this.preview) { this.previewVideo(!this.local.camOn); this.changed(); return; }
    if (this.local.camOn) {
      const t = this.camTrack();
      if (t) t.enabled = false;
      this.local.camOn = false;
      await this.updatePresence();
      this.changed();
      return;
    }
    let t = this.camTrack();
    if (!t) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
        t = s.getVideoTracks()[0];
        if (!this.stream) this.stream = new MediaStream();
        this.stream.addTrack(t);
        this.local.stream = this.stream;
      } catch {
        this.notice('카메라를 켤 수 없어요. 브라우저 권한이나 다른 앱이 쓰고 있는지 확인해 주세요.');
        return;
      }
    } else {
      t.enabled = true;
    }
    this.local.camOn = true;
    if (!this.screenTrack) await this.attach('video', t);
    await this.updatePresence();
    this.changed();
  }

  async toggleScreen() {
    if (this.preview) {
      this.local.screenOn = !this.local.screenOn;
      if (this.local.screenOn) {
        this.screenStream = this.fakeStream('화면 공유', 45);
        this.screenTrack = this.screenStream ? this.screenStream.getVideoTracks()[0] : null;
      } else {
        this.stopScreen();
      }
      this.changed();
      return;
    }
    if (this.local.screenOn) { this.stopScreen(); return; }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch {
      this.notice('화면 공유를 시작하지 못했어요. (브라우저가 지원하지 않거나 취소하셨어요.)');
      return;
    }
    const t = stream.getVideoTracks()[0];
    if (!t) return;
    this.screenStream = stream;
    this.screenTrack = t;
    t.addEventListener('ended', () => this.stopScreen());
    this.local.screenOn = true;
    await this.attach('video', t);
    await this.updatePresence();
    this.changed();
  }

  stopScreen() {
    if (!this.local.screenOn && !this.screenTrack && !this.screenStream) return;
    this.screenTrack = null;
    try { this.screenStream?.getTracks().forEach((t) => t.stop()); } catch { /* 무시 */ }
    this.screenStream = null;
    this.local.screenOn = false;
    if (!this.preview) {
      const cam = this.local.camOn ? this.camTrack() : null;
      this.attach('video', cam).catch(() => {});
      this.updatePresence().catch(() => {});
    }
    this.changed();
  }

  // ---------- 소리 크기(말하는 중 표시) ----------
  startMeters() {
    if (this.meterTimer || this.preview) return;
    this.meterTimer = setInterval(() => this.pollLevels(), 300);
    if (this.stream) this.addMeter('me', this.stream);
  }

  addMeter(id, stream) {
    if (this.preview || !stream || !stream.getAudioTracks().length) return;
    if (this.analysers.has(id)) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      this.analysers.set(id, { ctx, an, buf: new Uint8Array(an.frequencyBinCount) });
    } catch { /* 소리 크기 표시는 없어도 된다 */ }
  }

  pollLevels() {
    for (const [id, m] of this.analysers) {
      try {
        m.an.getByteTimeDomainData(m.buf);
        let sum = 0;
        for (let i = 0; i < m.buf.length; i++) { const v = (m.buf[i] - 128) / 128; sum += v * v; }
        const on = Math.sqrt(sum / m.buf.length) > SPEAK_LEVEL;
        const p = id === 'me' ? this.local : this.peerOf(id.slice(2));
        if (p && Boolean(p.speaking) !== on) { p.speaking = on; this.changed(); }
      } catch { /* 무시 */ }
    }
  }

  // ---------- 미리보기(연습) ----------
  async joinPreview(wantVideo) {
    this.local.micOn = true;
    this.local.camOn = Boolean(wantVideo);
    if (wantVideo) { this.local.stream = this.fakeStream('나', 205); }
    this.notice('미리보기예요 — 카메라·마이크 없이 화면만 연습합니다.');
    this.changed();
    this.timers.push(setTimeout(() => {
      this.addPeer('preview-haneul', '김하늘', { micOn: true });
      this.changed();
    }, 900));
    this.timers.push(setTimeout(() => {
      this.addPeer('preview-seoyun', '이서윤', { micOn: false, camOn: true, stream: this.fakeStream('이서윤', 150) });
      this.changed();
    }, 1700));
    this.timers.push(setTimeout(() => {
      const p = this.peerOf('preview-haneul');
      if (p) { p.speaking = true; this.changed(); }
      this.timers.push(setTimeout(() => { if (p) { p.speaking = false; this.changed(); } }, 1600));
    }, 2600));
  }

  /** 카메라 대신 쓸 그림 — 캔버스를 흘려보내 <video> 에 실제 영상이 뜨게 한다 */
  fakeStream(label, hue) {
    try {
      const c = document.createElement('canvas');
      c.width = 480; c.height = 270;
      const g = c.getContext('2d');
      if (!g) return null;
      g.fillStyle = `hsl(${hue} 78% 58%)`;
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = 'rgba(0,0,0,.12)';
      for (let i = 0; i < 6; i++) g.fillRect(0, (i * 47) % c.height, c.width, 3);
      g.fillStyle = '#000';
      g.font = '900 34px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(label, c.width / 2, c.height / 2);
      return c.captureStream ? c.captureStream(2) : null;
    } catch { return null; }
  }

  previewVideo(on) {
    this.local.camOn = Boolean(on);
    this.local.stream = on ? this.fakeStream('나', 205) : null;
    this.changed();
  }
}
