/**
 * 面板「今日超额」的基准：默认对全市场涨跌中位数，取不到才退回沪指。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Ledger } from '../lib/js/ledger.js';
import { buildPortfolio } from '../lib/js/panel.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-astock-panel-'));
  const ledger = new Ledger(join(dir, 'ledger.sqlite'));
  ledger.setCash(10000);
  ledger.recordTrade('600000', 'buy', 10, 100, { tradeDate: '2026-01-05', name: '浦发银行' });
  return ledger;
}

const quoteStub = async (codes) => {
  const table = {
    '600000': { code: '600000', name: '浦发银行', price: 10.5, change: 0.5 },
    '000001': { code: '000001', name: '上证指数', price: 3400, change_pct: 0.3 },
  };
  return codes.map((code) => table[code]).filter(Boolean);
};

/** 自选股行情桩：按代码回一条固定价，不联网。 */
const watchQuoteStub = async (codes) => codes.map((code) => ({
  code, name: code, price: 10.0, change_pct: 0.5,
}));

test('今日超额：默认基准是全市场中位数', async () => {
  const ledger = setup();
  const snap = await buildPortfolio({
    ledger,
    fetchQuotes: quoteStub,
    fetchMedian: async () => ({ ok: true, median: 1.2, total: 5000 }),
  });
  const kpi = snap.kpis.find((item) => item.label === '今日超额');
  assert.equal(kpi.note, '全市场中位 +1.20%');
  const equity = snap.kpis.find((item) => item.label === '总资产').value;
  const todayPnl = snap.kpis.find((item) => item.label === '总资产').delta;
  const expected = Math.round(((todayPnl / equity) * 100 - 1.2) * 100) / 100;
  assert.ok(Math.abs(kpi.value - expected) < 0.02, `${kpi.value} vs ${expected}`);
});

test('今日超额：中位数取不到时退回沪指并注明', async () => {
  const ledger = setup();
  const snap = await buildPortfolio({
    ledger,
    fetchQuotes: quoteStub,
    fetchMedian: async () => ({ ok: false, reason: 'boom' }),
  });
  const kpi = snap.kpis.find((item) => item.label === '今日超额');
  assert.match(kpi.note, /沪指 \+0\.30%/);
  assert.match(kpi.note, /中位数未取到/);
});

test('今日超额：中位数与沪指都取不到时给空值，不拿 0 冒充', async () => {
  const ledger = setup();
  const snap = await buildPortfolio({
    ledger,
    fetchQuotes: async () => [],
    fetchMedian: async () => ({ ok: false, reason: 'boom' }),
  });
  const kpi = snap.kpis.find((item) => item.label === '今日超额');
  assert.equal(kpi.value, null);
  assert.equal(kpi.note, '基准数据未取到');
});

// ---------------------------------------------------------------- 自选买点

/** 自选三只（都不在持仓里），台账与计划同目录。 */
function setupWatch() {
  const ledger = setup();
  ledger.addWatch('600036', '招商银行');
  ledger.addWatch('300364', '中文在线');
  ledger.addWatch('600900', '长江电力');
  return ledger;
}

function planPathOf(ledger) {
  return join(dirname(ledger.path), 'watch-plan.json');
}

test('自选买点：只取 le/lt，按价格从高到低，最多 3 条', async () => {
  const ledger = setupWatch();
  writeFileSync(planPathOf(ledger), JSON.stringify({
    rules: [
      { code: '600036', price: 42.8, op: 'le', label: '回踩MA20', severity: 'action' },
      // 同一只股票的多档买点 + 一条卖出档（gt 不能进买点）
      { code: '300364', price: 21.3, op: 'le', label: '前低', severity: 'action' },
      { code: '300364', price: 20.1, op: 'lt', label: '第二档', severity: 'urgent' },
      { code: '300364', price: 19.5, op: 'lt', label: '第三档', severity: 'info' },
      { code: '300364', price: 18.2, op: 'lt', label: '第四档', severity: 'info' },
      { code: '600900', price: 34.9, op: 'ge', label: '止盈', severity: 'action' },
    ],
  }), 'utf8');

  const snap = await buildPortfolio({
    ledger,
    fetchQuotes: watchQuoteStub,
    fetchMedian: async () => ({ ok: false }),
  });

  const byCode = Object.fromEntries(snap.watch.map((w) => [w.code, w]));
  assert.deepEqual(byCode['600036'].buyAt, [
    { price: 42.8, label: '回踩MA20', severity: 'action' },
  ]);
  // 4 档只留价格最高的 3 档，且按降序
  assert.deepEqual(byCode['300364'].buyAt.map((b) => b.price), [21.3, 20.1, 19.5]);
  assert.equal(byCode['300364'].buyAt[1].severity, 'urgent');
  // 只有 ge 档 → 没有买点，给空数组而不是 0/占位字符串
  assert.deepEqual(byCode['600900'].buyAt, []);

  rmSync(dirname(ledger.path), { recursive: true, force: true });
});

test('自选买点：没有计划文件时 buyAt 全为空数组且面板正常', async () => {
  const ledger = setupWatch();
  const snap = await buildPortfolio({
    ledger,
    fetchQuotes: watchQuoteStub,
    fetchMedian: async () => ({ ok: false }),
  });

  assert.equal(snap.ok, true);
  assert.equal(snap.watch.length, 3);
  for (const w of snap.watch) {
    assert.deepEqual(w.buyAt, [], `${w.code} 应为空数组`);
  }

  rmSync(dirname(ledger.path), { recursive: true, force: true });
});
