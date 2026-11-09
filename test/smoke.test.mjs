/**
 * 冒烟测试：不依赖 DSH 宿主，用假 ctx 验证「插件能装、19 个工具都在、调用链能跑」。
 *
 *   node --test test/
 *
 * 只跑**不需要联网**的用例（astock_calc 的算账/公式模式是纯函数），
 * 联网用例单独标出来，网络不通时跳过而不是判失败。
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { TOOLS, USAGE_GUIDANCE, apply, inject, name, toolNames } from '../lib/plugin.js';
import * as shim from '../lib/boot.js';
import { KEY_MAP, toAstockConfig } from '../lib/config.js';
import { SETTINGS_KEYS } from '../lib/config-schema.js';
import { loadClientBundle } from './client-loader.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 整个文件用**沙箱 home**，不读真实的 `~/.dsh` / `~/.lite-work`。
 *
 * 之前这里用的是真实 home：默认存档目录指向 `~/.dsh/astock-data`，激活时还会
 * 从 `~/.lite-work/astock-data` 迁移旧台账。于是同一份代码，在干净机器上全绿，
 * 在有真实台账的开发机上「空仓」用例全红（面板里冒出天山铝业、流水 8 条）。
 * 设置页与文档也说过台账/存档默认落在 `$DSH_HOME`，所以这里按真实语义隔离。
 */
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'dsh-astock-home-'));
process.env.DSH_HOME = SANDBOX_HOME;
process.env.DSH_ASTOCK_LEGACY_DIR = join(SANDBOX_HOME, 'no-such-legacy-dir');

/** 造一个最小可用的 cordis ctx。 */
function fakeCtx({ schedule } = {}) {
  const registered = new Map();
  const prompts = [];
  const routes = [];
  return {
    ctx: {
      tools: {
        register(definition) {
          assert.ok(definition?.name, '工具必须有 name');
          assert.ok(definition?.parameters, '工具必须有 parameters');
          assert.equal(typeof definition.execute, 'function');
          registered.set(definition.name, definition);
        },
      },
      systemPrompt: {
        context(entry) {
          prompts.push(entry);
        },
      },
      // 宿主有 webServer / schedule 时插件要接上（没有也不能影响工具注册）
      inject(deps, callback) {
        const host = { ...this, webServer: this.webServer, schedule: this.schedule };
        callback(host);
      },
      webServer: {
        register(route) {
          routes.push(route);
          return () => {};
        },
      },
      schedule,
      effect(fn) {
        return fn();
      },
    },
    registered,
    prompts,
    routes,
  };
}

/** 跑一次假 HTTP 请求，返回解析后的 JSON。 */
function callRoute(route, url = '/api/dsh-astock/panel') {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      statusCode: 0,
      headers: {},
      writeHead(code, headers) {
        this.statusCode = code;
        this.headers = headers || {};
      },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.from(String(chunk)));
        try {
          resolve({
            status: this.statusCode,
            headers: this.headers,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          });
        } catch (err) {
          reject(err);
        }
      },
    };
    Promise.resolve(route.handler({ method: 'GET', url }, res)).catch(reject);
  });
}

/** POST 一个 JSON 体（请求对象只需要可异步迭代，与 Node 的 IncomingMessage 一致）。 */
function postRoute(route, payload, url = '/api/dsh-astock/panel') {
  const raw = JSON.stringify(payload ?? {});
  const req = {
    method: 'POST',
    url,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(raw, 'utf8');
    },
  };
  return new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      statusCode: 0,
      writeHead(code) { this.statusCode = code; },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.from(String(chunk)));
        resolve({ status: this.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      },
    };
    Promise.resolve(route.handler(req, res)).catch(reject);
  });
}

/** 原样取响应（下载端点用：响应体不是 JSON）。 */
function rawGetRoute(route, url) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      statusCode: 0,
      headers: {},
      writeHead(code, headers) {
        this.statusCode = code;
        this.headers = headers || {};
      },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.from(String(chunk)));
        resolve({
          status: this.statusCode,
          headers: this.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      },
    };
    Promise.resolve(route.handler({ method: 'GET', url }, res)).catch(reject);
  });
}

test('插件元信息与上游一致', () => {
  assert.equal(name, 'dsh-astock');
  assert.deepEqual(inject, ['tools', 'systemPrompt']);
  assert.equal(TOOLS.length, 19);
  assert.match(USAGE_GUIDANCE, /astock_quote/);
  assert.match(USAGE_GUIDANCE, /不构成投资建议/);
});

test('19 个工具全部注册，名字与上游 astock-plugin 一致', () => {
  const { ctx, registered, prompts } = fakeCtx();
  const returned = apply(ctx, {});
  // Cordis 会把 apply 的返回值当 effect，所以必须什么都不返回
  assert.equal(returned, undefined);
  assert.equal(registered.size, 19);
  assert.deepEqual([...registered.keys()].sort(), [
    'astock_act', 'astock_archive', 'astock_backtest', 'astock_business',
    'astock_calc', 'astock_events', 'astock_extra', 'astock_flow',
    'astock_hint', 'astock_kline', 'astock_pick', 'astock_portfolio',
    'astock_quote', 'astock_record', 'astock_screen', 'astock_search',
    'astock_sentiment', 'astock_sync', 'astock_watch',
  ]);
  assert.equal(toolNames().length, 19);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].order, 120);
});

test('schema 是上游导出的原始对象（不是手抄的副本）', () => {
  const quote = TOOLS.find((tool) => tool.name === 'astock_quote');
  assert.equal(quote.parameters.properties.codes.type, 'array');
  assert.deepEqual(quote.parameters.required, []);
  assert.match(quote.description, /腾讯行情/);

  const calc = TOOLS.find((tool) => tool.name === 'astock_calc');
  assert.ok(calc.parameters.properties.mode.enum.includes('rule_check'));
});

test('配置映射：camelCase 落到上游 snake_case，只透传显式值', () => {
  assert.equal(KEY_MAP.commissionRate, 'commission_rate');
  const mapped = toAstockConfig({
    pythonPath: 'x',
    timeoutMs: 1000,
    commissionRate: 0.0003,
    stopLossPct: 6,
    ledgerPath: 'C:/tmp/ledger.sqlite',
    astock: { pick_strategy: 'quality', take_profit_pct: 20 },
  });
  assert.deepEqual(mapped, {
    commission_rate: 0.0003,
    stop_loss_pct: 6,
    ledger_path: 'C:/tmp/ledger.sqlite',
    pick_strategy: 'quality',
    take_profit_pct: 20,
  });
  // 空字符串视为「没配」，不能把上游默认值顶掉
  assert.deepEqual(toAstockConfig({ ledgerPath: '', stopLossPct: null }), {});
});

test('配置映射：DSH 的惰性包装 {get} 会被拆成真值（否则插件激活失败）', () => {
  // 宿主（设置表单 + 热更新）把每个字段包成 { get: () => current }。
  // 踩过的坑：把包装对象当字符串用 → path.dirname 抛
  // "The path argument must be of type string. Received an instance of Object"，
  // 整个插件不激活（工具、面板端点全没），界面上只剩 404。
  const lazy = (value) => ({ get: () => value });
  const mapped = toAstockConfig({
    ledgerPath: lazy('C:/tmp/ledger.sqlite'),
    mailPort: lazy(587),
    mailEnabled: lazy(true),
    stopLossPct: lazy(0),
    astock: lazy({ pick_strategy: 'quality' }),
  });
  assert.deepEqual(mapped, {
    ledger_path: 'C:/tmp/ledger.sqlite',
    mail_port: 587,
    mail_enabled: true,
    stop_loss_pct: 0,
    pick_strategy: 'quality',
  });
});

test('装配：每个配置值都是惰性包装时，19 个工具与面板端点照样注册', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-astock-lazy-'));
  const lazy = (value) => ({ get: () => value });
  const config = {};
  // 模拟宿主：45 个字段全部包一层（默认值给 undefined 即可，走插件自己的默认）
  for (const key of SETTINGS_KEYS) config[key] = lazy(undefined);
  config.ledgerPath = lazy(join(dir, 'ledger.sqlite'));
  config.archivePath = lazy(join(dir, 'archive.sqlite'));
  config.astock = lazy({});

  const { ctx, registered, routes } = fakeCtx();
  assert.doesNotThrow(() => apply(ctx, config));
  assert.equal(registered.size, 19);
  assert.ok(routes.some((route) => route.path === '/api/dsh-astock/panel'));
  assert.ok(routes.some((route) => route.path === '/api/dsh-astock/info'));
});

test('纯函数工具（astock_calc 算账）能跑通完整调用链', async () => {
  const { ctx, registered } = fakeCtx();
  apply(ctx, { timeoutMs: 60_000 });
  const calc = registered.get('astock_calc');
  const out = await calc.execute({
    mode: 'cost',
    entry_price: 10,
    shares: 1000,
    cash: 50000,
    equity: 200000,
    stop_pct: 8,
    take_pct: 15,
  }, { agent: { session: { header: { cwd: ROOT } } } });
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 20, `输出太短：${out}`);
  assert.ok(!out.startsWith('[Error]'), `工具报错：${out}`);
});

test('JS 重写：astock_calc cost 模式走 JS（不依赖子进程）', async () => {
  const { ctx, registered } = fakeCtx();
  apply(ctx, {});
  const calc = registered.get('astock_calc');
  const out = await calc.execute({
    mode: 'cost', entry_price: 10, shares: 1000, stop_pct: 8, take_pct: 15,
  }, {});
  assert.match(out, /成本与盈亏计算/);
  assert.match(out, /盈亏平衡价/);
  // 子进程桥接的错误信息不应出现
  assert.ok(!out.includes('spawn'));
  assert.ok(!out.startsWith('[Error]'));
});

test('未知参数不会让工具炸掉（返回 [Error] 文案或空结果说明）', async () => {
  const { ctx, registered } = fakeCtx();
  apply(ctx, {});
  const search = registered.get('astock_search');
  const out = await search.execute({ keyword: '' }, {});
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 0);
});

test('自检：不依赖 Python 也能拿到 19 个工具与台账路径', async () => {
  const { selftest } = await import('../lib/plugin.js');
  // 用临时台账目录，避免读到开发者本机的 settings.json（否则断言随环境变化）
  const dir = mkdtempSync(join(tmpdir(), 'dsh-astock-selftest-'));
  const info = await selftest({ ledgerPath: join(dir, 'ledger.sqlite') });
  assert.equal(info.toolCount, 19);
  assert.ok(info.ledgerPath.endsWith('ledger.sqlite'));
  assert.ok(info.runtime.startsWith('node '));
  assert.equal(typeof info.mail.ready, 'boolean');
});

test('装配壳（lib/boot.js）能加载实现并注册同样的 19 个工具', async () => {
  assert.equal(shim.name, 'dsh-astock');
  assert.deepEqual(shim.inject, ['tools', 'systemPrompt']);
  const { ctx, registered } = fakeCtx();
  await shim.apply(ctx, {});
  assert.equal(registered.size, 19);
});

test('客户端 bundle：能求值、导出 apply/inject', () => {
  const client = loadClientBundle();
  assert.equal(typeof client.apply, 'function');
  assert.deepEqual(client.inject, ['slots', 'sidebarRightTabs']);
});

test('客户端 bundle：apply 注册右栏 tab 类型与 body，key 与 id 一致', () => {
  const client = loadClientBundle();
  const calls = [];
  const effects = [];
  const ctx = {
    sidebarRightTabs: {
      register(definition) {
        calls.push({ where: 'type', definition });
        return () => {};
      },
    },
    slots: {
      inject(name, factory) {
        calls.push({ where: 'inject', name });
        return factory();
      },
      register(options, component) {
        calls.push({ where: 'body', options, component });
        return () => {};
      },
    },
    effect(fn, label) {
      effects.push(label);
      return fn();
    },
  };

  client.apply(ctx);

  const type = calls.find((c) => c.where === 'type');
  assert.ok(type, '必须注册 tab 类型');
  assert.equal(type.definition.id, 'dsh-astock');
  assert.equal(type.definition.kind, 'astock');
  assert.equal(type.definition.priority, 'extension');
  assert.equal(type.definition.title(), 'A股');
  assert.ok(Array.isArray(type.definition.guide) && type.definition.guide.length > 0);

  const body = calls.find((c) => c.where === 'body');
  assert.ok(body, '必须注册 tab body');
  assert.equal(body.options.name, 'sidebar.right.pane.tab');
  // 宿主按「类型的 id」取 body，两者必须一模一样，否则 tab 打开是空白
  assert.equal(body.options.key, type.definition.id);
  assert.equal(typeof body.component, 'function');

  assert.equal(effects.length, 2, '类型与 body 都必须挂在 effect 里（卸载时一起清）');
});

test('宿主：注册面板端点，空仓时返回可渲染的 portfolio 结构', async () => {
  const ledger = join(mkdtempSync(join(tmpdir(), 'dsh-astock-test-')), 'ledger.sqlite');
  const { ctx, routes } = fakeCtx();
  apply(ctx, { ledgerPath: ledger, timeoutMs: 60_000 });

  const route = routes.find((r) => r.path === '/api/dsh-astock/panel');
  assert.ok(route, '必须注册 /api/dsh-astock/panel');
  assert.equal(route.kind, 'exact');

  const { status, body } = await callRoute(route);
  assert.equal(status, 200);
  assert.equal(body.view, 'portfolio');
  assert.equal(body.ok, true);
  assert.equal(body.empty, true);
  assert.ok(Array.isArray(body.kpis) && body.kpis.length === 6);
  // 新加的两张卡：今日超额（对沪指）与净值曲线
  assert.ok(body.kpis.some((k) => k.label === '今日超额'));
  assert.ok(body.kpis.some((k) => k.label.includes('净值')));
  assert.ok(Array.isArray(body.equityCurve));
  assert.deepEqual(body.positions, []);
  assert.ok(body.limits && body.limits.positionCapPct > 0);
  assert.ok(body.renderedAt.length > 0);
});

test('宿主：面板端点拒绝 PUT', async () => {
  const ledger = join(mkdtempSync(join(tmpdir(), 'dsh-astock-test-')), 'ledger.sqlite');
  const { ctx, routes } = fakeCtx();
  apply(ctx, { ledgerPath: ledger });
  const route = routes.find((r) => r.path === '/api/dsh-astock/panel');

  const result = await new Promise((resolve, reject) => {
    const res = {
      writeHead(code) { this.code = code; },
      end(chunk) { resolve({ status: this.code, body: JSON.parse(String(chunk)) }); },
    };
    Promise.resolve(route.handler({ method: 'PUT', url: '/api/dsh-astock/panel' }, res)).catch(reject);
  });
  assert.equal(result.status, 405);
  assert.equal(result.body.ok, false);
});

test('宿主：POST 未知操作返回 400，不会误发信', async () => {
  const ledger = join(mkdtempSync(join(tmpdir(), 'dsh-astock-test-')), 'ledger.sqlite');
  const { ctx, routes } = fakeCtx();
  apply(ctx, { ledgerPath: ledger });
  const route = routes.find((r) => r.path === '/api/dsh-astock/panel');

  const result = await postRoute(route, { op: 'nope' });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /未知操作/);
});

test('宿主：POST mail_test 在未配置时返回可读原因（不打网络）', async () => {
  const ledger = join(mkdtempSync(join(tmpdir(), 'dsh-astock-test-')), 'ledger.sqlite');
  const { ctx, routes } = fakeCtx();
  apply(ctx, { ledgerPath: ledger });
  const route = routes.find((r) => r.path === '/api/dsh-astock/panel');

  const result = await postRoute(route, { op: 'mail_test' });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, false);
  assert.match(result.body.message, /未启用邮件通知/);
});

test('宿主：panel=mail 返回通知体检（view=mail）', async () => {
  const ledger = join(mkdtempSync(join(tmpdir(), 'dsh-astock-test-')), 'ledger.sqlite');
  const { ctx, routes } = fakeCtx();
  apply(ctx, { ledgerPath: ledger });
  const route = routes.find((r) => r.path === '/api/dsh-astock/panel');

  const { body } = await callRoute(route, '/api/dsh-astock/panel?panel=mail');
  assert.equal(body.view, 'mail');
  assert.equal(body.ready, false);
  assert.equal(body.enabled, false);
  assert.ok(body.dedupeHours > 0);
  assert.ok(body.maxPerHour > 0);
});

test('盯盘：start/status/stop 全部落到宿主 schedule', async () => {
  const tasks = new Map();
  let seq = 0;
  const schedule = {
    async create(input) {
      const task = {
        id: `schedule-${++seq}`,
        title: input.title,
        prompt: input.prompt,
        timing: input.timing,
        target: input.target,
        active: true,
        scheduledAtLocal: '2026-11-09T09:15:00+08:00',
        updatedAt: '2026-11-07T10:00:00.000Z',
      };
      tasks.set(task.id, task);
      return task;
    },
    async edit(request) {
      const task = tasks.get(request.id);
      if (request.action === 'delete') {
        tasks.delete(request.id);
        return { id: request.id, deleted: true };
      }
      Object.assign(task, request.patch ?? {});
      return task;
    },
    async list() {
      return [...tasks.values()];
    },
  };

  const ledger = join(mkdtempSync(join(tmpdir(), 'dsh-astock-test-')), 'ledger.sqlite');
  const { ctx, registered } = fakeCtx({ schedule });
  apply(ctx, { ledgerPath: ledger, timeoutMs: 60_000 });
  const tool = registered.get('astock_watch');

  // 未创建时应说明「未创建」，而不是让模型以为已经在盯
  const before = await tool.execute({ action: 'status' }, {});
  assert.match(before, /未创建/);
  assert.equal(tasks.size, 0);

  const started = await tool.execute({ action: 'start' }, {});
  assert.match(started, /已启动盯盘/);
  assert.match(started, /工作日 9:00–14:59/);
  assert.equal(tasks.size, 1);
  const task = [...tasks.values()][0];
  assert.equal(task.title, 'A股盯盘');
  assert.equal(task.timing.cron.time_zone, 'Asia/Shanghai');
  assert.equal(task.target.kind, 'new_once');

  const running = await tool.execute({ action: 'status' }, {});
  assert.match(running, /运行中/);
  assert.match(running, /2026-11-09 09:15/);

  const stopped = await tool.execute({ action: 'stop' }, {});
  assert.match(stopped, /盯盘已停止/);
  assert.equal(tasks.size, 0);
});

test('盯盘：没有 schedule 服务时，start 给出可读错误而不是崩溃', async () => {
  const ledger = join(mkdtempSync(join(tmpdir(), 'dsh-astock-test-')), 'ledger.sqlite');
  const { ctx, registered } = fakeCtx();
  apply(ctx, { ledgerPath: ledger });
  const out = await registered.get('astock_watch').execute({ action: 'start' }, {});
  assert.match(out, /\[Error\] 启动盯盘失败/);
  assert.match(out, /没有可用的定时服务/);
});

test('宿主：panel=maint 返回维护结构（不联网）', async () => {
  const ledger = join(mkdtempSync(join(tmpdir(), 'dsh-astock-test-')), 'ledger.sqlite');
  const { ctx, routes } = fakeCtx();
  apply(ctx, { ledgerPath: ledger });
  const route = routes.find((r) => r.path === '/api/dsh-astock/panel');

  const { body } = await callRoute(route, '/api/dsh-astock/panel?panel=maint');
  assert.equal(body.view, 'maint');
  assert.equal(body.ok, true);
  assert.ok(body.archive && typeof body.archive.codes === 'number');
  assert.ok(Array.isArray(body.backups));
  assert.ok(body.paths && body.paths.ledger.endsWith('ledger.sqlite'));
  assert.equal(body.automation.archiveAuto, true);
  // 没有 schedule 服务时报告状态是 available:false（面板显示「未创建」）
  assert.equal(body.automation.report.available, false);
});

test('宿主：下载端点返回附件头与可解析的台账 JSON', async () => {
  const ledger = join(mkdtempSync(join(tmpdir(), 'dsh-astock-test-')), 'ledger.sqlite');
  const { ctx, routes } = fakeCtx();
  apply(ctx, { ledgerPath: ledger });
  const route = routes.find((r) => r.path === '/api/dsh-astock/panel');

  const response = await rawGetRoute(route, '/api/dsh-astock/panel?download=ledger.json');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /application\/json/);
  assert.match(response.headers['content-disposition'], /attachment/);
  const parsed = JSON.parse(response.text);
  assert.equal(parsed.format, 'dsh-astock-ledger/1');
  assert.deepEqual(parsed.positions, []);
});

test('宿主：POST archive_update 在空台账时返回可读原因（不打网络）', async () => {
  const ledger = join(mkdtempSync(join(tmpdir(), 'dsh-astock-test-')), 'ledger.sqlite');
  const { ctx, routes } = fakeCtx();
  apply(ctx, { ledgerPath: ledger });
  const route = routes.find((r) => r.path === '/api/dsh-astock/panel');

  const result = await postRoute(route, { op: 'archive_update' });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, false);
  assert.match(result.body.message, /没有持仓或自选股/);
});

test('宿主：POST import_trades 只预览，不落账', async () => {
  const ledger = join(mkdtempSync(join(tmpdir(), 'dsh-astock-test-')), 'ledger.sqlite');
  const { ctx, routes } = fakeCtx();
  apply(ctx, { ledgerPath: ledger });
  const route = routes.find((r) => r.path === '/api/dsh-astock/panel');

  const text = '成交日期,代码,方向,成交价,数量,费用\n2026-11-05,600000,买入,10.00,1000,5.1';
  const result = await postRoute(route, { op: 'import_trades', text, commit: false });
  assert.equal(result.status, 200);
  assert.equal(result.body.committed, false);
  assert.equal(result.body.summary.ok, 1);
  assert.equal(result.body.rows[0].code, '600000');
  // 预览不能真的写台账
  const { body } = await callRoute(route, '/api/dsh-astock/panel?panel=maint');
  assert.equal(body.ledger.trades, 0);
});

test('宿主：备份创建 / 列表 / 恢复（恢复前自动再备份）', async () => {
  const ledger = join(mkdtempSync(join(tmpdir(), 'dsh-astock-test-')), 'ledger.sqlite');
  const { ctx, routes } = fakeCtx();
  apply(ctx, { ledgerPath: ledger });
  const route = routes.find((r) => r.path === '/api/dsh-astock/panel');

  // 先让台账/存档文件真正落盘（真实使用中它们早就存在）
  await callRoute(route, '/api/dsh-astock/panel?panel=maint');

  const created = await postRoute(route, { op: 'backup_create' });
  assert.equal(created.body.ok, true);
  assert.ok(created.body.name);

  const listed = await postRoute(route, { op: 'backup_list' });
  assert.equal(listed.body.backups.length, 1);

  const restored = await postRoute(route, { op: 'backup_restore', name: created.body.name });
  assert.equal(restored.body.ok, true);
  assert.deepEqual(restored.body.restored, ['ledger', 'archive']);
  assert.ok(restored.body.safetyBackup);
});

test('宿主：POST ledger_rebuild 按流水重算持仓', async () => {
  const ledger = join(mkdtempSync(join(tmpdir(), 'dsh-astock-test-')), 'ledger.sqlite');
  const { ctx, routes } = fakeCtx();
  apply(ctx, { ledgerPath: ledger });
  const route = routes.find((r) => r.path === '/api/dsh-astock/panel');

  const text = '成交日期,代码,方向,成交价,数量,费用\n2026-11-05,600000,买入,10.00,1000,5.1';
  await postRoute(route, { op: 'import_trades', text, commit: true });

  const rebuilt = await postRoute(route, { op: 'ledger_rebuild' });
  assert.equal(rebuilt.body.ok, true);
  assert.equal(rebuilt.body.rebuilt.length, 1);
  assert.equal(rebuilt.body.rebuilt[0].code, '600000');
  assert.equal(rebuilt.body.rebuilt[0].shares, 1000);
  assert.equal(rebuilt.body.rebuilt[0].cost_price, 10.0051);
});

test('自动化装配：archiveAutoUpdate 装每日定时器，postCloseReport 自动建任务', async () => {
  const ticks = [];
  const tasks = new Map();
  let seq = 0;
  const schedule = {
    async create(input) {
      const task = {
        id: `schedule-auto-${++seq}`,
        title: input.title,
        prompt: input.prompt,
        timing: input.timing,
        target: input.target,
        active: true,
        updatedAt: '2026-11-07T10:00:00.000Z',
      };
      tasks.set(task.id, task);
      return task;
    },
    async edit(request) {
      const task = tasks.get(request.id);
      if (request.action === 'delete') {
        tasks.delete(request.id);
        return { id: request.id, deleted: true };
      }
      Object.assign(task, request.patch ?? {});
      return task;
    },
    async list() {
      return [...tasks.values()];
    },
  };

  const ledger = join(mkdtempSync(join(tmpdir(), 'dsh-astock-test-')), 'ledger.sqlite');
  const { ctx } = fakeCtx({ schedule });
  ctx.interval = (fn) => {
    ticks.push(fn);
    return () => {};
  };
  ctx.timeout = () => () => {};

  apply(ctx, {
    ledgerPath: ledger,
    dailyArchive: true,
    postCloseReport: true,
  });

  // 邮件探测 + 每日维护各一个 interval
  assert.equal(ticks.length, 2);
  // report.ensure 是异步的（不能阻塞插件激活），等一个微任务
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(tasks.size, 1);
  assert.equal([...tasks.values()][0].title, 'A股盘后报告');
});

test('自动化装配：dailyArchive=false 时不装每日定时器', () => {
  const ticks = [];
  const ledger = join(mkdtempSync(join(tmpdir(), 'dsh-astock-test-')), 'ledger.sqlite');
  const { ctx } = fakeCtx();
  ctx.interval = (fn) => {
    ticks.push(fn);
    return () => {};
  };
  ctx.timeout = () => () => {};

  apply(ctx, { ledgerPath: ledger, dailyArchive: false });
  // 只剩邮件探测那一个 interval
  assert.equal(ticks.length, 1);
});

test('盘后报告：report_on 创建独立会话任务，report_off 删除', async () => {
  const tasks = new Map();
  let seq = 0;
  const schedule = {
    async create(input) {
      const task = {
        id: `schedule-${++seq}`,
        title: input.title,
        prompt: input.prompt,
        timing: input.timing,
        target: input.target,
        active: true,
        scheduledAtLocal: '2026-11-09T15:05:00+08:00',
        updatedAt: '2026-11-07T10:00:00.000Z',
      };
      tasks.set(task.id, task);
      return task;
    },
    async edit(request) {
      if (request.action === 'delete') {
        tasks.delete(request.id);
        return { id: request.id, deleted: true };
      }
      const task = tasks.get(request.id);
      Object.assign(task, request.patch ?? {});
      return task;
    },
    async list() {
      return [...tasks.values()];
    },
  };

  const ledger = join(mkdtempSync(join(tmpdir(), 'dsh-astock-test-')), 'ledger.sqlite');
  const { ctx, routes } = fakeCtx({ schedule });
  apply(ctx, { ledgerPath: ledger });
  const route = routes.find((r) => r.path === '/api/dsh-astock/panel');

  const on = await postRoute(route, { op: 'report_on' });
  assert.equal(on.body.ok, true);
  assert.equal(tasks.size, 1);
  const task = [...tasks.values()][0];
  assert.equal(task.title, 'A股盘后报告');
  assert.match(task.timing.cron.expression, /^5 15 \* \* 1-5$/);
  assert.equal(task.target.kind, 'new_once');
  assert.match(task.prompt, /astock_sentiment/);

  // 维护面板应能看到这条任务在运行
  const maint = await callRoute(route, '/api/dsh-astock/panel?panel=maint');
  assert.equal(maint.body.automation.report.available, true);
  assert.equal(maint.body.automation.report.active, true);

  const off = await postRoute(route, { op: 'report_off' });
  assert.equal(off.body.removed, 1);
  assert.equal(tasks.size, 0);
});

/** 本地今天（台账用本地日期，不能用 toISOString 的 UTC）。 */
function localToday() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

test('交易面板：trade_save 落账 → trade 视图可见 → trade_delete 重算持仓', async () => {
  const ledger = join(mkdtempSync(join(tmpdir(), 'dsh-astock-trade-')), 'ledger.sqlite');
  const { ctx, routes } = fakeCtx();
  apply(ctx, { ledgerPath: ledger });
  const route = routes.find((r) => r.path === '/api/dsh-astock/panel');
  assert.ok(route);

  const saved = await postRoute(route, {
    op: 'trade_save',
    side: 'buy',
    code: '600000',
    name: '浦发银行',
    price: 10,
    shares: 100,
    trade_date: localToday(),
    note: '面板录入',
  });
  assert.equal(saved.body.ok, true);
  assert.match(saved.body.message, /已录入买入/);

  const tradeView = await callRoute(route, '/api/dsh-astock/panel?panel=trade');
  assert.equal(tradeView.body.view, 'trade');
  assert.equal(tradeView.body.ok, true);
  assert.equal(tradeView.body.positions.length, 1);
  assert.equal(tradeView.body.positions[0].code, '600000');
  assert.equal(tradeView.body.positions[0].shares, 100);
  assert.equal(tradeView.body.trades.length, 1);
  const tradeId = tradeView.body.trades[0].id;
  assert.ok(tradeId > 0);

  const deleted = await postRoute(route, { op: 'trade_delete', trade_id: tradeId });
  assert.equal(deleted.body.ok, true);
  const after = await callRoute(route, '/api/dsh-astock/panel?panel=trade');
  assert.equal(after.body.positions.length, 0);
  assert.equal(after.body.trades.length, 0);
});

test('交易面板：trade_save 的校验错误会变成可读消息，而不是 500', async () => {
  const ledger = join(mkdtempSync(join(tmpdir(), 'dsh-astock-trade-')), 'ledger.sqlite');
  const { ctx, routes } = fakeCtx();
  apply(ctx, { ledgerPath: ledger });
  const route = routes.find((r) => r.path === '/api/dsh-astock/panel');

  const badSide = await postRoute(route, { op: 'trade_save', side: 'hold', code: '600000', price: 10, shares: 100 });
  assert.equal(badSide.body.ok, false);
  assert.match(badSide.body.message, /buy|sell/);

  const noPosition = await postRoute(route, {
    op: 'trade_save', side: 'sell', code: '600000', price: 10, shares: 100, trade_date: localToday(),
  });
  assert.equal(noPosition.body.ok, false);
  assert.match(noPosition.body.message, /无持仓/);
});

test('交易面板：plan_cancel 把待触发事件单标成 cancelled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-astock-trade-'));
  const ledger = join(dir, 'ledger.sqlite');
  const { ctx, routes } = fakeCtx();
  apply(ctx, { ledgerPath: ledger });
  const route = routes.find((r) => r.path === '/api/dsh-astock/panel');

  const { Ledger } = await import('../lib/js/ledger.js');
  const store = new Ledger(ledger);
  const plan = store.savePlan({
    code: '600000', name: '浦发银行', side: 'sell', price: 9.2, shares: 100,
    stop_loss: 9.2, reason: '条件单参数', kind: 'conditional_order',
  });

  const view = await callRoute(route, '/api/dsh-astock/panel?panel=trade');
  assert.equal(view.body.plans.length, 1);
  assert.equal(view.body.plans[0].plan_id, plan.plan_id);

  const cancelled = await postRoute(route, { op: 'plan_cancel', plan_id: plan.plan_id });
  assert.equal(cancelled.body.ok, true);
  assert.equal(cancelled.body.plan.status, 'cancelled');

  const after = await callRoute(route, '/api/dsh-astock/panel?panel=trade');
  assert.equal(after.body.plans.length, 0);
});

test('交易面板：流水与事件单都按服务端分页返回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-astock-trade-'));
  const ledger = join(dir, 'ledger.sqlite');
  const { ctx, routes } = fakeCtx();
  apply(ctx, { ledgerPath: ledger });
  const route = routes.find((r) => r.path === '/api/dsh-astock/panel');

  // 25 笔流水：第一页 20、第二页 5
  for (let i = 0; i < 25; i += 1) {
    const saved = await postRoute(route, {
      op: 'trade_save', side: 'buy', code: '600000', price: 10, shares: 100,
      trade_date: localToday(),
    });
    assert.equal(saved.body.ok, true);
  }
  const first = await callRoute(route, '/api/dsh-astock/panel?panel=trade');
  assert.equal(first.body.trades.length, 20);
  assert.deepEqual(first.body.tradesPage, { page: 1, pages: 2, total: 25, size: 20 });

  const second = await callRoute(route, '/api/dsh-astock/panel?panel=trade&trade_page=2');
  assert.equal(second.body.trades.length, 5);
  assert.equal(second.body.tradesPage.page, 2);

  // 页码越界时夹到最后一页，不返回空页
  const clamped = await callRoute(route, '/api/dsh-astock/panel?panel=trade&trade_page=99');
  assert.equal(clamped.body.tradesPage.page, 2);
  assert.equal(clamped.body.trades.length, 5);

  // 10 张待触发事件单：每页 8，第二页 2
  const { Ledger } = await import('../lib/js/ledger.js');
  const store = new Ledger(ledger);
  for (let i = 0; i < 10; i += 1) {
    store.savePlan({
      plan_id: `P20261109-${i + 1}`,
      code: '600000', name: '浦发银行', side: 'sell', price: 9.2, shares: 100,
      stop_loss: 9.2, reason: '分页测试', kind: 'conditional_order',
    });
  }
  const plansFirst = await callRoute(route, '/api/dsh-astock/panel?panel=trade');
  assert.equal(plansFirst.body.plans.length, 8);
  assert.deepEqual(plansFirst.body.plansPage, { page: 1, pages: 2, total: 10, size: 8 });
  const plansSecond = await callRoute(route, '/api/dsh-astock/panel?panel=trade&plan_page=2');
  assert.equal(plansSecond.body.plans.length, 2);
  assert.equal(plansSecond.body.plansPage.page, 2);
});
