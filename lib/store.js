/**
 * 资源库：把"找到并核实过"的东西沉淀下来，下次不用重找。
 *
 * 存储：$DSH_HOME/resfinder/library.jsonl（一行一条 JSON，追加写，坏了也只坏一行）。
 * 去重：按规范化 URL 的 sha1 前 12 位做 id，重复 save 同一 URL 会更新而不是再存一条。
 * 这是本机数据，不要提交到任何仓库。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

export function dataDir() {
  /* 优先级：RESFINDER_HOME（显式指定）> DSH_HOME（插件内运行时）> ~/.dsh（独立 CLI 兜底） */
  const explicit = process.env.RESFINDER_HOME;
  const home = explicit || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'resfinder');
}

export function libraryFile() {
  return path.join(dataDir(), 'library.jsonl');
}

function ensureDir() {
  fs.mkdirSync(dataDir(), { recursive: true });
}

export function normalizeUrl(url) {
  try {
    const u = new URL(String(url).trim());
    u.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'spm_id_from', 'vd_source', 'from'].forEach((k) =>
      u.searchParams.delete(k),
    );
    let s = u.toString();
    s = s.replace(/\/$/, '');
    return s.toLowerCase();
  } catch {
    return String(url || '').trim().toLowerCase();
  }
}

export function idOf(url) {
  return createHash('sha1').update(normalizeUrl(url)).digest('hex').slice(0, 12);
}

function readAll() {
  const file = libraryFile();
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 单行损坏就跳过，不让整个库读不出来 */
    }
  }
  return out;
}

function writeAll(items) {
  ensureDir();
  const file = libraryFile();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, items.map((it) => JSON.stringify(it)).join('\n') + (items.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 存一条资源。
 * @param {object} item { title, url, kind?, tags?:string[], note?, source?, verified?:boolean, meta? }
 */
export function save(item) {
  const url = String(item?.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('url 必须是完整 http(s) 地址');
  const title = String(item.title || '').trim() || url;
  const now = new Date().toISOString();
  const items = readAll();
  const id = idOf(url);
  const index = items.findIndex((it) => it.id === id);
  const tags = Array.from(new Set((item.tags || []).map((t) => String(t).trim()).filter(Boolean)));
  const record = {
    id,
    title,
    url,
    kind: item.kind || 'link',
    tags,
    note: String(item.note || ''),
    source: item.source || 'manual',
    verified: Boolean(item.verified),
    meta: item.meta || {},
    createdAt: index >= 0 ? items[index].createdAt : now,
    updatedAt: now,
    hits: index >= 0 ? (items[index].hits || 0) + 1 : 1,
  };
  if (index >= 0) items[index] = record;
  else items.push(record);
  writeAll(items);
  return record;
}

export function list({ q = '', tag = '', kind = '', limit = 30 } = {}) {
  let items = readAll();
  if (q) {
    const needle = String(q).toLowerCase();
    items = items.filter((it) =>
      `${it.title} ${it.url} ${it.note} ${(it.tags || []).join(' ')}`.toLowerCase().includes(needle),
    );
  }
  if (tag) items = items.filter((it) => (it.tags || []).includes(tag));
  if (kind) items = items.filter((it) => it.kind === kind);
  return items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit);
}

/** 按 URL 找库内条目（规范化后比对，容忍 utm 参数/尾斜杠差异）。 */
export function findByUrl(url) {
  const id = idOf(url);
  return readAll().find((it) => it.id === id) || null;
}

/**
 * 局部更新一条记录（巡检用）：只改给定字段，不动 hits / createdAt。
 * 记录不存在时抛错，让调用方知道"这条已经被删了"。
 */
export function patch(id, fields) {
  const items = readAll();
  const index = items.findIndex((it) => it.id === id);
  if (index < 0) throw new Error(`没有 id=${id} 的记录`);
  const next = { ...items[index], ...fields, id, updatedAt: new Date().toISOString() };
  items[index] = next;
  writeAll(items);
  return next;
}

export function remove(id) {  const items = readAll();
  const next = items.filter((it) => it.id !== id);
  if (next.length === items.length) return false;
  writeAll(next);
  return true;
}

export function stats() {
  const items = readAll();
  const byKind = {};
  const tags = new Map();
  for (const it of items) {
    byKind[it.kind] = (byKind[it.kind] || 0) + 1;
    for (const t of it.tags || []) tags.set(t, (tags.get(t) || 0) + 1);
  }
  return {
    file: libraryFile(),
    total: items.length,
    byKind,
    tags: [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([tag, n]) => ({ tag, n })),
  };
}
