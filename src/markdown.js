// 메시지 본문을 안전한 DOM 으로 그립니다 (innerHTML 을 쓰지 않습니다).
// 지원: 문단, 줄바꿈, 굵게, 기울임, 취소선, 인라인 코드, 코드블록, 목록, 인용, 제목, 구분선, 링크, @AI 표시.
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(\*(?!\s)[^*\n]+(?<!\s)\*)|(\[[^\]\n]{1,120}\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s<>"']+)|(@(?:AI|Alter|ai|alter)\b)/g;

function appendLink(parent, url) {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer nofollow';
  a.textContent = url;
  parent.appendChild(a);
}

function inline(text, parent) {
  // 재귀 호출(굵게 안의 기울임 등)에서 lastIndex 가 섞이지 않도록 호출마다 새 정규식을 씁니다.
  const re = new RegExp(INLINE.source, 'g');
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    if (m[1]) {
      const code = document.createElement('code');
      code.textContent = tok.slice(1, -1);
      parent.appendChild(code);
    } else if (m[2] || m[3]) {
      const b = document.createElement('strong');
      inline(tok.slice(2, -2), b);
      parent.appendChild(b);
    } else if (m[4]) {
      const s = document.createElement('s');
      inline(tok.slice(2, -2), s);
      parent.appendChild(s);
    } else if (m[5]) {
      const i = document.createElement('em');
      inline(tok.slice(1, -1), i);
      parent.appendChild(i);
    } else if (m[6]) {
      const a = document.createElement('a');
      a.href = m[7];
      a.target = '_blank';
      a.rel = 'noopener noreferrer nofollow';
      a.textContent = tok.slice(1, tok.indexOf(']('));
      parent.appendChild(a);
    } else if (m[8]) {
      let url = tok;
      let tail = '';
      const t = /[),.;:!?]+$/.exec(url);
      if (t) { tail = t[0]; url = url.slice(0, -tail.length); }
      appendLink(parent, url);
      if (tail) parent.appendChild(document.createTextNode(tail));
    } else if (m[9]) {
      const s = document.createElement('span');
      s.className = 'mention';
      s.textContent = tok;
      parent.appendChild(s);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

export function renderMarkdown(input) {
  const frag = document.createDocumentFragment();
  const lines = String(input ?? '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  let para = null;
  const flush = () => { if (para) { if (para.childNodes.length) frag.appendChild(para); para = null; } };

  while (i < lines.length) {
    const line = lines[i];

    const fence = /^\s*```\s*([\w+#-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      if (fence[1]) code.className = 'lang-' + fence[1];
      code.textContent = buf.join('\n');
      pre.appendChild(code);
      frag.appendChild(pre);
      continue;
    }

    if (/^\s*$/.test(line)) { flush(); i++; continue; }

    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const el = document.createElement('h' + h[1].length);
      inline(h[2].trim(), el);
      frag.appendChild(el);
      i++;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line) && line.replace(/[\s\-*_]/g, '') === '') {
      flush();
      frag.appendChild(document.createElement('hr'));
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flush();
      const bq = document.createElement('blockquote');
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      inline(buf.join('\n'), bq);
      frag.appendChild(bq);
      continue;
    }

    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[1]);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m || /\d/.test(m[1]) !== ordered) break;
        const li = document.createElement('li');
        inline(m[2], li);
        list.appendChild(li);
        i++;
      }
      frag.appendChild(list);
      continue;
    }

    if (!para) para = document.createElement('p');
    else para.appendChild(document.createElement('br'));
    inline(line, para);
    i++;
  }
  flush();
  return frag;
}
