/**
 * CI 用的离线断言：不联网，只验结构完整性。
 * 联网的 smoke.mjs 不适合放进 CI（会因目标站点抖动而红）。
 */
import { buildTools } from '../lib/tools.js';
import { diffCheck } from '../lib/watch.js';
import { panelHtml } from '../lib/ui.js';

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

const tools = buildTools();
const names = tools.map((t) => t.name);
for (const want of ['res_search', 'res_read', 'res_dig', 'res_channels', 'res_verify', 'res_save', 'res_library', 'res_watch', 'res_sources']) {
  ok(names.includes(want), `缺工具 ${want}`);
}
for (const t of tools) {
  ok(t.description && t.description.length > 20, `${t.name} 描述太短`);
  ok(t.parameters?.type === 'object', `${t.name} 参数不是 object schema`);
  ok(typeof t.execute === 'function', `${t.name} 缺 execute`);
}

/* 巡检变化判定：核心逻辑，不需要网络 */
const cases = [
  [null, { status: 0, verdict: 'suspicious', finalHost: '', tlsOk: null }, 'down'],
  [null, { status: 200, verdict: 'official', finalHost: 'a.com', tlsOk: true }, 'first-check'],
  [{ status: 200, verdict: 'official', finalHost: 'a.com', tlsOk: true }, { status: 200, verdict: 'official', finalHost: 'a.com', tlsOk: false }, 'tls-warning'],
  [{ status: 200, verdict: 'official', finalHost: 'a.com' }, { status: 200, verdict: 'official', finalHost: 'b.com' }, 'domain-changed'],
  [{ status: 404, verdict: 'unknown', finalHost: 'a.com' }, { status: 200, verdict: 'unknown', finalHost: 'a.com' }, 'up'],
];
for (const [prev, now, want] of cases) {
  const got = diffCheck(prev, now).join(',');
  ok(got === want, `diffCheck 期望 ${want} 实际 ${got}`);
}

/* 面板与结构化渲染 */
ok(panelHtml().includes('/resfinder/api'), '面板缺 API 路径');
const defs = [];
const mod = await import('../lib/index.js');
mod.apply({ tools: { register: (d) => defs.push(d) } }, {});
ok(defs.length === 9, `默认应注册 9 个工具，实际 ${defs.length}`);
const namesOff = [];
mod.apply({ tools: { register: (d) => namesOff.push(d.name) } }, { enableSearch: false });
ok(namesOff.length === 7, `enableSearch=false 应注册 7 个，实际 ${namesOff.length}`);
const render = defs[0].output.render({}, { text: 'T', data: { a: 1 } })[0].text;
ok(render.includes('```json'), 'render 没把 data 渲染成 JSON');

if (fails.length) {
  console.error('FAIL\n' + fails.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
console.log(`PASS 离线断言全通过（${tools.length} 工具 / ${cases.length} 判定用例 / 面板与渲染）`);
