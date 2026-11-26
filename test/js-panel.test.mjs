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
import { snapshot } from '../lib/js/portfolio.js';

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

// ---------------------------------------------------------------- 累计盈亏

/**
 * 用户报的问题：面板只显示「浮动盈亏」，亏着卖掉的票已经从持仓里消失，
 * 账面看上去永远是「这几只暂时浮亏」，看不到「这只已经认亏出局」。
 */
test('账户盈亏：卖掉后的亏损必须留在账上，不能只报浮动盈亏', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-astock-panel-'));
  const ledger = new Ledger(join(dir, 'ledger.sqlite'));
  ledger.setCash(10000);
  ledger.recordTrade('600000', 'buy', 10, 1000, { tradeDate: '2026-01-05', name: '浦发银行' });
  // 8 元卖掉 400 股：已实现约 -800（含费用），但 remaining 600 股是浮盈的
  ledger.recordTrade('600000', 'sell', 8, 400, { tradeDate: '2026-01-06', name: '浦发银行' });

  const ref = await snapshot(ledger, { fetchQuotes: quoteStub });
  const snap = await buildPortfolio({
    ledger,
    fetchQuotes: quoteStub,
    fetchMedian: async () => ({ ok: false }),
  });

  const kpi = snap.kpis.find((item) => item.label === '账户盈亏');
  assert.ok(kpi, '面板必须有「账户盈亏」这一格');
  assert.equal(snap.kpis.some((item) => item.label === '浮动盈亏'), false, '不要再把浮动盈亏当主指标');
  assert.equal(kpi.deltaLabel, '对本金');

  const expected = Math.round((ref.data.float_pnl + ref.data.realized_pnl) * 100) / 100;
  assert.ok(Math.abs(kpi.value - expected) < 0.02, `累计 ${kpi.value} vs ${expected}`);
  assert.ok(ref.data.realized_pnl < 0, '8 元卖出 10 元成本的票，已实现必须是负的');
  // 只报浮动会显示成正的；累计必须更差，这才是这个指标存在的理由
  assert.ok(kpi.value < ref.data.float_pnl, `累计 ${kpi.value} 应低于浮动 ${ref.data.float_pnl}`);
  assert.match(kpi.note, /已实现 -/);
  assert.match(kpi.hint, /流水盈亏/);
  assert.match(kpi.hint, /净本金/);

  // 结构化也给一份，客户端不必自己重算
  assert.ok(Math.abs(snap.pnl.total - expected) < 0.02);
  assert.equal(snap.pnl.sellCount, 1);
  assert.ok(Math.abs(snap.pnl.capitalBase - (ref.data.equity - expected)) < 0.02);

  rmSync(dir, { recursive: true, force: true });
});

test('账户盈亏：没卖过时等于浮动盈亏，并明说没有卖出流水', async () => {
  const ledger = setup();
  const snap = await buildPortfolio({
    ledger,
    fetchQuotes: quoteStub,
    fetchMedian: async () => ({ ok: false }),
  });
  const kpi = snap.kpis.find((item) => item.label === '账户盈亏');
  assert.equal(kpi.value, snap.pnl.float);
  assert.equal(snap.pnl.source, 'derived');
  assert.equal(snap.pnl.realized, 0);
  assert.equal(snap.pnl.sellCount, 0);
  assert.match(kpi.note, /暂无卖出流水/);
});

test('账户盈亏：登记本金后按账户口径，副行把账实差异拆出来', async () => {
  const ledger = setup();
  ledger.addCapital(10000, { date: '2026-01-05', note: '初始投入' });
  const snap = await buildPortfolio({
    ledger,
    fetchQuotes: quoteStub,
    fetchMedian: async () => ({ ok: false }),
  });
  const kpi = snap.kpis.find((item) => item.label === '账户盈亏');
  assert.equal(kpi.deltaLabel, '对本金');
  assert.equal(snap.pnl.source, 'capital');
  assert.equal(snap.pnl.capital, 10000);
  // 总资产 − 本金 与 浮动 + 已实现 不是同一个数，差额必须写在副行
  assert.ok(Math.abs(snap.pnl.total - (kpi.value)) < 0.02);
  assert.ok(Math.abs(snap.pnl.gap - (snap.pnl.total - snap.pnl.trade)) < 0.02);
  assert.match(kpi.note, /差 /);
});
