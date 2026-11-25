/**
 * 判断留痕（研究档案）：记判断 → 到期复核 → 审定 → 兑现统计。
 *
 * 这一层最容易被写成「荐股记录」，所以测试同时钉住**边界**：
 * 没有目标价/概率字段、兑现率只算已判定、作废不计入、判过不能重复判、
 * 拿不到价格就留 pending 不硬凑。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Ledger } from '../lib/js/ledger.js';
import { runPortfolio } from '../lib/js/portfolio.js';
import { buildJournal } from '../lib/js/panel.js';
import {
  judgeVerify, renderList, renderRecorded, renderStats, verifyRuleText,
} from '../lib/js/journal.js';

function ledgerAt() {
  return new Ledger(join(mkdtempSync(join(tmpdir(), 'dsh-astock-journal-')), 'ledger.sqlite'));
}

/** 假的行情：返回**数组**（与真实 fetchQuotes 一致，别写成 map）。 */
function quoteStub(price = 38.2) {
  return async (codes) => codes.map((code) => ({
    code: String(code), name: '测试股份', price, change_pct: -1.2,
    volume_ratio: 0.9, turnover_rate: 1.1,
  }));
}

test('记判断：缺内容/方向非法/条件缺价位都要报错', () => {
  const ledger = ledgerAt();
  assert.throws(() => ledger.saveThesis({ code: '600000' }), /claim/);
  assert.throws(() => ledger.saveThesis({ code: '600000', claim: 'x', stance: 'strong-buy' }),
    /方向只能是/);
  assert.throws(() => ledger.saveThesis({
    code: '600000', claim: 'x', verify_kind: 'price_below',
  }), /verify_price/);
  assert.throws(() => ledger.saveThesis({
    code: '600000', claim: 'x', verify_date: '2026/01/01',
  }), /YYYY-MM-DD/);
});

test('记判断：快照与记录价落库，取不到价格就留空', () => {
  const ledger = ledgerAt();
  const t = ledger.saveThesis({
    code: '600000',
    claim: '跌破 38.60 后不收回就减半',
    stance: 'bear',
    basis: '周线跌破 60 日线',
    evidence_for: '主力连续 5 日净流出',
    evidence_against: '研报仍在上调盈利预测',
    verify_date: '2026-12-31',
    verify_kind: 'price_below',
    verify_price: 38.6,
    price_at: 39.1,
    snapshot: { 现价: 39.1 },
  });
  assert.equal(t.code, '600000');
  assert.equal(t.stance, 'bear');
  assert.equal(t.outcome, 'pending');
  assert.equal(t.version, 1);
  assert.equal(t.price_at, 39.1);
  assert.ok(t.snapshot.includes('现价'));

  const bare = ledger.saveThesis({ code: '000001', claim: '只观察' });
  assert.equal(bare.price_at, null);
  assert.equal(bare.stance, 'watch');
  assert.equal(bare.outcome, 'pending');
});

test('到期筛选：只看「复核日已到且未判定」，未来的不算', () => {
  const ledger = ledgerAt();
  ledger.saveThesis({ code: '600000', claim: 'A', verify_date: '2026-12-31' });
  ledger.saveThesis({ code: '600000', claim: 'B', verify_date: '2026-01-01' });
  const due = ledger.listTheses({ due: true, today: '2026-06-01' });
  assert.equal(due.length, 1);
  assert.equal(due[0].claim, 'B');
  assert.equal(ledger.countTheses({ due: true, today: '2026-06-01' }), 1);
  // 没设复核日的永远不该进「该复核」
  assert.equal(ledger.countTheses({ due: true, today: '2030-01-01' }), 2);
});

test('审定：hit/miss/void 三态，判过不能重复判，pending 不能手改', () => {
  const ledger = ledgerAt();
  const t = ledger.saveThesis({ code: '600000', claim: 'x', verify_date: '2026-01-01' });
  assert.throws(() => ledger.settleThesis(t.thesis_id, { outcome: 'pending' }), /hit/);
  const settled = ledger.settleThesis(t.thesis_id, {
    outcome: 'hit', price: 38.1, note: '到期跌到 38.10',
  });
  assert.equal(settled.outcome, 'hit');
  assert.equal(settled.outcome_price, 38.1);
  assert.equal(settled.outcome_note, '到期跌到 38.10');
  assert.ok(settled.outcome_at);
  assert.throws(() => ledger.settleThesis(t.thesis_id, { outcome: 'miss' }), /不能重复判定/);
});

test('版本演进：prev_id 叠一版，version 递增且不改上一版', () => {
  const ledger = ledgerAt();
  const v1 = ledger.saveThesis({ code: '600000', claim: '减半', verify_date: '2026-01-01' });
  const v2 = ledger.saveThesis({
    code: '600000', claim: '清仓（逻辑变了）', prev_id: v1.thesis_id,
  });
  assert.equal(v2.version, 2);
  assert.equal(v2.prev_id, v1.thesis_id);
  assert.equal(ledger.getThesis(v1.thesis_id).version, 1);
  assert.equal(ledger.thesisVersions('600000').length, 2);
});

test('兑现统计：分母只算已判定，作废与待复核单列', () => {
  const ledger = ledgerAt();
  const a = ledger.saveThesis({ code: '600000', claim: 'a' });
  const b = ledger.saveThesis({ code: '600000', claim: 'b' });
  const c = ledger.saveThesis({ code: '600000', claim: 'c' });
  ledger.saveThesis({ code: '000001', claim: 'd' });
  ledger.settleThesis(a.thesis_id, { outcome: 'hit', price: 1 });
  ledger.settleThesis(b.thesis_id, { outcome: 'miss', price: 2 });
  ledger.settleThesis(c.thesis_id, { outcome: 'void' });
  const stats = ledger.thesisStats();
  assert.equal(stats.settled, 2);
  assert.equal(stats.hit, 1);
  assert.equal(stats.miss, 1);
  assert.equal(stats.void, 1);
  assert.equal(stats.pending, 1);
  assert.equal(stats.hit_rate, 50);
  // 没判定过时不该给出 0%（那会被读成「全军覆没」）
  assert.equal(ledger.thesisStats({ code: '000001' }).hit_rate, null);
});

test('judgeVerify：跌破/站上按真实价格判，拿不到价格返回 null 不猜', () => {
  const below = { verify_kind: 'price_below', verify_price: 38.6 };
  assert.equal(judgeVerify(below, 38.5).state, 'met');
  assert.equal(judgeVerify(below, 38.7).state, 'not_met');
  assert.equal(judgeVerify(below, null).state, null);
  const above = { verify_kind: 'price_above', verify_price: 50 };
  assert.equal(judgeVerify(above, 50.1).state, 'met');
  assert.equal(judgeVerify({}, 10).state, null);
  assert.equal(verifyRuleText(below), '到期时收盘价跌破 38.60');
  assert.equal(verifyRuleText({}), '');
});

test('渲染：兑现率必须写明「不是上涨概率」', () => {
  const text = renderStats({ settled: 3, hit: 2, miss: 1, void: 0, pending: 2, hit_rate: 66.6667 });
  assert.match(text, /66\.67%/);
  assert.match(text, /不是未来上涨概率/);
  assert.match(text, /样本只有 3 条/);

  const zero = renderStats({ settled: 0, hit: 0, miss: 0, void: 0, pending: 1, hit_rate: null });
  assert.match(zero, /不预设/);

  const rec = renderRecorded({
    thesis_id: 'T20260101-01', code: '600000', name: '浦发银行', stance: 'bear',
    claim: '跌破 38.60 减半', verify_date: '2026-01-10',
    verify_kind: 'price_below', verify_price: 38.6, version: 1, price_at: 39,
  });
  assert.match(rec, /已记下判断 T20260101-01/);
  assert.match(rec, /到期时收盘价跌破 38\.60/);
  assert.match(rec, /没有目标价、没有概率/);

  const empty = renderList([], { due: true });
  assert.match(empty, /没有到期该复核/);
});

test('工具端到端：record → list(due) → settle → stats', async () => {
  const ledger = ledgerAt();
  const opts = { ledger, fetchQuotes: quoteStub(38.2) };

  const rec = await runPortfolio({
    action: 'journal_record',
    code: '600000',
    claim: '跌破 38.60 后不收回就减半',
    stance: 'bear',
    basis: '周线跌破 60 日线',
    verify_date: '2020-01-01', // 已到期，便于验证 due
    verify_kind: 'price_below',
    verify_price: 38.6,
  }, opts);
  assert.match(rec, /已记下判断/);
  assert.match(rec, /记录价/);
  // 记录价自动取自行情（38.20），并说明来源
  assert.match(rec, /38\.20/);
  assert.match(rec, /不是你的成交价/);

  const list = await runPortfolio({ action: 'journal_list', due: true }, opts);
  assert.match(list, /该复核的判断/);
  assert.match(list, /现价 38\.20 已跌破 38\.60/);

  const id = ledger.listTheses({ due: true, today: '2026-11-25' })[0].thesis_id;
  const settled = await runPortfolio({
    action: 'journal_settle', thesis_id: id, outcome: 'hit', price: 38.1, note: '如期',
  }, opts);
  assert.match(settled, /已审定/);
  assert.match(settled, /兑现/);

  const stats = await runPortfolio({ action: 'journal_stats' }, opts);
  assert.match(stats, /兑现率/);
  assert.match(stats, /\| 兑现率 \| 100\.00% \|/);
});

test('工具端到端：缺参数与异常都有可读错误，不抛栈', async () => {
  const ledger = ledgerAt();
  const opts = { ledger, fetchQuotes: quoteStub() };
  assert.match(await runPortfolio({ action: 'journal_record' }, opts), /\[Error\].*claim/);
  assert.match(await runPortfolio({ action: 'journal_settle' }, opts), /\[Error\].*thesis_id/);
  assert.match(await runPortfolio({ action: 'journal_settle', thesis_id: 'nope', outcome: 'hit' }, opts),
    /\[Error\].*没有这条判断/);
  assert.match(await runPortfolio({ action: 'journal_list', thesis_id: 'nope' }, opts),
    /\[Error\].*没有这条判断/);
});

// ── 档案面板（buildJournal）────────────────────────────────────────────

/** 面板 tick：不是所有到期行都需要现价，只有带价位条件的才去取。 */
test('回归：listTheses / countTheses 不传 today 也不抛 TDZ', () => {
  // 曾经的写法是 `today = today()`：默认值解析到参数自身，抛
  // ReferenceError: Cannot access 'today' before initialization。
  // 所有工具调用都显式传了 today，所以只有面板（不传）踩得到。
  const ledger = ledgerAt();
  ledger.saveThesis({ code: '600000', claim: 'x', verify_date: '2020-01-01' });
  assert.equal(ledger.listTheses().length, 1);
  assert.equal(ledger.countTheses(), 1);
  // 到期筛选在「不传 today」时也要按真实今天算
  assert.equal(ledger.countTheses({ due: true }), 1);
});

test('档案面板：待复核优先，判定与工具端同源', async () => {
  const ledger = ledgerAt();
  ledger.saveThesis({
    code: '600000', name: '浦发银行', stance: 'bear',
    claim: '跌破 9.50 就减半', verify_date: '2026-11-20',
    verify_kind: 'price_below', verify_price: 9.5, price_at: 9.6,
  });
  // 未到期的：不该进待复核
  ledger.saveThesis({
    code: '600519', name: '贵州茅台', stance: 'watch',
    claim: '等回调', verify_date: '2099-01-01',
  });

  const data = await buildJournal({
    ledger,
    fetchQuotes: async (codes) => codes.map((code) => ({ code, name: '浦发银行', price: 9.41 })),
  });

  assert.equal(data.view, 'journal');
  assert.equal(data.ok, true);
  assert.equal(data.empty, false);
  assert.equal(data.due.length, 1);
  assert.equal(data.due[0].code, '600000');
  assert.equal(data.due[0].judgeState, 'met');
  assert.match(data.due[0].judgeText, /现价 9\.41 已跌破 9\.50/);
  assert.equal(data.due[0].needsPrice, true);
  assert.equal(data.due[0].overdueDays, 5);
  assert.equal(data.recent.length, 2);

  // KPI：待复核 2 条（含未到期那条）、已判定 0、兑现率不给数字
  const kpi = Object.fromEntries(data.kpis.map((k) => [k.label, k.value]));
  assert.equal(kpi['待复核'], 2);
  assert.equal(kpi['已判定'], 0);
  assert.equal(kpi['兑现率'], null);
  assert.match(data.kpis.find((k) => k.label === '兑现率').note, /需先复核/);
  assert.match(data.disclaimer, /不是上涨概率/);

  // 面板判定与工具端是同一个函数：拿同一组输入比对，不能有第二套口径
  const thesis = ledger.getThesis(data.due[0].thesisId);
  assert.equal(judgeVerify(thesis, { price: 9.41 }).state, data.due[0].judgeState);
});

test('档案面板：没有价位条件的到期行不取行情（省一次请求）', async () => {
  const ledger = ledgerAt();
  ledger.saveThesis({
    code: '600000', claim: '人工判断的一条', verify_date: '2020-01-01',
  });
  let asked = null;
  const data = await buildJournal({
    ledger,
    fetchQuotes: async (codes) => { asked = codes; return []; },
  });
  assert.equal(asked, null, '不该为没有价位条件的行去拉行情');
  assert.equal(data.due.length, 1);
  assert.equal(data.due[0].needsPrice, false);
  assert.equal(data.due[0].judgeState, null);
  assert.equal(data.due[0].price, null);
});

test('档案面板：行情取不到时价格为 null，判定为「无法自动判定」，不编数字', async () => {
  const ledger = ledgerAt();
  ledger.saveThesis({
    code: '600000', claim: 'x', verify_date: '2020-01-01',
    verify_kind: 'price_below', verify_price: 9.5,
  });
  const data = await buildJournal({
    ledger,
    fetchQuotes: async () => { throw new Error('断网'); },
  });
  assert.equal(data.ok, true, '行情挂了不能让整页挂掉');
  assert.equal(data.due[0].price, null);
  assert.equal(data.due[0].judgeState, null);
  assert.match(data.due[0].judgeText, /取不到当前价/);
});

test('档案面板：空档案给可操作的空态，不是空白页', async () => {
  const data = await buildJournal({ ledger: ledgerAt(), fetchQuotes: async () => [] });
  assert.equal(data.empty, true);
  assert.equal(data.due.length, 0);
  assert.equal(data.recent.length, 0);
  assert.equal(data.kpis.length, 4);
  assert.equal(Object.fromEntries(data.kpis.map((k) => [k.label, k.value]))['兑现率'], null);
});

test('档案面板：台账读不到返回 ok:false + hint，不抛给宿主', async () => {
  const broken = {
    thesisStats() { throw new Error('database is locked'); },
    listTheses() { return []; },
  };
  const data = await buildJournal({ ledger: broken });
  assert.equal(data.ok, false);
  assert.match(data.error, /database is locked/);
  assert.match(data.hint, /重启 DSH/);
});

test('审定后：待复核减少、兑现率立刻反映（面板重拉看到的数）', async () => {
  const ledger = ledgerAt();
  const a = ledger.saveThesis({
    code: '600000', claim: 'A', verify_date: '2020-01-01',
    verify_kind: 'price_below', verify_price: 9.5,
  });
  const opts = { ledger, fetchQuotes: async (codes) => codes.map((code) => ({ code, price: 9.4 })) };

  const before = await buildJournal(opts);
  assert.equal(before.due.length, 1);

  ledger.settleThesis(a.thesis_id, { outcome: 'hit', price: 9.4 });
  const after = await buildJournal(opts);
  assert.equal(after.due.length, 0);
  const kpi = Object.fromEntries(after.kpis.map((k) => [k.label, k.value]));
  assert.equal(kpi['已判定'], 1);
  assert.equal(kpi['兑现率'], 100);
});
