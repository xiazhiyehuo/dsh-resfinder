#!/usr/bin/env node
/**
 * resfinder CLI —— 给"没有 DSH 的自主型 AI"用。
 *
 * 用法（全部支持 --json，方便被别的 agent 直接解析）：
 *   resfinder sources
 *   resfinder search "nodejs 官网" --limit 5 [--engines bing,github] [--site github.com]
 *   resfinder read https://nodejs.org/zh-cn --chars 4000 [--offset 0] [--text] [--links]
 *   resfinder dig "检索增强生成 综述" --top 3
 *   resfinder channels nodejs
 *   resfinder verify https://example.com/download [--file D:/a.exe] [--sha256 abc…]
 *   resfinder save --url https://… --title "…" --kind doc --tags 教材,待读 --note "…"
 *   resfinder list --q 教材 [--tag 待读] [--kind doc] [--stats]
 *   resfinder mcp            # 以 MCP stdio 方式启动（等价于 resfinder-mcp）
 */

import { buildTools } from '../lib/tools.js';
import { ENGINES, DEFAULT_ENGINES } from '../lib/search.js';
import { registryStats } from '../lib/channels.js';
import * as store from '../lib/store.js';

const TOOLS = Object.fromEntries(buildTools().map((t) => [t.name.replace(/^res_/, ''), t]));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i += 1;
      }
    } else if (a.startsWith('-') && a.length === 2) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) out[a.slice(1)] = true;
      else {
        out[a.slice(1)] = next;
        i += 1;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function help() {
  return `resfinder —— 自主型 AI 检索工具（零依赖）

命令：
  sources                                    列出可用的检索源 / 站点适配器 / 渠道表规模
  search <词> [--engine bing] [--limit 8] [--site host] [--lang zh-CN]
  read <url> [--chars 20000] [--offset 0] [--text] [--links]
  dig <词> [--top 3] [--chars 4000]
  channels <资源名>
  verify <url> [--file <本地文件>] [--sha256 <期望值>]
  save --url <url> [--title x] [--kind link] [--tags a,b] [--note x] [--verified]
  list [--q x] [--tag x] [--kind x] [--limit 20] [--stats]
  watch [--limit 50] [--concurrency 3] [--json]   巡检库内链接（挂了/换域名/降档/证书异常）
  mcp                                        以 MCP stdio 启动（给支持 MCP 的 agent）

所有命令都可加 --json 输出结构化结果。
资源库位置：$DSH_HOME/resfinder/library.jsonl（默认 ~/.dsh/resfinder/library.jsonl）
`;
}

async function callTool(name, args) {
  const tool = TOOLS[name];
  if (!tool) throw new Error(`未知命令：${name}\n\n${help()}`);
  const res = await tool.execute(args);
  return res?.text ?? '';
}

async function main() {
  const argv = process.argv.slice(2);
  const [cmdRaw, ...rest] = argv;
  const cmd = String(cmdRaw || 'help').toLowerCase();
  const args = parseArgs(rest);
  const json = Boolean(args.json);
  const positional = args._;

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return help();
  if (cmd === 'mcp') {
    const { startServer } = await import('../mcp/server.js');
    await startServer();
    return '';
  }

  if (cmd === 'sources') {
    if (json) {
      return JSON.stringify({
        engines: Object.entries(ENGINES).map(([id, e]) => ({ id, label: e.label, kind: e.kind })),
        defaults: DEFAULT_ENGINES,
        channels: registryStats(),
      }, null, 2);
    }
    return callTool('sources', {});
  }

  if (cmd === 'search') {
    const q = positional.join(' ').trim();
    if (!q) throw new Error('用法：resfinder search "检索词" [--limit 8]');
    const text = await callTool('search', {
      query: q,
      engines: typeof args.engine === 'string' ? args.engine : typeof args.engines === 'string' ? args.engines : 'auto',
      limit: Number(args.limit) || 8,
      site: typeof args.site === 'string' ? args.site : '',
      lang: typeof args.lang === 'string' ? args.lang : 'zh-CN',
    });
    return text;
  }

  if (cmd === 'read') {
    const url = positional[0];
    if (!url) throw new Error('用法：resfinder read <url> [--chars 20000]');
    return callTool('read', {
      url,
      mode: args.text ? 'text' : 'markdown',
      maxChars: Number(args.chars) || 20000,
      offset: Number(args.offset) || 0,
      withLinks: Boolean(args.links),
    });
  }

  if (cmd === 'dig') {
    const q = positional.join(' ').trim();
    if (!q) throw new Error('用法：resfinder dig "检索词" [--top 3]');
    return callTool('dig', { query: q, topN: Number(args.top) || 3, charsEach: Number(args.chars) || 4000 });
  }

  if (cmd === 'channels') {
    const n = positional.join(' ').trim();
    if (!n) throw new Error('用法：resfinder channels <资源名>');
    return callTool('channels', { name: n });
  }

  if (cmd === 'verify') {
    const url = positional[0];
    if (!url) throw new Error('用法：resfinder verify <url> [--file 本地文件 --sha256 期望值]');
    const text = await callTool('verify', {
      url,
      file: typeof args.file === 'string' ? args.file : '',
      expectSha256: typeof args.sha256 === 'string' ? args.sha256 : '',
    });
    return text;
  }

  if (cmd === 'save') {
    const url = typeof args.url === 'string' ? args.url : positional[0];
    if (!url) throw new Error('用法：resfinder save --url <url> [--title x] [--tags a,b]');
    return callTool('save', {
      url,
      title: typeof args.title === 'string' ? args.title : undefined,
      kind: typeof args.kind === 'string' ? args.kind : 'link',
      tags: typeof args.tags === 'string' ? args.tags.split(',').map((s) => s.trim()).filter(Boolean) : [],
      note: typeof args.note === 'string' ? args.note : '',
      verified: Boolean(args.verified),
    });
  }

  if (cmd === 'list') {
    if (json) {
      return JSON.stringify(args.stats ? store.stats() : store.list({
        q: typeof args.q === 'string' ? args.q : '',
        tag: typeof args.tag === 'string' ? args.tag : '',
        kind: typeof args.kind === 'string' ? args.kind : '',
        limit: Number(args.limit) || 20,
      }), null, 2);
    }
    return callTool('library', {
      q: typeof args.q === 'string' ? args.q : '',
      tag: typeof args.tag === 'string' ? args.tag : '',
      kind: typeof args.kind === 'string' ? args.kind : '',
      limit: Number(args.limit) || 20,
      statsOnly: Boolean(args.stats),
    });
  }

  if (cmd === 'watch') {
    if (json) {
      const { watch } = await import('../lib/watch.js');
      const r = await watch({ limit: Number(args.limit) || 50, concurrency: Number(args.concurrency) || 3 });
      return JSON.stringify(r, null, 2);
    }
    return callTool('watch', { limit: Number(args.limit) || 50, concurrency: Number(args.concurrency) || 3 });
  }

  return `未知命令：${cmd}\n\n${help()}`;
}

main()
  .then((text) => {
    if (text) process.stdout.write(`${text}\n`);
  })
  .catch((err) => {
    process.stderr.write(`ERROR: ${err?.message || String(err)}\n`);
    process.exitCode = 1;
  });
