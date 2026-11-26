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
import { snapshot } from '../lib/js/portfolio.js';

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

test('累计盈亏：已卖出标的的亏损计入总额，并给出可核对的倒推本金', async () => {
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
  assert.match(snap.text, /累计盈亏（浮动 \+ 已实现）/);
  assert.match(snap.text, /只看浮动盈亏会把/);
});

test('累计盈亏：没有卖出流水时等于浮动盈亏，不虚构已实现', async () => {
  const ledger = ledgerAt();
  ledger.setCash(20000);
  ledger.recordTrade('002241', 'buy', 26.00, 100, { tradeDate: '2026-11-09', name: '歌尔股份' });

  const snap = await snapshot(ledger, { fetchQuotes: quoteStub });
  assert.equal(snap.data.realized_sell_count, 0);
  assert.equal(snap.data.realized_pnl, 0);
  assert.equal(snap.data.total_pnl, snap.data.float_pnl);
});
