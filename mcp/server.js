#!/usr/bin/env node
/**
 * MCP stdio 服务端 —— 把同一套 res_* 能力暴露给任何支持 MCP 的自主型 AI
 * （Claude Desktop / Cursor / Codex / 自研 agent 都能接）。
 *
 * 为什么手写而不用 @modelcontextprotocol/sdk：
 *  · 这个插件要能独立分发到别的机器上跑，不想带一堆依赖；
 *  · 只用到的部分就是 JSON-RPC 2.0 + 换行分隔，手写不到 150 行，行为完全可预期。
 *
 * 协议要点：stdin 每行一个 JSON-RPC 消息；stdout 每行一个响应；日志只能走 stderr，
 * 否则会把协议流写脏（这是 MCP 服务端最常见的翻车点）。
 */

import readline from 'node:readline';
import { buildTools } from '../lib/tools.js';

const SERVER_INFO = { name: 'dsh-resfinder', version: '0.1.0' };
const PROTOCOL_VERSION = '2024-11-05';

export function toolDescriptors() {
  return buildTools().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
  }));
}

async function callTool(name, args) {
  const tool = buildTools().find((t) => t.name === name);
  if (!tool) {
    return { content: [{ type: 'text', text: `ERROR: 未知工具 ${name}` }], isError: true };
  }
  try {
    const res = await tool.execute(args || {});
    return { content: [{ type: 'text', text: String(res?.text ?? '') }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `ERROR: ${err?.message || String(err)}` }], isError: true };
  }
}

async function handle(message) {
  const { id, method, params } = message || {};
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    case 'notifications/initialized':
    case 'initialized':
      return null;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: toolDescriptors() });
    case 'tools/call': {
      const name = params?.name;
      const result = await callTool(name, params?.arguments || {});
      return reply(result);
    }
    case 'resources/list':
      return reply({ resources: [] });
    case 'prompts/list':
      return reply({ prompts: [] });
    default:
      if (id === undefined) return null;
      return fail(-32601, `未实现的方法：${method}`);
  }
}

export async function startServer() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } });
      return;
    }
    const batch = Array.isArray(message) ? message : [message];
    for (const item of batch) {
      try {
        const response = await handle(item);
        if (response) write(response);
      } catch (err) {
        process.stderr.write(`[resfinder-mcp] ${err?.stack || err}\n`);
        if (item?.id !== undefined) {
          write({ jsonrpc: '2.0', id: item.id, error: { code: -32603, message: String(err?.message || err) } });
        }
      }
    }
  });

  rl.on('close', () => process.exit(0));
  process.stderr.write('[resfinder-mcp] 已启动（stdio），工具：' + toolDescriptors().map((t) => t.name).join(', ') + '\n');
}

/* 直接执行时启动；被 CLI 或其它模块 import 时只导出 */
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('server.js')) {
  startServer();
}
