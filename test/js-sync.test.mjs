import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseReceipt, parseCsv, parseLines } from '../lib/js/receipt.js';
import { runSync } from '../lib/js/sync.js';
import { Ledger } from '../lib/js/ledger.js';

test('回单解析：逐行格式', () => {
  const parsed = parseReceipt('600000 买入 9.53 2000 2026-10-24\n000001 卖出 11.20 500 2026-10-24');
  assert.equal(parsed.method, 'lines');
  assert.equal(parsed.trades.length, 2);
  const [buy, sell] = parsed.trades;
  assert.equal(buy.code, '600000');
  assert.equal(buy.side, 'buy');
  assert.equal(buy.price, 9.53);
  assert.equal(buy.shares, 2000);
  assert.equal(buy.trade_date, '2026-10-24');
  assert.equal(buy.ok, true);
  assert.equal(sell.side, 'sell');
});

test('回单解析：CSV 表头 / 费用合并 / 金额校验', () => {
  const text = '证券代码,证券名称,买卖标志,成交价格,成交数量,成交金额,成交日期,手续费,印花税,过户费\n'
    + '600000,浦发银行,买入,9.53,2000,19060.00,2026-10-24,5.00,0,0.19\n'
    + '000001,平安银行,卖出,11.20,500,5600.00,2026-10-24,5.00,2.80,0.06';
  const trades = parseCsv(text);
  assert.equal(trades.length, 2);
  assert.equal(trades[0].fee, 5.19);
  assert.equal(trades[0].name, '浦发银行');
  assert.equal(trades[1].fee, 7.86);
  assert.equal(trades[0].ok, true);

  const bad = parseCsv('证券代码,买卖标志,成交价格,成交数量,成交金额\n'
    + '600000,买入,9.53,2000,100.00');
  assert.equal(bad[0].ok, false);
  assert.match(bad[0].problems[0], /金额校验不符/);
});

test('回单解析：缺字段进 unparsed / 重复去重', () => {
  const parsed = parseReceipt('600000 买入 9.53\n600000 买入 9.53 2000\n600000 买入 9.53 2000');
  assert.equal(parsed.trades.length, 2);
  assert.equal(parsed.duplicates_removed, 1);
  assert.equal(parsed.unparsed.length, 1);
  assert.equal(parsed.usable.length, 1);
});

test('astock_sync：预览不落账 / 落账更新持仓 / 资金提示', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-astock-sync-'));
  const ledger = new Ledger(path.join(dir, 'ledger.sqlite'));
  ledger.setCash(50000);
  const text = '600000 买入 9.53 2000 2026-10-24';

  const preview = await runSync({ text, dry_run: true }, { ledger });
  assert.match(preview, /未落账/);
  assert.match(preview, /确认无误后用 `dry_run=false`/);
  assert.equal(ledger.listPositions().length, 0);

  const done = await runSync({ text, dry_run: false }, { ledger });
  assert.match(done, /成交已同步/);
  assert.match(done, /落账结果：成功 1 笔/);
  assert.match(done, /本次净资金变动 -19,065\.19 元/);
  const pos = ledger.listPositions()[0];
  assert.equal(pos.shares, 2000);
  assert.equal(pos.cost_price, 9.5326);

  fs.rmSync(dir, { recursive: true, force: true });
});
