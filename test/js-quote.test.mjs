import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  boardOf, checkOrderSize, limitPrices, marketContext, normalizeCode,
  tradingStatus,
} from '../lib/js/market.js';
import { fmtTencentTime, parseTencentQuote } from '../lib/js/kline.js';
import { runQuote } from '../lib/js/quote-tool.js';
import { Ledger } from '../lib/js/ledger.js';

/** 造一条 50 字段的腾讯快照（只填被测字段，其余留空）。 */
function tencentFields({
  name = '浦发银行', code = '600000', price = '9.53', prev = '9.40',
  time = '20261023161458', change = '0.13', changePct = '1.38',
  high = '9.60', low = '9.35', amountWan = '123456.78', turnover = '0.42',
  floatMcap = '2800', totalMcap = '3000', limitUp = '10.34', limitDown = '8.46',
  volumeRatio = '1.23',
} = {}) {
  const f = new Array(50).fill('');
  f[0] = '1';
  f[1] = name;
  f[2] = code;
  f[3] = price;
  f[4] = prev;
  f[5] = '9.45';
  f[6] = '123456';
  f[30] = time;
  f[31] = change;
  f[32] = changePct;
  f[33] = high;
  f[34] = low;
  f[37] = amountWan;
  f[38] = turnover;
  f[39] = '5.20';
  f[43] = '2.66';
  f[44] = floatMcap;
  f[45] = totalMcap;
  f[46] = '0.55';
  f[47] = limitUp;
  f[48] = limitDown;
  f[49] = volumeRatio;
  return f;
}

test('行情解析：字段映射 / 时间格式 / 涨跌停 / 停牌兜底', () => {
  const quote = parseTencentQuote(tencentFields(), 'sh');
  assert.equal(quote.code, '600000');
  assert.equal(quote.name, '浦发银行');
  assert.equal(quote.price, 9.53);
  assert.equal(quote.change_pct, 1.38);
  assert.equal(quote.amount, 1_234_567_800);
  assert.equal(quote.total_mcap, 3_000 * 1e8);
  assert.equal(quote.trade_time, '2026-10-23 16:14:58');
  assert.equal(quote.limit_up, 10.34);
  assert.equal(quote.limit_down, 8.46);
  assert.equal(quote.board, 'main');
  assert.equal(quote.extra.price_is_prev_close, undefined);

  assert.equal(fmtTencentTime('202610231455'), '2026-10-23 14:55');
  assert.equal(fmtTencentTime(''), '');

  // 停牌/未开盘：price=0 → 用昨收，并标记
  const halted = parseTencentQuote(tencentFields({ price: '0.00' }), 'sh');
  assert.equal(halted.price, 9.4);
  assert.equal(halted.extra.price_is_prev_close, true);

  // 指数返回 -1 的涨跌停 → 视为无，不能显示 -1.00
  const index = parseTencentQuote(tencentFields({
    code: '000001', name: '上证指数', price: '3200', prev: '3180',
    limitUp: '-1', limitDown: '-1',
  }), 'sh', 'index');
  assert.equal(index.limit_up, null);
  assert.equal(index.limit_down, null);
});

test('市场规则：代码归一化 / 板块 / 涨跌停 / 数量校验', () => {
  assert.deepEqual(normalizeCode('sh600000'), { code: '600000', venue: 'sh' });
  assert.deepEqual(normalizeCode('000001.sz'), { code: '000001', venue: 'sz' });
  assert.deepEqual(normalizeCode('sz.000001'), { code: '000001', venue: 'sz' });
  assert.deepEqual(normalizeCode('000001', 'index'), { code: '000001', venue: 'sh' });
  assert.throws(() => normalizeCode('sh300001'), /不匹配/);
  assert.throws(() => normalizeCode('abc'), /无法识别/);

  assert.equal(boardOf('600000'), 'main');
  assert.equal(boardOf('300001'), 'gem');
  assert.equal(boardOf('688001'), 'star');
  assert.equal(boardOf('430047'), 'bj');
  assert.equal(boardOf('510300'), 'etf');

  assert.deepEqual(limitPrices(9.4, '600000'), { up: 10.34, down: 8.46, pct: 10 });
  assert.deepEqual(limitPrices(10, '300001'), { up: 12, down: 8, pct: 20 });
  assert.deepEqual(limitPrices(10, '688001'), { up: 12, down: 8, pct: 20 });
  assert.deepEqual(limitPrices(10, '430047'), { up: 13, down: 7, pct: 30 });
  assert.deepEqual(limitPrices(10, '600000', '*ST 测试'), { up: 10.5, down: 9.5, pct: 5 });
  assert.deepEqual(limitPrices(0, '600000'), { up: null, down: null, pct: 10 });

  assert.equal(checkOrderSize(100, '600000', 'buy'), null);
  assert.match(checkOrderSize(150, '600000', 'buy'), /整数倍/);
  assert.match(checkOrderSize(100, '688001', 'buy'), /200/);
  assert.equal(checkOrderSize(50, '600000', 'sell', 50), null);
  assert.match(checkOrderSize(50, '600000', 'sell', 100), /零股/);
});

test('交易时段：盘前 / 竞价 / 午休 / 收盘 / 周末', () => {
  // 2026-11-06 是周五（UTC 时间 + 8h = 北京）
  assert.equal(tradingStatus(new Date('2026-11-06T00:30:00Z')).phase, '开盘前');
  assert.equal(tradingStatus(new Date('2026-11-06T01:20:00Z')).phase, '开盘集合竞价');
  assert.equal(tradingStatus(new Date('2026-11-06T02:00:00Z')).phase, '上午连续竞价');
  assert.equal(tradingStatus(new Date('2026-11-06T04:00:00Z')).phase, '午间休市');
  assert.equal(tradingStatus(new Date('2026-11-06T08:00:00Z')).phase, '已收盘');
  assert.equal(tradingStatus(new Date('2026-11-08T02:00:00Z')).phase, '非交易日（周末）');
  assert.equal(tradingStatus(new Date('2026-11-06T02:00:00Z')).open, true);
  assert.equal(tradingStatus(new Date('2026-11-08T02:00:00Z')).open, false);

  const ctx = marketContext(new Date('2026-11-06T08:00:00Z'));
  assert.match(ctx.text, /已收盘/);
});

test('astock_quote 输出：表头 / 行 / 停牌提示 / 非交易时段注', async () => {
  const quote = parseTencentQuote(tencentFields(), 'sh');
  const halted = parseTencentQuote(tencentFields({
    name: '停牌股', code: '600001', price: '0.00',
  }), 'sh');
  const out = await runQuote({ codes: ['600000', '600001'] }, {
    fetchQuotes: async () => [quote, halted],
    marketContext: () => ({ open: false, text: '当前已收盘，显示的为当日收盘价（不会再变动）；如需操作请规划到下一交易日。' }),
  });
  assert.match(out, /^\*\*2 只行情\*\*（当前已收盘/);
  assert.match(out, /\| 名称\(代码\) \| 现价 \| 涨跌幅 \| 跌停\/涨停 \| 量比 \| 换手 \| 成交额 \| 总市值 \| 时间 \|/);
  assert.match(out, /\| 浦发银行\(600000\) \| 9\.53 \| \+1\.38% \| 8\.46 \/ 10\.34 \| 1\.23 \| 0\.42% \| 12\.35亿 \| 3000\.00亿 \| 2026-10-23 16:14:58 \|/);
  assert.match(out, /⏸ 无成交价（停牌\/未开盘）：停牌股\(600001\)/);
  assert.match(out, /注：当前已收盘/);
});

test('台账：现金 / 自选 / 买入卖出 / T+1 / 已实现盈亏 / 重建', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-astock-ledger-'));
  const dbPath = path.join(dir, 'ledger.sqlite');
  const ledger = new Ledger(dbPath);

  assert.equal(ledger.getCash().balance, 0);
  assert.equal(ledger.setCash(50000).balance, 50000);
  ledger.addWatch('sh600000', '浦发银行');
  assert.deepEqual(ledger.ledgerCodes(), ['600000']);

  const y = new Date(Date.now() - 86400000);
  const yesterday = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
  const buy = ledger.recordTrade('600000', 'buy', 10, 100, {
    tradeDate: yesterday, name: '浦发银行',
  });
  assert.equal(buy.fee, 5.01);
  assert.equal(buy.cost_price_after, 10.0501);
  assert.equal(buy.shares_after, 100);

  const pos = ledger.listPositions()[0];
  assert.equal(pos.shares, 100);
  assert.equal(pos.cost_amount, 1005.01);
  assert.equal(pos.available_today, 100);

  // 今日买入的部分不可卖：昨天 100 + 今天 100，可卖仍只有 100
  const today = new Date();
  const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  ledger.recordTrade('600000', 'buy', 10, 100, { tradeDate: stamp });
  assert.equal(ledger.listPositions()[0].available_today, 100);
  assert.throws(
    () => ledger.recordTrade('600000', 'sell', 10.5, 200),
    /可卖数量不足/,
  );

  const sell = ledger.recordTrade('600000', 'sell', 10.5, 100, { tradeDate: stamp });
  assert.equal(sell.realized_pnl, 39.45);
  assert.equal(sell.shares_after, 100);
  assert.equal(ledger.realizedPnl().realized_pnl, 39.45);

  const trades = ledger.trades({ code: '600000' });
  assert.equal(trades.length, 3);
  ledger.deleteTrade(trades[0].id);
  assert.equal(ledger.trades({ code: '600000' }).length, 2);

  fs.rmSync(dir, { recursive: true, force: true });
});
