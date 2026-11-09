import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildPositionHints, buildT1Hint, hintsConfig, suggestBuy, suggestSell,
} from '../lib/js/hints.js';
import {
  avoidRoundNumber, buildBuyOrder, buildSellOrder, stopLossPrice, takeProfitPrice,
} from '../lib/js/orders.js';
import { runHint } from '../lib/js/hint-tool.js';
import { Ledger } from '../lib/js/ledger.js';

const CFG = hintsConfig({});

function quote(over = {}) {
  return {
    code: '600000', name: '浦发银行', price: 9.1, prev_close: 10,
    change_pct: -9, limit_up: 11, limit_down: 8.9, volume_ratio: 1.2,
    limit_pct: 10, ...over,
  };
}

test('提示规则：止损 / 止盈 / 单票超限 / T+1', () => {
  const stop = buildPositionHints(
    { code: '600000', name: '浦发银行', shares: 100, cost_price: 10 },
    quote(), CFG,
  );
  assert.equal(stop[0].kind, 'stop_loss');
  assert.match(stop[0].title, /浮亏 -9\.00%/);
  assert.equal(stop[0].shares, 100);
  assert.match(stop[0].basis, /≤ -8\.0%/);

  const take = buildPositionHints(
    { code: '600000', name: '浦发银行', shares: 100, cost_price: 10 },
    quote({ price: 11.6, change_pct: 16, limit_up: 12 }), CFG,
  );
  assert.equal(take[0].kind, 'take_profit');
  assert.equal(take[0].shares, 100);
  assert.match(take[0].title, /浮盈 \+16\.00%/);

  const cap = buildPositionHints(
    { code: '600000', name: '浦发银行', shares: 100, cost_price: 10 },
    quote({ price: 30, change_pct: 0, limit_up: 33, limit_down: 27 }), CFG,
    { totalEquity: 10000, totalMarketValue: 3000 },
  );
  assert.equal(cap.find((h) => h.kind === 'position_cap').kind, 'position_cap');
  assert.match(cap.find((h) => h.kind === 'position_cap').title, /单票占比 30\.0% 超上限/);
  assert.match(cap.find((h) => h.kind === 'position_cap').suggestion, /25\.0%/);

  const t1 = buildT1Hint({ code: '600000', name: '浦发银行', shares: 100 }, 0);
  assert.equal(t1.kind, 't1_locked');
  assert.match(t1.title, /今日可卖 0 股，100 股 T\+1 锁定/);
});

test('提示规则：涨停直接返回 / 跌停保留异动 / 自选只报仓位无关信号', () => {
  const up = buildPositionHints(
    { code: '600000', name: '浦发银行', shares: 100, cost_price: 10 },
    quote({ price: 11, limit_up: 11, change_pct: 10 }), CFG,
  );
  assert.equal(up.length, 1);
  assert.equal(up[0].kind, 'limit_up');

  const down = buildPositionHints(
    { code: '600000', name: '浦发银行', shares: 100, cost_price: 10 },
    quote({ price: 9, limit_down: 9, change_pct: -10 }), CFG,
  );
  assert.deepEqual(down.map((h) => h.kind), ['limit_down', 'event']);

  const watch = buildPositionHints(
    { code: '600000' }, quote({ price: 11, limit_up: 11, change_pct: 10 }), CFG,
    { watchOnly: true },
  );
  assert.equal(watch[0].kind, 'limit_up');
});

test('买卖估算：整手 / 费用 / T+1 裁剪', () => {
  const buy = suggestBuy('600000', '浦发银行', 10, 50000, CFG, {
    totalMarketValue: 0,
  });
  assert.equal(buy.suggest_shares, 1200);
  assert.equal(buy.suggest_amount, 12000);
  assert.equal(buy.limit_up, 11);
  assert.equal(buy.limit_down, 9);
  assert.match(buy.reason, /单票占比 25\.0%/);

  const sell = suggestSell(
    { code: '600000', name: '浦发银行', shares: 200, cost_price: 10 },
    10.5, 100, { ratio: 0.5 },
  );
  assert.equal(sell.suggest_shares, 100);
  assert.equal(sell.remain_shares, 100);
  assert.equal(sell.est_realized_pnl, 44.46);
});

test('条件单：整数关口避让 / 跌停约束 / 已失效一侧只提示', () => {
  assert.equal(avoidRoundNumber(9.0, 'down'), 8.99);
  assert.equal(avoidRoundNumber(10.0, 'up'), 10.01);
  assert.equal(stopLossPrice(10, 10, '600000'), 8.99);
  assert.equal(stopLossPrice(10, 20, '600000', '', 10), 9.01);
  assert.equal(takeProfitPrice(10, 15, '600000'), 11.5);

  const sell = buildSellOrder('600000', '浦发银行', 9, 100, 10, 8, 15, {
    prevClose: 10,
  });
  assert.equal(sell.stop_loss, null);
  assert.match(sell.notes.join('\n'), /止损线 9\.20 已高于现价 9\.00/);
  assert.equal(sell.take_profit, 11.5);

  const buy = buildBuyOrder('600000', '浦发银行', 10, 5000, 8, 15, {
    prevClose: 10,
  });
  assert.equal(buy.shares, 400);
  assert.equal(buy.stop_loss, 9.2);
  assert.equal(buy.take_profit, 11.5);
});

test('astock_hint：触发止损 + 条件单落库 + 免责声明', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-astock-hint-'));
  const ledger = new Ledger(path.join(dir, 'ledger.sqlite'));
  ledger.setCash(50000);
  const y = new Date(Date.now() - 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  const yd = `${y.getFullYear()}-${pad(y.getMonth() + 1)}-${pad(y.getDate())}`;
  ledger.recordTrade('600000', 'buy', 10, 100, { tradeDate: yd, name: '浦发银行' });

  const out = await runHint({ code: '600000', no_sentiment: true }, {
    ledger,
    fetchQuotes: async () => [quote({ price: 9.1, change_pct: -9 })],
    fetchKlines: async () => ({ bars: [{ high: 10.5 }] }),
  });
  assert.match(out, /^\*\*下单提示\*\*/);
  assert.match(out, /触发止损线/);
  assert.match(out, /### 可照抄的条件单/);
  assert.match(out, /计划号  P\d{8}-1/);
  assert.match(out, /不构成投资建议/);

  const plans = ledger.listPlans();
  assert.equal(plans.length, 1);
  assert.equal(plans[0].code, '600000');
  assert.equal(plans[0].side, 'sell');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('事件单：止损/止盈拆成两张券商可照抄的条件单', () => {
  const buy = buildBuyOrder('600000', '浦发银行', 10, 5000, 8, 15, { prevClose: 10 });
  const tickets = buy.eventOrders();
  assert.equal(tickets.length, 2, '默认应生成止损 + 止盈两张');
  assert.equal(tickets[0].label, '止损');
  assert.match(tickets[0].trigger, /最新价 ≤ 9\.20/);
  assert.equal(tickets[0].shares, buy.shares);
  assert.equal(tickets[0].side, 'sell');
  assert.equal(tickets[1].label, '止盈');
  assert.match(tickets[1].trigger, /最新价 ≥ 11\.50/);

  const block = buy.orderBlock();
  assert.match(block, /事件单（券商 App → 条件单/);
  assert.match(block, /止损：触发「最新价 ≤ 9\.20」→ 卖出/);

  // 只有止损、没有止盈时只出一张
  const stopOnly = buildSellOrder('600000', '浦发银行', 9.5, 100, 10, 8, 0, { prevClose: 10 });
  const only = stopOnly.eventOrders();
  assert.equal(only.length, 1);
  assert.equal(only[0].label, '止损');
});
