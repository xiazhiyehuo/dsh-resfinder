#!/usr/bin/env node
/**
 * 本地预览：不重启 DSH 也能看 Web 面板长得对不对。
 * 用法：node scripts/preview.mjs [port]   → 打开 http://127.0.0.1:<port>/resfinder
 *
 * 只是开发期自检用，和正式路由（ctx.webServer.register）跑的是同一份 ui.js。
 */

import http from 'node:http';
import { panelHtml, handleApi } from '../lib/ui.js';

const port = Number(process.argv[2]) || 3099;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname === '/resfinder' || url.pathname === '/resfinder/') {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(panelHtml());
    return;
  }
  if (url.pathname === '/resfinder/api') {
    handleApi(req, res);
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[preview] http://127.0.0.1:${port}/resfinder`);
});
