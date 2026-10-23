/**
 * 工具层：把 lib 能力包装成模型可直接调用的 res_* 工具。
 *
 * 约定：
 *  · 一律返回 { text }，失败也返回文本（以 "ERROR: " 开头），而不是抛异常 ——
 *    让模型自己看得见错误、自己换策略，比整轮工具炸掉更有用；
 *  · 每个工具都要能单独工作，不依赖上一次调用留下的隐式状态；
 *  · 输出里显式写出"来源/时间/是否截断"，避免把没验过的东西当成事实。
 */

import { search, ENGINES, DEFAULT_ENGINES } from './search.js';
import { mapLimit } from './http.js';
import { readPage, readMany } from './sites.js';
import { verifyLink, sha256File, compareSha256 } from './verify.js';
import { channelsFor, registryStats } from './channels.js';
import { save, list, stats, remove, findByUrl, patch } from './store.js';
import { watch, formatWatch } from './watch.js';
import { cacheKey, cacheGet, cacheSet, recordEngine, formatQuality, cacheStats } from './memory.js';

/* 缓存有效期：检索结果 30 分钟、页面正文 6 小时、深挖 2 小时。
   过期的记忆比没记忆更危险，所以宁短不长；命中时会明确标出"多久之前"。 */
const TTL = { search: 30 * 60 * 1000, read: 6 * 60 * 60 * 1000, dig: 2 * 60 * 60 * 1000 };

function ageLabel(ageMs) {
  const s = Math.round(Number(ageMs || 0) / 1000);
  if (s < 90) return `${s} 秒前`;
  if (s < 5400) return `${Math.round(s / 60)} 分钟前`;
  return `${(s / 3600).toFixed(1)} 小时前`;
}

const ERROR = (msg) => `ERROR: ${msg}`;

function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function fmtResults({ results, engines }, query) {
  const engineNote = engines
    .map((e) => (e.ok ? `${e.id}(${e.count} 条/${e.ms}ms)` : `${e.id}(失败: ${e.error})`))
    .join('，');
  if (!results.length) {
    return `检索「${query}」没有结果。引擎：${engineNote}\n建议：换更短的关键词、换语言（英文名）、或显式指定 engines（github / bilibili / paper / crossref / so360）。`;
  }
  const lines = [`检索「${query}」共 ${results.length} 条（引擎：${engineNote}）`, ''];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet.slice(0, 300)}`);
    if (r.site) lines.push(`   来源站点：${r.site}${r.extra?.redirect ? `（跳转链，真实站点 ${r.extra.realSite || '?'}）` : ''}`);
  });
  lines.push('', '下一步可用：res_read 读某条正文；res_verify 核对域名；res_channels 找官方下载渠道；res_save 存进资源库。');
  return lines.join('\n');
}

export function buildTools() {
  return [
    {
      name: 'res_search',
      description:
        '通用检索：一次调用打多个源（默认 Bing；可选 360 / GitHub / 哔哩哔哩 / 论文 OpenAlex / Crossref DOI / SearXNG / Tavily / Brave）。用于找资料、找软件官网、找视频、找论文、找代码仓库。返回标题+链接+摘要+来源站点，不做内容抓取（要正文用 res_read）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '检索词。中英文都行；找官网就写「产品名 官网」或「产品名 official site」。' },
          engines: {
            type: 'string',
            description: '逗号分隔的源，缺省 auto（Bing，空手时自动换 360）。可用：bing / so360 / github / bilibili / paper / crossref / searxng / tavily / brave。',
          },
          limit: { type: 'number', description: '返回条数，默认 8，最大 20。' },
          site: { type: 'string', description: '只搜某个站点，例如 github.com、bilibili.com、arxiv.org。' },
          lang: { type: 'string', description: '语言偏好，默认 zh-CN；英文内容用 en-US。' },
        },
        required: ['query'],
      },
      async execute(args) {
        const query = String(args.query || '').trim();
        if (!query) return { text: ERROR('query 不能为空') };
        const limit = Math.min(Math.max(1, Number(args.limit) || 8), 20);
        const engines = args.engines || 'auto';
        const site = args.site || '';
        const key = cacheKey(['search', engines, limit, site, args.lang || 'zh-CN', query]);
        try {
          const cached = cacheGet(key, TTL.search);
          if (cached.hit) {
            return {
              text: `[缓存 · ${ageLabel(cached.ageMs)}查过] 命中的是同一组参数；要最新结果就换 engines 或加 site 重新搜。\n\n${fmtResults(cached.value, query)}`,
              data: { ...cached.value, cached: true, cachedAt: cached.cachedAt },
            };
          }
          const out = await search(query, { engines, limit, site, lang: args.lang || 'zh-CN' });
          for (const e of out.engines) recordEngine(e.id, { ok: e.ok, empty: e.ok && e.count === 0, ms: e.ms, error: e.error });
          cacheSet(key, out, TTL.search);
          return { text: fmtResults(out, query), data: { results: out.results, engines: out.engines, cached: false } };
        } catch (err) {
          return { text: ERROR(`检索失败：${err.message}`) };
        }
      },
    },

    {
      name: 'res_read',
      description:
        '读一个页面并转成可引用的正文。内置站点适配器：GitHub 仓库（Star/许可/Releases/README）、哔哩哔哩视频（UP/简介/分P/字幕地址）、arXiv 摘要页（作者/摘要/PDF/DOI），其它站点走正文抽取。长文自动截断并给 nextOffset 供续读。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', description: '完整 http(s) 地址。' },
          mode: { type: 'string', enum: ['markdown', 'text'], description: '输出格式，默认 markdown（保留标题/链接）。' },
          maxChars: { type: 'number', description: '最多返回多少字符，默认 20000。' },
          offset: { type: 'number', description: '从第几个字符开始（续读长文用），默认 0。' },
          withLinks: { type: 'boolean', description: '同时列出页面里值得跟进的链接。' },
        },
        required: ['url'],
      },
      async execute(args) {
        const url = String(args.url || '').trim();
        if (!/^https?:\/\//i.test(url)) return { text: ERROR('url 必须是完整 http(s) 地址') };
        try {
          const r = await readPage(url, {
            mode: args.mode === 'text' ? 'text' : 'markdown',
            maxChars: Math.min(Math.max(500, Number(args.maxChars) || 20000), 60000),
            offset: Number(args.offset) || 0,
            withLinks: Boolean(args.withLinks),
          });
          const key = cacheKey(['read', url, args.mode === 'text' ? 'text' : 'markdown', Number(args.offset) || 0]);
          cacheSet(key, r, TTL.read);
          /* 用前自动校鲜（事件驱动的巡检，不靠 cron）：
             这条 URL 在库里、且上次核验超过 7 天 → 后台重核验一次，不阻塞本次返回。
             结果只回写库，不打扰调用方；烂了下次 res_watch / 面板就能看到。 */
          const known = findByUrl(url);
          if (known && r.status >= 400) {
            /* 软 404：页面抓回来了但状态码是 404/410 之类，同样算链接烂了 */
            try {
              patch(known.id, { lastIssue: 'down', lastStatus: r.status, lastCheckedAt: new Date().toISOString() });
            } catch { /* ignore */ }
          }
          if (known) {
            const staleMs = 7 * 24 * 60 * 60 * 1000;
            const last = known.lastCheckedAt ? Date.parse(known.lastCheckedAt) : 0;
            if (!last || Date.now() - last > staleMs) {
              void (async () => {
                try {
                  const v = await verifyLink(r.finalUrl || url);
                  patch(known.id, {
                    lastCheckedAt: new Date().toISOString(),
                    lastVerdict: v.verdict,
                    lastFinalHost: v.finalHost,
                    lastStatus: v.finalStatus,
                    lastIssue: v.finalStatus >= 400 ? 'down' : '',
                  });
                } catch { /* 后台校鲜失败就算了，不影响本次读取 */ }
              })();
            }
          }
          const head = [
            `# ${r.title}`,
            `适配器：${r.adapter} · 全文 ${r.chars} 字符${r.truncated ? ` · 已截断，续读用 offset=${r.nextOffset}` : ''}`,
          ];
          if (r.fallbackReason) head.push(`⚠ 适配器回退（${r.fallbackReason}）—— 现在给的是通用正文，可能缺结构化字段（如 Star/Releases）；配 GITHUB_TOKEN 可提高配额。`);
          if (r.meta && Object.keys(r.meta).length) {
            head.push(`元信息：${Object.entries(r.meta).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${v}`).join(' · ')}`);
          }
          head.push('', r.content);
          if (r.links?.length) {
            head.push('', '## 页面链接');
            for (const l of r.links.slice(0, 25)) head.push(`- ${l.text || '(无标题)'} → ${l.url}`);
          }
          return {
            text: head.join('\n'),
            data: {
              url: r.url,
              finalUrl: r.finalUrl,
              adapter: r.adapter,
              title: r.title,
              meta: r.meta,
              chars: r.chars,
              truncated: r.truncated,
              nextOffset: r.nextOffset,
              content: r.content,
              links: r.links,
            },
          };
        } catch (err) {
          /* 失败自动回写：读挂了就是最真实的巡检信号，把库里对应条目记成 down，
             下次 agent 选链接时会自己避开（零调度成本，只在真出事时记一笔）。 */
          const broken = findByUrl(url);
          if (broken) {
            try {
              patch(broken.id, {
                lastIssue: 'down',
                lastStatus: 0,
                lastCheckedAt: new Date().toISOString(),
              });
            } catch { /* 记录不存在就算了 */ }
          }
          return { text: ERROR(`读取失败：${err.message}`) };
        }
      },
    },

    {
      name: 'res_dig',
      description:
        '一步到位地"查资料"：先检索，再并行抓前 N 条的正文，返回可直接引用的素材（不替你下结论，只把正文摊开）。适合"这个主题现在是什么情况/给我原始材料"这类需求。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '检索词。' },
          engines: { type: 'string', description: '检索源，同 res_search。' },
          topN: { type: 'number', description: '抓几条正文，默认 3，最大 5。' },
          charsEach: { type: 'number', description: '每条保留多少字符，默认 4000。' },
        },
        required: ['query'],
      },
      async execute(args) {
        const query = String(args.query || '').trim();
        if (!query) return { text: ERROR('query 不能为空') };
        const topN = Math.min(Math.max(1, Number(args.topN) || 3), 5);
        const charsEach = Math.min(Math.max(800, Number(args.charsEach) || 4000), 12000);
        try {
          const digKey = cacheKey(['dig', args.engines || 'auto', topN, charsEach, query]);
          const digCached = cacheGet(digKey, TTL.dig);
          if (digCached.hit) {
            return {
              text: `[缓存 · ${ageLabel(digCached.ageMs)}查过]\n\n${digCached.value.text}`,
              data: { ...digCached.value.data, cached: true, cachedAt: digCached.cachedAt },
            };
          }
          const found = await search(query, { engines: args.engines || 'auto', limit: topN });
          if (!found.results.length) return { text: fmtResults(found, query) };
          const pages = await readMany(found.results.map((r) => r.url), { maxChars: charsEach, concurrency: 3 });
          const lines = [
            `# 「${query}」检索 + 正文（${nowIso()}）`,
            '',
            `命中 ${found.results.length} 条，抓取 ${pages.length} 条正文。`,
            '',
          ];
          found.results.forEach((r, i) => {
            lines.push(`## [${i + 1}] ${r.title}`);
            lines.push(`- URL：${r.url}`);
            if (r.snippet) lines.push(`- 摘要：${r.snippet.slice(0, 240)}`);
            const page = pages.find((p) => p.url === r.url) || pages[i];
            if (page?.error) lines.push(`- 正文：抓取失败（${page.error}）`);
            else if (page) {
              lines.push(`- 正文（${page.chars} 字符，适配器 ${page.adapter}）：`, '', '```', page.content, '```');
            }
            lines.push('');
          });
          lines.push('提醒：以上是页面原文片段，未经交叉验证；关键结论请用 res_verify 核来源可信度。');
          const text = lines.join('\n');
          const data = {
            query,
            results: found.results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet, site: r.site, engine: r.engine })),
            pages: pages.map((p) => ({ url: p.url, title: p.title, adapter: p.adapter, chars: p.chars, error: p.error, content: p.content })),
            cached: false,
          };
          cacheSet(digKey, { text, data }, TTL.dig);
          return { text, data };
        } catch (err) {
          return { text: ERROR(`深挖失败：${err.message}`) };
        }
      },
    },

    {
      name: 'res_channels',
      description:
        '给资源名，直接给它的官方获取渠道（官网 / 官方仓库 Releases / 官方应用商店 / 正版图书馆入口），并说明每个渠道给不给校验值。没登记的资源会给出检索式与"官方站判据"，不会瞎编链接。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: '资源名，例如 nodejs、python、7-zip、国家标准、电子书、字体。' },
        },
        required: ['name'],
      },
      async execute(args) {
        const name = String(args.name || '').trim();
        if (!name) return { text: ERROR('name 不能为空') };
        const info = channelsFor(name);
        const lines = [];
        if (info.registryHit) {
          lines.push(`# ${info.name}（已登记，类目 ${info.category}）`, '');
          for (const ch of info.channels) lines.push(`- **${ch.label}**：${ch.url}${ch.note ? `\n  ${ch.note}` : ''}`);
          lines.push('', '提醒：进入页面后用 res_verify 核最终域名；二进制下载后核对页面给出的 SHA256。');
        } else {
          lines.push(`# 「${info.name}」未登记，按通用打法来找`, '');
          lines.push('## 建议检索式');
          for (const s of info.searches) lines.push(`- [${s.engine}] ${s.query} —— ${s.why}`);
          lines.push('', '## 官方站判据');
          for (const c of info.checklist) lines.push(`- ${c}`);
          lines.push('', info.caution);
        }
        return { text: lines.join('\n') };
      },
    },

    {
      name: 'res_verify',
      description:
        '核验一个链接落在谁手里：跳转链、最终域名、TLS 证书、是否短链/仿冒，给出 official / trusted / unknown / suspicious 四档结论与理由。下载前、填手机号前、登录前先跑一次。也可给出本地文件路径 + 期望 SHA256 做哈希比对。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', description: '要核验的完整地址。' },
          fromPage: {
            type: 'string',
            description: '页面链接体检：给出页面地址，抓出页面上所有外链逐条核验，标出可疑来源（教程/合集页常见仿冒下载链接）。给了它会忽略 url。',
          },
          limit: { type: 'number', description: '体检时最多核验多少条外链，默认 8，最大 15。' },
          file: { type: 'string', description: '可选：本地文件绝对路径，算 SHA256。' },
          expectSha256: { type: 'string', description: '可选：官方公布的期望 SHA256，给出则做比对。' },
        },
      },
      async execute(args) {
        /* 页面链接体检：一篇教程里最危险的不是文章本身，是它给出的下载链接 */
        if (args.fromPage) {
          const page = String(args.fromPage).trim();
          if (!/^https?:\/\//i.test(page)) return { text: ERROR('fromPage 必须是完整 http(s) 地址') };
          const max = Math.min(Math.max(1, Number(args.limit) || 8), 15);
          try {
            const r = await readPage(page, { maxChars: 200, withLinks: true });
            const links = (r.links || []).filter((l) => !l.url.includes(new URL(page).hostname)).slice(0, max);
            if (!links.length) return { text: `页面「${r.title}」里没抓到可体检的外链（可能是 JS 渲染或全站内链）。` };
            const checked = await mapLimit(links, 3, async (l) => {
              try {
                const v = await verifyLink(l.url);
                return { text: l.text || '(无标题)', url: l.url, verdict: v.verdict, host: v.finalHost, status: v.finalStatus, reasons: v.reasons.slice(0, 2) };
              } catch (err) {
                return { text: l.text || '(无标题)', url: l.url, verdict: 'unknown', host: '', status: 0, reasons: [err.message] };
              }
            });
            const order = { suspicious: 0, unknown: 1, trusted: 2, official: 3 };
            checked.sort((a, b) => (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9));
            const bad = checked.filter((c) => c.verdict === 'suspicious');
            const lines = [
              `# 链接体检：${r.title}`,
              ``,
              `页面 ${page} · 共核验 ${checked.length} 条外链 · **${bad.length} 条可疑**`,
              '',
            ];
            for (const c of checked) {
              const mark = c.verdict === 'suspicious' ? '⚠' : c.verdict === 'unknown' ? '?' : '·';
              lines.push(`${mark} [${c.verdict}] ${c.text}`);
              lines.push(`   ${c.url}`);
              if (c.host) lines.push(`   落地 ${c.host} (${c.status})${c.reasons.length ? ` · ${c.reasons.join('；')}` : ''}`);
            }
            lines.push('', '提醒：suspicious 的链接不要在上面登录、填手机号或下可执行文件。');
            return { text: lines.join('\n'), data: { page, title: r.title, checked, suspicious: bad.length } };
          } catch (err) {
            return { text: ERROR(`链接体检失败：${err.message}`) };
          }
        }
        const url = String(args.url || '').trim();
        if (!/^https?:\/\//i.test(url)) return { text: ERROR('url 必须是完整 http(s) 地址（体检模式用 fromPage）') };
        try {
          const r = await verifyLink(url);
          const lines = [
            `# 核验结果：${r.verdict.toUpperCase()}`,
            '',
            `- 入口：${r.url}`,
            `- 最终：${r.finalUrl}（状态 ${r.finalStatus}，${r.https ? 'https' : 'http 明文'}）`,
            `- 最终域名：${r.finalHost}${r.contentType ? ` · Content-Type ${r.contentType}` : ''}`,
            '',
          ];
          if (r.chain.length > 1) {
            lines.push('## 跳转链');
            r.chain.forEach((c, i) => lines.push(`${i + 1}. ${c.status || 'ERR'} ${c.url}${c.location ? ` → ${c.location}` : ''}${c.error ? ` (${c.error})` : ''}`));
            lines.push('');
          }
          if (r.tls) {
            lines.push('## TLS 证书');
            lines.push(`- 签发：${r.tls.issuer || '?'} · 主体：${r.tls.subject || '?'}`);
            lines.push(`- 有效期：${r.tls.validFrom} → ${r.tls.validTo}`);
            lines.push(`- 校验：${r.tls.authorized ? '通过' : `未通过（${r.tls.authorizationError}）`}`);
            if (r.tls.altNames?.length) lines.push(`- SAN：${r.tls.altNames.join(', ')}`);
            lines.push('');
          }
          lines.push('## 判据');
          for (const reason of r.reasons.length ? r.reasons : ['没有触发任何风险特征']) lines.push(`- ${reason}`);
          lines.push('', `## 建议`, r.advice);

          if (args.file) {
            const h = sha256File(String(args.file));
            lines.push('', '## 文件哈希', `- ${h.file}（${h.bytes} 字节）`, `- SHA256：${h.sha256}`);
            if (args.expectSha256) {
              const cmp = compareSha256(h.sha256, args.expectSha256);
              lines.push(`- 与期望值比对：${cmp.match ? '一致 ✓' : '不一致 ✗'}（期望 ${cmp.expected}）`);
            }
          }
          return { text: lines.join('\n') };
        } catch (err) {
          return { text: ERROR(`核验失败：${err.message}`) };
        }
      },
    },

    {
      name: 'res_save',
      description: '把找到并核实过的资源存进本机资源库（按 URL 去重，重复存会更新并 +1 命中）。标签自己定，例如 官方/待读/教材/工具。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: '标题。' },
          url: { type: 'string', description: '完整地址。' },
          kind: { type: 'string', description: '类型：link / software / paper / video / doc / book / asset / other。' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签列表。' },
          note: { type: 'string', description: '备注：为什么存、从哪来的、核验结论。' },
          verified: { type: 'boolean', description: '是否已经 res_verify 核过。' },
        },
        required: ['url'],
      },
      async execute(args) {
        try {
          const rec = save({
            title: args.title,
            url: args.url,
            kind: args.kind,
            tags: Array.isArray(args.tags) ? args.tags : [],
            note: args.note,
            verified: Boolean(args.verified),
            source: 'agent',
          });
          const s = stats();
          return { text: `已存入资源库：${rec.id} · ${rec.title}\n${rec.url}\n当前共 ${s.total} 条（${s.file}）` };
        } catch (err) {
          return { text: ERROR(`保存失败：${err.message}`) };
        }
      },
    },

    {
      name: 'res_library',
      description: '查本机资源库：按关键词/标签/类型检索已存资源，或给 id 删除。也可以看统计（各类型条数、热门标签）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          q: { type: 'string', description: '关键词（标题/URL/备注/标签）。' },
          tag: { type: 'string', description: '按标签过滤。' },
          kind: { type: 'string', description: '按类型过滤。' },
          limit: { type: 'number', description: '条数上限，默认 20。' },
          statsOnly: { type: 'boolean', description: '只看统计。' },
          removeId: { type: 'string', description: '删除某条（给 id）。' },
        },
      },
      async execute(args) {
        try {
          if (args.removeId) {
            const done = remove(String(args.removeId));
            return { text: done ? `已删除 ${args.removeId}` : ERROR(`没找到 ${args.removeId}`) };
          }
          const s = stats();
          if (args.statsOnly) {
            const lines = [`资源库：${s.total} 条`, `文件：${s.file}`];
            lines.push(`类型分布：${Object.entries(s.byKind).map(([k, v]) => `${k} ${v}`).join(' · ') || '（空）'}`);
            lines.push(`热门标签：${s.tags.map((t) => `${t.tag}(${t.n})`).join(' · ') || '（无）'}`);
            return { text: lines.join('\n') };
          }
          const items = list({ q: args.q || '', tag: args.tag || '', kind: args.kind || '', limit: Math.min(Number(args.limit) || 20, 100) });
          if (!items.length) return { text: `资源库里没有匹配项（共 ${s.total} 条）。` };
          const lines = [`命中 ${items.length} 条（库内共 ${s.total} 条）`, ''];
          for (const it of items) {
            lines.push(`- [${it.id}] ${it.title}${it.verified ? ' ✓已核验' : ''}`);
            lines.push(`  ${it.url}`);
            if (it.tags?.length) lines.push(`  标签：${it.tags.join('、')}`);
            if (it.note) lines.push(`  备注：${it.note.slice(0, 160)}`);
          }
          return { text: lines.join('\n') };
        } catch (err) {
          return { text: ERROR(`查询失败：${err.message}`) };
        }
      },
    },

    {
      name: 'res_watch',
      description:
        '巡检本机资源库里已存的链接：逐条核验跳转链/最终域名/TLS，和历史比对后只报告变化——页面挂了（down）、落地域名变了（domain-changed）、可信档位下降（downgraded）、证书校验失败（tls-warning）。首次运行只建立基线。库大了用 limit 分批。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'number', description: '最多巡检多少条（按最近更新排序），默认 50，最大 300。' },
          concurrency: { type: 'number', description: '并发数，默认 3，别超过 5（每条要 1~5 个请求）。' },
          urls: { type: 'array', items: { type: 'string' }, description: '只查这些 URL 试跑，不写历史、不改库。' },
        },
      },
      async execute(args) {
        try {
          const result = await watch({
            limit: Number(args.limit) || 50,
            concurrency: Math.min(Math.max(1, Number(args.concurrency) || 3), 5),
            urls: Array.isArray(args.urls) && args.urls.length ? args.urls : null,
          });
          return {
            text: formatWatch(result),
            data: {
              checked: result.checked,
              alerts: result.alerts.map((a) => ({ title: a.title, url: a.url, kinds: a.kinds, verdict: a.verdict, finalHost: a.finalHost, status: a.status, prev: a.prev })),
              changes: result.changes.map((c) => ({ title: c.title, url: c.url, kinds: c.kinds, alerting: c.alerting, verdict: c.verdict, finalHost: c.finalHost, status: c.status })),
            },
          };
        } catch (err) {
          return { text: ERROR(`巡检失败：${err.message}`) };
        }
      },
    },

    {
      name: 'res_sources',
      description: '列出这个插件当前真正能用的检索源与站点适配器（含哪些需要 API key、本机实测通不通），以及官方渠道登记表的规模。模型拿不准"能查什么"时先调这个。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      async execute() {
        const keyed = {
          tavily: Boolean(process.env.TAVILY_API_KEY),
          brave: Boolean(process.env.BRAVE_API_KEY),
          searxng: Boolean(process.env.SEARXNG_URL),
          github: Boolean(process.env.GITHUB_TOKEN) ? '已配 token（限速更宽）' : '免 token（限速 10 次/分）',
        };
        const lines = ['# 可用检索源', ''];
        for (const [id, e] of Object.entries(ENGINES)) {
          const need = ['tavily', 'brave', 'searxng'].includes(id) ? '需要配置' : '免 key';
          const state = keyed[id] === undefined ? '' : ` · 当前：${keyed[id] === true ? '已配置' : keyed[id]}`;
          lines.push(`- ${id}（${e.label}，${e.kind}）— ${need}${state}`);
        }
        lines.push('', `默认源：${DEFAULT_ENGINES.join(', ')}（空手时自动换 360）`, '');
        lines.push('# 站点适配器');
        lines.push('- github.com/owner/repo → 仓库元信息 + Releases + README');
        lines.push('- bilibili.com/video/BV… → 标题/UP/简介/分P/字幕地址（搜索走 wbi 签名）');
        lines.push('- arxiv.org/abs/… → 作者/摘要/PDF/DOI');
        lines.push('- (book|movie).douban.com/subject/… → 评分/作者/ISBN/简介');
        lines.push('- 其它站点 → 通用正文抽取（Markdown / 纯文本，可续读）');
        lines.push('', `官方渠道登记表：${JSON.stringify(registryStats())}`);
        lines.push('', '# 来源质量（近期实测，按产出率排序）');
        lines.push(formatQuality());
        const cs = cacheStats();
        lines.push('', `# 记忆层：缓存 ${cs.entries} 条（新鲜 ${cs.fresh} / 过期 ${cs.stale}）`);
        lines.push('缓存命中会标明"多久之前查过"；过期记忆不参与命中，宁短勿错。');
        lines.push('', '说明：DDG / 公共 SearXNG / export.arxiv.org 在本机网络实测不通，所以没有列为默认源；有自建 SearXNG 或代理时用 SEARXNG_URL 打开。');
        return { text: lines.join('\n') };
      },
    },
  ];
}
