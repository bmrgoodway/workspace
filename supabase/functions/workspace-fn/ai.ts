// Alter(AI) 답변 만들기 — 학교 공용 AI 게이트웨이(hub-ai)를 먼저 쓰고, 없으면 Gemini 를 직접 부릅니다.
// 키는 함수 비밀값에서만 읽고, 브라우저에는 절대 내려보내지 않습니다.
//
//   WORKSPACE_AI_TOKEN        허브 hub-ai 를 부르는 이 앱 신분증(bmrai_…). 있으면 이 길만 씁니다.
//                             업체 키(Gemini·OpenAI·Claude·Grok)는 허브만 갖고, 여기에는 없습니다.
//   WORKSPACE_AI_MODEL        (선택) 모델 덮어쓰기(예: openai:gpt-4o). 비우면 허브의 기본 모델
//                             (bmr_admin.ai_config.default_model)을 그대로 씁니다 —
//                             그래서 허브에서 모델을 바꾸면 이 앱에도 바로 적용됩니다.
//   WORKSPACE_GEMINI_API_KEY  AI 토큰이 아직 없을 때만 쓰는 예비 길 (Gemini 직접 호출).
//   WORKSPACE_GEMINI_MODEL    (선택) 예비 길의 모델. 그 모델이 없거나(404) 이 키에서 못 쓰면
//                             아래 후보들을 차례로 시도하고, 그래도 안 되면 Gemini 의 모델 목록을 조회해
//                             쓸 수 있는 모델을 골라 기억합니다(콜드 스타트마다 한 번).

const PREFIX = 'WORKSPACE_';
const env = (name: string) => (Deno.env.get(PREFIX + name) ?? '').trim();

/** 허브 hub-ai 를 부르는 신분증 (있으면 이 길만 쓴다) */
export const hubToken = () => env('AI_TOKEN');
export const hasHub = () => hubToken() !== '';
const geminiKey = () => env('GEMINI_API_KEY');
const hasGemini = () => geminiKey() !== '';

/** 지금 AI 를 부르는 길 — 'hub'(허브 공용) · 'gemini'(직접 호출) · 'none'(열쇠 없음) */
export type AiVia = 'hub' | 'gemini' | 'none';
export const aiVia = (): AiVia => (hasHub() ? 'hub' : hasGemini() ? 'gemini' : 'none');
/** AI 를 부를 수 있는 상태인가 (/health 의 ai_ready) */
export const hasKey = () => aiVia() !== 'none';

/** 허브 기본 모델을 쓸 때 화면에 보여 줄 이름 (실제 모델은 답변을 받을 때 허브가 알려 준다) */
const HUB_DEFAULT_LABEL = '허브 기본 모델';

/** 설정값 → 기억해 둔 모델 → 기본 후보 순서. 화면(/hello·관리)에는 이 값을 보여 줍니다. */
const CANDIDATES = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash'];
let cached = '';
export const currentModel = () => {
  if (aiVia() === 'hub') return env('AI_MODEL') || HUB_DEFAULT_LABEL;
  return cached || env('GEMINI_MODEL') || CANDIDATES[0];
};

/** 허브에 보낼 최대 답변 길이(토큰). hub-ai 상한(32,000) 안이면 된다 */
const MAX_TOKENS = 1200;

/** 마지막 AI 시도 결과 (진단용 — 비밀값은 담지 않음) */
let last: { at: string; model: string; source: AiResult['source']; status: number } | null = null;
export const lastAiResult = () => last;
const remember = (model: string, source: AiResult['source'], status: number) => {
  last = { at: new Date().toISOString(), model, source, status };
};

export type Turn = { author: string; kind: 'user' | 'ai'; content: string; files?: string[] };

const SYSTEM = [
  '너는 별무리학교의 교내 워크스페이스에서 함께 일하는 AI 조력자 "Alter" 다.',
  '선생님들이 채널과 스레드에서 나누는 대화를 읽고, 물어본 것에 바로 쓸 수 있는 답을 준다.',
  '규칙:',
  '- 한국어로, 정중하지만 사무적인 인사말 없이 바로 본론부터 쓴다. 보통 3~8문장, 필요하면 짧은 목록.',
  '- 대화에 없는 사실(학교 일정, 학생 개인정보, 성적, 연락처)은 지어내지 않는다. 모르면 모른다고 하고 무엇을 확인하면 되는지 알려 준다.',
  '- 학생 이름·연락처 같은 개인정보가 보이면 답변에 다시 옮겨 적지 않는다.',
  '- 마크다운을 써도 된다(굵게, 목록, `코드`, ```코드블록```). 표는 쓰지 않는다.',
  '- 사진·파일은 **이름·종류·크기만** 알 수 있고 내용은 볼 수 없다. 사진에 무엇이 찍혔는지 지어내지 말고, 필요하면 "사진은 내용을 볼 수 없으니 글로 설명해 주세요"라고 짚어 준다.',
  '- 교사가 바로 실행할 수 있는 다음 행동을 한 가지 이상 제안한다.',
].join('\n');

/** 최근 대화를 프롬프트로 정리 (너무 길면 잘라 냄) */
function buildPrompt(channel: string, turns: Turn[], ask: string, files: string[] = []): string {
  const lines = turns.slice(-12).map((t) => {
    const who = t.kind === 'ai' ? 'Alter' : t.author || '선생님';
    const text = t.content.replace(/\s+/g, ' ').slice(0, 700);
    const att = t.files && t.files.length ? ` [첨부: ${t.files.join(', ')}]` : '';
    return `${who}: ${text}${att}`;
  });
  return [
    `[채널] ${channel}`,
    '[최근 대화]',
    lines.length ? lines.join('\n') : '(아직 대화가 없습니다)',
    '[답할 메시지]',
    ask.slice(0, 2000),
    ...(files.length ? [`[이 메시지의 첨부] ${files.join(', ')} (내용은 볼 수 없고 이름·종류만 압니다)`] : []),
  ].join('\n');
}

export type AiResult = { text: string; source: 'hub' | 'gemini' | 'fallback' | 'error'; model?: string };

const FALLBACK = [
  '지금은 제 AI 열쇠(`WORKSPACE_AI_TOKEN`)가 아직 연결되지 않아서 실제 답변을 만들 수 없어요.',
  '',
  '관리자분이 허브 → 내 서비스 → 앱 정보 → **🤖 앱 AI** 에서 **AI 토큰 발급**을 한 번 누르면(`WORKSPACE_AI_TOKEN`) 바로 대화할 수 있습니다. 발급이 어려우면 **개발자 셀프서비스 → 함수 비밀값**에 `WORKSPACE_GEMINI_API_KEY` 를 넣는 예비 길도 있어요.',
  '',
  '그동안에도 이 워크스페이스는 그대로 쓸 수 있어요. 채널에 글을 남기고 스레드로 이어 가면 됩니다. 🙂',
].join('\n');

/** Alter 의 답변 한 개. 실패해도 예외를 던지지 않고 사람이 읽을 수 있는 문장을 돌려줍니다. */
export async function ask(opts: { channel: string; turns: Turn[]; message: string; files?: string[] }): Promise<AiResult> {
  const how = aiVia();
  if (how === 'none') {
    remember('-', 'fallback', 0);
    return { text: FALLBACK, source: 'fallback' };
  }
  const prompt = buildPrompt(opts.channel, opts.turns, opts.message || '(글 없이 사진·파일만 보냈습니다)', opts.files ?? []);
  const deadline = Date.now() + 100_000; // 함수 실행 한도 안에서만 시도
  return how === 'hub' ? await askHub(prompt, deadline) : await askGemini(prompt, deadline);
}

// ---------- 1) 허브 공용 게이트웨이 (hub-ai) ----------
// 요청: { model?, system, messages: [{role, content}], temperature?, max_tokens? }
// 응답: { ok, app, provider, model, text, usage: { input_tokens, output_tokens, total_tokens } }
// 오류: { error } + 상태 (401 신분증 · 403 권한/모델 · 429 한도 · 502 업체 · 503 설정)
type HubReply = {
  ok?: boolean; provider?: string; model?: string; text?: string; error?: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
};

const sbUrl = () => (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '');

async function askHub(prompt: string, deadline: number): Promise<AiResult> {
  const base = sbUrl();
  if (!base) {
    remember('-', 'error', 0);
    return { text: '서버 주소(SUPABASE_URL)를 알 수 없어 AI 를 부르지 못했어요. 관리자에게 알려 주세요.', source: 'error' };
  }
  const override = env('AI_MODEL');
  const body: Record<string, unknown> = {
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.6,
    max_tokens: MAX_TOKENS,
  };
  // 모델을 정해 두었을 때만 보낸다 — 비우면 허브의 기본 모델(ai_config.default_model)을 쓴다
  if (override) body.model = override;
  const wait = Math.max(5_000, Math.min(60_000, deadline - Date.now()));

  let r: Response;
  try {
    r = await fetch(`${base}/functions/v1/hub-ai`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${hubToken()}`,
        apikey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(wait),
    });
  } catch (e) {
    const timedOut = /abort|timeout/i.test(`${(e as Error)?.name ?? ''} ${(e as Error)?.message ?? ''}`);
    console.error('hub-ai', timedOut ? 'timeout' : 'network', (e as Error)?.message ?? e);
    remember(override || HUB_DEFAULT_LABEL, 'error', timedOut ? 504 : 0);
    return { text: explainHub(timedOut ? 504 : 0, ''), source: 'error' };
  }

  const raw = await r.text();
  let j: HubReply = {};
  try { j = raw ? JSON.parse(raw) as HubReply : {}; } catch { /* 아래에서 오류로 다룬다 */ }

  if (!r.ok) {
    const msg = String(j.error ?? '').slice(0, 300);
    console.error('hub-ai', r.status, msg || raw.slice(0, 200));
    remember(override || HUB_DEFAULT_LABEL, 'error', r.status);
    return { text: explainHub(r.status, msg), source: 'error' };
  }

  const text = String(j.text ?? '').trim();
  const label = [j.provider, j.model].filter(Boolean).join(':') || override || HUB_DEFAULT_LABEL;
  if (!text) {
    remember(label, 'error', r.status);
    return { text: '답변을 만들지 못했어요. 다시 한 번 물어봐 주세요.', source: 'error', model: label };
  }
  remember(label, 'hub', r.status);
  return { text: text.slice(0, 6000), source: 'hub', model: label };
}

/** hub-ai 오류를 Alter 가 읽을 수 있는 문장으로. 허브가 준 한국어 안내는 그대로 덧붙인다 */
function explainHub(status: number, message: string): string {
  const m = message ? `\n\n(${message})` : '';
  const tail = '허브 → 내 서비스 → 앱 정보 → 🤖 앱 AI 에서 확인할 수 있어요.';
  if (status === 0) return 'AI 서버(hub-ai)에 연결하지 못했어요. 잠시 뒤 다시 불러 주세요.';
  if (status === 401) return `AI 신분증(\`WORKSPACE_AI_TOKEN\`)이 거절됐어요. 🤖 앱 AI 에서 **AI 토큰 재발급**을 한 번 눌러 주세요.${m}`;
  if (status === 403) return `이 앱은 지금 그 AI 를 쓸 수 없어요. ${tail}${m}`;
  if (status === 429) return message || '지금 AI 요청이 잠시 몰려서 답을 못 만들었어요 (한도 초과). 1~2분 뒤에 다시 불러 주세요.';
  if (status === 413) return message || '한 번에 보내는 글이 너무 깁니다. 대화를 조금 줄이고 다시 물어봐 주세요.';
  if (status === 404 || status === 405) return `허브 AI 주소(hub-ai)를 찾지 못했어요. 관리자에게 알려 주세요.${m}`;
  if (status === 502) return `AI 업체 쪽에서 답을 받지 못했어요. 잠시 뒤 다시 불러 주세요.${m}`;
  if (status === 503) return `AI 설정이 아직 준비되지 않았어요. ${tail}${m}`;
  if (status === 504) return 'AI 응답이 너무 늦어요. 잠시 뒤 다시 불러 주세요.';
  if (status >= 500) return message || 'AI 쪽에 일시적인 문제가 생겼어요. 잠시 뒤 다시 불러 주세요.';
  return message || `답변을 만드는 중 문제가 생겼어요 (HTTP ${status}). 잠시 뒤 다시 불러 주세요.`;
}

// ---------- 2) 예비 길: Gemini 직접 호출 ----------
type Attempt = { status: number; text: string; note: string };

async function generate(model: string, prompt: string, timeoutMs: number): Promise<Attempt> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey() },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.6, maxOutputTokens: MAX_TOKENS },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await r.text();
  if (r.status >= 400) {
    console.error('gemini', model, r.status, raw.slice(0, 300));
    return { status: r.status, text: '', note: raw.slice(0, 300) };
  }
  try {
    const j = JSON.parse(raw) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
    };
    const text = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
    const note = text ? '' : (j.promptFeedback?.blockReason || j.candidates?.[0]?.finishReason || '');
    return { status: r.status, text, note };
  } catch {
    return { status: r.status, text: '', note: '' };
  }
}

/** 이 키로 쓸 수 있는 모델 목록 (flash 계열 우선) */
async function discover(deadline: number): Promise<string[]> {
  const left = deadline - Date.now();
  if (left < 2000) return [];
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
      headers: { 'x-goog-api-key': geminiKey() },
      signal: AbortSignal.timeout(Math.min(15_000, left)),
    });
    if (!r.ok) {
      console.error('gemini models', r.status, (await r.text()).slice(0, 200));
      return [];
    }
    const j = await r.json() as { models?: { name?: string; supportedGenerationMethods?: string[] }[] };
    const names = (j.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m) => String(m.name ?? '').replace(/^models\//, ''))
      .filter((n) => n.toLowerCase().includes('gemini'));
    const score = (n: string) =>
      (n.includes('flash') ? 4 : 0) +
      (n.includes('2.5') ? 3 : n.includes('2.0') ? 2 : n.includes('1.5') ? 1 : 0) -
      (n.includes('pro') ? 1 : 0) -
      (n.includes('exp') || n.includes('preview') ? 0.5 : 0);
    return names.sort((a, b) => score(b) - score(a));
  } catch (e) {
    console.error('gemini models', (e as Error)?.message ?? e);
    return [];
  }
}

async function askGemini(prompt: string, deadline: number): Promise<AiResult> {
  let lastBad = 0;
  let sawQuota = false;

  const order = [...new Set([env('GEMINI_MODEL'), cached, ...CANDIDATES].filter(Boolean))];
  const tryModel = async (m: string): Promise<AiResult | null> => {
    if (Date.now() > deadline) return null;
    try {
      const g = await generate(m, prompt, Math.min(45_000, deadline - Date.now()));
      lastBad = g.status;
      // 모델이 없거나(404) 이 키에서 못 쓰는 경우(400) → 다음 후보
      if (g.status === 404 || g.status === 400) return null;
      if (g.status === 429) { sawQuota = true; return null; }
      if (g.status >= 400) {
        remember(m, 'error', g.status);
        return { text: explainGemini(g.status), source: 'error', model: m };
      }
      if (!g.text) {
        remember(m, 'error', g.status);
        return {
          text: g.note ? `이 내용에는 답하기 어려워요 (${g.note}). 다른 말로 다시 물어봐 주세요.` : '답변을 만들지 못했어요. 다시 한 번 물어봐 주세요.',
          source: 'error', model: m,
        };
      }
      cached = m;
      remember(m, 'gemini', g.status);
      return { text: g.text.slice(0, 6000), source: 'gemini', model: m };
    } catch (e) {
      console.error('gemini', m, (e as Error)?.name ?? '', (e as Error)?.message ?? e);
      lastBad = 0;
      return null;
    }
  };

  for (const m of order) {
    const out = await tryModel(m);
    if (out) return out;
  }

  // 후보가 모두 안 되면 이 키에서 쓸 수 있는 모델을 찾아 본다
  const usable = await discover(deadline);
  for (const m of usable.slice(0, 3)) {
    if (order.includes(m)) continue;
    const out = await tryModel(m);
    if (out) return out;
  }

  remember(cached || currentModel(), 'error', lastBad);
  if (sawQuota) return { text: explainGemini(429), source: 'error' };
  return {
    text: [
      `지금은 쓸 수 있는 Gemini 모델을 찾지 못했어요${lastBad ? ` (마지막 오류 HTTP ${lastBad})` : ''}.`,
      '',
      `서버가 \`${currentModel()}\` 부터 여러 모델을 차례로 시도했지만 이 열쇠로는 모두 거절됐습니다.`,
      '허브 → 내 서비스 → 앱 정보 → 🤖 앱 AI 에서 `WORKSPACE_AI_TOKEN`(권장)을 발급하거나, 개발자 셀프서비스에서 `WORKSPACE_GEMINI_API_KEY` 와 `WORKSPACE_GEMINI_MODEL`(선택) 값을 확인해 주세요.',
    ].join('\n'),
    source: 'error',
  };
}

function explainGemini(status: number): string {
  if (status === 429) return '지금 AI 요청이 잠시 몰려서 답을 못 만들었어요 (한도 초과). 1~2분 뒤에 다시 불러 주세요.';
  if (status === 403 || status === 401) return 'AI 열쇠가 거절됐어요 (`WORKSPACE_GEMINI_API_KEY`). 관리자에게 열쇠를 다시 확인해 달라고 알려 주세요.';
  if (status === 404) return '이 열쇠로 쓸 수 있는 AI 모델을 찾지 못했어요. `WORKSPACE_GEMINI_MODEL` 값을 확인해 주세요.';
  if (status >= 500) return 'AI 쪽에 일시적인 문제가 생겼어요. 잠시 뒤 다시 불러 주세요.';
  if (status === 0) return 'AI 에 연결하지 못했어요. 잠시 뒤 다시 불러 주세요.';
  return `답변을 만드는 중 문제가 생겼어요 (HTTP ${status}). 잠시 뒤 다시 불러 주세요.`;
}
