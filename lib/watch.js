/**
 * 巡检：把资源库里"存了就忘"的链接变成会自己报警的资产。
 *
 * 每次巡检对每条链接跑一次 verifyLink（跳转链 + 最终域名 + TLS），和历史比对，
 * 只报告"变化"和"问题"，不重复念一遍所有正常项：
 *   first-check     首次巡检，建立基线
 *   down            最终状态码 ≥400 或连接失败（页面挂了 / 删了）
 *   domain-changed  最终落地域名变了（换站 / 被劫持 / 短链改指向）
 *   downgraded      可信档位下降（official → unknown/suspicious 等）
 *   upgraded        档位回升（修好了 / 换成官方了）
 *   tls-warning     https 站点证书校验不通过
 *   ok              无变化且无问题
 *
 * 历史写在 $DSH_HOME/resfinder/watch-history.jsonl，一条一次检查。
 * 单库全量巡检 = 每条 1~5 个请求，库大了请用 limit 分批，别一次扫几百条。
 */

import fs from 'node:fs';
import path from 'node:path';
import { dataDir, list, patch } from './store.js';
import { verifyLink } from './verify.js';

export function historyFile() {
  return path.join(dataDir(), 'watch-history.jsonl');
}

const VERDICT_RANK = { official: 3, trusted: 2, unknown: 1, suspicious: 0 };

function readHistory() {
  const file = historyFile();
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
  }
  return out;
}

function appendHistory(entry) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.appendFileSync(historyFile(), `${JSON.stringify(entry)}\n`, 'utf8');
}

function lastOf(history, id) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].id === id) return history[i];
  }
  return null;
}

/** 判定本次检查相对上次的变化。首次检查也要报问题（死链不该被"首次"盖住）。 */
export function diffCheck(prev, now) {
  const failed = now.status === 0 || now.status >= 400;
  if (!prev) {
    const first = [];
    if (failed) first.push('down');
    if (now.tlsOk === false) first.push('tls-warning');
    return first.length ? first : ['first-check'];
  }
  const changes = [];
  if (prev.status !== now.status) {
    if (failed) changes.push('down');
    else if (prev.status >= 400 || prev.status === 0) changes.push('up');
  }
  if (prev.finalHost && now.finalHost && prev.finalHost !== now.finalHost) changes.push('domain-changed');
  const before = VERDICT_RANK[prev.verdict] ?? 1;
  const after = VERDICT_RANK[now.verdict] ?? 1;
  if (after < before) changes.push('downgraded');
  if (after > before) changes.push('upgraded');
  if (now.tlsOk === false && prev.tlsOk !== false) changes.push('tls-warning');
  return changes.length ? changes : ['ok'];
}

/** 哪些变化需要人看一眼。 */
export const ALERTING = new Set(['down', 'domain-changed', 'downgraded', 'tls-warning']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 核验一次，连接层失败就退一步重试一次。
 * 为什么要重试：并发巡检时偶发 reset/超时会把正常站点判成 down —— 误报比漏报更伤信任，
 * 用户看到"官网挂了"结果官网好好的，之后就再也不信这个告警了。
 * 注意只对"连不上"重试；HTTP 4xx/5xx 是明确答案，直接采信。
 */
async function verifyWithRetry(url) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const v = await verifyLink(url);
      if (v.finalStatus !== 0) return v;
      lastError = new Error('连接失败（状态 0）');
    } catch (err) {
      lastError = err;
    }
    if (attempt === 0) await sleep(700);
  }
  return { error: lastError?.message || '检查失败' };
}

/**
 * 跑一次巡检。
 * @param {object} opts
 * @param {number} [opts.limit]      最多检查多少条（按最近更新排序）
 * @param {number} [opts.concurrency] 并发，默认 3
 * @param {string[]} [opts.urls]     只查这些 URL（不写库，用于试跑/自检）
 * @returns {Promise<{checked:number, alerts:Array, changes:Array, skipped:number}>}
 */
export async function watch({ limit = 50, concurrency = 3, urls = null } = {}) {
  const items = Array.isArray(urls)
    ? urls.map((u, i) => ({ id: `adhoc-${i}`, title: u, url: u }))
    : list({ limit: Math.max(1, Math.min(Number(limit) || 50, 300)) });

  const history = readHistory();
  const changes = [];
  let skipped = 0;

  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length || 1) }, async () => {
    while (items.length) {
      const item = items.shift();
      if (!item) break;
      let now;
      const v = await verifyWithRetry(item.url);
      if (v.error) {
        now = { verdict: 'suspicious', finalHost: '', finalUrl: item.url, status: 0, tlsOk: null, error: v.error, reasons: ['检查失败（已重试一次）'] };
      } else {
        now = {
          verdict: v.verdict,
          finalHost: v.finalHost,
          finalUrl: v.finalUrl,
          status: v.finalStatus,
          tlsOk: v.tls ? Boolean(v.tls.authorized) : null,
          reasons: v.reasons.slice(0, 4),
        };
      }
      const prev = Array.isArray(urls) ? null : lastOf(history, item.id);
      const kinds = diffCheck(prev, now);
      const entry = { id: item.id, url: item.url, at: new Date().toISOString(), ...now };

      if (!Array.isArray(urls)) {
        appendHistory(entry);
        history.push(entry);
        try {
          patch(item.id, {
            lastCheckedAt: entry.at,
            lastVerdict: now.verdict,
            lastFinalHost: now.finalHost,
            lastStatus: now.status,
            lastIssue: kinds.some((k) => ALERTING.has(k)) ? kinds.join(', ') : '',
          });
        } catch {
          skipped += 1; /* 老记录已删也不影响巡检本身 */
        }
      }

      changes.push({
        id: item.id,
        title: item.title,
        url: item.url,
        kinds,
        verdict: now.verdict,
        finalHost: now.finalHost,
        status: now.status,
        reasons: now.reasons,
        prev: prev ? { verdict: prev.verdict, finalHost: prev.finalHost, status: prev.status } : null,
        alerting: kinds.some((k) => ALERTING.has(k)),
      });
    }
  });

  await Promise.all(workers);
  const alerts = changes.filter((c) => c.alerting);
  return { checked: changes.length, alerts, changes, skipped };
}

/** 把巡检结果渲染成给人看的文本。 */
export function formatWatch(result) {
  if (!result.checked) return '资源库是空的，没东西可巡检。先 res_save 存几条。';
  const lines = [`巡检 ${result.checked} 条链接：${result.alerts.length} 条需要你看一眼`, ''];
  const label = {
    'first-check': '首次（建立基线）',
    down: '页面挂了 / 连不上',
    up: '恢复了',
    'domain-changed': '落地域名变了',
    downgraded: '可信档位下降',
    upgraded: '档位回升',
    'tls-warning': '证书校验未通过',
    ok: '正常',
  };
  for (const c of result.changes) {
    const mark = c.alerting ? '⚠' : '·';
    lines.push(`${mark} [${c.kinds.map((k) => label[k] || k).join(' / ')}] ${c.title}`);
    lines.push(`   ${c.url}`);
    if (c.prev && (c.prev.finalHost !== c.finalHost || c.prev.status !== c.status)) {
      lines.push(`   之前：${c.prev.finalHost || '?'} (${c.prev.status}) → 现在：${c.finalHost || '?'} (${c.status})`);
    }
    if (c.reasons?.length) lines.push(`   判据：${c.reasons.join('；')}`);
  }
  if (result.alerts.length) {
    lines.push('', '处理建议：domain-changed / downgraded 先去官网核对是不是换了发布页；down 的标成"已失效"或删掉；tls-warning 别在上面下载东西。');
  }
  return lines.join('\n');
}
