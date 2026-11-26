/**
 * 「今日盈亏」口径：昨仓 + 今买 + 今卖 + 费用，四段必须自洽。
 *
 * 老实现用 (现价 - 昨收) × 当前持股数，会把今天刚买的仓位当成昨天就持有，
 * 又漏掉今天卖掉和当天费用——验收用例里偏差 164 元。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Ledger } from '../lib/js/ledger.js';
import { runPortfolio, snapshot } from '../lib/js/portfolio.js';

function todayIso() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function ledgerAt() {
  return new Ledger(join(mkdtempSync(join(tmpdir(), 'dsh-astock-pnl-')), 'ledger.sqlite'));
}

const QUOTES = {
  '002241': { code: '002241', name: '歌尔股份', price: 25.69, change: 0.95 },
  '510500': { code: '510500', name: '中证500ETF', price: 6.67, change: 0.06 },
  '512890': { code: '512890', name: '红利低波ETF', price: 1.24, change: -0.005 },
  '002532': { code: '002532', name: '天山股份', price: 11.61, change: -0.55 },
};

async function quoteStub(codes) {
  return codes.map((code) => QUOTES[code]).filter(Boolean);
}

test('今日盈亏：昨仓 + 今买（含费） + 今卖（含费）四段合计', async () => {
  const ledger = ledgerAt();
  ledger.setCash(20000);
  const today = todayIso();
  // 昨仓
  ledger.recordTrade('510500', 'buy', 6.60, 500, { tradeDate: '2026-11-09', name: '中证500ETF' });
  ledger.recordTrade('512890', 'buy', 1.25, 3000, { tradeDate: '2026-11-09', name: '红利低波ETF' });
  ledger.recordTrade('002532', 'buy', 12.00, 100, { tradeDate: '2026-11-09', name: '天山股份' });
  // 今日：买歌尔、卖天山
  ledger.recordTrade('002241', 'buy', 25.73, 100, { tradeDate: today, name: '歌尔股份' });
  ledger.recordTrade('002532', 'sell', 11.61, 100, { tradeDate: today, name: '天山股份' });

  const snap = await snapshot(ledger, { fetchQuotes: quoteStub });
  // 歌尔 -9.03 / 510500 +30 / 512890 -15 / 天山 -60.59
  assert.ok(Math.abs(snap.data.today_pnl - (-54.62)) < 0.02, `today_pnl=${snap.data.today_pnl}`);
  assert.match(snap.text, /今日盈亏已含当日卖出标的：天山股份\(002532\)/);
  // 不可把今天新买的仓位套昨收：老实现会给出 +109 附近
  assert.ok(snap.data.today_pnl < 0);
  // 其它口径不动
  assert.ok(snap.data.float_pnl !== 0);
  assert.equal(snap.data.equity, Math.round((snap.data.total_market_value + 20000) * 100) / 100);
});

test('今日盈亏：空仓但有当日卖出，仍要计入且不报错', async () => {
  const ledger = ledgerAt();
  ledger.setCash(20000);
  const today = todayIso();
  ledger.recordTrade('002532', 'buy', 12.00, 100, { tradeDate: '2026-11-09', name: '天山股份' });
  ledger.recordTrade('002532', 'sell', 11.61, 100, { tradeDate: today, name: '天山股份' });

  const snap = await snapshot(ledger, { fetchQuotes: quoteStub });
  assert.equal(snap.data.positions.length, 0);
  assert.ok(Math.abs(snap.data.today_pnl - (-60.59)) < 0.02, `today_pnl=${snap.data.today_pnl}`);
});

test('今日盈亏：卖出标的行情缺失时不抛异常，并提示未计入', async () => {
  const ledger = ledgerAt();
  ledger.setCash(20000);
  const today = todayIso();
  ledger.recordTrade('002532', 'buy', 12.00, 100, { tradeDate: '2026-11-09', name: '天山股份' });
  ledger.recordTrade('002532', 'sell', 11.61, 100, { tradeDate: today, name: '天山股份' });

  const snap = await snapshot(ledger, { fetchQuotes: async () => [] });
  assert.equal(snap.data.today_pnl, 0);
  assert.match(snap.text, /行情缺失/);
});

// ---------------------------------------------------------------- 累计盈亏

test('账户盈亏：已卖出标的的亏损计入总额，并给出可核对的倒推本金', async () => {
  const ledger = ledgerAt();
  ledger.setCash(20000);
  ledger.recordTrade('002241', 'buy', 25.00, 1000, { tradeDate: '2026-11-09', name: '歌尔股份' });
  // 23.00 卖掉 400 股：已实现亏约 820 元（含费用），剩下的 600 股按 25.69 仍是浮盈
  ledger.recordTrade('002241', 'sell', 23.00, 400, { tradeDate: '2026-11-10', name: '歌尔股份' });

  const snap = await snapshot(ledger, { fetchQuotes: quoteStub });
  const data = snap.data;
  const expected = Math.round((data.float_pnl + data.realized_pnl) * 100) / 100;

  assert.ok(data.realized_pnl < 0, `已实现应为负：${data.realized_pnl}`);
  assert.equal(data.realized_sell_count, 1);
  assert.ok(Math.abs(data.total_pnl - expected) < 0.02, `total=${data.total_pnl} vs ${expected}`);
  // 浮盈（现价 25.69 > 成本）与累计（含已实现亏损）方向相反才说明口径真的换了
  assert.ok(data.float_pnl > 0);
  assert.ok(Math.abs(data.capital_base - (data.equity - expected)) < 0.02);
  assert.ok(data.total_pnl_pct !== null);
  assert.match(snap.text, /流水盈亏（浮动 \+ 已实现）/);
  assert.match(snap.text, /账户盈亏 = 总资产 − 净本金/);
});

test('账户盈亏：没有卖出流水时等于浮动盈亏，不虚构已实现', async () => {
  const ledger = ledgerAt();
  ledger.setCash(20000);
  ledger.recordTrade('002241', 'buy', 26.00, 100, { tradeDate: '2026-11-09', name: '歌尔股份' });

  const snap = await snapshot(ledger, { fetchQuotes: quoteStub });
  assert.equal(snap.data.realized_sell_count, 0);
  assert.equal(snap.data.realized_pnl, 0);
  assert.equal(snap.data.total_pnl, snap.data.float_pnl);
});

// ---------------------------------------------------------------- 本金（出入金）

test('本金：记一笔入金后总盈亏按「总资产 − 本金」，差额单列成账实差异', async () => {
  const ledger = ledgerAt();
  ledger.setCash(20000);
  ledger.recordTrade('002241', 'buy', 25.00, 1000, { tradeDate: '2026-11-09', name: '歌尔股份' });
  ledger.recordTrade('002241', 'sell', 23.00, 400, { tradeDate: '2026-11-10', name: '歌尔股份' });

  const before = await snapshot(ledger, { fetchQuotes: quoteStub });
  assert.equal(before.data.pnl_source, 'derived', '没登记本金时退回流口径');

  ledger.addCapital(20000, { date: '2026-11-09', note: '初始投入' });
  const snap = await snapshot(ledger, { fetchQuotes: quoteStub });

  assert.equal(snap.data.pnl_source, 'capital');
  assert.equal(snap.data.capital_total, 20000);
  assert.equal(snap.data.capital_count, 1);
  // 账户口径：总资产 − 本金
  assert.ok(Math.abs(snap.data.total_pnl - (before.data.equity - 20000)) < 0.02,
    `total=${snap.data.total_pnl}`);
  // 差额必须等量关系成立：账户 − 流水 = 差异
  assert.ok(Math.abs(snap.data.reconcile_gap
    - (snap.data.total_pnl - snap.data.trade_pnl)) < 0.02);
  assert.match(snap.text, /账户盈亏（总资产 − 本金）/);
  assert.match(snap.text, /账实差异/);
  // 差额要指明「台账从哪天开始」：开始记账之前的钱不在流水里
  assert.equal(snap.data.ledger_start, '2026-11-09');
  assert.match(snap.text, /台账第一笔成交是 2026-11-09/);
});

test('本金：action=capital_add / capital / capital_delete 走同一本账', async () => {
  const ledger = ledgerAt();
  const opts = { ledger };
  assert.match(await runPortfolio({ action: 'capital_add', amount: 0 }, opts), /\[Error\]/);
  assert.match(await runPortfolio({
    action: 'capital_add', amount: 20000, date: '2026-10-23', note: '初始投入',
  }, opts), /净本金 20,000/);

  const listed = await runPortfolio({ action: 'capital' }, opts);
  assert.match(listed, /20,000\.00/);
  assert.match(listed, /2026-10-23/);
  assert.match(listed, /初始投入/);

  const row = ledger.listCapital()[0];
  assert.match(await runPortfolio({ action: 'capital_delete', capital_id: row.id }, opts), /已删除/);
  assert.equal(ledger.netCapital().count, 0);
  assert.equal(ledger.netCapital().total, 0);
});

test('本金：负数记出金，净本金取合计；没有记录时 count=0 不当 0 本金用', async () => {
  const ledger = ledgerAt();
  assert.deepEqual(ledger.netCapital(), { total: 0, count: 0, first_date: '' });
  ledger.addCapital(20000, { date: '2026-10-23' });
  ledger.addCapital(-5000, { date: '2026-11-01', note: '取出一部分' });
  const net = ledger.netCapital();
  assert.equal(net.total, 15000);
  assert.equal(net.count, 2);
  assert.equal(net.first_date, '2026-10-23');
});

test('账实差异：1 元以内的零头（手续费/校准四舍五入）不当成账不对', async () => {
  const ledger = ledgerAt();
  ledger.setCash(20000);
  ledger.recordTrade('002241', 'buy', 25.00, 100, { tradeDate: '2026-11-09', name: '歌尔股份' });
  const snap = await snapshot(ledger, { fetchQuotes: quoteStub });
  // 本金 = 总资产 − 流水盈亏 + 0.4（模拟几百块口径外的四舍五入）
  ledger.addCapital(20000);
  const tuned = await snapshot(ledger, { fetchQuotes: quoteStub });
  assert.ok(Math.abs(tuned.data.reconcile_gap) >= 1, '这个用例的差额本来就是几千块');
  assert.match(tuned.text, /> 账实差异 [-+]?[\d,]/);

  const ledger2 = ledgerAt();
  ledger2.setCash(10000);
  ledger2.recordTrade('002241', 'buy', 25.00, 100, { tradeDate: '2026-11-09', name: '歌尔股份' });
  const base = await snapshot(ledger2, { fetchQuotes: quoteStub });
  // 让账户口径与流水口径只差 0.4 元
  ledger2.addCapital(Math.round((base.data.equity - base.data.trade_pnl - 0.4) * 100) / 100);
  const tiny = await snapshot(ledger2, { fetchQuotes: quoteStub });
  assert.ok(Math.abs(tiny.data.reconcile_gap) < 1, `gap=${tiny.data.reconcile_gap}`);
  assert.doesNotMatch(tiny.text, /> 账实差异 [-+]?[\d,]/);
});
