/**
 * 官方渠道判定。
 *
 * 目的：自主型 AI 找资源时最容易犯的错不是"找不到"，而是"找到一个长得像官方的站"。
 * 这里维护一张可核对的渠道表（官方站 / 官方仓库 / 官方应用商店），命中就直出；
 * 没命中也不装懂——给出检索式和"官方站通常长什么样"的判据，让上层继续查证。
 *
 * 只收正版与公开授权来源；不收录盗版、破解、账号共享类站点。
 */

/** 常见资源的官方渠道（key 全部小写，用于在用户输入里做包含匹配）。 */
export const REGISTRY = [
  {
    key: ['node.js', 'nodejs', 'node'],
    name: 'Node.js',
    category: 'runtime',
    channels: [
      { label: '官网下载页', url: 'https://nodejs.org/zh-cn/download', note: '提供 LTS / Current，含 SHASUMS256.txt' },
      { label: '历史版本', url: 'https://nodejs.org/dist/', note: '所有版本的源码与二进制 + 校验文件' },
      { label: '国内镜像（非官方但常用）', url: 'https://npmmirror.com/mirrors/node', note: '阿里系镜像，速度稳定' },
    ],
  },
  {
    key: ['python', 'python3', 'cpython'],
    name: 'Python',
    category: 'runtime',
    channels: [
      { label: '官网下载', url: 'https://www.python.org/downloads/', note: '含 Windows/macOS 安装包与签名说明' },
      { label: '源码与全部版本', url: 'https://www.python.org/ftp/python/', note: '' },
      { label: '官方文档', url: 'https://docs.python.org/zh-cn/3/', note: '有中文版' },
    ],
  },
  {
    key: ['git'],
    name: 'Git',
    category: 'devtool',
    channels: [
      { label: '官网下载', url: 'https://git-scm.com/downloads', note: '' },
      { label: 'Windows 版（官方镜像）', url: 'https://github.com/git-for-windows/git/releases', note: '发布在 GitHub Releases' },
    ],
  },
  {
    key: ['vs code', 'vscode', 'visual studio code'],
    name: 'Visual Studio Code',
    category: 'devtool',
    channels: [
      { label: '官网下载', url: 'https://code.visualstudio.com/Download', note: '' },
      { label: '官方仓库', url: 'https://github.com/microsoft/vscode', note: '源码；二进制请走官网' },
    ],
  },
  {
    key: ['docker', 'docker desktop'],
    name: 'Docker',
    category: 'devtool',
    channels: [
      { label: '官网下载', url: 'https://www.docker.com/products/docker-desktop/', note: '个人/小企业免费，商用需订阅' },
      { label: '镜像文档', url: 'https://hub.docker.com/', note: '' },
    ],
  },
  {
    key: ['java', 'jdk', 'openjdk', 'temurin'],
    name: 'JDK',
    category: 'runtime',
    channels: [
      { label: 'Oracle JDK', url: 'https://www.oracle.com/java/technologies/downloads/', note: '商用注意许可条款' },
      { label: 'Eclipse Temurin（开源免费）', url: 'https://adoptium.net/', note: '推荐给一般开发用' },
    ],
  },
  {
    key: ['ffmpeg'],
    name: 'FFmpeg',
    category: 'devtool',
    channels: [
      { label: '官网下载', url: 'https://ffmpeg.org/download.html', note: '官方只给源码与第三方构建链接' },
      { label: 'Windows 构建（gyan.dev）', url: 'https://www.gyan.dev/ffmpeg/builds/', note: '官方下载页列出的构建方' },
    ],
  },
  {
    key: ['7-zip', '7zip'],
    name: '7-Zip',
    category: 'tool',
    channels: [{ label: '官网', url: 'https://www.7-zip.org/', note: '认准 7-zip.org，其余多为仿站' }],
  },
  {
    key: ['obs', 'obs studio'],
    name: 'OBS Studio',
    category: 'tool',
    channels: [
      { label: '官网下载', url: 'https://obsproject.com/download', note: '' },
      { label: '官方仓库', url: 'https://github.com/obsproject/obs-studio/releases', note: '' },
    ],
  },
  {
    key: ['vlc'],
    name: 'VLC',
    category: 'tool',
    channels: [{ label: '官网下载', url: 'https://www.videolan.org/vlc/', note: '' }],
  },
  {
    key: ['chrome', 'google chrome'],
    name: 'Google Chrome',
    category: 'browser',
    channels: [
      { label: '官网下载', url: 'https://www.google.com/chrome/', note: '国内可用 https://www.google.cn/chrome/' },
      { label: '企业版 MSI', url: 'https://chromeenterprise.google/browser/download/', note: '' },
    ],
  },
  {
    key: ['firefox'],
    name: 'Firefox',
    category: 'browser',
    channels: [{ label: '官网下载', url: 'https://www.mozilla.org/firefox/', note: '' }],
  },
  {
    key: ['powershell', 'pwsh'],
    name: 'PowerShell 7',
    category: 'tool',
    channels: [
      { label: '官方 Releases', url: 'https://github.com/PowerShell/PowerShell/releases', note: '' },
      { label: '微软文档', url: 'https://learn.microsoft.com/powershell/', note: '' },
    ],
  },
  {
    key: ['arxiv', '预印本'],
    name: 'arXiv',
    category: 'paper',
    channels: [
      { label: '官网检索', url: 'https://arxiv.org/search/', note: '' },
      { label: '论文检索（OpenAlex）', url: 'https://api.openalex.org/works?search=your+topic', note: '免 key 的开放索引' },
    ],
  },
  {
    key: ['知网', 'cnki', '中国知网'],
    name: '中国知网',
    category: 'paper',
    channels: [{ label: '官网', url: 'https://www.cnki.net/', note: '需要机构订阅或个人购买；先用单位 VPN/图书馆权限' }],
  },
  {
    key: ['国家标准', '国标', 'gbt', 'gb/t'],
    name: '国家标准全文公开系统',
    category: 'standard',
    channels: [{ label: '官方查询', url: 'https://openstd.samr.gov.cn/bzgk/gb/', note: '强制性国标全文可在线看' }],
  },
  {
    key: ['国家图书馆', 'nlc'],
    name: '中国国家图书馆',
    category: 'book',
    channels: [{ label: '官网', url: 'https://www.nlc.cn/', note: '读者卡可在线读部分电子书与古籍' }],
  },
  {
    key: ['gutenberg', '古登堡'],
    name: 'Project Gutenberg',
    category: 'book',
    channels: [{ label: '官网', url: 'https://www.gutenberg.org/', note: '公版书，可直接下载 epub/txt' }],
  },
  {
    key: ['open library', 'openlibrary'],
    name: 'Open Library',
    category: 'book',
    channels: [{ label: '官网', url: 'https://openlibrary.org/', note: '借阅式访问；部分书可在线读' }],
  },
  {
    key: ['unsplash'],
    name: 'Unsplash',
    category: 'asset',
    channels: [{ label: '官网', url: 'https://unsplash.com/', note: '免费可商用，注意具体许可' }],
  },
  {
    key: ['pexels'],
    name: 'Pexels',
    category: 'asset',
    channels: [{ label: '官网', url: 'https://www.pexels.com/', note: '免费素材，遵守许可' }],
  },
  {
    key: ['wikimedia', '维基共享'],
    name: 'Wikimedia Commons',
    category: 'asset',
    channels: [{ label: '官网', url: 'https://commons.wikimedia.org/', note: '留意每个文件的许可协议' }],
  },
  {
    key: ['google fonts', '字体', 'font'],
    name: 'Google Fonts',
    category: 'font',
    channels: [
      { label: '官网', url: 'https://fonts.google.com/', note: '开源字体，注意 OFL 条款' },
      { label: '思源系列（官方仓库）', url: 'https://github.com/adobe-fonts/source-han-sans/releases', note: '' },
    ],
  },
  {
    key: ['f-droid', 'fdroid'],
    name: 'F-Droid',
    category: 'appstore',
    channels: [{ label: '官网', url: 'https://f-droid.org/', note: '开源安卓应用商店，可校验签名' }],
  },
  {
    key: ['winget', 'chocolatey', 'scoop'],
    name: 'Windows 包管理器',
    category: 'appstore',
    channels: [
      { label: 'winget（微软官方）', url: 'https://learn.microsoft.com/windows/package-manager/', note: '随 Windows 提供' },
      { label: 'Chocolatey', url: 'https://chocolatey.org/', note: '社区维护，注意包来源' },
      { label: 'Scoop', url: 'https://scoop.sh/', note: '社区维护' },
    ],
  },
];

function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 在登记表里找条目：名字包含 key，或 key 包含名字（处理"装个 node"这类口语）。 */
export function lookup(query) {
  const q = norm(query);
  if (!q) return null;
  let best = null;
  for (const entry of REGISTRY) {
    for (const key of entry.key) {
      if (q === key) return entry;
      if (q.includes(key) || key.includes(q)) {
        if (!best || key.length > best.matched.length) best = { ...entry, matched: key };
      }
    }
  }
  return best;
}

/** 给"没登记过的资源"一套通用的找官方渠道打法，而不是瞎猜链接。 */
export function genericGuidance(name) {
  const q = String(name || '').trim() || '<资源名>';
  return {
    registryHit: false,
    name: q,
    channels: [],
    searches: [
      { engine: 'bing', query: `${q} 官网`, why: '找官方入口：官网域名通常与产品名一致' },
      { engine: 'bing', query: `${q} official site`, why: '英文名搜索往往先命中官网' },
      { engine: 'github', query: q, why: '开源项目走 GitHub Releases，能拿到校验值' },
      { engine: 'bing', query: `${q} site:github.com release`, why: '直接找发布页' },
    ],
    checklist: [
      '域名与产品名一致，且用 https（如 nodejs.org、python.org）',
      '下载页给出校验值（SHA256）或签名说明',
      '仓库 README / Releases 与官网互相对得上',
      '不在网盘、破解站、聚合下载站取二进制',
      '装完用 res_verify 核一次落地域名和跳转链',
    ],
    caution: '没登记 ≠ 有问题；但"没核过就装"是主要风险来源。先用上面的检索式定位官网，再用 res_verify 核对。',
  };
}

export function channelsFor(name) {
  const hit = lookup(name);
  if (hit) {
    const { matched, ...rest } = hit;
    return { registryHit: true, matchedKey: matched, ...rest };
  }
  return genericGuidance(name);
}

export function registryStats() {
  const byCategory = {};
  for (const e of REGISTRY) byCategory[e.category] = (byCategory[e.category] || 0) + 1;
  return { entries: REGISTRY.length, byCategory };
}
