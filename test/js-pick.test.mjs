import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeTechnical, passesFilters, percentiles, rankCandidates, Scored,
  sizePositions, SizingConfig, STRATEGIES,
} from '../lib/js/quant.js';
import { renderPick, renderRanking, runPick } from '../lib/js/pick-tool.js';
import { feeConfig } from '../lib/js/market.js';

function bars(seed = 0) {
  return Array.from({ length: 80 }, (_, i) => {
    const base = 10 + seed + i * 0.02 + Math.sin((i + seed) / 4) * 0.8;
    return {
      date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      open: base - 0.1,
      close: base,
      high: base + 0.3,
      low: base - 0.3,
      volume_lot: 1000 + i * 10 + seed * 50,
    };
  });
}

function row(code, name, over = {}) {
  return {
    code, name, price: 10, change_pct: 1, amount_yuan: 2e8,
    total_mcap_yuan: 1e11, pe: 8, pb: 1.2, turnover_pct: 3,
    main_net_inflow_yuan: 1e7, ...over,
  };
}

test('技术因子：均线 / 动量 / 区间 / RSI', () => {
  const tech = computeTechnical(bars());
  assert.equal(tech.bars, 80);
  assert.ok(tech.ma5 > 0);
  assert.ok(tech.ma60 > 0);
  assert.ok(tech.pos_in_range >= 0 && tech.pos_in_range <= 100);
  assert.ok(tech.rsi14 >= 0 && tech.rsi14 <= 100);
  assert.ok(tech.volatility_20d > 0);
});

test('硬门槛：ST / 成交额 / 涨停 / 涨幅上限', () => {
  const tech = { bars: 80 };
  assert.equal(passesFilters(row('600000', '浦发银行'), tech, STRATEGIES.momentum)[0], true);
  assert.match(passesFilters(row('600000', '*ST 测试'), tech, STRATEGIES.momentum)[1], /ST/);
  assert.match(passesFilters(row('600000', '浦发银行', { amount_yuan: 1e7 }), tech, STRATEGIES.momentum)[1], /成交额/);
  assert.match(passesFilters(row('600000', '浦发银行', { change_pct: 10 }), tech, STRATEGIES.momentum)[1], /涨停/);
  assert.match(passesFilters(row('600000', '浦发银行', { change_pct: 9.6 }), tech, STRATEGIES.momentum)[1], /涨幅/);
});

test('百分位：并列平均秩 / 方向反转 / 单元素', () => {
  assert.deepEqual(percentiles({ a: 1, b: 2, c: 3 }), { a: 0, b: 0.5, c: 1 });
  assert.deepEqual(percentiles({ a: 1, b: 2, c: 3 }, -1), { a: 1, b: 0.5, c: 0 });
  assert.deepEqual(percentiles({ a: 5 }), { a: 1 });
  assert.deepEqual(percentiles({ a: 1, b: 1, c: 2 }), { a: 0.25, b: 0.25, c: 1 });
});

test('打分：贡献和等于得分 / 缺失因子剔除权重', () => {
  const strat = STRATEGIES.momentum;
  const candidates = [
    new Scored({
      code: '600000', name: 'A', price: 10, score: 0,
      tech: computeTechnical(bars()), row: row('600000', 'A'),
    }),
    new Scored({
      code: '300001', name: 'B', price: 20, score: 0,
      tech: computeTechnical(bars(2)), row: row('300001', 'B', { pe: null, pb: null }),
    }),
  ];
  const ranked = rankCandidates(candidates, strat);
  assert.equal(ranked.length, 2);
  for (const c of ranked) {
    const sum = Object.values(c.contributions).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - c.score) < 0.02);
    assert.ok(c.explain(2).length > 0);
  }
  assert.ok(ranked[0].score >= ranked[1].score);
});

test('仓位分配：整手 / 单票上限 / 剩余预算回收', () => {
  const scored = [
    new Scored({ code: '600000', name: 'A', price: 10, score: 80 }),
    new Scored({ code: '300001', name: 'B', price: 20, score: 60 }),
    new Scored({ code: '688001', name: 'C', price: 50, score: 40 }),
  ];
  const [taken, skipped, summary] = sizePositions(
    scored, 100000, 200000, new SizingConfig({ max_positions: 3 }),
    { feeCfg: feeConfig({}), strategy: STRATEGIES.momentum },
  );
  assert.equal(skipped.length, 0);
  assert.equal(taken.length, 3);
  assert.equal(taken[0].shares, 4000);
  assert.equal(taken[0].amount, 40000);
  assert.equal(taken[1].shares, 1300);
  assert.equal(taken[2].shares, 200);
  assert.equal(summary.allocated_amount, 76000);
  assert.equal(summary.remaining_cash, 3968.99);
  assert.equal(summary.position_cap_amount, 50000);
});

test('astock_pick：KPI / board / table / rank_only', async () => {
  const rows = [
    row('600000', '浦发银行'),
    row('300001', '特锐德', { amount_yuan: 1.5e8, total_mcap_yuan: 5e10 }),
  ];
  const collected = {
    rows,
    techs: {
      600000: computeTechnical(bars()),
      300001: computeTechnical(bars(2)),
    },
    scanned: 5563,
    fetch_failed: 0,
    universe: 'main',
  };
  const snapshotStub = async () => ({ data: { cash: 100000, total_market_value: 100000 } });

  const out = await runPick({ strategy: 'momentum' }, {
    ledger: { fee: feeConfig({}) },
    config: { backtest_auto_grade: false },
    snapshot: snapshotStub,
    collect: async () => collected,
  });
  assert.match(out, /^\*\*量化选股 \+ 买入计划\*\*（策略：趋势动量）/);
  assert.match(out, /```kpi/);
  assert.match(out, /```board/);
  assert.match(out, /```table/);
  assert.match(out, /买入清单（照此填单）/);
  assert.match(out, /明细核对/);
  assert.match(out, /资金口径/);
  assert.match(out, /不构成投资建议/);

  const rank = await runPick({ strategy: 'momentum', rank_only: true, top_n: 2 }, {
    ledger: { fee: feeConfig({}) },
    config: { backtest_auto_grade: false },
    snapshot: snapshotStub,
    collect: async () => collected,
  });
  assert.match(rank, /^\*\*得分排行\*\*（趋势动量/);
  assert.match(rank, /```table/);
  assert.match(rank, /相对排名不是上涨概率/);
});

test('renderPick / renderRanking 空结果文案', () => {
  const empty = renderPick({
    strategy: 'momentum', allocations: [], skipped: [], summary: { cash: 0, budget: 0 },
    scanned: 10, candidates: 0,
  });
  assert.match(empty, /本轮没有产生可执行的买入计划/);
  assert.match(empty, /过滤门槛过严/);

  assert.equal(renderRanking({ top: [], strategy: 'momentum' }), '本轮没有候选通过策略筛选。');
});
