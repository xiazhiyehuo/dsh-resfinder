# 安装说明

三种用法，按 agent 形态选一种。零第三方依赖，需要 Node >= 20。

## 1. 全局命令

```bash
npm install -g dsh-resfinder
resfinder sources
resfinder verify https://bit.ly/xxx --json
resfinder channels nodejs
resfinder watch --limit 50 --json
```

约定：**全部命令支持 `--json`**；正文走 stdout，错误走 stderr 且退出码非 0。

## 2. MCP 客户端

```jsonc
{
  "mcpServers": {
    "resfinder": { "command": "node", "args": ["<安装目录>/mcp/server.js"] }
  }
}
```

JSON-RPC 2.0 over stdio，方法：`initialize` / `tools/list` / `tools/call`。
暴露 `res_read` `res_channels` `res_verify` `res_save` `res_library` `res_watch` `res_sources`
（另有两个检索工具 `res_search` / `res_dig`，默认启用；与搜索类插件共存时可关，见下）。

## 3. DSH 插件

```bash
dsh plugin --profile web add github:xiazhijiehuo/dsh-resfinder
```

只想用核验/渠道/巡检、把搜索留给别的插件：

```yaml
- id: dsh-resfinder
  config:
    enableSearch: false   # 不注册 res_search / res_dig
```

Web 面板在 `http://127.0.0.1:3080/resfinder`。

## 数据位置

`$DSH_HOME/resfinder/`（未设则 `~/.dsh/resfinder/`，可用 `RESFINDER_HOME` 覆盖）：
`library.jsonl` 资源库 · `cache.json` 缓存 · `metrics.json` 来源质量 · `watch-history.jsonl` 巡检历史。

## 网络前提（2026-10 实测）

- 免 key 可用：Bing、360、GitHub、npm、crates.io、Stack Overflow、哔哩哔哩（wbi 签名）、OpenAlex、Crossref
- 不通：DuckDuckGo、公共 SearXNG 实例、`export.arxiv.org`
- 需 key：Tavily `TAVILY_API_KEY` · Brave `BRAVE_API_KEY` · SearXNG `SEARXNG_URL`
- `GITHUB_TOKEN` 可选：GitHub API 配额 60 → 5000 次/小时

## 自检

```bash
node scripts/smoke.mjs      # 22 项，含真实网络请求
node scripts/preview.mjs 3099   # 预览 Web 面板
```
