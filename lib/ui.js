/**
 * Web 面板：`GET /resfinder` 一个单页 + `POST /resfinder/api` 一条 JSON 桥。
 *
 * 为什么自己挂路由而不是做 DSH 侧边栏：侧边栏要打进客户端 bundle（构建链、样式隔离、
 * 版本耦合都是成本），而这个面板的用途就是"看库 + 随手搜一下"，一个独立页面最省事，
 * 也不会跟别的插件抢插槽。
 *
 * 安全：只读本机、只写本机 JSONL；POST 要求同源或回环来源（照抄 dsh-purge 的判据），
 * 避免被别的页面跨站打进来删库。
 */

import { search, ENGINES } from './search.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPage } from './sites.js';
import { verifyLink } from './verify.js';
import { save, list, remove, stats } from './store.js';
import { watch } from './watch.js';

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}

function sendHtml(res, html) {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(html);
}

async function readBody(req, limit = 512 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sameOrigin(req) {
  const remote = String(req.socket?.remoteAddress || '');
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (loopback) return true;
  const host = String(req.headers.host || '');
  const origin = req.headers.origin;
  if (!host) return false;
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/* ───────────────────────── 页面 ───────────────────────── */

export function panelHtml() {
  const engineOptions = ['auto', ...Object.keys(ENGINES)]
    .map((id) => `<option value="${id}">${id}</option>`)
    .join('');
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>resfinder · 检索台</title>
<style>
  :root { color-scheme: dark; --bg:#0b1220; --card:#131c2d; --line:#22304a; --fg:#dbe6f6; --dim:#7f93b3; --acc:#4ea1ff; --ok:#3ddc97; --warn:#ffb454; --bad:#ff6b6b; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.6 "Segoe UI","Microsoft YaHei",system-ui,sans-serif; }
  header { padding:14px 20px; border-bottom:1px solid var(--line); display:flex; gap:14px; align-items:baseline; flex-wrap:wrap; }
  header h1 { font-size:16px; margin:0; font-weight:600; letter-spacing:.5px; }
  header .stat { color:var(--dim); font-size:12px; }
  main { padding:18px 20px 60px; max-width:1080px; margin:0 auto; }
  .row { display:flex; gap:8px; flex-wrap:wrap; }
  input, select, button, textarea { background:#0e1728; color:var(--fg); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font:inherit; }
  input[type=text] { flex:1 1 320px; }
  button { cursor:pointer; }
  button:hover { border-color:var(--acc); }
  button.primary { background:#14304f; border-color:#2a5c8f; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 14px; margin-top:12px; }
  .card h3 { margin:0 0 6px; font-size:14px; }
  .muted { color:var(--dim); font-size:12px; word-break:break-all; }
  .post { color:var(--acc); text-decoration:none; }
  pre { white-space:pre-wrap; word-break:break-word; background:#0a1120; border:1px solid var(--line); border-radius:8px; padding:10px; max-height:420px; overflow:auto; font:12px/1.55 ui-monospace,Consolas,monospace; }
  .tag { display:inline-block; padding:1px 7px; border:1px solid var(--line); border-radius:99px; font-size:11px; color:var(--dim); margin-right:4px; }
  .v-official { color:var(--ok); } .v-trusted { color:#8fc7ff; } .v-unknown { color:var(--warn); } .v-suspicious { color:var(--bad); }
  .actions { display:flex; gap:6px; margin-top:8px; }
  .actions button { padding:4px 10px; font-size:12px; }
  section { margin-top:26px; }
  section > h2 { font-size:13px; text-transform:uppercase; letter-spacing:1px; color:var(--dim); border-bottom:1px solid var(--line); padding-bottom:6px; }
  .libitem { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; padding:10px 0; border-bottom:1px dashed var(--line); }
  .libitem:last-child { border-bottom:none; }
  .del { background:transparent; border-color:#5a2a2a; color:#ff9a9a; }
</style></head>
<body>
<header>
  <h1>resfinder · 检索台</h1>
  <span class="stat" id="stat">加载中…</span>
</header>
<main>
  <div class="row">
    <input id="q" type="text" placeholder="找什么？例如：nodejs 官网 / 检索增强生成 综述 / 7-zip">
    <select id="engine">${engineOptions}</select>
    <button class="primary" id="go">检索</button>
    <button id="lib-refresh">刷新资源库</button>
    <button id="watch">巡检库内链接</button>
  </div>
  <div id="out"></div>

  <section id="watchsec" style="display:none">
    <h2>巡检结果</h2>
    <div id="watchout"></div>
  </section>

  <section>
    <h2>资源库</h2>
    <div id="lib"><p class="muted">…</p></div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

async function api(op, payload = {}) {
  const res = await fetch('/resfinder/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op, ...payload }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || '请求失败');
  return json.data;
}

function show(html) { $('out').innerHTML = html; }

async function refreshStat() {
  try {
    const s = await api('stats');
    $('stat').textContent = \`库内 \${s.total} 条 · 文件 \${s.file}\`;
  } catch (e) { $('stat').textContent = '统计失败：' + e.message; }
}

async function renderLibrary() {
  try {
    const items = await api('list');
    if (!items.length) { $('lib').innerHTML = '<p class="muted">还没存东西。检索后点「存」即可。</p>'; return; }
    $('lib').innerHTML = items.map((it) => \`
      <div class="libitem">
        <div>
          <div><strong>\${esc(it.title)}</strong> \${it.verified ? '<span class="tag">已核验</span>' : ''}\${it.lastIssue ? '<span class="tag" style="border-color:#5a2a2a;color:#ff9a9a">' + esc(it.lastIssue) + '</span>' : ''}</div>
          <div class="muted"><a class="post" href="\${esc(it.url)}" target="_blank" rel="noreferrer">\${esc(it.url)}</a></div>
          <div class="muted">\${(it.tags || []).map((t) => '<span class="tag">' + esc(t) + '</span>').join('')} \${esc(it.note || '')}</div>
        </div>
        <button class="del" data-id="\${esc(it.id)}">删除</button>
      </div>\`).join('');
    $('lib').querySelectorAll('.del').forEach((b) => b.addEventListener('click', async () => {
      await api('remove', { id: b.dataset.id });
      renderLibrary(); refreshStat();
    }));
  } catch (e) { $('lib').innerHTML = '<p class="muted">读取失败：' + esc(e.message) + '</p>'; }
}

async function doSearch() {
  const q = $('q').value.trim();
  if (!q) return;
  show('<p class="muted">检索中…</p>');
  try {
    const r = await api('search', { query: q, engines: $('engine').value, limit: 8 });
    if (!r.results.length) { show('<p class="muted">没有结果。换个更短的关键词，或换引擎。</p>'); return; }
    show(r.results.map((x, i) => \`
      <div class="card">
        <h3>\${i + 1}. \${esc(x.title)}</h3>
        <div class="muted"><a class="post" href="\${esc(x.url)}" target="_blank" rel="noreferrer">\${esc(x.url)}</a></div>
        <div>\${esc(x.snippet || '')}</div>
        <div class="muted">来源 \${esc(x.site || '')} · 引擎 \${esc(x.engine || '')}</div>
        <div class="actions">
          <button data-act="read" data-url="\${esc(x.url)}">读正文</button>
          <button data-act="verify" data-url="\${esc(x.url)}">核验域名</button>
          <button data-act="save" data-title="\${esc(x.title)}" data-url="\${esc(x.url)}">存进库</button>
        </div>
        <pre id="d-\${i}" style="display:none"></pre>
      </div>\`).join(''));
    show(bindDetails($('out')));
  } catch (e) { show('<p class="muted">失败：' + esc(e.message) + '</p>'); }
}

function bindDetails(root) {
  root.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.card');
      const pre = card.querySelector('pre');
      const act = btn.dataset.act;
      if (act === 'save') {
        await api('save', { url: btn.dataset.url, title: btn.dataset.title, kind: 'link', tags: ['面板'] });
        refreshStat(); renderLibrary();
        btn.textContent = '已存';
        return;
      }
      pre.style.display = 'block';
      pre.textContent = act === 'read' ? '读取中…' : '核验中…';
      try {
        const r = act === 'read'
          ? await api('read', { url: btn.dataset.url, maxChars: 6000 })
          : await api('verify', { url: btn.dataset.url });
        pre.textContent = r.text;
        if (act === 'verify') {
          const cls = 'v-' + (r.verdict || 'unknown');
          pre.innerHTML = '<span class="' + cls + '">【' + esc(r.verdict) + '】</span>\\n' + esc(r.text);
        }
      } catch (e) { pre.textContent = '失败：' + e.message; }
    });
  });
  return root.innerHTML;
}

$('go').addEventListener('click', doSearch);
$('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
$('lib-refresh').addEventListener('click', () => { refreshStat(); renderLibrary(); });

async function doWatch() {
  const sec = $('watchsec');
  sec.style.display = 'block';
  $('watchout').innerHTML = '<p class="muted">巡检中（每条链接 1~5 个请求，库里条数多会慢一点）…</p>';
  try {
    const r = await api('watch', { limit: 50 });
    if (!r.checked) { $('watchout').innerHTML = '<p class="muted">资源库是空的，先存几条再巡检。</p>'; return; }
    const rows = r.rows.map((x) => \`
      <div class="libitem">
        <div>
          <div><strong>\${x.alerting ? '⚠ ' : '· '}\${esc(x.title)}</strong> <span class="tag">\${x.kinds.map((k) => esc(k)).join(' / ')}</span></div>
          <div class="muted"><a class="post" href="\${esc(x.url)}" target="_blank" rel="noreferrer">\${esc(x.url)}</a></div>
          <div class="muted">\${esc(x.from)} → \${esc(x.to)} · <span class="v-\${esc(x.verdict)}">\${esc(x.verdict)}</span></div>
        </div>
      </div>\`).join('');
    $('watchout').innerHTML = \`<p class="muted">巡检 \${r.checked} 条，\${r.alerts} 条需要注意。</p>\` + rows;
    refreshStat(); renderLibrary();
  } catch (e) { $('watchout').innerHTML = '<p class="muted">失败：' + esc(e.message) + '</p>'; }
}
$('watch').addEventListener('click', doWatch);
refreshStat(); renderLibrary();
</script>
</body></html>`;
}

/* ───────────────────────── API ───────────────────────── */

export async function handleApi(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
  if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'cross-origin rejected' });

  let body;
  try {
    const raw = await readBody(req);
    body = raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${err.message}` });
  }

  try {
    switch (body.op) {
      case 'stats':
        return sendJson(res, 200, { ok: true, data: stats() });
      case 'list':
        return sendJson(res, 200, {
          ok: true,
          data: list({ q: body.q || '', tag: body.tag || '', kind: body.kind || '', limit: Math.min(Number(body.limit) || 50, 200) }),
        });
      case 'search': {
        const out = await search(String(body.query || ''), {
          engines: body.engines && body.engines !== 'auto' ? body.engines : 'auto',
          limit: Math.min(Number(body.limit) || 8, 20),
          site: body.site || '',
        });
        return sendJson(res, 200, {
          ok: true,
          data: {
            results: out.results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet, site: r.site, engine: r.engine })),
            engines: out.engines,
          },
        });
      }
      case 'read': {
        const r = await readPage(String(body.url || ''), { maxChars: Math.min(Number(body.maxChars) || 6000, 30000) });
        return sendJson(res, 200, {
          ok: true,
          data: { text: `# ${r.title}\n[适配器 ${r.adapter} · ${r.chars} 字符${r.truncated ? ' · 已截断' : ''}]\n\n${r.content}` },
        });
      }
      case 'verify': {
        const r = await verifyLink(String(body.url || ''));
        const text = [
          `最终：${r.finalUrl}（${r.finalStatus}）`,
          `最终域名：${r.finalHost}${r.tls ? ` · 证书 ${r.tls.issuer}` : ''}`,
          '',
          ...(r.reasons.length ? r.reasons.map((x) => `· ${x}`) : ['· 未触发风险特征']),
          '',
          r.advice,
        ].join('\n');
        return sendJson(res, 200, { ok: true, data: { verdict: r.verdict, text } });
      }
      case 'save':
        return sendJson(res, 200, { ok: true, data: save({ ...body, source: 'panel' }) });
      case 'watch': {
        const r = await watch({ limit: Math.min(Number(body.limit) || 50, 200), concurrency: 3 });
        return sendJson(res, 200, {
          ok: true,
          data: {
            checked: r.checked,
            alerts: r.alerts.length,
            rows: r.changes.map((c) => ({
              title: c.title,
              url: c.url,
              kinds: c.kinds,
              alerting: c.alerting,
              from: c.prev ? `${c.prev.finalHost || '?'} (${c.prev.status})` : '—',
              to: `${c.finalHost || '?'} (${c.status})`,
              verdict: c.verdict,
            })),
          },
        });
      }
      case 'remove':
        return sendJson(res, 200, { ok: true, data: { removed: remove(String(body.id || '')) } });
      default:
        return sendJson(res, 400, { ok: false, error: `未知 op：${body.op}` });
    }
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err?.message || String(err) });
  }
}

/** 挂路由。webServer 不在（headless / 桌面端无 web）时静默跳过。 */
export function registerRoutes(ctx) {
  const server = ctx?.webServer;
  if (!server?.register) return { ok: false, reason: 'webServer 服务不可用' };
  try {
    ctx.effect(() => server.register({
      kind: 'exact',
      path: '/resfinder',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, error: 'GET only' });
        sendHtml(res, panelHtml());
      },
    }));
    ctx.effect(() => server.register({
      kind: 'exact',
      path: '/resfinder/api',
      handler: handleApi,
    }));
    return { ok: true, reason: '已注册 /resfinder 与 /resfinder/api' };
  } catch (err) {
    return { ok: false, reason: `注册失败：${err?.message || String(err)}` };
  }
}

/* ───────────────────────── 独立插件行 ─────────────────────────
 * 为什么单独一条：cordis 里 inject 声明的服务缺失时，这个插件行根本不会起，
 * 但工具那行（只依赖 tools）照常工作。面板挂了不该连累检索能力，
 * 所以拆成两行 —— 跟 dsh-purge 把 tools 与 ui 分开是同一个理由。
 * 注册结果写到 $DSH_HOME/resfinder/panel-status.json：黑窗口看不到报错时靠它定位。 */

export const name = 'dsh-resfinder-ui';
export const inject = ['webServer'];

export function apply(ctx) {
  const result = registerRoutes(ctx);
  try {
    const dir = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    fs.mkdirSync(path.join(dir, 'resfinder'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'resfinder', 'panel-status.json'),
      JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2),
      'utf8',
    );
  } catch { /* 状态文件写不了也不影响路由本身 */ }
  if (!result.ok) process.stderr.write(`[dsh-resfinder] 面板未挂载：${result.reason}\n`);
}

export default { name, inject, apply };
