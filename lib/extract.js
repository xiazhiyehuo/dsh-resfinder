/**
 * HTML → 纯文本 / Markdown / 页面元信息。
 *
 * 目标不是"完美还原网页"，而是"让自主型 AI 拿到可读、可引用、带链接锚点的正文"：
 *  · 去掉 script/style/svg/nav 之类噪声；
 *  · 保住标题层级、列表、代码块、表格行和绝对化后的链接；
 *  · 用块密度挑出正文（<p>/<pre>/<h*> 命中率高，比按容器猜更稳）。
 */

const NOISE_TAGS = ['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'form', 'button', 'select'];

const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–', middot: '·', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', times: '×', divide: '÷', deg: '°', plusmn: '±',
  ensp: ' ', emsp: ' ', thinsp: ' ', zwj: '', zwnj: '', shy: '',
};

export function decodeEntities(input) {
  if (!input) return '';
  return String(input).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const hit = NAMED_ENTITIES[body.toLowerCase()];
    return hit === undefined ? whole : hit;
  });
}

function stripNoise(html) {
  let out = String(html || '');
  for (const tag of NOISE_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
    out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/>`, 'gi'), ' ');
  }
  out = out.replace(/<!--[\s\S]*?-->/g, ' ');
  return out;
}

/** 把 <a>/<img> 就地替换成 markdown；必须在剥标签之前做。 */
function inlineMarkdown(html, baseUrl) {
  let out = html;
  out = out.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /src=["']([^"']+)["']/i.exec(tag)?.[1] || '';
    const alt = decodeEntities(/alt=["']([^"']*)["']/i.exec(tag)?.[1] || '');
    if (!src || src.startsWith('data:')) return ' ';
    return `![${alt}](${abs(src, baseUrl)})`;
  });
  out = out.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => {
    const text = decodeEntities(String(inner).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    const url = abs(decodeEntities(href), baseUrl);
    if (!text) return url ? `<${url}>` : ' ';
    if (!url || url.startsWith('javascript:') || url.startsWith('#')) return text;
    return `[${text}](${url})`;
  });
  return out;
}

function abs(href, base) {
  if (!href) return '';
  try {
    return new URL(href, base || undefined).toString();
  } catch {
    return '';
  }
}

/** 块级标签 → 换行，再统一收尾。 */
function blockify(html) {
  return html
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, lv) => `\n\n${'#'.repeat(Number(lv))} `)
    .replace(/<\/(h[1-6])>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|li|tr|dd|dt|figcaption|blockquote)>/gi, '\n')
    .replace(/<(p|div|section|article|li|tr|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<pre\b[^>]*>/gi, '\n```\n')
    .replace(/<\/pre>/gi, '\n```\n')
    .replace(/<td\b[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ');
}

function tidy(text) {
  return decodeEntities(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0\u3000]+/g, ' ').replace(/\s+([,.;:!?，。；：！？)）】》])/g, '$1').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
}

export function htmlToMarkdown(html, baseUrl = '') {
  const clean = inlineMarkdown(stripNoise(html), baseUrl);
  return tidy(blockify(clean));
}

export function htmlToText(html, baseUrl = '') {
  return htmlToMarkdown(html, baseUrl)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '· ')
    .replace(/```/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function pageMeta(html) {
  const head = String(html || '').slice(0, 200000);
  const pick = (re) => {
    const m = re.exec(head);
    return m ? decodeEntities(m[1] || '').trim() : '';
  };
  return {
    title: pick(/<title[^>]*>([\s\S]*?)<\/title>/i) || pick(/property=["']og:title["'][^>]*content=["']([^"']*)["']/i),
    description:
      pick(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
      pick(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i),
    siteName: pick(/<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']*)["']/i),
    canonical: pick(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']*)["']/i),
    lang: pick(/<html[^>]+lang=["']([^"']*)["']/i),
    publishedAt:
      pick(/<meta[^>]+property=["']article:published_time["'][^>]*content=["']([^"']*)["']/i) ||
      pick(/<time[^>]+datetime=["']([^"']*)["']/i),
  };
}

/** 抽链接清单，供"这个页面里还有哪些可读的东西"用。 */
export function extractLinks(html, baseUrl, { limit = 200 } = {}) {
  const seen = new Set();
  const out = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(String(html || ''))) && out.length < limit) {
    const url = abs(decodeEntities(match[1]), baseUrl);
    if (!url || !/^https?:/i.test(url) || seen.has(url)) continue;
    const text = decodeEntities(match[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    seen.add(url);
    out.push({ url, text: text.slice(0, 120) });
  }
  return out;
}

/**
 * 正文抽取：按"段落块"打分，挑出真正的文章主体。
 * 网页常见的导航/推荐位大多是短句 + 密集链接，长段落 + 低链接密度才是正文。
 */
export function mainContent(html, baseUrl = '') {
  const clean = stripNoise(html);
  const blocks = [];
  const re = /<(p|pre|blockquote|li|h1|h2|h3|h4|td)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(clean))) {
    const raw = m[2];
    const text = decodeEntities(raw.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (text.length < 12) continue;
    const linkChars = (raw.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || [])
      .map((a) => decodeEntities(a.replace(/<[^>]+>/g, '')).length)
      .reduce((a, b) => a + b, 0);
    const density = linkChars / Math.max(1, text.length);
    const tag = m[1].toLowerCase();
    const weight = tag === 'pre' ? 80 : tag.startsWith('h') ? 30 : tag === 'li' ? -10 : 0;
    const score = text.length * (1 - Math.min(0.9, density)) + weight;
    if (score < 24) continue;
    blocks.push({ tag, text, score, order: blocks.length });
  }

  const navPatterns = [/^(首页|登录|注册|关于我们|联系我们|隐私政策|用户协议|版权所有|下载APP)$/, /^(上一页|下一页|查看更多|阅读全文|返回顶部)$/];
  const kept = blocks.filter((b) => !navPatterns.some((re2) => re2.test(b.text)));

  if (!kept.length) {
    const fallback = htmlToText(html, baseUrl);
    return { text: fallback.slice(0, 20000), blocks: 0, method: 'fallback' };
  }

  const best = kept.slice().sort((a, b) => b.score - a.score).slice(0, 1)[0];
  const minScore = Math.max(24, best.score * 0.12);
  const ordered = kept
    .filter((b) => b.score >= minScore || b.tag.startsWith('h') || b.tag === 'pre')
    .sort((a, b) => a.order - b.order);

  const text = tidy(ordered.map((b) => b.text).join('\n\n')).slice(0, 60000);
  return { text, blocks: ordered.length, method: 'density' };
}
