// 사진·파일 첨부 도우미.
// 파일은 Storage 버킷 'workspace'(비공개)에 올리고, 메시지에는 [{path,name,mime,size}] 만 적습니다.
// 버킷 규칙(BMR APPS 기본): 로그인한 사람은 읽기 / 자기 폴더(<내 아이디>/…)에만 올리기.
// 그래서 올릴 때 경로는 반드시 '<내 아이디>/<시각>-<무작위>.<확장자>' (한글 금지) 로 만들고,
// 볼 때는 1시간짜리 서명 주소(createSignedUrl)를 만들어 씁니다.
import { supabase } from './supabase.js';

export const BUCKET = 'workspace';
export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 버킷 한도 10MB
const SIGN_SECONDS = 3600;
const cache = new Map(); // '경로' 또는 '경로|d' → { url, exp }

export const isImage = (mime) => /^image\//i.test(String(mime || ''));

const EXT_BY_MIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/heic': '.heic', 'image/heif': '.heif', 'image/svg+xml': '.svg', 'application/pdf': '.pdf',
};

/** 올릴 때 쓸 확장자 (영문·숫자만, 최대 8자) */
function extFor(file) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(file.name || ''));
  if (m) return '.' + m[1].toLowerCase();
  return EXT_BY_MIME[String(file.type || '').toLowerCase()] || '';
}

export function formatSize(bytes) {
  const b = Math.max(0, Number(bytes) || 0);
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10 * 1024 ? 1 : 0)}KB`;
  return `${(b / (1024 * 1024)).toFixed(1)}MB`;
}

/** 미리보기(연습) 모드용 — 서버에 올리지 않고 이 브라우저 안의 주소만 만든다 */
export function previewAttachment(file) {
  const id = 'p-' + Math.random().toString(36).slice(2, 10);
  return {
    path: 'preview/' + id,
    name: file.name || '파일',
    mime: file.type || 'application/octet-stream',
    size: file.size,
    url: URL.createObjectURL(file),
  };
}

/** 파일 하나를 내 폴더에 올리고 메시지에 적을 정보를 돌려준다 */
export async function uploadAttachment(file) {
  if (!file) throw new Error('파일을 읽지 못했어요.');
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`«${file.name || '파일'}» 은(는) 10MB를 넘어 올릴 수 없어요.`);
  }
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('로그인이 끝나지 않아 파일을 올릴 수 없어요. 새로 고친 뒤 다시 시도해 주세요.');
  const name = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}${extFor(file)}`;
  const path = `${user.id}/${name}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: file.type || 'application/octet-stream',
    cacheControl: '3600',
    upsert: false,
  });
  if (error) throw new Error(`«${file.name || '파일'}» 을(를) 올리지 못했어요. ${error.message || ''}`.trim());
  return { path, name: file.name || '파일', mime: file.type || 'application/octet-stream', size: file.size };
}

/** 올렸다가 메시지를 못 보낸 파일을 지운다 (자기 파일만 지울 수 있음) */
export async function removeUploaded(list) {
  const paths = (list || []).map((a) => a && a.path).filter((p) => p && !String(p).startsWith('preview/'));
  if (!paths.length) return;
  try { await supabase.storage.from(BUCKET).remove(paths); } catch { /* 지우지 못해도 화면은 계속 */ }
}

/** 볼 주소. download=true 면 원래 파일 이름으로 내려받게 한다. */
export async function fileUrl(att, { download = false } = {}) {
  if (!att || !att.path) throw new Error('첨부 정보가 없어요.');
  if (att.url) return att.url; // 미리보기 모드(로컬 주소)
  const key = att.path + (download ? '|d' : '');
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.url;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(
    att.path, SIGN_SECONDS, download ? { download: att.name || true } : undefined,
  );
  if (error || !data || !data.signedUrl) throw new Error(error?.message || '파일 주소를 만들지 못했어요.');
  cache.set(key, { url: data.signedUrl, exp: Date.now() + (SIGN_SECONDS - 300) * 1000 });
  return data.signedUrl;
}
