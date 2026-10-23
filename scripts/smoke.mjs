/**
 * 冒烟测试：不依赖 DSH 宿主，直接跑 lib 的真实网络能力。
 * 用法：node scripts/smoke.mjs      （约 40 秒，需要联网）
 * 环境：DSH_HOME 有就用它存资源库；也可用 RESFINDER_HOME 单独指定。
 * 退出码 0 = 全部通过；1 = 有失败项。
 */

import { search } from '../lib/search.js';
import { readPage } from '../lib/sites.js';
import { verifyLink, sha256File } from '../lib/verify.js';
import { channelsFor } from '../lib/channels.js';
import { save, list, stats } from '../lib/store.js';
import { panelHtml, handleApi } from '../lib/ui.js';

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((note) => results.push({ name, ok: true, note: note || '' }))
    .catch((err) => results.push({ name, ok: false, note: err?.message || String(err) }));
}

await check('search · bing', async () => {
  const r = await search('nodejs 官网', { limit: 3 });
  if (!r.results.length) throw new Error('0 条结果');
  return `${r.results.length} 条 · ${r.results[0].title.slice(0, 30)}`;
});

await check('search · github', async () => {
  const r = await search('mcp server', { engines: 'github', limit: 3 });
  if (!r.results.length) throw new Error('0 条结果');
  return r.results[0].title;
});

await check('search · bilibili', async () => {
  const r = await search('红队 渗透', { engines: 'bilibili', limit: 2 });
  if (!r.results.length) throw new Error('0 条结果');
  return r.results[0].title.slice(0, 30);
});

await check('search · paper(OpenAlex)', async () => {
  const r = await search('retrieval augmented generation', { engines: 'paper', limit: 2 });
  if (!r.results.length) throw new Error('0 条结果');
  return r.results[0].title.slice(0, 40);
});

await check('search · npm 包', async () => {
  const r = await search('markdown parser', { engines: 'npm', limit: 2 });
  if (!r.results.length) throw new Error('0 条结果');
  return `${r.results[0].title} · ${r.results[0].snippet.slice(0, 40)}`;
});

await check('search · crates.io', async () => {
  const r = await search('serde', { engines: 'crates', limit: 2 });
  if (!r.results.length) throw new Error('0 条结果');
  return r.results[0].title;
});

await check('search · stackoverflow', async () => {
  const r = await search('python list comprehension', { engines: 'stackoverflow', limit: 2 });
  if (!r.results.length) throw new Error('0 条结果');
  return r.results[0].title.slice(0, 40);
});

await check('read · github 适配器', async () => {
  const r = await readPage('https://github.com/searxng/searxng', { maxChars: 400 });
  /* 适配器失败会降级成 generic：如果是配额问题就注明，不算功能坏了 */
  if (r.adapter !== 'github') {
    if (/rate limit|403/i.test(r.fallbackReason || '')) return `跳过（GitHub 配额用尽，已降级 generic：${r.fallbackReason.slice(0, 60)}）`;
    throw new Error(`适配器未命中：${r.adapter}${r.fallbackReason ? ` / ${r.fallbackReason}` : ''}`);
  }
  return `star=${r.meta?.stars ?? '?'} · ${r.chars} 字符`;
});

await check('read · bilibili 适配器', async () => {
  const r = await readPage('https://www.bilibili.com/video/BV1Ms8i6oENx/', { maxChars: 400 });
  if (r.adapter !== 'bilibili') throw new Error(`适配器未命中：${r.adapter}`);
  return r.title.slice(0, 30);
});

await check('read · douban 适配器', async () => {
  const r = await readPage('https://book.douban.com/subject/1084336/', { maxChars: 400 });
  if (r.adapter !== 'douban') throw new Error(`适配器未命中：${r.adapter}`);
  if (!r.meta?.rating) throw new Error('没取到评分');
  return `${r.title} · ${r.meta.rating} 分`;
});

await check('read · 通用页面抽取', async () => {
  const r = await readPage('https://nodejs.org/zh-cn', { maxChars: 600 });
  if (r.adapter !== 'generic') throw new Error(`适配器异常：${r.adapter}`);
  if (r.content.length < 100) throw new Error('正文太短，可能抽取失败');
  return `${r.chars} 字符`;
});

await check('verify · 官方域名判 official', async () => {
  const r = await verifyLink('https://nodejs.org/zh-cn/download');
  if (r.verdict !== 'official') throw new Error(`判成了 ${r.verdict}`);
  return `${r.finalHost} · TLS ${r.tls?.issuer || '?'}`;
});

await check('verify · 短链判 suspicious', async () => {
  const r = await verifyLink('https://bit.ly/3xyz');
  if (r.verdict !== 'suspicious') throw new Error(`判成了 ${r.verdict}`);
  return r.chain.map((c) => c.host).join(' → ');
});

await check('channels · 登记表命中', async () => {
  const info = channelsFor('我想装 nodejs');
  if (!info.registryHit) throw new Error('没命中登记表');
  return info.channels[0].url;
});

await check('store · 写入/查询/统计', async () => {
  const rec = save({ title: '[smoke] Node.js 官网', url: 'https://nodejs.org/zh-cn/download', kind: 'software', tags: ['smoke'], verified: true });
  const hit = list({ tag: 'smoke' });
  if (!hit.length) throw new Error('存进去查不到');
  return `${rec.id} · 库内共 ${stats().total} 条`;
});

await check('verify · 本地文件哈希', async () => {
  const h = sha256File(new URL(import.meta.url).pathname.replace(/^\//, ''));
  if (!/^[a-f0-9]{64}$/.test(h.sha256)) throw new Error('哈希格式异常');
  return `${h.bytes} 字节`;
});

await check('panel · 页面 + API 桥', async () => {
  const html = panelHtml();
  if (!html.includes('/resfinder/api')) throw new Error('页面没挂 API 路径');
  if (!html.includes('巡检库内链接')) throw new Error('页面缺巡检按钮');
  const body = Buffer.from(JSON.stringify({ op: 'stats' }));
  const res = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(s) { this.body = s; } };
  await handleApi({
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator]() { yield body; },
  }, res);
  const parsed = JSON.parse(res.body);
  if (!parsed.ok) throw new Error(`API 返回失败：${parsed.error}`);
  return `页面 ${html.length} 字节 · API ok · 库内 ${parsed.data.total} 条`;
});

await check('watch · 变化判定（未登录也能跑的逻辑）', async () => {
  const { diffCheck } = await import('../lib/watch.js');
  const cases = [
    [null, { status: 0, verdict: 'suspicious', finalHost: '', tlsOk: null }, ['down']],
    [null, { status: 200, verdict: 'official', finalHost: 'a.com', tlsOk: true }, ['first-check']],
    [{ status: 200, verdict: 'official', finalHost: 'a.com', tlsOk: true }, { status: 200, verdict: 'official', finalHost: 'a.com', tlsOk: false }, ['tls-warning']],
    [{ status: 200, verdict: 'official', finalHost: 'a.com' }, { status: 200, verdict: 'official', finalHost: 'b.com' }, ['domain-changed']],
    [{ status: 404, verdict: 'unknown', finalHost: 'a.com' }, { status: 200, verdict: 'unknown', finalHost: 'a.com' }, ['up']],
  ];
  for (const [prev, now, want] of cases) {
    const got = diffCheck(prev, now);
    if (got.join(',') !== want.join(',')) throw new Error(`期望 ${want.join(',')} 实际 ${got.join(',')}`);
  }
  return `${cases.length} 个用例全对`;
});

await check('watch · 试跑（死链要报 down）', async () => {
  const { watch } = await import('../lib/watch.js');
  const r = await watch({ urls: ['https://this-domain-should-not-exist-9z8x.example/'] });
  if (!r.alerts.length) throw new Error('死链没被报出来');
  return `${r.checked} 条 · 报警 ${r.alerts.length} 条`;
});

await check('tools · 9 个工具都定义完整', async () => {
  const { buildTools } = await import('../lib/tools.js');
  const tools = buildTools();
  const names = tools.map((t) => t.name);
  const want = ['res_search', 'res_read', 'res_dig', 'res_channels', 'res_verify', 'res_save', 'res_library', 'res_watch', 'res_sources'];
  for (const n of want) {
    if (!names.includes(n)) throw new Error(`缺工具 ${n}`);
  }
  for (const t of tools) {
    if (!t.description || t.description.length < 20) throw new Error(`${t.name} 描述太短`);
    if (t.parameters?.type !== 'object') throw new Error(`${t.name} 参数不是 JSON Schema object`);
    if (typeof t.execute !== 'function') throw new Error(`${t.name} 没有 execute`);
  }
  return `${tools.length} 个 · 全部有描述/参数/execute`;
});

await check('memory · 缓存命中 + 来源指标', async () => {
  const { buildTools } = await import('../lib/tools.js');
  const tools = Object.fromEntries(buildTools().map((t) => [t.name, t]));
  const q = `缓存自检 ${process.pid} ${Date.now()}`;
  const first = await tools.res_search.execute({ query: q, limit: 2 });
  if (first.data?.cached) throw new Error('首次不该命中缓存');
  const second = await tools.res_search.execute({ query: q, limit: 2 });
  if (!second.data?.cached) throw new Error('同参数第二次没命中缓存');
  const sources = await tools.res_sources.execute({});
  if (!sources.text.includes('来源质量')) throw new Error('res_sources 没有来源质量段');
  return `二次命中：${second.text.split('\n')[0].slice(0, 30)}`;
});

await check('memory · 结构化输出 data 字段', async () => {
  const { buildTools } = await import('../lib/tools.js');
  const tools = Object.fromEntries(buildTools().map((t) => [t.name, t]));
  const r = await tools.res_search.execute({ query: 'nodejs', limit: 2 });
  if (!Array.isArray(r.data?.results)) throw new Error('res_search 缺 data.results');
  if (typeof r.data.results[0]?.url !== 'string') throw new Error('data.results 结构不对');
  return `${r.data.results.length} 条结构化结果`;
});

let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.note ? `  —  ${r.note}` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exitCode = failed ? 1 : 0;
