/**
 * 链接核验：判断"这个下载/阅读地址到底落在谁手里"。
 *
 * 自主型 AI 最容易踩的坑：搜到一条排在前面的链接，名字对、页面像，落地域名却是仿站。
 * 所以核验只看三件客观事实 —— 跳转链、最终域名、TLS 证书；再叠加域名名单给结论。
 * 结论分四档：official（官方）/ trusted（可信平台）/ unknown（未登记）/ suspicious（可疑）。
 * 永远不说"绝对安全"：只给证据和它支持到哪一档。
 */

import tls from 'node:tls';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { REGISTRY } from './channels.js';

const SHORTENERS = new Set([
  'bit.ly', 't.cn', 'dwz.cn', 'url.cn', 'goo.gl', 'tinyurl.com', 'is.gd', 'suo.im', 'cutt.ly', 'shorturl.at', 'b23.tv',
]);

const RISKY_TLDS = new Set(['tk', 'ml', 'ga', 'cf', 'gq', 'top', 'xyz', 'buzz', 'cyou', 'icu']);

const TRUSTED_PLATFORMS = [
  'github.com', 'gitlab.com', 'gitee.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com',
  'pypi.org', 'npmjs.com', 'crates.io', 'packagist.org', 'maven.apache.org', 'repo1.maven.org',
  'hub.docker.com', 'quay.io', 'ghcr.io',
  'arxiv.org', 'doi.org', 'openalex.org', 'crossref.org', 'semanticscholar.org', 'pubmed.ncbi.nlm.nih.gov',
  'wikipedia.org', 'wikimedia.org', 'archive.org',
  'bilibili.com', 'zhihu.com', 'juejin.cn', 'segmentfault.com', 'csdn.net', 'oschina.net', '51cto.com',
  'stackoverflow.com', 'developer.mozilla.org', 'learn.microsoft.com', 'docs.python.org', 'nodejs.org',
  'npmjs.com', 'npmmirror.com', 'mirrors.tuna.tsinghua.edu.cn', 'mirrors.aliyun.com', 'mirrors.ustc.edu.cn',
  'openstd.samr.gov.cn', 'nlc.cn', 'gutenberg.org', 'openlibrary.org', 'unsplash.com', 'pexels.com', 'fonts.google.com',
];

/** 从渠道登记表里抽出官方域名，作为 official 档的依据。 */
const OFFICIAL_DOMAINS = new Set();
for (const entry of REGISTRY) {
  for (const ch of entry.channels || []) {
    try {
      OFFICIAL_DOMAINS.add(new URL(ch.url).hostname.replace(/^www\./, '').toLowerCase());
    } catch {
      /* 忽略坏 URL */
    }
  }
}
for (const d of ['nodejs.org', 'python.org', 'git-scm.com', 'code.visualstudio.com', 'ffmpeg.org', '7-zip.org', 'obsproject.com', 'videolan.org']) {
  OFFICIAL_DOMAINS.add(d);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function suffixOf(host) {
  const parts = String(host).split('.');
  return parts.length >= 2 ? parts.slice(-2).join('.') : host;
}

function matchesDomain(host, list) {
  for (const d of list) {
    if (host === d || host.endsWith(`.${d}`)) return d;
  }
  return '';
}

/** 跟随跳转链，只读响应头（GET + 立刻 cancel body，避免把大文件拉下来）。 */
async function followChain(input, maxHops = 6, timeoutMs = 15000) {
  const chain = [];
  let current = String(input);
  for (let hop = 0; hop <= maxHops; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          accept: '*/*',
        },
      });
    } catch (err) {
      chain.push({ url: current, status: 0, error: err?.name === 'AbortError' ? '超时' : err?.message || String(err) });
      return chain;
    } finally {
      clearTimeout(timer);
    }
    const location = res.headers.get('location');
    const item = {
      url: current,
      status: res.status,
      host: hostOf(current),
      contentType: res.headers.get('content-type') || '',
      location: location ? new URL(location, current).toString() : '',
    };
    if (res.body) {
      try { await res.body.cancel(); } catch { /* 不读 body */ }
    }
    chain.push(item);
    if (!location || ![301, 302, 303, 307, 308].includes(res.status)) break;
    current = item.location;
  }
  return chain;
}

function tlsInfo(url) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return resolve(null);
    }
    if (parsed.protocol !== 'https:') return resolve(null);
    const port = Number(parsed.port) || 443;
    const socket = tls.connect(
      { host: parsed.hostname, port, servername: parsed.hostname, timeout: 8000, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate();
        const authorized = socket.authorized;
        resolve({
          authorized,
          authorizationError: socket.authorizationError ? String(socket.authorizationError) : '',
          issuer: cert?.issuer?.O || cert?.issuer?.CN || '',
          subject: cert?.subject?.CN || '',
          validFrom: cert?.valid_from || '',
          validTo: cert?.valid_to || '',
          altNames: (cert?.subjectaltname || '').split(',').slice(0, 8),
        });
        socket.end();
      },
    );
    socket.on('error', () => resolve(null));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(null);
    });
  });
}

function scoreHost(host) {
  const reasons = [];
  let verdict = 'unknown';

  if (!host) {
    reasons.push('无法解析主机名');
    return { verdict: 'suspicious', reasons };
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    reasons.push('直接用 IP 访问：没有域名背书，且常见于临时/钓鱼站');
    return { verdict: 'suspicious', reasons };
  }

  const official = matchesDomain(host, OFFICIAL_DOMAINS);
  if (official) {
    return { verdict: 'official', reasons: [`域名 ${host} 在官方渠道登记表里（${official}）`] };
  }
  const platform = matchesDomain(host, TRUSTED_PLATFORMS);
  if (platform) {
    verdict = 'trusted';
    reasons.push(`域名 ${host} 属于可信平台（${platform}）：内容是第三方产出，需看仓库/作者可信度`);
  }

  if (host.startsWith('xn--') || host.includes('.xn--')) {
    verdict = 'suspicious';
    reasons.push('域名含 punycode（xn--）：存在同形字仿冒风险');
  }
  if (SHORTENERS.has(host) || SHORTENERS.has(suffixOf(host))) {
    verdict = 'suspicious';
    reasons.push('短链跳转：真实落地地址在跳转链末尾，需看最终域名');
  }
  const tld = String(host).split('.').pop();
  if (RISKY_TLDS.has(tld) && verdict !== 'official') {
    verdict = verdict === 'suspicious' ? verdict : 'suspicious';
    reasons.push(`顶级域 .${tld} 上仿冒/垃圾站比例偏高`);
  }
  if (/[0-9]{4,}/.test(host) && verdict === 'unknown') {
    reasons.push('域名里带长串数字，常见于批量生成的下载站');
  }
  if (host.split('.').length > 4) reasons.push('子域层级很深，留意是否挂在他人免费空间下');

  return { verdict, reasons };
}

/**
 * 核验一个地址。
 * @returns {Promise<object>} { url, verdict, host, https, chain, finalHost, contentType, tls, reasons, advice }
 */
export async function verifyLink(input, { maxHops = 6 } = {}) {
  const url = String(input || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error(`需要完整 http(s) 地址：${url}`);

  const chain = await followChain(url, maxHops);
  const last = chain[chain.length - 1] || { url, status: 0 };
  const finalHost = hostOf(last.url || url);
  const https = (last.url || url).startsWith('https://');
  const initialScore = scoreHost(hostOf(url));
  const finalScore = scoreHost(finalHost);

  const reasons = [...finalScore.reasons];
  if (initialScore.verdict === 'suspicious' && finalScore.verdict !== 'suspicious') {
    reasons.push('入口域名可疑，但最终落地到了可信域名 —— 仍建议直接用最终地址');
  }
  if (chain.length > 2) reasons.push(`跳转 ${chain.length - 1} 次，最终落在 ${finalHost}`);
  if (!https) reasons.push('最终地址是 http 明文，下载内容可能被中间人替换');
  if (last.status >= 400) reasons.push(`最终状态码 ${last.status}（页面可能已失效）`);

  let verdict = finalScore.verdict;
  /* 入口可疑 + 落地未知 → 整体按可疑处理，别让"跳一次就洗白"成立 */
  if (initialScore.verdict === 'suspicious' && verdict === 'unknown') verdict = 'suspicious';

  const tls = https ? await tlsInfo(last.url || url) : null;
  if (tls && !tls.authorized) {
    reasons.push(`TLS 校验未通过：${tls.authorizationError || '未知原因'}`);
    if (verdict === 'trusted' || verdict === 'official') verdict = 'unknown';
  }

  const advice = {
    official: '域名与官方登记一致。仍要核对页面上给出的校验值（SHA256 / 签名）。',
    trusted: '可信平台上的第三方内容：看仓库活跃度、作者、Release 是否带校验值，再决定是否用。',
    unknown: '未登记域名：先找出该项目的官方来源再下载，别只凭页面像不像。',
    suspicious: '证据指向可疑：不要在该站登录、填手机号或下载可执行文件；改走官方渠道。',
  }[verdict];

  return {
    url,
    verdict,
    host: hostOf(url),
    finalUrl: last.url || url,
    finalHost,
    finalStatus: last.status || 0,
    https,
    contentType: last.contentType || '',
    chain: chain.map((c) => ({ url: c.url, status: c.status, host: c.host, location: c.location, error: c.error })),
    tls,
    reasons,
    advice,
  };
}

/** 下载文件后算 SHA256，和官方公布的比对。 */
export function sha256File(filePath) {
  const hash = createHash('sha256');
  const buf = fs.readFileSync(filePath);
  hash.update(buf);
  return { file: filePath, bytes: buf.length, sha256: hash.digest('hex') };
}

export function compareSha256(actual, expected) {
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/^sha256[:-]/, '');
  const a = norm(actual);
  const e = norm(expected);
  if (!e) return { match: null, note: '没有提供期望值，只返回实际哈希' };
  return { match: a === e, actual: a, expected: e };
}

export { OFFICIAL_DOMAINS, TRUSTED_PLATFORMS };
