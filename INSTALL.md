# 安装

Node 20 以上，不用装任何依赖。

## 当命令用

```bash
npm i -g dsh-resfinder

resfinder sources                                # 看哪些源能用
resfinder verify https://bit.ly/xxx              # 核验一个链接
resfinder verify https://某篇教程 --from-page ...
resfinder channels nodejs                        # 官方入口在哪
resfinder watch --limit 50                       # 巡检库里的链接
```

加 `--json` 输出结构化结果，方便脚本或 agent 直接读。正文走 stdout，错误走 stderr，失败退出码非 0。

## 接 MCP 客户端

```jsonc
{
  "mcpServers": {
    "resfinder": { "command": "node", "args": ["<安装目录>/mcp/server.js"] }
  }
}
```

走 stdio，方法是 `initialize` / `tools/list` / `tools/call`。

## 装进 DSH

```bash
dsh plugin --profile web add github:xiazhijiehuo/dsh-resfinder
```

装完在 `http://127.0.0.1:3080/resfinder` 有面板。

如果搜索已经交给别的插件，把自带的两个检索工具关掉：

```yaml
- id: dsh-resfinder
  config:
    enableSearch: false
```

剩下 `res_read` `res_verify` `res_channels` `res_save` `res_library` `res_watch` `res_sources` 七个，各管各的。

## 数据在哪

默认 `~/.dsh/resfinder/`，设了 `DSH_HOME` 就跟过去，也可以单独用 `RESFINDER_HOME` 指。

- `library.jsonl` — 存过并核验过的链接
- `cache.json` — 检索和读页的缓存
- `metrics.json` — 各检索源的产出率、耗时
- `watch-history.jsonl` — 每次巡检的记录

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `TAVILY_API_KEY` | 启用 Tavily 检索 |
| `BRAVE_API_KEY` | 启用 Brave 检索 |
| `SEARXNG_URL` | 接自建 SearXNG |
| `GITHUB_TOKEN` | GitHub API 配额 60 → 5000 次/小时 |

## 自己跑测试

```bash
node scripts/ci.mjs         # 离线断言，不联网
node scripts/smoke.mjs      # 联网冒烟，22 项
```
