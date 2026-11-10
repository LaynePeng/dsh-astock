/**
 * 宿主侧能力（面板 / 维护 / 邮件）的单元测试。
 *
 * 这一层是「去 Python 化」最后搬过来的：导出导入、备份恢复、数据自愈、
 * 面板数据整形、邮件渲染与判定。它们不联网（除了明确标注的那几条），
 * 所以可以在 CI 里稳定跑。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Ledger } from '../lib/js/ledger.js';
import { Archive } from '../lib/js/archive.js';
import * as maintenance from '../lib/js/maintenance.js';
import * as panel from '../lib/js/panel.js';
import * as notify from '../lib/js/notify.js';
import * as alerts from '../lib/js/alerts.js';
import * as smtp from '../lib/js/smtp.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-astock-host-'));
}

function makeLedger(dir = tempDir()) {
  return new Ledger(join(dir, 'ledger.sqlite'), {});
}

// ────────────────────────────────────────────── 导出

test('导出台账 JSON：格式标记 + 费用明细解析成对象', () => {
  const ledger = makeLedger();
  ledger.recordTrade('600000', 'buy', 10, 1000, { tradeDate: '2026-01-05', name: '浦发银行' });
  const payload = maintenance.exportPayload(ledger, 'ledger.json');
  assert.equal(payload.ok, true);
  assert.match(payload.filename, /^astock-ledger-\d{8}-\d{6}\.json$/);
  const body = JSON.parse(payload.content);
  assert.equal(body.format, maintenance.EXPORT_FORMAT);
  assert.equal(body.positions.length, 1);
  assert.equal(body.trades.length, 1);
  assert.equal(typeof body.trades[0].fee_detail, 'object');
});

test('导出成交 CSV：带 BOM、中文表头、CRLF（Excel 双击不乱码）', () => {
  const ledger = makeLedger();
  ledger.recordTrade('600000', 'buy', 10, 1000, { tradeDate: '2026-01-05' });
  const payload = maintenance.exportPayload(ledger, 'trades.csv');
  assert.equal(payload.ok, true);
  assert.ok(payload.content.startsWith('\ufeff'));
  assert.match(payload.content, /成交日期,代码,名称,方向/);
  assert.ok(payload.content.includes('\r\n'));
  assert.match(payload.content, /买入/);
});

// ────────────────────────────────────────────── 导入

test('导入解析：缺表头 / 日期坏 / 方向坏都明确报错，不猜', () => {
  const missing = maintenance.parseTradeRows('代码,价格\n600000,10');
  assert.deepEqual(missing.rows, []);
  assert.match(missing.errors[0], /表头缺少/);

  const badDate = maintenance.parseTradeRows(
    '成交日期,代码,方向,成交价,数量\n2026-13-40,600000,买入,10,1000',
  );
  assert.equal(badDate.rows.length, 0);
  assert.match(badDate.errors[0], /日期格式无法识别/);

  const badSide = maintenance.parseTradeRows(
    '成交日期,代码,方向,成交价,数量\n2026-01-05,600000,转账,10,1000',
  );
  assert.equal(badSide.rows.length, 0);
  assert.match(badSide.errors[0], /方向只能是/);
});

test('导入解析：中文表头、8 位日期、引号字段、千分位都能吃', () => {
  const text = [
    '成交日期,代码,方向,成交价,数量,费用,备注',
    '20260105,600000,买入,10.5,"1,000","5.1","备注,含逗号"',
  ].join('\n');
  const { rows, errors } = maintenance.parseTradeRows(text);
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].trade_date, '2026-01-05');
  assert.equal(rows[0].price, 10.5);
  assert.equal(rows[0].shares, 1000);
  assert.equal(rows[0].fee, 5.1);
  assert.equal(rows[0].note, '备注,含逗号');
});

test('导入预览：重复行标 duplicate，且不参与后续持仓推演', () => {
  const ledger = makeLedger();
  ledger.recordTrade('600000', 'buy', 10, 1000, { tradeDate: '2026-01-05' });
  const text = [
    '成交日期,代码,方向,成交价,数量',
    '2026-01-05,600000,买入,10,1000',
    '2026-01-06,600000,卖出,11,1500',
  ].join('\n');
  const preview = maintenance.importTrades(ledger, text, false);
  assert.equal(preview.committed, false);
  assert.equal(preview.summary.duplicate, 1);
  // 卖出 1500 > 1000：按「重复行被跳过」推演，所以必须报可卖不足
  assert.equal(preview.summary.error, 1);
  assert.match(preview.rows[1].problems.join('；'), /可卖数量不足/);
});

test('导入落账：按日期排序回放，重复行跳过，成本按加权摊费', () => {
  const ledger = makeLedger();
  const text = [
    '成交日期,代码,方向,成交价,数量,费用',
    '2026-01-06,600000,买入,11,1000,5',
    '2026-01-05,600000,买入,10,1000,5',
  ].join('\n');
  const result = maintenance.importTrades(ledger, text, true);
  assert.equal(result.ok, true);
  assert.equal(result.summary.applied, 2);
  const pos = ledger.listPositions()[0];
  assert.equal(pos.shares, 2000);
  // (10*1000+5 + 11*1000+5) / 2000 = 10.505
  assert.equal(pos.cost_price, 10.505);

  // 再导一次：全部按重复跳过
  const again = maintenance.importTrades(ledger, text, true);
  assert.equal(again.summary.applied, 0);
  assert.equal(again.summary.skipped, 2);
});

// ────────────────────────────────────────────── 数据自愈

test('数据自愈：按全部流水重放，重建持仓与移动加权成本', () => {
  const ledger = makeLedger();
  ledger.recordTrade('600000', 'buy', 10, 1000, { tradeDate: '2026-01-05' });
  ledger.recordTrade('600000', 'buy', 12, 1000, { tradeDate: '2026-01-06' });
  ledger.recordTrade('600000', 'sell', 15, 500, { tradeDate: '2026-01-07' });
  const result = maintenance.rebuildPositions(ledger);
  assert.equal(result.ok, true);
  assert.equal(result.rebuilt.length, 1);
  assert.equal(result.rebuilt[0].shares, 1500);
  // 卖出不改成本价：两次买入后的成本价保持
  const expected = ledger.listPositions()[0].cost_price;
  assert.equal(result.rebuilt[0].cost_price, expected);
  assert.deepEqual(result.untouched, []);
});

test('数据自愈：只有持仓没有流水的标的原样保留', () => {
  const ledger = makeLedger();
  ledger.recordTrade('600000', 'buy', 10, 1000, { tradeDate: '2026-01-05' });
  // 手工塞一条没有流水的持仓（模拟历史手工维护）
  ledger._db((db) => {
    db.prepare(
      'INSERT INTO positions(code, name, shares, cost_price, opened_at, updated_at)'
      + ' VALUES (?,?,?,?,?,?)',
    ).run('000001', '平安银行', 500, 9.9, '2025-01-01', '2025-01-01');
  });
  const result = maintenance.rebuildPositions(ledger);
  assert.deepEqual(result.untouched, ['000001']);
  assert.equal(ledger.listPositions().length, 2);
});

// ────────────────────────────────────────────── 备份

test('备份：VACUUM INTO 出的是完整快照，恢复后流水还在', () => {
  const dir = tempDir();
  const ledger = new Ledger(join(dir, 'ledger.sqlite'), {});
  ledger.recordTrade('600000', 'buy', 10, 1000, { tradeDate: '2026-01-05' });
  const archive = new Archive(join(dir, 'archive.sqlite'));

  const created = maintenance.createBackup({ ledger, archive });
  assert.equal(created.ok, true);
  assert.ok(created.files.some((item) => item.label === 'ledger'));

  ledger.recordTrade('600000', 'sell', 11, 500, { tradeDate: '2026-01-06' });
  assert.equal(ledger.listPositions()[0].shares, 500);

  const restored = maintenance.restoreBackup({ ledger, archive }, created.name);
  assert.equal(restored.ok, true);
  assert.deepEqual(restored.restored.sort(), ['archive', 'ledger']);
  assert.equal(ledger.listPositions()[0].shares, 1000);
});

test('备份列表：按名字倒序、limit 生效、坏 meta 不炸', () => {
  const dir = tempDir();
  const ledger = new Ledger(join(dir, 'ledger.sqlite'), {});
  ledger.recordTrade('600000', 'buy', 10, 100, { tradeDate: '2026-01-05' });
  const archive = new Archive(join(dir, 'archive.sqlite'));

  const first = maintenance.createBackup({ ledger, archive });
  // 关掉 60 秒节流，才能测「同一秒内两份名字不同」
  const second = maintenance.createBackup({ ledger, archive, minIntervalMs: 0 });
  // 同一秒内两次：第二份带 pid 后缀，名字不同
  assert.notEqual(first.name, second.name);

  const list = maintenance.listBackups(ledger.path, 1);
  assert.equal(list.length, 1);
  assert.ok(list[0].sizeBytes > 0);

  writeFileSync(join(maintenance.backupRoot(ledger.path), first.name, 'meta.json'), '{坏 JSON');
  const again = maintenance.listBackups(ledger.path, 10);
  assert.equal(again.length, 2);
});

// ────────────────────────────────────────────── 净值曲线

test('净值曲线：按日期升序、坏行跳过（同日多条由写入侧去重）', () => {
  const dir = tempDir();
  const ledger = new Ledger(join(dir, 'ledger.sqlite'), {});
  const file = maintenance.equityPath(ledger.path);
  writeFileSync(file, [
    '{"date":"2026-01-06","equity":101000}',
    '不是 JSON',
    '{"date":"2026-01-05","equity":100000}',
  ].join('\n'), 'utf8');
  const curve = maintenance.readEquityCurve(ledger.path, 10);
  assert.deepEqual(curve.map((item) => item.date), ['2026-01-05', '2026-01-06']);
  assert.equal(curve[1].equity, 101000);
});

// ────────────────────────────────────────────── 面板

test('面板：持仓视图字段齐全，缺行情时不编数字', async () => {
  const ledger = makeLedger();
  ledger.recordTrade('600000', 'buy', 10, 1000, { tradeDate: '2026-01-05' });
  ledger.setCash(5000);
  const data = await panel.buildPortfolio({
    ledger,
    config: { stop_loss_pct: 8, take_profit_pct: 15, position_cap_pct: 25 },
    // 行情取不到：snapshot 会用成本价兜底，index 取不到给空对象
    fetchQuotes: async () => [],
  });
  assert.equal(data.ok, true);
  assert.equal(data.empty, false);
  assert.equal(data.positions.length, 1);
  assert.equal(data.positions[0].code, '600000');
  assert.equal(data.positions[0].shares, 1000);
  assert.equal(data.positions[0].cost, 10.005);
  assert.deepEqual(data.index, {});
  assert.equal(data.limits.stopLossPct, 8);
  assert.equal(data.kpis.length, 6);
});

test('面板：空台账给出 empty 标记而不是报错', async () => {
  const ledger = makeLedger();
  const data = await panel.buildPortfolio({
    ledger, config: {}, fetchQuotes: async () => [],
  });
  assert.equal(data.ok, true);
  assert.equal(data.empty, true);
  assert.deepEqual(data.positions, []);
});

test('面板：选股视图把三套策略都列出来，标出默认策略', async () => {
  const ledger = makeLedger();
  ledger.setCash(100000);
  const fakeScan = async () => ({
    momentum: {
      scanned: 100,
      candidates: 3,
      cached: true,
      cache_age_sec: 12,
      allocations: [{
        code: '600000', name: '浦发银行', price: 10, score: 88.5,
        shares: 1000, amount: 10000, weight_pct: 10, stop_loss: 9.2, take_profit: 11.5,
      }],
    },
    reversal: { scanned: 100, candidates: 1, allocations: [] },
    quality: { scanned: 100, candidates: 2, allocations: [] },
  });
  const data = await panel.buildPick({
    ledger, config: { pick_strategy: 'quality' }, scanAll: fakeScan,
  });
  assert.equal(data.ok, true);
  assert.equal(data.strategies.length, 3);
  assert.equal(data.defaultStrategy, 'quality');
  assert.equal(data.strategies.find((s) => s.isDefault).key, 'quality');
  const momentum = data.strategies.find((s) => s.key === 'momentum');
  assert.equal(momentum.items[0].stopLoss, 9.2);
  assert.match(data.disclaimer, /不是上涨概率/);
});

test('面板：选股失败给出可行动提示而不是白屏', async () => {
  const ledger = makeLedger();
  const data = await panel.buildPick({
    ledger,
    config: {},
    scanAll: async () => {
      throw new Error('接口限流');
    },
  });
  assert.equal(data.ok, false);
  assert.match(data.error, /选股失败/);
  assert.match(data.hint, /限流/);
});

// ────────────────────────────────────────────── 邮件渲染与判定

test('邮件渲染：主题带级别与前三只，正文含建议与免责声明', () => {
  const entries = [
    {
      code: '600000', name: '浦发银行', severity: 'urgent', title: '触发止损',
      detail: '现价 9.20，成本 10.00', suggestion: '卖出 1000 股',
    },
    {
      code: '000001', name: '平安银行', severity: 'action', title: '放量',
    },
  ];
  const { subject, text } = notify.renderMail(entries, '2026-01-05 10:00');
  assert.match(subject, /^\[A股助手\]🔴 紧急 浦发银行、平安银行/);
  assert.match(text, /盯盘发现 2 条信号/);
  assert.match(text, /→ 卖出 1000 股/);
  assert.match(text, /不构成投资建议/);
  const html = notify.renderMailHtml(entries, '2026-01-05 10:00');
  assert.match(html, /border-left:4px solid #d93025/);
  assert.match(html, /<h3/);
});

test('去重：同一信号 6 小时内只放行一次，落盘后重启仍然记得', () => {
  const dir = tempDir();
  const file = join(dir, 'mail-state.json');
  const first = new notify.Notifier(file);
  assert.equal(first.shouldSend('600000', 'stop_loss').sendable, true);
  first.markSent('600000', 'stop_loss');
  assert.equal(first.shouldSend('600000', 'stop_loss').sendable, false);
  // 换一个实例（模拟进程重启）
  const second = new notify.Notifier(file);
  assert.equal(second.shouldSend('600000', 'stop_loss').sendable, false);
  // 不同 kind 不受影响
  assert.equal(second.shouldSend('600000', 'take_profit').sendable, true);
});

test('邮件判定：未启用时直接跳过，不碰行情', async () => {
  const ledger = makeLedger();
  const result = await alerts.runOnce(ledger, { mail_enabled: false });
  assert.equal(result.ok, true);
  assert.equal(result.sent, false);
  assert.match(result.skipped, /未启用/);
});

test('邮件状态：不回显密码；收件人留空时回落到发给自己', () => {
  const status = alerts.status({
    mail_enabled: true,
    mail_host: 'smtp.qq.com',
    mail_username: 'me@qq.com',
    mail_password: 'secret',
  });
  assert.equal(status.ready, true);
  assert.deepEqual(status.recipients, ['me@qq.com']);
  assert.equal(status.password, undefined);
  assert.equal(status.host, 'smtp.qq.com');

  // 没有账号时无法发信，原因要能指到「填哪里」
  const empty = alerts.status({ mail_enabled: true, mail_host: 'smtp.qq.com' });
  assert.equal(empty.ready, false);
  assert.match(empty.reason, /账号/);
});

test('SMTP：配置不全时不连接，直接给出原因', async () => {
  const result = await smtp.sendMail({ enabled: false }, { subject: 'x', text: 'y' });
  assert.equal(result.ok, false);
  assert.match(result.message, /未启用/);
});

test('SMTP：MIME 主题按 RFC 2047 编码，正文 base64 折行', () => {
  const message = smtp.buildMessage({
    from: 'me@qq.com',
    to: ['you@qq.com'],
    subject: '[A股助手] 测试',
    text: '正文',
  });
  assert.match(message, /^From: =\?UTF-8\?B\?/m);
  assert.match(message, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(message, /Content-Transfer-Encoding: base64/);
  const body = message.split('\r\n\r\n').pop();
  assert.ok(body.length > 0);
  assert.ok(body.split('\r\n').every((line) => line.length <= 76));
});

test('SMTP：DATA 阶段点转义（行首 . 变 ..）', () => {
  assert.equal(smtp.dotStuff('a\r\n.b\r\n..c'), 'a\r\n..b\r\n...c');
});

test('SMTP 协议状态机：对本地假服务器走完 EHLO/AUTH/MAIL/RCPT/DATA/QUIT', async () => {
  const received = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let authStep = 0;
    let inData = false;
    socket.write('220 fake.local ESMTP ready\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\r\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 2.0.0 queued\r\n');
          } else {
            received.push(line);
          }
        } else if (authStep === 1) {
          authStep = 2;
          socket.write('334 UGFzc3dvcmQ6\r\n');
        } else if (authStep === 2) {
          authStep = 3;
          socket.write('235 2.7.0 accepted\r\n');
        } else if (line.startsWith('EHLO')) {
          socket.write('250-fake.local\r\n250 AUTH LOGIN PLAIN\r\n');
        } else if (line === 'AUTH LOGIN') {
          authStep = 1;
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (line.startsWith('MAIL FROM')) {
          socket.write('250 2.1.0 ok\r\n');
        } else if (line.startsWith('RCPT TO')) {
          socket.write('250 2.1.5 ok\r\n');
        } else if (line === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (line === 'QUIT') {
          socket.write('221 bye\r\n');
        }
        index = buffer.indexOf('\r\n');
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  let conn = null;
  try {
    const socket = await new Promise((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1', () => resolve(s));
      s.once('error', reject);
    });
    conn = new smtp.SmtpConnection(socket, { timeoutMs: 3000 });

    await conn.command('', [220]);
    await conn.command('EHLO test.local', [250]);
    await conn.command('AUTH LOGIN', [334]);
    await conn.command(Buffer.from('me@qq.com').toString('base64'), [334]);
    await conn.command(Buffer.from('secret').toString('base64'), [235]);
    await conn.command('MAIL FROM:<me@qq.com>', [250]);
    await conn.command('RCPT TO:<you@qq.com>', [250]);
    await conn.command('DATA', [354]);
    // 与 sendMail 一致：DATA 前先做点转义
    await conn.command(`${smtp.dotStuff('Subject: hi\r\n\r\nbody\r\n.leading dot')}\r\n.`, [250]);
    await conn.command('QUIT', [221]);
  } finally {
    conn?.close();
    await new Promise((resolve) => server.close(resolve));
  }

  assert.ok(received.some((line) => line.includes('Subject: hi')));
  // 点转义：以 . 开头的行必须变成 ..
  assert.ok(received.includes('..leading dot'));
});

// ────────────────────────────────────────────── 维护面板

test('维护面板：不联网也能给出存档/备份/台账/净值', () => {
  const dir = tempDir();
  const ledger = new Ledger(join(dir, 'ledger.sqlite'), {});
  ledger.recordTrade('600000', 'buy', 10, 100, { tradeDate: '2026-01-05' });
  const archive = new Archive(join(dir, 'archive.sqlite'));
  const data = maintenance.maintPayload({ ledger, archive, config: { pick_strategy: 'momentum' } });
  assert.equal(data.ok, true);
  assert.equal(data.view, 'maint');
  assert.equal(data.ledger.positions, 1);
  assert.equal(data.ledger.trades, 1);
  assert.equal(data.archive.codes, 0);
  assert.deepEqual(data.equity.curve, []);
  assert.equal(data.paths.ledger, ledger.path);
  assert.match(data.disclaimer, /不是单只股票上涨的概率/);
});

test('回测落盘：写入后能读回，坏文件返回 null', () => {
  const dir = tempDir();
  const ledger = new Ledger(join(dir, 'ledger.sqlite'), {});
  const payload = { strategy: 'momentum', label: '趋势动量', winRate: 60 };
  assert.equal(maintenance.readBacktestResult(ledger.path), null);
  maintenance.persistBacktest(ledger.path, payload);
  assert.deepEqual(maintenance.readBacktestResult(ledger.path), payload);
  writeFileSync(maintenance.backtestPath(ledger.path), '{坏');
  assert.equal(maintenance.readBacktestResult(ledger.path), null);
});

test('CSV 导出能被自己的导入器读回去（round-trip）', () => {
  const ledger = makeLedger();
  ledger.recordTrade('600000', 'buy', 10, 1000, {
    tradeDate: '2026-01-05', name: '浦发银行', note: '含,逗号',
  });
  const csv = maintenance.exportPayload(ledger, 'trades.csv').content;
  const { rows, errors } = maintenance.parseTradeRows(csv);
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].trade_date, '2026-01-05');
  assert.equal(rows[0].side, 'buy');
  assert.equal(rows[0].shares, 1000);
  assert.equal(rows[0].note, '含,逗号');
});

test('导出 JSON 可读回：cash / positions / trades 都在', () => {
  const ledger = makeLedger();
  ledger.setCash(12345.67);
  ledger.recordTrade('600000', 'buy', 10, 1000, { tradeDate: '2026-01-05' });
  const content = maintenance.exportPayload(ledger, 'ledger.json').content;
  const body = JSON.parse(content);
  assert.equal(body.cash, 12345.67);
  assert.equal(body.positions.length, 1);
  assert.equal(body.trades.length, 1);
  // 文件本身也应是合法 UTF-8（写完能被自己的 readFileSync 读回）
  const dir = tempDir();
  const file = join(dir, 'x.json');
  writeFileSync(file, content, 'utf8');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).format, maintenance.EXPORT_FORMAT);
});
