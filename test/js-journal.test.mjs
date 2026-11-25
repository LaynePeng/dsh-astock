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
