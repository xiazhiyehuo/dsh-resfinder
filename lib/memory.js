/**
 * 记忆层：给自主型 AI 用的「查过就别再查」+「哪个源靠谱」。
 *
 * 两层分工：
 *   · 缓存（cache.json）：检索/读页的结果按 TTL 暂存，命中就不发请求 —— 省时间、躲风控。
 *     缓存是"可能过时的记忆"，所以每条都有 at/ttl，res_* 返回时会标 cached 和年龄。
 *   · 指标（metrics.json）：每个检索源的调用次数、成功/空手/失败、平均耗时。
 *     让 agent 自己看出"最近 bilibili 老风控，换 github 或 bing"，而不是靠提示词写死。
 *
 * 为什么不用数据库：这两个都是可丢弃数据，坏了删掉重来即可；单文件 JSON + 原子写足够。
 * 库（library.jsonl）才是需要保留的资产，语义上互不污染：只有 verify 过的东西才进库。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function memoryDir() {
  const explicit = process.env.RESFINDER_HOME;
  const home = explicit || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'resfinder');
}

const CACHE_FILE = () => path.join(memoryDir(), 'cache.json');
const METRICS_FILE = () => path.join(memoryDir(), 'metrics.json');
const MAX_CACHE_ENTRIES = 600;

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(memoryDir(), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    /* 记忆层写失败不该影响主流程 */
  }
}

/* ───────────────────────── 缓存 ───────────────────────── */

export function cacheKey(parts) {
  return parts.filter((p) => p !== undefined && p !== null && p !== '').join('|');
}

/** 取缓存。ttlMs 传 0 表示只要没过期（按条目自己的 ttl）就拿。 */
export function cacheGet(key, ttlMs = 0) {
  const db = readJson(CACHE_FILE(), {});
  const hit = db[key];
  if (!hit) return { hit: false };
  const age = Date.now() - Number(hit.at || 0);
  const ttl = ttlMs || Number(hit.ttl || 0);
  if (!ttl || age > ttl) return { hit: false, expired: true, ageMs: age };
  return { hit: true, value: hit.value, ageMs: age, cachedAt: new Date(hit.at).toISOString() };
}

export function cacheSet(key, value, ttlMs) {
  const db = readJson(CACHE_FILE(), {});
  db[key] = { at: Date.now(), ttl: ttlMs, value };
  const keys = Object.keys(db);
  if (keys.length > MAX_CACHE_ENTRIES) {
    /* 超上限就按最旧淘汰，别让记忆层无限膨胀 */
    keys.sort((a, b) => Number(db[a].at) - Number(db[b].at));
    for (const k of keys.slice(0, keys.length - MAX_CACHE_ENTRIES)) delete db[k];
  }
  writeJson(CACHE_FILE(), db);
}

/** 清理过期条目，返回删掉多少条。 */
export function cachePrune() {
  const db = readJson(CACHE_FILE(), {});
  const now = Date.now();
  let removed = 0;
  for (const [k, v] of Object.entries(db)) {
    const ttl = Number(v.ttl || 0);
    if (ttl && now - Number(v.at || 0) > ttl) {
      delete db[k];
      removed += 1;
    }
  }
  if (removed) writeJson(CACHE_FILE(), db);
  return removed;
}

export function cacheStats() {
  const db = readJson(CACHE_FILE(), {});
  const now = Date.now();
  let fresh = 0;
  let stale = 0;
  for (const v of Object.values(db)) {
    const ttl = Number(v.ttl || 0);
    if (!ttl || now - Number(v.at || 0) > ttl) stale += 1;
    else fresh += 1;
  }
  return { entries: Object.keys(db).length, fresh, stale, file: CACHE_FILE() };
}

/* ───────────────────────── 来源质量 ───────────────────────── */

const ENGINES_META_KEY = '__engines';

export function recordEngine(id, { ok, empty, ms, error }) {
  const db = readJson(METRICS_FILE(), {});
  const cur = db[ENGINES_META_KEY]?.[id] || { calls: 0, ok: 0, empty: 0, fail: 0, msSum: 0, lastAt: '' };
  cur.calls += 1;
  if (!ok) cur.fail += 1;
  else if (empty) cur.empty += 1;
  else cur.ok += 1;
  cur.msSum += Number(ms) || 0;
  cur.lastAt = new Date().toISOString();
  if (error) cur.lastError = String(error).slice(0, 160);
  db[ENGINES_META_KEY] = { ...(db[ENGINES_META_KEY] || {}), [id]: cur };
  writeJson(METRICS_FILE(), db);
}

/** 按"近期产出率"排序的源质量表；没跑过的源不出现。 */
export function engineQuality() {
  const db = readJson(METRICS_FILE(), {});
  const all = db[ENGINES_META_KEY] || {};
  return Object.entries(all)
    .map(([id, s]) => ({
      id,
      calls: s.calls,
      yieldRate: s.calls ? Number(((s.ok / s.calls) * 100).toFixed(0)) : 0,
      emptyRate: s.calls ? Number(((s.empty / s.calls) * 100).toFixed(0)) : 0,
      failRate: s.calls ? Number(((s.fail / s.calls) * 100).toFixed(0)) : 0,
      avgMs: s.calls ? Math.round(s.msSum / s.calls) : 0,
      lastAt: s.lastAt,
      lastError: s.lastError || '',
    }))
    .sort((a, b) => b.yieldRate - a.yieldRate || a.avgMs - b.avgMs);
}

export function formatQuality() {
  const rows = engineQuality();
  if (!rows.length) return '还没有调用记录（跑几次检索后这里会有各源的成功率）。';
  return rows
    .map((r) => `- ${r.id}：产出率 ${r.yieldRate}% · 空手 ${r.emptyRate}% · 失败 ${r.failRate}% · 均耗时 ${r.avgMs}ms（${r.calls} 次调用${r.lastError ? `，最近错误：${r.lastError}` : ''}）`)
    .join('\n');
}
