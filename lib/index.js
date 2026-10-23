/**
 * dsh-resfinder — 自主型 AI 检索插件（DeepSeek Harness 插件层）
 *
 * 只做一件事：让模型"想查什么就能查到、查到了能判断来源可信不可信"。
 * 不接第三方依赖，全部走 Node 内建能力（fetch / tls / crypto / fs）。
 *
 * 注册的工具有：res_search / res_read / res_dig / res_channels / res_verify / res_save / res_library / res_sources
 * 同名能力在 bin/resfinder.js（CLI）与 mcp/server.js（MCP stdio）里也有一份，
 * 三处共用 lib/，所以 CLI、MCP、DSH 里行为一致。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTools } from './tools.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');

export const name = 'dsh-resfinder';

/* 只依赖 tools 服务：本插件不发布任何服务，也不改提示词。 */
export const inject = ['tools'];

/* 文本给人看，data 给 agent 直接消费（无需解析排版）。
   data 是可选的：没提供的工具（如 res_channels）只回 text。 */
const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string' },
      data: { type: 'object', additionalProperties: true },
    },
  },
  /* render 决定模型真正看到什么。data 字段如果只放进工具结果而不渲染，
     模型那边是看不见的 —— 所以这里把 data 以 JSON 块附在文本后面（超长截断，避免双倍 token）。 */
  render: (_args, value) => {
    const text = String(value?.text ?? '');
    const data = value?.data;
    if (!data) return [{ type: 'text', text }];
    let json = '';
    try {
      json = JSON.stringify(data);
    } catch {
      return [{ type: 'text', text }];
    }
    const MAX = 2500;
    const shown = json.length > MAX ? `${json.slice(0, MAX)}…（共 ${json.length} 字符，已截断；要更多就缩小 limit/参数）` : json;
    return [{ type: 'text', text: `${text}\n\n---\n结构化数据：\n\`\`\`json\n${shown}\n\`\`\`` }];
  },
};

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 把随包的技能说明落到 $DSH_HOME/skills/resfinder/SKILL.md（已存在就不覆盖，用户改过的优先）。 */
function installSkill() {
  try {
    const src = path.join(pkgRoot, 'skills', 'resfinder', 'SKILL.md');
    if (!fs.existsSync(src)) return;
    const dir = path.join(dshHome(), 'skills', 'resfinder');
    const dst = path.join(dir, 'SKILL.md');
    if (fs.existsSync(dst)) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(src, dst);
  } catch {
    /* 技能安装失败不影响工具可用性 */
  }
}

export function apply(ctx, config = {}) {
  const searxUrl = config?.searxUrl || process.env.SEARXNG_URL || '';
  if (searxUrl) process.env.SEARXNG_URL = searxUrl;

  if (!ctx?.tools?.register) return;

  /* 与超市搜索插件共存时的分工开关：
     enableSearch=false → 不注册 res_search / res_dig，搜索交给 dsh-free-search / modsearch；
     本插件只保留 res_read（含中文站点适配）/ res_verify / res_channels / res_watch / 资源库。 */
  const skipSearch = config?.enableSearch === false;
  const SEARCH_TOOLS = new Set(['res_search', 'res_dig']);

  for (const tool of buildTools()) {
    if (skipSearch && SEARCH_TOOLS.has(tool.name)) continue;
    ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: textOutput,
      async execute(args) {
        /* 工具自身已经把所有异常翻译成 ERROR 文本，这里只兜底防"抛出去整轮挂掉" */
        try {
          return await tool.execute(args || {});
        } catch (err) {
          return { text: `ERROR: ${tool.name} 执行异常：${err?.message || String(err)}` };
        }
      },
    });
  }

  installSkill();
  /* 面板在独立插件行（dsh-resfinder/ui，见 lib/ui.js）：webServer 缺失时只丢面板，不影响工具。 */
}

export default { name, inject, apply };
