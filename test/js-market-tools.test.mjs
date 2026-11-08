import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runSearch } from '../lib/js/search.js';
import { runScreen } from '../lib/js/screen.js';
import { runFlow } from '../lib/js/flow.js';
import { runRecord, runPortfolio } from '../lib/js/portfolio.js';
import { Ledger } from '../lib/js/ledger.js';

function tempLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-astock-pf-'));
  return { dir, ledger: new Ledger(path.join(dir, 'ledger.sqlite')) };
}

test('astock_search：过滤债券 / 空结果文案', async () => {
  const out = await runSearch({ keyword: '浦发' }, {
    search: async () => ([
      { code: '600000', name: '浦发银行', market: '沪A', board: '沪深主板', symbol: 'sh600000', kind: 'stock' },
      { code: '360003', name: '浦发优1', market: '债券', board: '未知', symbol: 'sh360003', kind: 'other' },
    ]),
  });
  assert.match(out, /\| 600000 \| 浦发银行 \| 沪A \| 沪深主板 \| sh600000 \|/);
  assert.doesNotMatch(out, /360003/);

  const empty = await runSearch({ keyword: 'zzzz' }, { search: async () => [] });
  assert.match(empty, /没找到与「zzzz」匹配/);
});

test('astock_screen：表头 / 命中数 / 排序说明', async () => {
  const out = await runScreen({ universe: 'main', sort_by: 'change_pct', limit: 5 }, {
    screenViaEastmoney: async () => ({
      total: 5563,
      source: 'eastmoney',
      rows: [{
        code: '600000', name: '浦发银行', price: 10.03, change_pct: 1.62,
        turnover_pct: 0.19, volume_ratio: 0.76, amount_yuan: 6.4e8,
        total_mcap_yuan: 3.34e11, main_net_inflow_yuan: 1.2e7,
      }],
    }),
  });
  assert.match(out, /^\*\*条件选股\*\*（main，全市场 5563 只，命中 1）/);
  assert.match(out, /\| 600000 \| 浦发银行 \| 10\.03 \| \+1\.62% \| 0\.19% \| 0\.76 \| 6\.40亿 \| 3340\.00亿 \| 1200\.00万 \|/);
  assert.match(out, /排序：change_pct/);
  assert.doesNotMatch(out, /新浪排行备源/);
});

test('astock_screen：东财失败自动切新浪并标注缺字段', async () => {
  const out = await runScreen({ limit: 1 }, {
    screenViaEastmoney: async () => { throw new Error('限流'); },
    screenViaSina: async () => ({
      total: 5000,
      source: 'sina',
      rows: [{
        code: '000001', name: '平安银行', price: 11.81, change_pct: 1.46,
        turnover_pct: 0.85, volume_ratio: null, amount_yuan: 1.9e9,
        total_mcap_yuan: 2.29e11, main_net_inflow_yuan: null,
      }],
    }),
  });
  assert.match(out, /命中 1/);
  assert.match(out, /新浪排行备源/);
  assert.match(out, /\| 19\.00亿 \| 2290\.00亿 \| - \|/);
});

test('astock_flow：主力合计 / 备源口径说明', async () => {
  const out = await runFlow({ code: '600000', days: 2 }, {
    fetchMoneyFlow: async () => ([
      {
        date: '2026-11-06', main_net: 1e7, super_net: 6e6, large_net: 4e6,
        mid_net: -1e6, small_net: -9e6, source: 'eastmoney',
      },
      {
        date: '2026-11-07', main_net: -2e6, super_net: -1e6, large_net: -1e6,
        mid_net: 5e5, small_net: 1.5e6, source: 'eastmoney',
      },
    ]),
  });
  assert.match(out, /^\*\*600000 近 2 日资金流\*\*（合计主力净额 800\.00万）/);
  assert.match(out, /主力=超大单\+大单口径/);

  const sina = await runFlow({ code: '600000' }, {
    fetchMoneyFlow: async () => ([{
      date: '2026-11-06', main_net: 1e7, super_net: 6e6, large_net: null,
      mid_net: null, small_net: null, source: 'sina',
    }]),
  });
  assert.match(sina, /新浪的「主力净额」口径/);
});

test('astock_record：预览校验 + 落账 + 资金提示', async () => {
  const { dir, ledger } = tempLedger();
  ledger.setCash(50000);

  const preview = await runRecord({
    side: 'buy', code: '600000', price: 10, shares: 150, dry_run: true, name: '浦发银行',
  }, { ledger });
  assert.match(preview, /校验未通过/);
  assert.match(preview, /整数倍/);

  const done = await runRecord({
    side: 'buy', code: '600000', price: 10, shares: 100, name: '浦发银行',
  }, { ledger });
  assert.match(done, /已录入买入/);
  assert.match(done, /成本价 \| 10\.0501/);
  assert.match(done, /真实可用应为 48,994\.99 元/);

  const pos = ledger.listPositions()[0];
  assert.equal(pos.available_today, 0);

  const sellPreview = await runRecord({
    side: 'sell', code: '600000', price: 10.5, shares: 100, dry_run: true, name: '浦发银行',
  }, { ledger });
  assert.match(sellPreview, /今日可卖仅 0 股/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('astock_portfolio：set_cash / trades / delete_trade / 空仓总览', async () => {
  const { dir, ledger } = tempLedger();
  const set = await runPortfolio({ action: 'set_cash', cash: 12345.6 }, { ledger });
  assert.match(set, /可用资金已设为 12,345\.60 元/);

  const empty = await runPortfolio({ action: 'summary' }, { ledger });
  assert.match(empty, /当前空仓/);
  assert.match(empty, /持仓数量 \| 0 只/);

  const noTrades = await runPortfolio({ action: 'trades' }, { ledger });
  assert.match(noTrades, /暂无成交记录/);

  fs.rmSync(dir, { recursive: true, force: true });
});
