// workspace-fn 메일 도우미 — 허브 함수 hub-mail 을 부릅니다.
// 보내는 주소는 허브가 정합니다: "<표시 이름>" <workspace@mail.bmrschool.net>
// 이 앱의 메일 토큰(WORKSPACE_MAIL_TOKEN)은 함수 비밀값에 들어 있으며, Resend 키는 앱이 갖지 않습니다.
//
// 한도: 앱마다 하루 100통 · 한 시간 20통 · 한 통에 받는 사람 10명. 학교 전체도 하루 100통입니다.
// 토큰을 브라우저에 노출하지 마세요. 서버 함수 안에서만 호출합니다.

const PREFIX = 'WORKSPACE_';
const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';

/** 허브가 정한 이 앱의 보내는 주소 (값은 hub-mail 이 붙인다) */
export const MAIL_FROM = 'workspace@mail.bmrschool.net';
/** 이 앱의 표시 이름 — 받는 사람 메일함에 '<별무리 워크스페이스>' 로 보인다 */
export const MAIL_FROM_NAME = '별무리 워크스페이스';

/** 메일 토큰(WORKSPACE_MAIL_TOKEN)이 함수 비밀값에 있는가 — 값은 절대 밖으로 내보내지 않는다 */
export const mailReady = () => Boolean(Deno.env.get(PREFIX + 'MAIL_TOKEN'));

export type SendMailInput = {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  reply_to?: string | string[];
  from_name?: string;
};

export async function sendMail(input: SendMailInput): Promise<{ ok: true; id: string; from: string; to_count: number }> {
  const token = Deno.env.get(PREFIX + 'MAIL_TOKEN') ?? '';
  if (!token) throw new Error('메일 토큰(WORKSPACE_MAIL_TOKEN)이 없습니다. 관리자에게 요청하세요.');
  if (!SB_URL) throw new Error('SUPABASE_URL 이 없습니다.');
  const r = await fetch(`${SB_URL}/functions/v1/hub-mail`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  const body = await r.json().catch(() => ({})) as { ok?: boolean; id?: string; from?: string; to_count?: number; error?: string };
  if (!r.ok || !body.ok) throw new Error(body.error || `메일 보내기 실패 (${r.status})`);
  return { ok: true, id: String(body.id ?? ''), from: String(body.from ?? ''), to_count: Number(body.to_count ?? 0) };
}

// ---------- 초대 메일 ----------
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const APP_URL = 'https://bmrgoodway.github.io/workspace/';

export type InviteMail = { subject: string; html: string; text: string };

/**
 * 초대 메일 한 통의 제목·HTML·텍스트.
 * 받는 사람이 바로 알아볼 수 있게: 누가 초대했는지 · 무슨 역할인지 · 어느 주소로 들어가는지.
 * HTML 은 바깥 CSS·그림 없이 표와 인라인 스타일만 씁니다(메일 앱이 잘게 잘라도 그대로 보이게).
 */
export function inviteMail(input: { inviter: string; email: string; role: 'member' | 'admin' }): InviteMail {
  const inviter = (input.inviter || '워크스페이스 관리자').slice(0, 40);
  const roleLabel = input.role === 'admin' ? '관리자' : '멤버';
  const roleNote = input.role === 'admin'
    ? '멤버·채널을 관리하고 연동 열쇠를 만들 수 있는 관리자 역할이에요.'
    : '채널에서 이야기하고 사진·파일을 나눌 수 있는 멤버 역할이에요.';
  const subject = `[별무리 워크스페이스] ${inviter}님이 워크스페이스에 초대했습니다`;

  const row = (k: string, v: string) => `<tr>
        <td style="padding:9px 0;border-bottom:1px solid #ececE4;font-size:12.5px;font-weight:800;color:#6b6b63;white-space:nowrap;vertical-align:top">${esc(k)}</td>
        <td style="padding:9px 0 9px 14px;border-bottom:1px solid #ececE4;font-size:13.5px;font-weight:800;color:#111;word-break:break-all">${esc(v)}</td>
      </tr>`;

  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(subject)}</title></head>
<body style="margin:0;padding:24px 12px;background:#f4f4ee;-webkit-font-smoothing:antialiased">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;border-collapse:separate;background:#ffffff;border:2px solid #111111;border-radius:14px;overflow:hidden;font-family:'Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',Helvetica,Arial,sans-serif">
        <tr><td style="padding:20px 24px;background:#ffdc1a;border-bottom:2px solid #111111">
          <div style="font-size:11px;font-weight:900;letter-spacing:.16em;color:#111111">BMR WORKSPACE</div>
          <div style="margin-top:5px;font-size:21px;line-height:1.3;font-weight:900;color:#111111">별무리 워크스페이스 초대</div>
        </td></tr>
        <tr><td style="padding:24px 24px 8px">
          <p style="margin:0 0 16px;font-size:15.5px;line-height:1.65;font-weight:700;color:#111111"><b>${esc(inviter)}</b>님이 선생님을 초대했습니다.</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
            ${row('초대된 메일', input.email)}
            ${row('부여된 역할', roleLabel)}
            ${row('접속 주소', APP_URL)}
          </table>
          <p style="margin:14px 0 0;font-size:12.5px;line-height:1.6;font-weight:700;color:#6b6b63">${esc(roleNote)}</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0 4px;border-collapse:collapse"><tr>
            <td style="background:#111111;border-radius:10px">
              <a href="${APP_URL}" style="display:inline-block;padding:13px 22px;font-size:15px;font-weight:900;color:#ffffff;text-decoration:none">워크스페이스 열기 →</a>
            </td>
          </tr></table>
          <p style="margin:14px 0 0;font-size:13.5px;line-height:1.65;font-weight:700;color:#111111">위 이메일 주소의 <b>Google 계정</b>으로 로그인하면 바로 참여할 수 있습니다.</p>
        </td></tr>
        <tr><td style="padding:14px 24px 22px">
          <p style="margin:0;padding-top:14px;border-top:1px solid #ececE4;font-size:11.5px;line-height:1.7;font-weight:650;color:#8a8a80">
            초대는 처음 로그인할 때 한 번만 쓰이고 사라집니다. 이 초대를 기다리지 않으셨다면 이 메일을 그냥 지우셔도 됩니다.<br>
            보낸 사람: 별무리 워크스페이스 · ${MAIL_FROM} · 별무리학교
          </p>
        </td></tr>
      </table>
      <div style="max-width:560px;margin:12px auto 0;font-size:11px;line-height:1.6;font-weight:650;color:#9b9b91;text-align:center">이 메일은 별무리 워크스페이스 관리자가 보낸 초대 안내입니다.</div>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    '별무리 워크스페이스 초대',
    '',
    `${inviter}님이 선생님을 초대했습니다.`,
    '',
    `· 초대된 메일: ${input.email}`,
    `· 부여된 역할: ${roleLabel} (${roleNote})`,
    `· 접속 주소: ${APP_URL}`,
    '',
    '위 이메일 주소의 Google 계정으로 로그인하면 바로 참여할 수 있습니다.',
    '초대는 처음 로그인할 때 한 번만 쓰이고 사라집니다.',
    '',
    `보낸 사람: 별무리 워크스페이스 · ${MAIL_FROM}`,
  ].join('\n');

  return { subject, html, text };
}
