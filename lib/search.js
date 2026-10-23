/**
 * 多源检索。
 *
 * 每个引擎都是一个 { id, label, kind, search(query, {limit, lang, site}) → Result[] }。
 * Result = { title, url, snippet, site, engine, kind, extra? }
 *
 * 关于"为什么是这几个引擎"（本机实测，2026-10）：
 *  · bing / so360 直连可用，结果页是服务端渲染的 HTML，稳；
 *  · duckduckgo、公共 searxng 实例直连被挡 → 只有你自建 searxng 或挂代理时才启用；
 *  · github / arxiv / wikipedia 走公开 API，无 key；
 *  · bilibili 搜索要走 wbi 签名，单独实现；view 接口免签，站点适配器里用。
 *  · tavily / brave / serper 有 key 就自动启用（配置或环境变量）。
 */

import { createHash } from 'node:crypto';
import { fetchText, fetchJson, mapLimit, absoluteUrl, HttpError } from './http.js';
import { decodeEntities, htmlToMarkdown } from './extract.js';

const enc = (s) => encodeURIComponent(String(s ?? ''));

function cleanText(s) {
  return decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/* ───────────────────────── Bing ───────────────────────── */

function parseBing(html, baseUrl) {
  const out = [];
  const blocks = String(html).split(/<li class="b_algo"/).slice(1);
  for (const block of blocks) {
    const anchor = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!anchor) continue;
    const url = absoluteUrl(decodeEntities(anchor[1]), 'https://cn.bing.com');
    if (!url || !/^https?:/i.test(url)) continue;
    const snippet =
      /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ||
      /<div[^>]*class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ||
      '';
    out.push({ title: cleanText(anchor[2]), url, snippet: cleanText(snippet), site: hostOf(url) });
  }
  return out;
}

/* ───────────────────────── 360 搜索 ───────────────────────── */

function parseSo360(html) {
  const out = [];
  const blocks = String(html).split(/<li class="res-list"/).slice(1);
  for (const block of blocks) {
    const anchor = /<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!anchor) continue;
    const url = absoluteUrl(decodeEntities(anchor[1]), 'https://www.so.com');
    if (!url || !/^https?:/i.test(url)) continue;
    const snippet =
      /<p[^>]*class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ||
      /<div[^>]*class="[^"]*res-comm-con[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1] ||
      '';
    /* 360 的结果链接是 so.com/link?m=… 跳转链，真实域名只能从 cite 里读 */
    const cite = cleanText(/<cite[^>]*>([\s\S]*?)<\/cite>/i.exec(block)?.[1] || '');
    out.push({
      title: cleanText(anchor[2]),
      url,
      snippet: cleanText(snippet),
      site: cite.replace(/^https?:\/\//, '').split('/')[0] || hostOf(url),
      extra: { redirect: url.includes('/link?'), realSite: cite },
    });
  }
  return out;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/* ───────────────────────── GitHub ───────────────────────── */

async function githubSearch(query, { limit = 10, kind = 'repos' } = {}) {
  const headers = { accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  if (kind === 'code') {
    const { json } = await fetchJson(`https://api.github.com/search/code?q=${enc(query)}&per_page=${limit}`, { headers });
    return (json.items || []).map((it) => ({
      title: `${it.repository?.full_name || ''} / ${it.path || ''}`,
      url: it.html_url,
      snippet: `代码命中：${it.path || ''}（仓库 ${it.repository?.full_name || '?'}）`,
      site: 'github.com',
      kind: 'code',
    }));
  }
  const { json } = await fetchJson(
    `https://api.github.com/search/repositories?q=${enc(query)}&per_page=${limit}&sort=stars&order=desc`,
    { headers },
  );
  return (json.items || []).map((it) => ({
    title: it.full_name,
    url: it.html_url,
    snippet: `${it.description || '(无描述)'} · ★${it.stargazers_count} · ${it.language || '?'} · 更新 ${String(it.updated_at || '').slice(0, 10)}`,
    site: 'github.com',
    kind: 'repo',
    extra: { stars: it.stargazers_count, language: it.language, license: it.license?.spdx_id || '', topics: it.topics || [] },
  }));
}

/* ───────────────────────── 学术检索（OpenAlex / Crossref） ─────────────────────────
 * 为什么不是 arXiv 官方 API：export.arxiv.org 在本机网络被墙（实测 000），
 * 而 arxiv.org 主页/摘要页能通。所以论文检索走 OpenAlex（开放、免 key），
 * 需要 DOI 元数据时用 Crossref。arXiv 单篇仍可用 res_fetch 抓 abs 页。 */

async function openalexSearch(query, { limit = 10 } = {}) {
  const url = `https://api.openalex.org/works?search=${enc(query)}&per-page=${Math.min(limit, 25)}&mailto=resfinder@localhost`;
  const { json } = await fetchJson(url, { timeoutMs: 25000 });
  return (json.results || []).map((w) => {
    const authors = (w.authorships || []).slice(0, 3).map((a) => a.author?.display_name).filter(Boolean).join('、');
    const doi = String(w.doi || '').replace(/^https?:\/\/doi\.org\//, '');
    const link = w.open_access?.oa_url || w.primary_location?.landing_page_url || (doi ? `https://doi.org/${doi}` : '');
    return {
      title: w.title || '(无标题)',
      url: link,
      snippet: `${w.publication_year || '?'} 年 · 被引 ${w.cited_by_count ?? '?'} 次 · ${authors || '作者未知'}${doi ? ` · DOI ${doi}` : ''}`,
      site: link ? hostOf(link) : 'openalex.org',
      kind: 'paper',
      extra: { doi, year: w.publication_year, citedBy: w.cited_by_count, oa: Boolean(w.open_access?.is_oa) },
    };
  }).filter((r) => r.url);
}

async function crossrefSearch(query, { limit = 10 } = {}) {
  const url = `https://api.crossref.org/works?query=${enc(query)}&rows=${Math.min(limit, 20)}&select=DOI,title,URL,container-title,issued,author,is-referenced-by-count`;
  const { json } = await fetchJson(url, { timeoutMs: 25000 });
  return (json.message?.items || []).map((it) => ({
    title: it.title?.[0] || '(无标题)',
    url: it.URL || (it.DOI ? `https://doi.org/${it.DOI}` : ''),
    snippet: `${it['container-title']?.[0] || '未标注期刊'} · ${(it.issued?.['date-parts']?.[0] || ['?'])[0]} 年 · 被引 ${it['is-referenced-by-count'] ?? '?'}${it.DOI ? ` · DOI ${it.DOI}` : ''}`,
    site: 'doi.org',
    kind: 'paper',
    extra: { doi: it.DOI },
  })).filter((r) => r.url);
}

/* ───────────────────────── 哔哩哔哩（wbi 签名） ───────────────────────── */

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
  12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52,
];

function biliHeaders() {
  return {
    referer: 'https://www.bilibili.com/',
    origin: 'https://www.bilibili.com',
    cookie: `buvid3=${randomHex(16)}-${randomHex(8)}-${randomHex(8)}-${randomHex(8)}-${randomHex(12)}infoc`,
  };
}

const BILI_HEADERS = biliHeaders();

function randomHex(n) {
  return Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
}

function md5(s) {
  return createHash('md5').update(String(s)).digest('hex');
}

let wbiCache = { key: '', at: 0 };

async function biliMixinKey() {
  if (wbiCache.key && Date.now() - wbiCache.at < 6 * 3600 * 1000) return wbiCache.key;
  const { json } = await fetchJson('https://api.bilibili.com/x/web-interface/nav', { headers: BILI_HEADERS });
  const imgUrl = json?.data?.wbi_img?.img_url || '';
  const subUrl = json?.data?.wbi_img?.sub_url || '';
  const name = (u) => String(u).split('/').pop().split('.')[0];
  const raw = name(imgUrl) + name(subUrl);
  if (raw.length < 32) throw new HttpError('哔哩哔哩 wbi 密钥获取失败（nav 接口未返回 wbi_img）', { status: 502 });
  const key = MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join('').slice(0, 32);
  wbiCache = { key, at: Date.now() };
  return key;
}

async function biliSign(params) {
  const mixin = await biliMixinKey();
  const wts = Math.floor(Date.now() / 1000);
  const merged = { ...params, wts };
  const query = Object.keys(merged)
    .sort()
    .map((k) => `${enc(k)}=${enc(String(merged[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return `${query}&w_rid=${md5(query + mixin)}`;
}

/**
 * B 站搜索：wbi 签名 + 一次重试。
 * 实测空手有两种原因——签名密钥过期、或触发了风控（返回 412 / code≠0 / 结果为空）。
 * 两种都靠"清掉 wbi 缓存 + 换一个 buvid3 cookie 再试一次"解决大部分情况；
 * 真被风控挡住就如实抛出，让上层显示"失败"而不是伪装成"没结果"。
 */
async function bilibiliSearch(query, { limit = 10 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      wbiCache = { key: '', at: 0 };
      Object.assign(BILI_HEADERS, biliHeaders());
      await new Promise((r) => setTimeout(r, 900)); /* 连续打会被风控，退一步再试 */
    }
    try {
      const qs = await biliSign({ search_type: 'video', keyword: query, page: 1, page_size: Math.min(limit, 20) });
      const { json } = await fetchJson(`https://api.bilibili.com/x/web-interface/wbi/search/type?${qs}`, { headers: BILI_HEADERS });
      if (json?.code !== 0) {
        throw new HttpError(`哔哩哔哩搜索返回 code=${json?.code} ${json?.message || ''}`, { status: 502 });
      }
      const items = json?.data?.result || [];
      if (!items.length) {
        lastError = new HttpError('哔哩哔哩搜索返回 0 条（可能是风控或关键词无人命中）', { status: 502 });
        continue;
      }
      return items.map((it) => ({
        title: cleanText(it.title),
        url: it.bvid ? `https://www.bilibili.com/video/${it.bvid}` : String(it.arcurl || ''),
        snippet: `${cleanText(it.description || '').slice(0, 200)} · UP ${cleanText(it.author || '')} · 播放 ${fmtCount(it.play)} · 弹幕 ${fmtCount(it.video_review)} · ${it.duration || ''}`,
        site: 'bilibili.com',
        kind: 'video',
        extra: { bvid: it.bvid, author: it.author, pubdate: it.pubdate },
      })).filter((r) => r.title && r.url);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('哔哩哔哩搜索失败');
}

function fmtCount(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
  return String(v);
}

/* ───────────────────────── 可选：带 key 的商用检索 ───────────────────────── */

async function tavilySearch(query, { limit = 10 } = {}) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new HttpError('未配置 TAVILY_API_KEY', { status: 401 });
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, max_results: limit, include_answer: false }),
  });
  const json = await res.json();
  return (json.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content, site: hostOf(r.url), kind: 'web' }));
}

async function braveSearch(query, { limit = 10 } = {}) {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new HttpError('未配置 BRAVE_API_KEY', { status: 401 });
  const { json } = await fetchJson(`https://api.search.brave.com/res/v1/web/search?q=${enc(query)}&count=${limit}`, {
    headers: { 'x-subscription-token': key, accept: 'application/json' },
  });
  return (json.web?.results || []).map((r) => ({ title: r.title, url: r.url, snippet: cleanText(r.description), site: hostOf(r.url), kind: 'web' }));
}

async function searxSearch(query, { limit = 10, searxUrl } = {}) {
  const base = String(searxUrl || process.env.SEARXNG_URL || '').replace(/\/$/, '');
  if (!base) throw new HttpError('未配置 searxng 实例地址（config.searxUrl 或 SEARXNG_URL）', { status: 401 });
  const { json } = await fetchJson(`${base}/search?q=${enc(query)}&format=json&language=zh-CN`);
  return (json.results || []).slice(0, limit).map((r) => ({ title: r.title, url: r.url, snippet: cleanText(r.content), site: hostOf(r.url), kind: 'web' }));
}

/* ───────────────────────── 引擎注册表 ───────────────────────── */

/* ───────────────────────── 包仓库（npm / crates.io） ─────────────────────────
 * 找库/找工具时，包仓库比通用搜索引擎准得多：能直接看到版本、下载量、维护状态。
 * 两个都是免 key 的公开 API，本机实测 200。 */

async function npmSearch(query, { limit = 10 } = {}) {
  const { json } = await fetchJson(`https://registry.npmjs.org/-/v1/search?text=${enc(query)}&size=${Math.min(limit, 25)}`);
  return (json.objects || []).map((o) => {
    const p = o.package || {};
    const weekly = o.downloads?.weekly ? ` · 周下载 ${o.downloads.weekly}` : '';
    return {
      title: p.name,
      url: `https://www.npmjs.com/package/${p.name}`,
      snippet: `${p.description || '(无描述)'} · v${p.version}${weekly} · 发布者 ${p.publisher?.username || '?'} · 更新 ${String(p.date || '').slice(0, 10)}`,
      site: 'npmjs.com',
      kind: 'package',
      extra: { version: p.version, homepage: p.links?.homepage || '', repo: p.links?.repository || '' },
    };
  });
}

async function cratesSearch(query, { limit = 10 } = {}) {
  const { json } = await fetchJson(`https://crates.io/api/v1/crates?q=${enc(query)}&per_page=${Math.min(limit, 25)}`, {
    headers: { 'user-agent': 'dsh-resfinder/0.1 (local agent)' },
  });
  return (json.crates || []).map((c) => ({
    title: c.name,
    url: `https://crates.io/crates/${c.name}`,
    snippet: `${c.description || '(无描述)'} · v${c.default_version || c.max_version} · 累计下载 ${c.downloads} · 更新 ${String(c.updated_at).slice(0, 10)}`,
    site: 'crates.io',
    kind: 'package',
    extra: { version: c.default_version, repo: c.repository || '' },
  }));
}

/* ───────────────────────── Stack Overflow（技术问答） ───────────────────────── */

async function stackSearch(query, { limit = 10 } = {}) {
  const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${enc(query)}&site=stackoverflow&pagesize=${Math.min(limit, 25)}&filter=default`;
  const { json } = await fetchJson(url, { timeoutMs: 20000 });
  return (json.items || []).map((it) => ({
    title: cleanText(it.title),
    url: it.link,
    snippet: `得分 ${it.score} · 回答 ${it.answer_count}${it.is_answered ? '（已解决）' : '（未解决）'} · 标签 ${(it.tags || []).slice(0, 4).join(', ')}`,
    site: 'stackoverflow.com',
    kind: 'qa',
    extra: { score: it.score, answered: it.is_answered },
  }));
}

/* ───────────────────────── 引擎注册表 ───────────────────────── */

export const ENGINES = {
  bing: {
    id: 'bing', label: 'Bing', kind: 'web',
    async search(query, { limit = 10, lang = 'zh-CN' } = {}) {
      const url = `https://cn.bing.com/search?q=${enc(query)}&count=${Math.min(limit * 2, 30)}&setlang=${lang}&ensearch=0`;
      const { text, url: finalUrl } = await fetchText(url, { timeoutMs: 18000 });
      return parseBing(text, finalUrl).slice(0, limit);
    },
  },
  so360: {
    id: 'so360', label: '360 搜索', kind: 'web',
    async search(query, { limit = 10 } = {}) {
      const { text } = await fetchText(`https://www.so.com/s?q=${enc(query)}&pn=1`, { timeoutMs: 12000 });
      return parseSo360(text).slice(0, limit);
    },
  },
  github: {
    id: 'github', label: 'GitHub 仓库', kind: 'code',
    search: (q, o) => githubSearch(q, { ...o, kind: 'repos' }),
  },
  arxiv: { id: 'paper', label: '论文（OpenAlex）', kind: 'paper', search: openalexSearch },
  paper: { id: 'paper', label: '论文（OpenAlex）', kind: 'paper', search: openalexSearch },
  crossref: { id: 'crossref', label: '论文（Crossref DOI）', kind: 'paper', search: crossrefSearch },
  bilibili: { id: 'bilibili', label: '哔哩哔哩视频', kind: 'video', search: bilibiliSearch },
  npm: { id: 'npm', label: 'npm 包', kind: 'package', search: npmSearch },
  crates: { id: 'crates', label: 'crates.io（Rust）', kind: 'package', search: cratesSearch },
  stackoverflow: { id: 'stackoverflow', label: 'Stack Overflow', kind: 'qa', search: stackSearch },
  tavily: { id: 'tavily', label: 'Tavily（需 key）', kind: 'web', search: tavilySearch },
  brave: { id: 'brave', label: 'Brave（需 key）', kind: 'web', search: braveSearch },
  searxng: { id: 'searxng', label: 'SearXNG（自建）', kind: 'web', search: searxSearch },
};

/* 默认只用 bing：实测最快最稳。其它源在 bing 空手或显式点名时才上，
   避免每次检索都被慢引擎拖住（360 单次能拖十几秒）。 */
export const DEFAULT_ENGINES = ['bing'];
export const FALLBACK_ENGINES = ['so360'];

function dedupe(results) {
  const seen = new Set();
  const out = [];
  for (const r of results) {
    if (!r?.url) continue;
    const key = r.url.replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * 跑检索。engine='auto' 时按默认引擎并发，单个引擎失败不影响整体。
 * @returns {Promise<{results:Array, engines:Array<{id:string,ok:boolean,count:number,error?:string}>}>}
 */
export async function search(query, { engines = 'auto', limit = 10, lang = 'zh-CN', site = '', searxUrl = '', timeoutMs = 18000 } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('检索词不能为空');
  const finalQuery = site ? `${q} site:${site}` : q;
  const auto = engines === 'auto' || !engines;
  const wanted = auto ? DEFAULT_ENGINES : String(engines).split(',').map((s) => s.trim()).filter(Boolean);

  const unknown = wanted.filter((id) => !ENGINES[id]);
  if (unknown.length) throw new Error(`未知检索源：${unknown.join(', ')}（可用：${Object.keys(ENGINES).join(' / ')}）`);

  const perEngine = Math.max(3, Math.ceil(limit * 0.8));
  const runGroup = (ids) => mapLimit(ids, 3, async (id) => {
    const started = Date.now();
    try {
      const results = await ENGINES[id].search(finalQuery, { limit: perEngine, lang, searxUrl, timeoutMs });
      return { id, ok: true, count: results.length, ms: Date.now() - started, results: results.map((r) => ({ ...r, engine: id })) };
    } catch (err) {
      return { id, ok: false, count: 0, ms: Date.now() - started, error: err?.message || String(err), results: [] };
    }
  });

  let settled = await runGroup(wanted);
  let merged = dedupe(settled.flatMap((s) => s.results)).slice(0, limit);

  /* auto 模式空手 → 换备用源再给一次机会，而不是直接回"啥也没找到" */
  if (auto && merged.length === 0) {
    const backup = await runGroup(FALLBACK_ENGINES.filter((id) => !wanted.includes(id)));
    settled = settled.concat(backup);
    merged = dedupe(settled.flatMap((s) => s.results)).slice(0, limit);
  }

  return {
    results: merged,
    engines: settled.map(({ results, ...meta }) => meta),
  };
}

export async function searchAndCheck(query, opts = {}) {
  const out = await search(query, opts);
  return out;
}

export { githubSearch, openalexSearch, crossrefSearch, bilibiliSearch, npmSearch, cratesSearch, stackSearch, parseBing, parseSo360, htmlToMarkdown };
