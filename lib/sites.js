/**
 * 页面读取 + 站点适配器。
 *
 * 通用路径：抓 HTML → 去噪 → 密度抽正文 → 输出 Markdown/纯文本。
 * 适配器路径：对结构化站点直接吃公开 API，拿到比"啃 HTML"更准的东西
 *   · GitHub 仓库 → 简介 / Star / 语言 / 许可证 / Releases / README 正文
 *   · 哔哩哔哩视频 → 标题 / UP / 简介 / 分P / 字幕地址 / 视频直链
 *   · arXiv 摘要页 → 标题 / 作者 / 摘要 / PDF 地址 / DOI
 * 适配器失败一律回落到通用路径，不抛给上层。
 */

import { fetchText, fetchJson, absoluteUrl, HttpError } from './http.js';
import { htmlToMarkdown, htmlToText, pageMeta, mainContent, extractLinks, decodeEntities } from './extract.js';

const BILI_HEADERS = {
  referer: 'https://www.bilibili.com/',
  cookie: 'buvid3=0F1A2B3C-4D5E-6F70-8192-A3B4C5D6E7F8infoc',
};

const GITHUB_HEADERS = { accept: 'application/vnd.github+json' };
function ghHeaders() {
  return process.env.GITHUB_TOKEN
    ? { ...GITHUB_HEADERS, authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : GITHUB_HEADERS;
}

function cut(text, maxChars, offset = 0) {
  const body = String(text || '');
  const from = Math.max(0, Number(offset) || 0);
  const slice = body.slice(from, from + Math.max(200, Number(maxChars) || 20000));
  return {
    content: slice,
    chars: body.length,
    truncated: from + slice.length < body.length,
    nextOffset: from + slice.length < body.length ? from + slice.length : null,
  };
}

/* ───────────────────────── GitHub ───────────────────────── */

async function readGithub(url) {
  const u = new URL(url);
  const parts = u.pathname.split('/').filter(Boolean);
  const [owner, repo, section, ...rest] = parts;
  if (!owner || !repo) throw new HttpError('不是仓库地址', { url });

  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const [repoRes, readmeRes, releaseRes, topicsRes] = await Promise.allSettled([
    fetchJson(api, { headers: ghHeaders() }),
    fetchText(`${api}/readme`, { headers: { ...ghHeaders(), accept: 'application/vnd.github.raw' } }),
    fetchJson(`${api}/releases?per_page=5`, { headers: ghHeaders() }),
    fetchJson(`${api}/topics`, { headers: { ...ghHeaders(), accept: 'application/vnd.github.mercy-preview+json' } }),
  ]);

  if (repoRes.status === 'rejected') throw repoRes.reason;
  const r = repoRes.value.json;
  const lines = [
    `# ${r.full_name}`,
    '',
    `${r.description || '(无描述)'}`,
    '',
    `- Star ${r.stargazers_count} · Fork ${r.forks_count} · Watchers ${r.subscribers_count ?? '?'} · Open issues ${r.open_issues_count}`,
    `- 语言 ${r.language || '?'} · 许可证 ${r.license?.spdx_id || '未声明'} · 默认分支 ${r.default_branch}`,
    `- 主页 ${r.homepage || '无'} · 创建 ${String(r.created_at).slice(0, 10)} · 最近推送 ${String(r.pushed_at).slice(0, 10)}`,
    `- 归档 ${r.archived ? '是（不再维护）' : '否'}${r.fork ? ' · 这是一个 fork' : ''}`,
  ];
  if (topicsRes.status === 'fulfilled') {
    const topics = topicsRes.value.json?.names || [];
    if (topics.length) lines.push(`- Topics：${topics.join(', ')}`);
  }
  if (releaseRes.status === 'fulfilled') {
    const releases = releaseRes.value.json || [];
    if (releases.length) {
      lines.push('', '## 最近发布');
      for (const rel of releases) {
        const assets = (rel.assets || []).slice(0, 4).map((a) => `${a.name}（${(a.size / 1024 / 1024).toFixed(1)}MB）`).join('、');
        lines.push(`- ${rel.tag_name} · ${String(rel.published_at).slice(0, 10)}${rel.prerelease ? ' · 预发布' : ''}${assets ? ` · 资产：${assets}` : ''}`);
      }
    }
  }
  if (readmeRes.status === 'fulfilled') {
    const readme = readmeRes.value.text || '';
    lines.push('', '## README', '', readme.slice(0, 12000));
  } else {
    lines.push('', '（README 读取失败，可能仓库为空或私有）');
  }
  return {
    adapter: 'github',
    title: `${r.full_name} — ${r.description || 'GitHub 仓库'}`,
    meta: { stars: r.stargazers_count, license: r.license?.spdx_id || '', language: r.language, pushedAt: r.pushed_at },
    content: lines.join('\n'),
  };
}

/* ───────────────────────── 哔哩哔哩 ───────────────────────── */

function bvidOf(url) {
  const m = /BV[0-9A-Za-z]{10}/.exec(url);
  return m ? m[0] : '';
}

async function readBilibili(url) {
  let target = url;
  if (/b23\.tv/.test(url)) {
    const res = await fetchText(url, { headers: BILI_HEADERS });
    target = res.url;
  }
  const bvid = bvidOf(target);
  if (!bvid) throw new HttpError('地址里没找到 BV 号', { url });

  const { json } = await fetchJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: BILI_HEADERS });
  if (json?.code !== 0) throw new HttpError(`B 站 view 接口返回 code=${json?.code} ${json?.message || ''}`, { url, status: 502 });
  const d = json.data;
  const lines = [
    `# ${d.title}`,
    '',
    `- UP：${d.owner?.name}（mid ${d.owner?.mid}） · 分区：${d.tname} · 发布：${new Date(d.pubdate * 1000).toISOString().slice(0, 10)}`,
    `- 时长：${Math.floor(d.duration / 60)}分${d.duration % 60}秒 · 播放：${d.stat?.view} · 弹幕：${d.stat?.danmaku} · 点赞：${d.stat?.like} · 收藏：${d.stat?.favorite}`,
    `- 链接：https://www.bilibili.com/video/${d.bvid}`,
    '',
    '## 简介',
    '',
    (d.desc || '(无简介)').trim(),
  ];
  if ((d.pages || []).length > 1) {
    lines.push('', `## 分P（共 ${d.pages.length}）`);
    for (const p of d.pages.slice(0, 40)) lines.push(`- P${p.page} ${p.part}（${p.duration}s）`);
  }

  /* 字幕：player/wbi/v2 —— 拿不到就明确写"没有字幕"，不要编造转录 */
  const firstCid = d.pages?.[0]?.cid;
  if (firstCid) {
    try {
      const pj = await fetchJson(
        `https://api.bilibili.com/x/player/wbi/v2?cid=${firstCid}&bvid=${d.bvid}`,
        { headers: BILI_HEADERS },
      );
      const subs = pj.json?.data?.subtitle?.subtitles || [];
      if (subs.length) {
        lines.push('', '## 字幕（AI/CC）');
        for (const s of subs) {
          const subUrl = s.subtitle_url?.startsWith('//') ? `https:${s.subtitle_url}` : s.subtitle_url;
          lines.push(`- ${s.lan_doc || s.lan}：${subUrl}`);
        }
      } else {
        lines.push('', '## 字幕', '', '（该视频没有公开字幕轨；要文字内容只能本地转录音频）');
      }
    } catch (err) {
      lines.push('', '## 字幕', '', `（字幕接口失败：${err.message}）`);
    }
  }
  return {
    adapter: 'bilibili',
    title: d.title,
    meta: { bvid: d.bvid, author: d.owner?.name, view: d.stat?.view, duration: d.duration },
    content: lines.join('\n'),
  };
}

/* ───────────────────────── arXiv 摘要页 ───────────────────────── */

async function readArxiv(url) {
  const { text, url: finalUrl } = await fetchText(url, { timeoutMs: 25000 });
  const meta = pageMeta(text);
  const abstract =
    /<blockquote class="abstract[^"]*">([\s\S]*?)<\/blockquote>/i.exec(text)?.[1] ||
    /<meta[^>]+name=["']citation_abstract["'][^>]+content=["']([^"']*)["']/i.exec(text)?.[1] ||
    '';
  const authors = [...text.matchAll(/<meta[^>]+name=["']citation_author["'][^>]+content=["']([^"']*)["']/gi)].map((m) => m[1]);
  const pdf = /<meta[^>]+name=["']citation_pdf_url["'][^>]+content=["']([^"']*)["']/i.exec(text)?.[1] || '';
  const doi = /<meta[^>]+name=["']citation_doi["'][^>]+content=["']([^"']*)["']/i.exec(text)?.[1] || '';
  if (!abstract && !authors.length) throw new HttpError('不是 arXiv 摘要页', { url: finalUrl });
  const lines = [
    `# ${decodeEntities(meta.title || 'arXiv')}`,
    '',
    `- 作者：${authors.join('、') || '未标注'}`,
    doi ? `- DOI：${doi}` : '',
    pdf ? `- PDF：${pdf}` : '',
    '',
    '## 摘要',
    '',
    htmlToText(abstract) || '(未取到摘要)',
  ].filter(Boolean);
  return { adapter: 'arxiv', title: meta.title || url, meta: { authors, doi, pdf }, content: lines.join('\n') };
}

/* ───────────────────────── 豆瓣条目（书 / 影视） ───────────────────────── */

async function readDouban(url) {
  const { text } = await fetchText(url, { timeoutMs: 20000 });
  const meta = pageMeta(text);
  const pick = (re) => decodeEntities(re.exec(text)?.[1] || '').replace(/\s+/g, ' ').trim();
  const subject = pick(/<span property="v:itemreviewed">([\s\S]*?)<\/span>/i) || meta.title.replace(/\s*\(豆瓣\)$/, '');
  const rating =
    pick(/property="v:average"[^>]*>\s*([\d.]+)\s*</i) || pick(/class="rating_num"[^>]*>\s*([\d.]+)\s*</i);
  const ratingCount = pick(/property="v:votes"[^>]*>\s*(\d+)\s*</i);
  const infoHtml = /<div id="info"[^>]*>([\s\S]*?)<\/div>/i.exec(text)?.[1] || '';
  const info = htmlToText(infoHtml, url).replace(/\n+/g, ' · ').trim();
  const introHtml = /<div class="intro">([\s\S]*?)<\/div>/i.exec(text)?.[1] || '';
  const intro = htmlToText(introHtml, url);
  const tags = [...text.matchAll(/<a class=" ?tag"?[^>]*>([^<]+)<\/a>/gi)].map((m) => m[1]).slice(0, 10);

  if (!subject && !info && !intro) throw new HttpError('不是豆瓣条目页', { url });
  const lines = [
    `# ${subject}`,
    '',
    rating ? `- 评分：${rating} / 10（${ratingCount || '?'} 人评价）` : '- 评分：暂无',
    info ? `- 信息：${info}` : '',
    tags.length ? `- 标签：${tags.join('、')}` : '',
    '',
    '## 简介',
    '',
    intro || '(未取到简介)',
  ].filter(Boolean);
  return {
    adapter: 'douban',
    title: subject || url,
    meta: { rating, ratingCount, tags },
    content: lines.join('\n'),
  };
}

/* ───────────────────────── 通用页面 ───────────────────────── */

async function readGeneric(url, { mode = 'markdown' } = {}) {
  const res = await fetchText(url, { timeoutMs: 25000, maxBytes: 6 * 1024 * 1024 });
  const { text, contentType } = res;
  const meta = pageMeta(text);

  if (/^(image|video|audio)\//i.test(contentType)) {
    return {
      adapter: 'binary',
      title: meta.title || url,
      meta: { contentType, bytes: res.bytes },
      content: `（这是 ${contentType} 直链，${(res.bytes / 1024).toFixed(0)} KB；文件本身没有可读文本，需要下载后用对应工具处理）`,
    };
  }
  if (/json/i.test(contentType)) {
    let pretty = text;
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* 原样输出 */ }
    return { adapter: 'json', title: meta.title || url, meta: {}, content: pretty };
  }

  const main = mainContent(text, res.url);
  const body = mode === 'text' ? htmlToText(main.text ? main.text : text, res.url) : (main.text || htmlToMarkdown(text, res.url));
  const header = [
    `# ${meta.title || '(无标题)'}`,
    meta.siteName ? `> 站点：${meta.siteName}` : '',
    meta.description ? `> 摘要：${meta.description}` : '',
    meta.publishedAt ? `> 发布：${meta.publishedAt}` : '',
    '',
  ].filter(Boolean).join('\n');
  return {
    adapter: 'generic',
    title: meta.title || url,
    status: res.status,
    meta: { description: meta.description, lang: meta.lang, publishedAt: meta.publishedAt },
    content: `${header}${body}`,
    raw: { html: text, links: extractLinks(text, res.url, { limit: 60 }) },
  };
}

/* ───────────────────────── 入口 ───────────────────────── */

const ADAPTERS = [
  { test: (u) => /(^|\.)github\.com$/i.test(u.hostname) && u.pathname.split('/').filter(Boolean).length >= 2, run: (u) => readGithub(u.toString()) },
  { test: (u) => /(^|\.)bilibili\.com$/i.test(u.hostname) || /(^|\.)b23\.tv$/i.test(u.hostname), run: (u) => readBilibili(u.toString()) },
  { test: (u) => /(^|\.)arxiv\.org$/i.test(u.hostname), run: (u) => readArxiv(u.toString()) },
  { test: (u) => /(^|\.)(book|movie)\.douban\.com$/i.test(u.hostname) && /\/subject\/\d+/.test(u.pathname), run: (u) => readDouban(u.toString()) },
];

/**
 * 读一个页面。
 * @returns {Promise<{url:string, finalUrl:string, adapter:string, title:string, meta:object, content:string, chars:number, truncated:boolean, nextOffset:number|null, links?:Array}>}
 */
export async function readPage(input, { mode = 'markdown', maxChars = 20000, offset = 0, withLinks = false } = {}) {
  const url = String(input || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error(`需要完整 http(s) 地址：${url}`);
  const parsed = new URL(url);

  let result = null;
  let fallbackReason = '';
  for (const adapter of ADAPTERS) {
    if (!adapter.test(parsed)) continue;
    try {
      result = await adapter.run(parsed);
      break;
    } catch (err) {
      /* 适配器失败 → 掉回通用抓取，但把原因留下来：
         最常见的是 GitHub 免 token 的 60 次/小时配额用完了，
         不告诉用户的话，他只会看到"抓到了页面"却不知道为什么少了 Star/Releases。 */
      fallbackReason = err?.message || String(err);
      result = null;
    }
  }
  if (!result) result = await readGeneric(url, { mode });
  if (fallbackReason) result = { ...result, fallbackReason };

  const sliced = cut(result.content, maxChars, offset);
  const out = {
    url,
    finalUrl: parsed.toString(),
    adapter: result.adapter,
    title: result.title,
    meta: result.meta || {},
    content: sliced.content,
    chars: sliced.chars,
    truncated: sliced.truncated,
    nextOffset: sliced.nextOffset,
    fallbackReason: result.fallbackReason || '',
    status: result.status || 200,
  };
  if (withLinks && result.raw?.links) out.links = result.raw.links.slice(0, 40);
  return out;
}

/** 批量读：并行抓正文，给"深挖"用。错误逐条记录，不整体失败。 */
export async function readMany(urls, { mode = 'markdown', maxChars = 6000, concurrency = 3 } = {}) {
  const list = (Array.isArray(urls) ? urls : [urls]).slice(0, 8);
  const out = [];
  const { mapLimit } = await import('./http.js');
  const settled = await mapLimit(list, concurrency, async (u) => readPage(u, { mode, maxChars }));
  settled.forEach((item, i) => {
    if (item?.error) out.push({ url: list[i], error: item.error });
    else out.push({ url: item.url, title: item.title, adapter: item.adapter, chars: item.chars, content: item.content });
  });
  return out;
}

export { readGeneric, readGithub, readBilibili, readArxiv, readDouban, absoluteUrl };
