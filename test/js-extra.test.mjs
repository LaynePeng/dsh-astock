import assert from 'node:assert/strict';
import test from 'node:test';

import { runExtra } from '../lib/js/extra-tool.js';

test('astock_extra：hot / industry / board_flow / st', async () => {
  const hot = await runExtra({ action: 'hot', limit: 1 }, {
    thsHotList: async () => [{
      rank: 1, code: '600000', name: '浦发银行', heat: 12345,
      change_pct: 1.62, rank_change: 2, concepts: ['银行'], tag: '持续上榜',
    }],
  });
  assert.match(hot, /^\*\*人气热榜\*\*（同花顺小时榜，前 1）/);
  assert.match(hot, /\| 1 \| 浦发银行\(600000\) \| 12,345 \| \+1\.62% \| \+2 \| 银行 \| 持续上榜 \|/);

  const industry = await runExtra({ action: 'industry', top_n: 1 }, {
    industryRank: async () => ({
      total: 100,
      top: [{ rank: 1, name: '银行', change_pct: 2.1, up_count: 30, down_count: 2, leader: '浦发银行', leader_change_pct: 5 }],
      bottom: [{ rank: 100, name: '煤炭', change_pct: -2.1, up_count: 1, down_count: 29, leader: '', leader_change_pct: null }],
    }),
  });
  assert.match(industry, /行业板块排名/);
  assert.match(industry, /\| 1 \| 银行 \| \+2\.10% \| 30涨\/2跌 \| 浦发银行\(\+5\.00%\) \|/);

  const flow = await runExtra({ action: 'board_flow', top_n: 1 }, {
    boardFundFlow: async () => ({
      total: 10,
      rows: [{ rank: 1, name: '银行', change_pct: 1, main_net_yuan: 1e8, main_pct: 2.5, leader: '浦发银行' }],
    }),
  });
  assert.match(flow, /行业板块资金流/);
  assert.match(flow, /\| 1 \| 银行 \| \+1\.00% \| 1\.00亿 \| 2\.50% \| 浦发银行 \|/);

  const st = await runExtra({ action: 'st', limit: 1 }, {
    stStocks: async () => [{
      code: '600001', name: '*ST 测试', market: 'sh', st_type: '*ST', price: 1.2, change_pct: -5,
    }],
  });
  assert.match(st, /ST \/ \*ST 名单/);
  assert.match(st, /\| \*ST 测试\(600001\) \| SH \| \*ST \| 1\.20 \| -5\.00% \|/);
});

test('astock_extra：margin / holders / lhb / concepts', async () => {
  const margin = await runExtra({ action: 'margin', code: '600000', days: 2 }, {
    marginTrading: async () => ([
      { date: '2026-11-05', fin_balance_yuan: 1e9, fin_buy_yuan: 1e7, fin_net_buy_yuan: -1e6, sec_balance_yuan: 1e7, total_balance_yuan: 1.01e9 },
      { date: '2026-11-06', fin_balance_yuan: 1.02e9, fin_buy_yuan: 2e7, fin_net_buy_yuan: 2e6, sec_balance_yuan: 1.1e7, total_balance_yuan: 1.031e9 },
    ]),
  });
  assert.match(margin, /600000 两融余额/);
  assert.match(margin, /\| 区间融资余额变化 \| \+2\.00% \|/);

  const holders = await runExtra({ action: 'holders', code: '600000' }, {
    holderCount: async () => ([
      { end_date: '2026-06-30', holders: 200000, change_num: 10000, change_pct: 5, avg_hold_value_yuan: 1e5 },
      { end_date: '2026-09-30', holders: 150000, change_num: -50000, change_pct: -25, avg_hold_value_yuan: 2e5 },
    ]),
  });
  assert.match(holders, /股东户数/);
  assert.match(holders, /户数下降 → 筹码趋于集中/);

  const lhb = await runExtra({ action: 'lhb' }, {
    lhbMarket: async () => ({
      date: '2026-11-06', total: 1, raw_records: 1,
      stocks: [{ code: '600000', name: '浦发银行', reason: '涨幅偏离', close: 10.03, change_pct: 5, net_buy_wan: 1200, buy_wan: 2000, sell_wan: 800 }],
    }),
  });
  assert.match(lhb, /全市场龙虎榜/);
  assert.match(lhb, /\| 浦发银行\(600000\) \| 涨幅偏离 \| 10\.03 \| \+5\.00% \| 1,200\.0 \|/);

  const concepts = await runExtra({ action: 'concepts', code: '600000' }, {
    conceptBlocks: async () => ({
      total: 1,
      boards: [{ name: '银行', code: 'BK0475', change_pct: 1.2, leader: '浦发银行' }],
    }),
  });
  assert.match(concepts, /板块\/概念归属/);
  assert.match(concepts, /\| 银行 \| BK0475 \| \+1\.20% \| 浦发银行 \|/);
});

test('astock_extra：未知 action 返回错误清单', async () => {
  const out = await runExtra({ action: 'nope' });
  assert.match(out, /^\[Error\] 未知 action=nope/);
  assert.match(out, /limit_sentiment/);
});
