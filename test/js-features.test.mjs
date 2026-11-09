/**
 * 新增能力的测试：设置存储 / OAuth / 台账 JSON 导入 / 自选导入 / 盘后复盘 / 选股缓存。
 *
 * 全部不联网（OAuth 用本地假 token 端点），可稳定跑在 CI 里。
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Ledger } from '../lib/js/ledger.js';
import * as settings from '../lib/js/settings.js';
import * as oauth from '../lib/js/oauth.js';
import * as maintenance from '../lib/js/maintenance.js';
import * as pickCache from '../lib/js/pick-cache.js';
import * as alerts from '../lib/js/alerts.js';
import * as report from '../lib/js/report.js';
import * as smtp from '../lib/js/smtp.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-astock-feat-'));
}

function makeLedger(dir = tempDir()) {
  return new Ledger(join(dir, 'ledger.sqlite'), {});
}

// ────────────────────────────────────────────── 设置存储

test('设置：保存/读取/脱敏，空字符串表示清除', () => {
  const dir = tempDir();
  const ledgerPath = join(dir, 'ledger.sqlite');
  const saved = settings.saveSettings(ledgerPath, {
    mail_enabled: true,
    mail_host: 'smtp.qq.com',
    mail_port: '587',
    mail_password: 'secret',
  });
  assert.equal(saved.ok, true);
  assert.ok(saved.saved.includes('mail_host'));

  const loaded = settings.loadSettings(ledgerPath);
  assert.equal(loaded.mail_enabled, true);
  assert.equal(loaded.mail_port, 587); // 字符串被转成数字
  assert.equal(loaded.mail_password, 'secret');

  const masked = settings.maskedValues(loaded);
  assert.equal(masked.mail_password, '******');
  assert.equal(masked.mail_host, 'smtp.qq.com');

  // 空字符串 = 清除该键（回落到宿主配置/默认）
  settings.saveSettings(ledgerPath, { mail_password: '' });
  assert.equal(settings.loadSettings(ledgerPath).mail_password, undefined);
});

test('设置：settingsToAstock 只透传认识的键，并按服务商推导发信参数', () => {
  const mapped = settings.settingsToAstock({
    mail_host: 'smtp.163.com',
    report_email: true,
    report_email_top: 5,
    unknown_key: 'x',
  });
  // 旧配置没有 mail_preset：按已填的服务器反推出 163，参数随之确定
  assert.equal(mapped.mail_preset, '163');
  assert.equal(mapped.mail_host, 'smtp.163.com');
  assert.equal(mapped.mail_port, 465);
  assert.equal(mapped.mail_auth, 'basic');
  assert.equal(mapped.report_email, true);
  assert.equal(mapped.report_email_top, 5);
  assert.equal(mapped.unknown_key, undefined);

  // Outlook 预设：认证方式固定 OAuth2，服务器 587 + STARTTLS
  const outlook = settings.settingsToAstock({ mail_preset: 'outlook' });
  assert.equal(outlook.mail_auth, 'oauth2');
  assert.equal(outlook.mail_host, 'smtp-mail.outlook.com');
  assert.equal(outlook.mail_port, 587);
  assert.equal(outlook.mail_secure, false);

  // 自定义服务商：保留手填值，认证方式可切换
  const custom = settings.settingsToAstock({
    mail_preset: 'custom', mail_auth: 'oauth2', mail_host: 'smtp.example.com', mail_port: 2525,
  });
  assert.equal(custom.mail_auth, 'oauth2');
  assert.equal(custom.mail_host, 'smtp.example.com');
  assert.equal(custom.mail_port, 2525);
});

test('设置：字段表覆盖邮件与盘后报告，且都有中文说明', () => {
  const fields = settings.fieldSpecs();
  const keys = fields.map((field) => field.key);
  for (const key of ['mail_enabled', 'mail_auth', 'mail_host', 'mail_password', 'report_email']) {
    assert.ok(keys.includes(key), `缺字段 ${key}`);
  }
  for (const field of fields) {
    assert.ok(field.label && field.label.length >= 2);
    assert.ok(field.hint && field.hint.length >= 4);
  }
});

// ────────────────────────────────────────────── OAuth

test('OAuth：默认用内置公共客户端与 common 租户（个人/组织都能授权）', () => {
  const cfg = oauth.oauthConfig({});
  assert.equal(cfg.provider, 'outlook');
  assert.equal(cfg.tenant, 'common');
  assert.equal(cfg.clientId, oauth.PUBLIC_CLIENT_IDS.outlook);
  assert.match(cfg.tokenUrl, /login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/token/);
  assert.equal(cfg.smtp.host, 'smtp-mail.outlook.com');
  assert.equal(cfg.smtp.port, 587);
});

test('OAuth：租户填了邮箱会被纠正（避免 AADSTS900023）', () => {
  const cfg = oauth.oauthConfig({ oauth_tenant: 'me@outlook.com' });
  assert.equal(cfg.tenant, 'common');
  assert.equal(cfg.tenantFixed, true);
});

test('OAuth：错误码翻成人话', () => {
  assert.match(
    oauth.explainOAuthError({ error: 'invalid_grant', error_description: 'AADSTS70000: nope' }, 400),
    /授权被拒|AADSTS70000/,
  );
  assert.match(oauth.explainOAuthError({ error: 'authorization_pending' }, 400), /等待/);
  assert.match(oauth.explainOAuthError({ error: 'expired_token' }, 400), /过期/);
  assert.match(
    oauth.explainOAuthError({ error_description: 'AADSTS900023: bad tenant' }, 400),
    /租户/,
  );
});

test('OAuth：设备码授权 → 轮询 → 拿 refresh_token（本地假端点）', async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      if (req.url === '/devicecode') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          device_code: 'dev-1', user_code: 'ABCD-EFGH',
          verification_uri: 'https://microsoft.com/devicelogin',
          expires_in: 900, interval: 5,
        }));
        return;
      }
      if (params.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600,
        }));
        return;
      }
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_request' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const own = {
    mail_provider: 'custom',
    oauth_client_id: 'client-1',
    oauth_devicecode_endpoint: `http://127.0.0.1:${port}/devicecode`,
    oauth_token_endpoint: `http://127.0.0.1:${port}/token`,
  };
  try {
    const started = await oauth.startDeviceCode(own);
    assert.equal(started.ok, true);
    assert.equal(started.userCode, 'ABCD-EFGH');
    assert.equal(started.verificationUri, 'https://microsoft.com/devicelogin');

    const polled = await oauth.pollDeviceCode(own, started.deviceCode);
    assert.equal(polled.status, 'done');
    assert.equal(polled.refreshToken, 'rt-1');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ────────────────────────────────────────────── 邮件配置与发信

test('邮件：OAuth2 模式自动套用 Outlook 的 SMTP 预设', () => {
  const cfg = alerts.mailConfig({ mail_enabled: true, mail_auth: 'oauth2', mail_username: 'me@outlook.com' });
  assert.equal(cfg.auth, 'oauth2');
  assert.equal(cfg.host, 'smtp-mail.outlook.com');
  assert.equal(cfg.port, 587);
  assert.equal(cfg.secure, false);
  assert.equal(cfg.password, '');
});

test('邮件：OAuth2 未授权时给出可操作原因', () => {
  const cfg = alerts.mailConfig({ mail_enabled: true, mail_auth: 'oauth2', mail_username: 'me@outlook.com' });
  const ready = alerts.mailReady(cfg);
  assert.equal(ready.ready, false);
  assert.match(ready.reason, /授权/);
});

test('SMTP：OAuth2 没有 access_token 时直接拒绝（不连服务器）', async () => {
  const result = await smtp.sendMail({
    enabled: true,
    auth: 'oauth2',
    host: 'smtp-mail.outlook.com',
    port: 587,
    secure: false,
    username: 'me@outlook.com',
    sender: 'me@outlook.com',
    recipients: ['me@outlook.com'],
  }, { subject: 'x', text: 'y' });
  assert.equal(result.ok, false);
  assert.match(result.message, /access_token/);
});

test('邮件：OAuth2 发信会先换 token 再走 XOAUTH2（假 token 端点 + 假发信）', async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      if (params.get('grant_type') === 'refresh_token') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'at-xyz', expires_in: 3600 }));
        return;
      }
      res.writeHead(400);
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const cfg = alerts.mailConfig({
      mail_enabled: true,
      mail_auth: 'oauth2',
      mail_username: 'me@outlook.com',
      oauth_client_id: 'client-1',
      oauth_token_endpoint: `http://127.0.0.1:${port}/token`,
      oauth_refresh_token: 'rt-1',
    });
    const calls = [];
    const sent = await alerts.deliver(cfg, { subject: 's', text: 't', html: '' }, {
      send: async (c, message) => {
        calls.push({ auth: c.auth, accessToken: message.accessToken });
        return { ok: true, message: 'sent' };
      },
    });
    assert.equal(sent.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].auth, 'oauth2');
    assert.equal(calls[0].accessToken, 'at-xyz');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ────────────────────────────────────────────── 台账 JSON 导入

test('台账 JSON：导出 → 预览 → 导入（另一个库）后资金/持仓/自选一致', () => {
  const source = makeLedger();
  source.setCash(12345.67);
  source.recordTrade('600000', 'buy', 10, 1000, { tradeDate: '2026-01-05', name: '浦发银行' });
  source.addWatch('000001', '平安银行', '观察');
  const exported = maintenance.exportPayload(source, 'ledger.json').content;

  const target = makeLedger();
  const preview = maintenance.previewLedgerImport(target, exported, { scope: 'all' });
  assert.equal(preview.ok, true);
  assert.equal(preview.positions.add.length, 1);
  assert.equal(preview.trades.new, 1);
  assert.equal(preview.watchlist.add.length, 1);

  const applied = maintenance.importLedger(target, exported, { scope: 'all' });
  assert.equal(applied.ok, true);
  assert.equal(applied.applied.trades, 1);
  assert.equal(applied.applied.watch, 1);
  assert.equal(target.listPositions()[0].shares, 1000);
  assert.equal(target.getCash().balance, 12345.67);
  assert.deepEqual(target.listWatch().map((w) => w.code), ['000001']);

  // 再导一次：成交全部按重复跳过
  const again = maintenance.importLedger(target, exported, { scope: 'all' });
  assert.equal(again.applied.trades, 0);
  assert.equal(again.applied.skipped, 1);
});

test('台账 JSON：只恢复资金与自选时不动流水与持仓', () => {
  const source = makeLedger();
  source.setCash(5000);
  source.recordTrade('600000', 'buy', 10, 100, { tradeDate: '2026-01-05' });
  source.addWatch('000001', '平安银行');
  const exported = maintenance.exportPayload(source, 'ledger.json').content;

  const target = makeLedger();
  target.recordTrade('000001', 'buy', 12, 200, { tradeDate: '2026-01-06' });
  const applied = maintenance.importLedger(target, exported, { scope: 'watch_cash' });
  assert.equal(applied.ok, true);
  assert.equal(applied.applied.trades, 0);
  assert.equal(target.listPositions()[0].code, '000001');
  assert.equal(target.listPositions()[0].shares, 200);
  assert.equal(target.getCash().balance, 5000);
  assert.deepEqual(target.listWatch().map((w) => w.code), ['000001']);
});

test('台账 JSON：坏 JSON 给出可读原因', () => {
  const ledger = makeLedger();
  const preview = maintenance.previewLedgerImport(ledger, '{坏', { scope: 'all' });
  assert.equal(preview.ok, false);
  assert.match(preview.message, /不是合法 JSON/);
});

// ────────────────────────────────────────────── 自选导入

test('自选：预览与导入（纯数组也认）', () => {
  const ledger = makeLedger();
  const text = JSON.stringify(['600000', { code: '000001', name: '平安银行', note: '观察' }]);
  const preview = maintenance.importWatchlist(ledger, text, { commit: false });
  assert.equal(preview.ok, true);
  assert.equal(preview.added.length, 2);
  assert.equal(ledger.listWatch().length, 0, '预览不能落账');

  const applied = maintenance.importWatchlist(ledger, text, { commit: true });
  assert.equal(applied.ok, true);
  assert.equal(ledger.listWatch().length, 2);
  const pingan = ledger.listWatch().find((w) => w.code === '000001');
  assert.equal(pingan.name, '平安银行');
});

// ────────────────────────────────────────────── 盘后复盘

test('盘后复盘：账户、持仓、信号、舆情都进正文与 HTML', async () => {
  const ledger = makeLedger();
  const snap = {
    data: {
      positions: [
        {
          code: '600000', name: '浦发银行', shares: 1000, cost_price: 10, available_today: 1000,
        },
      ],
      quotes: {
        '600000': { code: '600000', name: '浦发银行', price: 9, prev_close: 9.5, change_pct: -5 },
      },
      total_market_value: 9000,
      equity: 29000,
      cash: 20000,
      float_pnl: -1000,
      today_pnl: -500,
      watch_count: 0,
    },
  };
  const built = await report.buildReport(ledger, { stop_loss_pct: 8 }, {
    now: new Date('2026-11-09T07:00:00Z'),
    snapshot: async () => snap,
    indexQuote: async () => ({ name: '上证指数', price: 3649.18, changePct: -1.1 }),
    collectSentiment: async (code, name) => ({
      code, name, items: [], errors: {}, extras: {},
    }),
  });
  assert.equal(built.ok, true);
  assert.match(built.subject, /盘后复盘/);
  assert.match(built.text, /总资产/);
  assert.match(built.text, /600000/);
  assert.match(built.text, /上证指数/);
  assert.match(built.text, /不构成投资建议/);
  assert.match(built.html, /<table/);
  assert.equal(built.summary.positions, 1);
});

test('盘后复盘：邮件未就绪时不发信，返回原因', async () => {
  const ledger = makeLedger();
  const result = await report.sendReport(ledger, { mail_enabled: false });
  assert.equal(result.ok, false);
  assert.match(result.message, /未启用/);
});

test('盘后复盘：配置就绪时调用发信通道', async () => {
  const ledger = makeLedger();
  const cfg = {
    mail_enabled: true,
    mail_host: 'smtp.qq.com',
    mail_port: 465,
    mail_secure: true,
    mail_username: 'me@qq.com',
    mail_password: 'secret',
    mail_to: 'me@qq.com',
  };
  let sentSubject = '';
  const result = await report.sendReport(ledger, cfg, {
    snapshot: async () => ({
      data: {
        positions: [], quotes: {}, total_market_value: 0, equity: 0, cash: 0,
        float_pnl: 0, today_pnl: 0, watch_count: 0,
      },
    }),
    indexQuote: async () => null,
    collectSentiment: async () => ({ items: [], errors: {}, extras: {} }),
    send: async (c, message) => {
      sentSubject = message.subject;
      return { ok: true, message: 'sent' };
    },
  });
  assert.equal(result.ok, true);
  assert.match(sentSubject, /盘后复盘/);
});

// ────────────────────────────────────────────── 选股缓存

test('选股缓存：落盘后能读回，过期或资金变化则失效', () => {
  const dir = tempDir();
  const ledgerPath = join(dir, 'ledger.sqlite');
  const results = {
    momentum: {
      strategy: 'momentum',
      strategy_label: '趋势动量',
      scanned: 100,
      candidates: 3,
      allocations: [{ code: '600000', name: '浦发银行', price: 10, shares: 100 }],
    },
  };
  pickCache.savePickCache(ledgerPath, results, { cash: 10000, equity: 20000 });
  const hit = pickCache.loadPickCache(ledgerPath, { cash: 10000, equity: 20000 });
  assert.ok(hit);
  assert.equal(hit.results.momentum.allocations[0].code, '600000');
  assert.equal(hit.results.momentum.cached, true);

  // 资金变了 → 失效（股数是按现金算的）
  assert.equal(pickCache.loadPickCache(ledgerPath, { cash: 20000, equity: 20000 }), null);

  // 文件过期 → 失效
  const file = pickCache.pickCachePath(ledgerPath);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  raw.savedAt = Date.now() - 60 * 60 * 1000;
  writeFileSync(file, JSON.stringify(raw), 'utf8');
  assert.equal(pickCache.loadPickCache(ledgerPath, { cash: 10000, equity: 20000 }), null);
});
