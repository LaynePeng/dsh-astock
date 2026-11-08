import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Ledger } from '../lib/js/ledger.js';
import { runWatch } from '../lib/js/watch-tool.js';

function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-astock-watch-'));
  return { dir, ledger: new Ledger(path.join(dir, 'ledger.sqlite')) };
}

test('astock_watch：add / list / remove / 空列表', async () => {
  const { dir, ledger } = temp();
  const empty = await runWatch({ action: 'list' }, { ledger });
  assert.match(empty, /自选列表为空/);

  const added = await runWatch({
    action: 'add', code: '600000', name: '浦发银行', note: '银行',
  }, { ledger });
  assert.equal(added, '✅ 已加入自选：浦发银行(600000)');

  const list = await runWatch({ action: 'list' }, {
    ledger,
    fetchQuotes: async () => [{ code: '600000', name: '浦发银行', price: 10.03, change_pct: 1.62 }],
  });
  assert.match(list, /\| 600000 \| 浦发银行 \| 10\.03 \| \+1\.62% \| 银行 \|/);

  const removed = await runWatch({ action: 'remove', code: '600000' }, { ledger });
  assert.equal(removed, '✅ 已从自选移除');
  assert.equal(ledger.listWatch().length, 0);

  const again = await runWatch({ action: 'remove', code: '600000' }, { ledger });
  assert.equal(again, '该代码不在自选列表中');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('astock_watch：缺 code / plan 交给 watch-tool', async () => {
  const { dir, ledger } = temp();
  assert.equal(await runWatch({ action: 'add' }, { ledger }), '[Error] 需要 code');
  assert.equal(await runWatch({ action: 'remove' }, { ledger }), '[Error] 需要 code');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('astock_watch：plan / set_rules 本地计划', async () => {
  const { dir, ledger } = temp();
  const planPath = path.join(dir, 'watch-plan.json');

  const empty = await runWatch({ action: 'plan' }, { ledger, planPath, interval: 300 });
  assert.match(empty, /盯盘规则（当前实际生效）/);
  assert.match(empty, /没有配置精确价位规则/);

  const set = await runWatch({
    action: 'set_rules',
    rules: [{ code: '600000', name: '浦发银行', op: 'lt', price: 9.5, severity: 'action' }],
    stop_loss_pct: 6,
  }, { ledger, planPath, interval: 300, enabled: true });
  assert.match(set, /✅ 已写入盯盘规则（共 1 条）/);
  assert.match(set, /止损线/);
  assert.match(set, /\| 600000 \| 浦发银行 \| 跌破 \| 9\.50 \| action \|/);

  const view = await runWatch({ action: 'plan' }, { ledger, planPath, interval: 300 });
  assert.match(view, /价位规则（1 条）/);
  assert.match(view, /600000/);
  assert.match(view, /止损线 \| 6/);

  const add = await runWatch({
    action: 'set_rules',
    add_rules: [{ code: '300001', name: '特锐德', op: 'gt', price: 20 }],
  }, { ledger, planPath });
  assert.match(add, /共 2 条/);

  const replace = await runWatch({
    action: 'set_rules',
    remove_rules: ['300001'],
    add_rules: [{ code: '300001', name: '特锐德', op: 'lt', price: 18 }],
  }, { ledger, planPath });
  assert.match(replace, /已替换盯盘规则/);
  assert.match(replace, /300001 是\*\*替换\*\*/);

  const clear = await runWatch({ action: 'set_rules', rules: [] }, { ledger, planPath });
  assert.match(clear, /已清空价位规则/);

  const bad = await runWatch({
    action: 'set_rules', rules: [{ code: '600000', price: 0 }],
  }, { ledger, planPath });
  assert.match(bad, /price 必须大于 0/);

  fs.rmSync(dir, { recursive: true, force: true });
});
