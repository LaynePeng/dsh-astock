/**
 * JS 重写第 1 个工具（astock_calc）的纯函数与输出测试。
 *
 * 这些公式是「错一位就误导人」的部分，必须能脱离网络单测。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  breakevenPrice, checkRuleDirection, checkRuleSet, maxDrawdown, positionShares,
  pyRound, riskAdjustedRatio, rsi, sma, summary,
} from '../lib/js/formula.js';
import { runCalc } from '../lib/js/calc.js';

test('pyRound：银行家舍入 + 浮点尾差不误判', () => {
  assert.equal(pyRound(2.5, 0), 2);
  assert.equal(pyRound(3.5, 0), 4);
  // 1.8749999999999984 不是真正的 .5，必须舍成 1.87
  assert.equal(pyRound(1.8749999999999984, 2), 1.87);
});

test('sma / rsi / maxDrawdown：与 Python 口径一致', () => {
  assert.equal(sma([1, 2, 3, 4, 5], 5), 3);
  assert.equal(sma([1, 2], 5), null);
  // 单调上涨 RSI=100；单调下跌 RSI=0
  assert.equal(rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]), 100);
  assert.equal(rsi([16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]), 0);
  const dd = maxDrawdown([10, 12, 8, 11]);
  assert.equal(dd.pct, -33.33);
  assert.equal(dd.peak, 12);
  assert.equal(dd.trough, 8);
});

test('算账：盈亏平衡价 / 可买股数 / 收益回撤比', () => {
  const be = breakevenPrice(10, 1000, 0, 0.00076);
  assert.ok(be > 10 && be < 10.01);
  const sz = positionShares(50000, 10, { equity: 200000, maxPositionPct: 20 });
  // 单票上限 4 万 → 4000 股
  assert.equal(sz.shares, 4000);
  assert.equal(sz.binding, '单票上限');
  assert.equal(riskAdjustedRatio(98.33, -50.05), 1.96);
  assert.equal(riskAdjustedRatio(10, 0), null);
});

test('规则体检：方向可达性', () => {
  // 跌破 9.5，现价 10.03 → 在上方，规则有效
  assert.equal(checkRuleDirection(10.03, 9.5, 'lt').ok, true);
  // 跌破 9.5，现价 9.4 → 已在下方，死规则
  assert.equal(checkRuleDirection(9.4, 9.5, 'lt').ok, false);
  // 站上 11，现价 10.03 → 在下方，规则有效
  assert.equal(checkRuleDirection(10.03, 11, 'gt').ok, true);

  const rows = checkRuleSet(
    [{ code: '600000', price: 9.5, op: 'lt' }],
    { 600000: 10.03 },
    null,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, true);
});

test('runCalc summary：用注入的 K 线跑完整输出（不联网）', async () => {
  const bars = Array.from({ length: 120 }, (_, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
    open: 10 + i * 0.01,
    close: 10 + i * 0.01,
    high: 10.1 + i * 0.01,
    low: 9.9 + i * 0.01,
    volume: 1000 + i,
  }));
  const out = await runCalc(
    { mode: 'summary', code: '600000', limit: 120 },
    {
      fetchKlines: async () => ({ bars, quote: { price: bars[bars.length - 1].close } }),
      fetchQuotes: async () => [],
    },
  );
  assert.match(out, /技术指标/);
  assert.match(out, /MA5/);
  assert.match(out, /RSI14/);
  assert.match(out, /区间最大回撤/);
  assert.match(out, /不预测未来/);
});

test('runCalc cost：与 Python 输出关键行一致', async () => {
  const out = await runCalc({
    mode: 'cost', entry_price: 10, shares: 1000, stop_pct: 8, take_pct: 15,
  });
  assert.match(out, /盈亏平衡价/);
  assert.match(out, /10\.0076/);
  assert.match(out, /盈亏比/);
  assert.match(out, /1\.87/);
});
