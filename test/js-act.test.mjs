import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildActionPlan, decideSells, renderActionPlan,
} from '../lib/js/actions.js';
import { hintsConfig } from '../lib/js/hints.js';
import { Allocation } from '../lib/js/quant.js';
import { feeConfig } from '../lib/js/market.js';
import { runAct } from '../lib/js/act-tool.js';

function fixture() {
  const positions = [
    {
      code: '600000', name: '浦发银行', shares: 1000, cost_price: 10, available_today: 500,
    },
    {
      code: '300001', name: '特锐德', shares: 500, cost_price: 20, available_today: 500,
    },
  ];
  const quotes = {
    600000: { price: 9, name: '浦发银行' },
    300001: { price: 21, name: '特锐德' },
  };
  const alloc = [new Allocation({
    code: '000001', name: '平安银行', shares: 1000, price: 10, score: 80,
    amount: 10000, fee: 5, stop_loss: 9.2, take_profit: 11.5,
  })];
  return { positions, quotes, alloc };
}

test('卖出判定：止损优先 / T+1 裁剪 / 换仓 / 超仓', () => {
  const { positions, quotes, alloc } = fixture();
  const sells = decideSells(positions, quotes, alloc.map((a) => a.code), hintsConfig({}), {
    totalMarketValue: 15000, totalEquity: 35000, feeCfg: feeConfig({}),
  });
  assert.equal(sells.length, 1);
  assert.equal(sells[0].code, '600000');
  assert.equal(sells[0].urgency, 'urgent');
  assert.equal(sells[0].shares, 500);
  assert.equal(sells[0].est_fee, 7.295);
  assert.equal(sells[0].asDict().est_fee, 7.29);
  assert.match(sells[0].reason, /触发止损线/);

  // 换仓：不在选股名单且浮亏
  const rebalance = decideSells([{
    code: '600000', name: 'A', shares: 100, cost_price: 10, available_today: 100,
  }], { 600000: { price: 9.5, name: 'A' } }, ['300001'], hintsConfig({}), {
    feeCfg: feeConfig({}),
  });
  assert.match(rebalance[0].reason, /建议换仓/);

  // 超仓：占权益 100% > 25%，减到上限内（按整手）
  const cap = decideSells([{
    code: '600000', name: 'A', shares: 1000, cost_price: 50, available_today: 1000,
  }], { 600000: { price: 50, name: 'A' } }, ['600000'], hintsConfig({}), {
    totalEquity: 50000, feeCfg: feeConfig({}),
  });
  assert.match(cap[0].reason, /超上限/);
  assert.equal(cap[0].shares, 700);
});

test('操作计划：先卖后买 / 资金闭环 / T+1 提示', () => {
  const { positions, quotes, alloc } = fixture();
  const plan = buildActionPlan(positions, quotes, alloc, 20000, hintsConfig({}), {
    strategy: { label: '趋势动量' },
    totalMarketValue: 15000,
    totalEquity: 35000,
    feeCfg: feeConfig({}),
  });
  assert.equal(plan.cash_before, 20000);
  assert.equal(plan.sell_proceeds, 4492.71);
  assert.equal(plan.buy_cost, 10005);
  assert.equal(plan.cash_after, 14487.71);
  assert.equal(plan.blocked, false);
  assert.ok(plan.notes.some((n) => n.includes('必须先卖出、再买入')));
  assert.ok(plan.notes.some((n) => n.includes('T+1 锁定')));

  const md = renderActionPlan(plan, '趋势动量');
  assert.match(md, /^## 📋 操作指示（趋势动量）/);
  assert.match(md, /第一步：卖出/);
  assert.match(md, /第二步：买入/);
  // 买入成交后要把止盈止损挂成券商事件单（条件单格式）
  assert.match(md, /第三步：买入成交后，把止盈止损挂成事件单/);
  assert.match(md, /最新价 ≤ \*\*9\.20\*\*/);
  assert.match(md, /最新价 ≥ \*\*11\.50\*\*/);
  assert.match(md, /\*\*操作后现金\*\* \| \*\*14,487\.71 元\*\*/);
  assert.match(md, /这不是自动交易/);
});

test('操作计划：无操作 / 买入资金不足', () => {
  const empty = buildActionPlan([], {}, [], 10000, hintsConfig({}), {
    totalMarketValue: 0, totalEquity: 10000, feeCfg: feeConfig({}),
  });
  assert.equal(empty.blocked, true);
  assert.match(renderActionPlan(empty), /本轮既无需卖出，也没有可买入的标的/);

  const insufficient = buildActionPlan([], {}, [new Allocation({
    code: '600000', name: 'A', shares: 1000, price: 20, amount: 20000, fee: 5,
  })], 1000, hintsConfig({}), {
    totalMarketValue: 0, totalEquity: 1000, feeCfg: feeConfig({}),
  });
  assert.equal(insufficient.blocked, true);
  assert.match(insufficient.notes[0], /超过可用资金/);
});

test('astock_act：注入选股与快照，输出操作指示', async () => {
  const { positions, quotes, alloc } = fixture();
  const out = await runAct({ no_grade: true }, {
    ledger: { fee: feeConfig({}) },
    config: {},
    snapshot: async () => ({
      data: {
        positions,
        quotes,
        cash: 20000,
        total_market_value: 15000,
        equity: 35000,
      },
    }),
    scan: async () => ({ allocations: alloc, strategy: 'momentum' }),
  });
  assert.match(out, /^## 📋 操作指示（趋势动量）/);
  assert.match(out, /浦发银行\(600000\)/);
  assert.match(out, /平安银行\(000001\)/);
  assert.match(out, /不构成投资建议|请自行复核/);
});
