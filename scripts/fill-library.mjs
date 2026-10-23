/**
 * 一次性填库脚本：对每条候选资源做「核验 → 入库」，并打印结果表。
 * 用法：DSH_HOME=D:/DeepSeekHarness/home node scripts/fill-library.mjs
 *
 * 只在第一次建库时手动跑；之后用 res_save / 面板「存进库」逐条加。
 */

import { verifyLink } from '../lib/verify.js';
import { save, list, stats } from '../lib/store.js';
import { mapLimit } from '../lib/http.js';

const SEEDS = [
  { title: 'fscan — 内网综合扫描', url: 'https://github.com/shadow1ng/fscan', kind: 'software', tags: ['红队', '扫描器', '内网'], note: '内网存活/端口/弱口令/未授权一把梭；从 Releases 下二进制并核对哈希' },
  { title: 'nuclei — 模板化漏洞扫描', url: 'https://github.com/projectdiscovery/nuclei', kind: 'software', tags: ['红队', '扫描器', 'Nday'], note: 'CVE/默认口令/暴露面模板；-t 指定模板，配合隧道可打内网' },
  { title: 'gogo — 内网资产测绘', url: 'https://github.com/chainreactors/gogo', kind: 'software', tags: ['红队', '扫描器', '指纹'], note: '高并发指纹识别 + 关键信息提取，适合先铺面' },
  { title: 'suo5 — 通过 WebShell 建 SOCKS5', url: 'https://github.com/zema1/suo5', kind: 'software', tags: ['红队', '隧道', '内网'], note: 'HTTP 通道隧道，内网突破主力；注意目标侧那一端才算突破' },
  { title: 'Python 官方下载', url: 'https://www.python.org/downloads/', kind: 'software', tags: ['运行时', '官方'], note: '官网给出签名与校验说明；装完核对 SHA256' },
  { title: '7-Zip 官网', url: 'https://www.7-zip.org/', kind: 'software', tags: ['工具', '官方'], note: '认准 7-zip.org，其余多为仿站' },
  { title: 'arXiv 检索入口', url: 'https://arxiv.org/search/', kind: 'paper', tags: ['论文', '学术'], note: '预印本；批量检索走 OpenAlex（export.arxiv.org 在本机网络不通）' },
  { title: '中国国家图书馆', url: 'https://www.nlc.cn/', kind: 'book', tags: ['图书', '正版'], note: '读者卡可在线读部分电子书与古籍；不碰盗版书站' },
];

const rows = [];
await mapLimit(SEEDS, 3, async (seed) => {
  try {
    const v = await verifyLink(seed.url);
    const rec = save({
      ...seed,
      verified: v.verdict === 'official' || v.verdict === 'trusted',
      source: 'seed',
      note: `${seed.note}｜核验：${v.verdict} → ${v.finalHost}`,
      meta: { verdict: v.verdict, finalHost: v.finalHost },
    });
    rows.push({ ok: true, title: seed.title, verdict: v.verdict, host: v.finalHost, status: v.finalStatus, id: rec.id });
  } catch (err) {
    rows.push({ ok: false, title: seed.title, error: err.message });
  }
});

rows.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh'));
for (const r of rows) {
  if (r.ok) console.log(`${r.verdict.padEnd(9)} ${String(r.status).padEnd(4)} ${r.host.padEnd(24)} ${r.title}`);
  else console.log(`FAIL      ${r.title} — ${r.error}`);
}
const s = stats();
console.log(`\n库内共 ${s.total} 条 · 类型 ${JSON.stringify(s.byKind)}`);
console.log(`最近入库：${list({ limit: 3 }).map((x) => x.title).join(' / ')}`);
