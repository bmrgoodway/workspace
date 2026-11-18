// Web Push (VAPID) — 서버에서만 씁니다.
//  · VAPID 열쇠쌍은 처음 한 번 Web Crypto 로 만들어 workspace.push_config 에 저장합니다 (관리자가 따로 넣을 필요 없음).
//  · 실제 암호화·전송은 web-push 라이브러리(npm)에 맡깁니다. 로드에 실패해도 함수는 계속 동작합니다.
//
// 비밀키는 push_config 에만 있고 브라우저에는 공개키만 나갑니다 (GET /push/key).
// deno-lint-ignore-file no-explicit-any
import type postgres from 'npm:postgres@3.4.5';

type Sql = ReturnType<typeof postgres>;

let webpush: any = null;
try {
  webpush = (await import('npm:web-push@3.6.7')).default;
} catch (e) {
  console.error('push', 'web-push 를 불러오지 못했습니다', (e as Error)?.message ?? e);
}

export const pushAvailable = () => Boolean(webpush);

const b64url = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (v: string) => {
  const s = atob(v.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((v.length + 3) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

export type Vapid = { publicKey: string; privateKey: string; subject: string };

/** VAPID 열쇠: 있으면 읽고, 없으면 만들어 저장한다 (동시 요청에도 하나만 남게). */
export async function getVapid(sql: Sql): Promise<Vapid> {
  const read = async (): Promise<Vapid | null> => {
    const [row] = await sql`select public_key, private_jwk, subject from workspace.push_config where id = 1`;
    if (!row) return null;
    const jwk = row.private_jwk as { d?: string } | null;
    if (!jwk?.d) return null;
    return { publicKey: String(row.public_key), privateKey: String(jwk.d), subject: String(row.subject) };
  };
  const found = await read();
  if (found) return found;

  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const priv = await crypto.subtle.exportKey('jwk', kp.privateKey) as JsonWebKey;
  const pub = await crypto.subtle.exportKey('jwk', kp.publicKey) as JsonWebKey;
  const x = fromB64url(String(pub.x));
  const y = fromB64url(String(pub.y));
  const raw = new Uint8Array(65);
  raw[0] = 4; raw.set(x, 1); raw.set(y, 33);
  const publicKey = b64url(raw);
  const subject = 'mailto:dev@bmrschool.org';
  const jwk = { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y, d: priv.d };

  await sql`insert into workspace.push_config (id, public_key, private_jwk, subject)
    values (1, ${publicKey}, ${sql.json(jwk)}, ${subject})
    on conflict (id) do nothing`;
  const after = await read();
  if (!after) throw new Error('VAPID 열쇠를 저장하지 못했습니다');
  return after;
}

export type Subscription = { endpoint: string; p256dh: string; auth: string };

export type PushPayload = { title: string; body: string; tag?: string; url?: string; icon?: string };

/** 구독들에 알림을 보낸다. 만료된 구독(404·410)은 지운다. */
export async function sendPush(sql: Sql, subs: Subscription[], payload: PushPayload): Promise<{ sent: number; removed: number; failed: number }> {
  if (!webpush || !subs.length) return { sent: 0, removed: 0, failed: 0 };
  const vapid = await getVapid(sql);
  const body = JSON.stringify({
    title: payload.title.slice(0, 120),
    body: payload.body.slice(0, 180),
    tag: payload.tag || 'workspace',
    url: payload.url || '/workspace/',
    icon: payload.icon || 'https://wjvqavianqceeyyxonfg.supabase.co/functions/v1/hub-favicon?slug=workspace',
  });
  const opts = {
    vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    TTL: 3600,
    urgency: 'high',
  };

  const expired: string[] = [];
  let sent = 0;
  let failed = 0;
  const deadline = Date.now() + 12_000;
  await Promise.all(subs.map(async (s) => {
    if (Date.now() > deadline) { failed++; return; }
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, opts);
      sent++;
    } catch (e) {
      const code = Number((e as { statusCode?: number })?.statusCode ?? 0);
      if (code === 404 || code === 410) expired.push(s.endpoint);
      else {
        failed++;
        console.error('push', code, String((e as Error)?.message ?? e).slice(0, 200));
      }
    }
  }));

  if (expired.length) {
    try { await sql`delete from workspace.push_subscriptions where endpoint in ${sql(expired)}`; } catch (e) {
      console.error('push cleanup', (e as Error)?.message ?? e);
    }
  }
  return { sent, removed: expired.length, failed };
}
