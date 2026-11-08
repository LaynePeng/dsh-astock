import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BacktestConfig, gradeRecommendation, renderBacktest, runBacktest,
} from '../lib/js/backtest.js';
import { runBacktestTool } from '../lib/js/backtest-tool.js';

function mk(seed) {
  return Array.from({ length: 200 }, (_, i) => {
    const base = 10 + seed + i * 0.01 + Math.sin((i + seed) / 5) * 0.7;
    return {
      date: `2025-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      open: base - 0.05,
      close: base,
      high: base + 0.2,
      low: base - 0.2,
      volume_lot: 1000 + i * 5 + seed * 20,
    };
  });
}

function fixture() {
  return {
    universe: [
      { code: '600000', name: 'A', bars: mk(0) },
      { code: '300001', name: 'B', bars: mk(2) },
      { code: '688001', name: 'C', bars: mk(4) },
    ],
    bench: mk(1).map((b) => ({ ...b, close: b.close + 100, open: b.open + 100 })),
  };
}

test('回测：期数 / 推荐率 / 超额 / 最大回撤', () => {
  const { universe, bench } = fixture();
  const bt = runBacktest('momentum', universe, bench, new BacktestConfig());
  assert.equal(bt.period_count, 13);
  assert.equal(bt.win_rate, 53.8);
  assert.equal(bt.avg_return_pct, 1.25);
  assert.equal(bt.avg_excess_pct, 1.09);
  assert.equal(bt.total_return_pct, 15.06);
  assert.equal(bt.benchmark_return_pct, 2.14);
  assert.equal(bt.max_drawdown_pct, -6.94);
  assert.equal(bt.best_period_pct, 8.96);
  assert.equal(bt.worst_period_pct, -6.94);
  assert.equal(bt.start_date, '2025-03-06');
  assert.equal(bt.end_date, '2025-07-13');

  const rec = gradeRecommendation(bt);
  assert.equal(rec.grade, 'B');
  assert.equal(rec.label, '可考虑');
  assert.equal(rec.confidence, '一般');
  assert.match(rec.reason, /历史 13 期中 7 期跑赢基准/);
});

test('回测：样本不足降 D / 未知策略报错', () => {
  const bt = runBacktest('momentum', fixture().universe, fixture().bench);
  bt.periods = bt.periods.slice(0, 3);
  const rec = gradeRecommendation(bt);
  assert.equal(rec.grade, 'D');
  assert.equal(rec.label, '样本不足');
  assert.throws(() => runBacktest('nope', fixture().universe, fixture().bench), /未知策略/);
});

test('回测报告：结论 / 指标 / 前提 / 逐期明细', () => {
  const { universe, bench } = fixture();
  const bt = runBacktest('momentum', universe, bench);
  const rec = gradeRecommendation(bt);
  const md = renderBacktest(bt, rec, 2);
  assert.match(md, /^## 🔵 回测结论：趋势动量 → \*\*可考虑（B 档）\*\*/);
  assert.match(md, /推荐率（跑赢基准的期数占比）/);
  assert.match(md, /\*\*53\.8%\*\*（7\/13 期）/);
  assert.match(md, /样本可信度 \| 一般（13 期）/);
  assert.match(md, /必须知道的前提/);
  assert.match(md, /逐期明细/);
  assert.match(md, /历史不代表未来，回测不构成投资建议/);
});

test('astock_backtest：参数校验 / 渲染取数失败脚注', async () => {
  const { universe, bench } = fixture();
  const bt = runBacktest('momentum', universe, bench);
  const rec = gradeRecommendation(bt);
  const out = await runBacktestTool({ strategy: 'momentum', detail_periods: 1 }, {
    config: {},
    run: async () => ({ result: bt, recommendation: rec, fetch_failed: 2 }),
  });
  assert.match(out, /回测结论：趋势动量/);
  assert.match(out, /2 只标的因取数失败未纳入回测/);

  const bad = await runBacktestTool({ strategy: 'nope' });
  assert.match(bad, /^\[Error\] 未知策略 nope/);
});
