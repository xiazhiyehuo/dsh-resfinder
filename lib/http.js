/**
 * 最小可用 HTTP 层：只用 Node 内建 fetch + TextDecoder，不引第三方依赖。
 *
 * 设计要点：
 *  · 统一 UA / 超时 / 大小上限，避免一个坏站点拖死整个检索；
 *  · 编码识别优先 Content-Type，其次扫描 meta charset —— 国内站点仍大量使用 GBK；
 *  · 重定向手动跟随，把跳转链路留下来（res_verify 要用它判断"最终落地域名"）；
 *  · 失败一律抛 HttpError，带 url/status，调用方决定降级。
 */

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];

export class HttpError extends Error {
  constructor(message, { url, status = 0, cause } = {}) {
    super(message);
    this.name = 'HttpError';
    this.url = url;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

let uaCursor = 0;
function nextUa() {
  uaCursor = (uaCursor + 1) % UA_POOL.length;
  return UA_POOL[uaCursor];
}

/** 从 HTTP 头或 HTML 前若干字节里认出编码，Node 24 自带 full-icu，gbk/gb2312/gb18030 都能解。 */
export function sniffCharset(buffer, contentType = '') {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || '');
  if (fromHeader) return normalizeCharset(fromHeader[1]);
  const head = buffer.subarray(0, 4096).toString('latin1');
  const meta =
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) ||
    /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(head) ||
    /encoding=["']([\w-]+)["']/i.exec(head);
  if (meta) return normalizeCharset(meta[1]);
  return 'utf-8';
}

function normalizeCharset(cs) {
  const c = String(cs || '').trim().toLowerCase();
  if (!c) return 'utf-8';
  if (c === 'gb2312' || c === 'gbk') return 'gb18030';
  return c;
}

export function decodeBuffer(buffer, contentType) {
  const charset = sniffCharset(buffer, contentType);
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

/**
 * 抓一个 URL。
 * @returns {Promise<{status:number,url:string,headers:Headers,text:string,bytes:number,redirects:string[],contentType:string}>}
 */
export async function fetchText(input, options = {}) {
  const {
    method = 'GET',
    headers = {},
    timeoutMs = 20000,
    maxBytes = 4 * 1024 * 1024,
    maxRedirects = 5,
    followRedirect = true,
    body = undefined,
    ua = nextUa(),
  } = options;

  let url = String(input);
  const redirects = [];
  let current = url;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const controller = new AbortController();
    /* 计时器必须罩住「取头 + 读完 body」整段：只罩 fetch() 的话，
       服务端慢慢吐 body 时永远不会被超时打断（360 搜索实测能拖到 58s）。 */
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(current, {
        method,
        body,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': ua,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'accept-encoding': 'gzip, deflate, br',
          ...headers,
        },
      });
    } catch (err) {
      clearTimeout(timer);
      throw new HttpError(`连接失败：${err?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : err?.message || String(err)}`, {
        url: current,
        cause: err,
      });
    }

    const status = res.status;
    const location = res.headers.get('location');
    if (followRedirect && location && [301, 302, 303, 307, 308].includes(status)) {
      clearTimeout(timer);
      redirects.push(current);
      if (res.body) {
        try { await res.body.cancel(); } catch { /* 丢掉响应体即可 */ }
      }
      current = new URL(location, current).toString();
      continue;
    }

    const contentType = res.headers.get('content-type') || '';
    const chunks = [];
    let bytes = 0;
    try {
      if (res.body) {
        for await (const chunk of res.body) {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            controller.abort();
            break;
          }
          chunks.push(chunk);
        }
      }
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new HttpError(`读取响应体超时 ${timeoutMs}ms（已收到 ${bytes} 字节）`, { url: current, status });
      }
      throw new HttpError(`读取响应失败：${err?.message || String(err)}`, { url: current, status, cause: err });
    } finally {
      clearTimeout(timer);
    }
    const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const text = /json|javascript|xml|text\/plain/i.test(contentType)
      ? buffer.toString('utf8')
      : decodeBuffer(buffer, contentType);

    if (!res.ok && status !== 404) {
      // 404 也放行：调用方往往想知道"这个页面不存在"而不是异常
      if (status >= 500 || status === 403 || status === 429) {
        throw new HttpError(`HTTP ${status}`, { url: current, status });
      }
    }

    return { status, url: current, headers: res.headers, text, bytes: buffer.length, redirects, contentType };
  }

  throw new HttpError('重定向次数超过上限', { url, status: 0 });
}

export async function fetchJson(input, options = {}) {
  const res = await fetchText(input, {
    ...options,
    headers: { accept: 'application/json, text/plain, */*', ...(options.headers || {}) },
  });
  try {
    return { ...res, json: JSON.parse(res.text) };
  } catch (err) {
    throw new HttpError(`返回不是合法 JSON（前 120 字符：${res.text.slice(0, 120)}）`, { url: res.url, status: res.status, cause: err });
  }
}

export async function mapLimit(items, limit, worker) {
  const list = Array.from(items);
  const out = new Array(list.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), list.length) }, async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      try {
        out[index] = await worker(list[index], index);
      } catch (err) {
        out[index] = { error: err?.message || String(err) };
      }
    }
  });
  await Promise.all(runners);
  return out;
}

export function absoluteUrl(href, base) {
  try {
    return new URL(String(href).trim(), base).toString();
  } catch {
    return '';
  }
}

export function domainOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}
