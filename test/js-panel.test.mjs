/**
 * 面板「今日超额」的基准：默认对全市场涨跌中位数，取不到才退回沪指。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
