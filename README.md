# dsh-resfinder

[![ci](https://github.com/xiazhijiehuo/dsh-resfinder/actions/workflows/ci.yml/badge.svg)](https://github.com/xiazhijiehuo/dsh-resfinder/actions/workflows/ci.yml)

**来源可信度工具** · 判断一个链接到底能不能用、什么时候会烂掉。

DeepSeek Harness 插件 + 独立 CLI + MCP 服务，零第三方依赖。

> 这不是又一个搜索插件。搜索交给 [`dsh-free-search`](https://www.npmjs.com/package/dsh-free-search) 或 [`@liustack/modsearch`](https://www.npmjs.com/package/@liustack/modsearch)；本插件负责**搜到之后**的事：这个来源可信吗？官方下载在哪？链接有没有悄悄换掉？

## 它解决什么

搜索引擎会把仿冒站排到前面，官网会换域名，发布页会 404。agent 和人一样，看到"名字对、页面像"就点了——这是找资源时最主要的风险来源。

三个动作：

| 工具 | 作用 |
| --- | --- |
| `res_verify` | 跳转链 + 最终域名 + TLS 证书 → `official` / `trusted` / `unknown` / `suspicious` 四档，附判据；支持 SHA256 比对 |
| `res_channels` | 资源名 → 官方渠道（官网 / Releases / 应用商店 / 正版图书馆），25 条登记表；未登记就给检索式与判据，不编链接 |
| `res_watch` | 巡检库内链接：和历史比对，只报变化（`down` / `domain-changed` / `downgraded` / `tls-warning` / `up`） |
| `res_verify --from-page` | **页面链接体检**：抓一篇教程/合集页上的所有外链逐条核验，把可疑的挑出来（最危险的不是文章，是它给的下载链接） |

配套：`res_read`（中文站点适配：B 站 wbi 搜索与播放页、豆瓣条目、arXiv、GitHub 仓库；其余走正文抽取）、`res_save` / `res_library`（资源库）、`res_sources`（自述能力与近期来源质量）。

## 截图

> `http://127.0.0.1:3080/resfinder` — 搜索 / 读正文 / 核验域名 / 存进库 / 一键巡检

![面板](docs/panel.png)

## 三个入口

| 入口 | 文件 | 给谁用 |
| --- | --- | --- |
| DSH 插件 | `lib/index.js` | DeepSeek Harness 会话内的 `res_*` 工具 |
| CLI | `bin/resfinder.js` | 任意能跑命令的 agent，全部支持 `--json` |
| MCP stdio | `mcp/server.js` | Claude Desktop / Cursor / 自研 agent |

```bash
npm install -g dsh-resfinder      # 或 npm i -g ./dsh-resfinder-*.tgz
resfinder verify https://bit.ly/xxx
resfinder channels nodejs
resfinder watch --limit 50 --json
```

## 设计取舍

- **核验只认客观事实**：跳转链、最终域名、TLS。域名名单只用来给档位，"看起来像"不作为结论依据；入口可疑 + 落地未知 → 仍判可疑，不让"跳一次就洗白"。
- **记忆分两层**：缓存（检索 30 分钟 / 读页 6 小时，过期不命中）+ 资源库（只放 verify 过的）。过期记忆比没记忆更危险。
- **告警宁可少报**：连接层失败先退 700ms 重试一次，只有重试也失败才判 `down`——误报会让人再也不信告警。
- **失败如实上报**：B 站搜索被风控就说失败，不伪装成"没找到"。
- **不碰盗版**：只给正版与公开授权渠道。

## 边界

- 不做全站爬虫，只读给定 URL。
- 不提供破解、盗版书影音、账号共享类渠道。
- 核验结论只在证据支持的范围里：`unknown` 就是 `unknown`，不替你升级成"安全"。

## 许可

MIT。第三方内容版权归原站点，引用时标注来源与抓取时间。
