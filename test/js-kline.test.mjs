import assert from 'node:assert/strict';
import test from 'node:test';

import { runKline } from '../lib/js/kline-tool.js';

function bars(n = 25) {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-10-${String(i + 1).padStart(2, '0')}`,
    open: i + 1,
    close: i + 1,
    high: i + 1.5,
    low: i + 0.5,
    volume_lot: (i + 1) * 100,
  }));
}

test('astock_kline：均线 / 区间 / 量比 / MA20 位置', async () => {
  const out = await runKline({ code: '600000' }, {
    fetchKlines: async () => ({ code: '600000', bars: bars() }),
  });
  assert.match(out, /^\*\*600000 day K 线\*\*（25 根，2026-10-01 → 2026-10-25，复权：qfq）/);
  assert.match(out, /\| 最新收盘 \| 25\.00 \|/);
  assert.match(out, /\| 区间涨跌幅 \| \+2400\.00% \|/);
  assert.match(out, /\| 区间最高 \/ 最低 \| 25\.50 \/ 0\.50 \|/);
  assert.match(out, /\| 现价距区间低点 \| \+4900\.00% \|/);
  assert.match(out, /\| MA5 \/ MA10 \/ MA20 \/ MA60 \| 23\.000 \/ 20\.500 \/ 15\.500 \/ - \|/);
  assert.match(out, /\| 近 5 根均量较前 5 根 \| 1\.77 倍 \|/);
  assert.match(out, /现价位于 MA20 上方（MA20=15\.500，现价 25\.000），偏离 \+61\.29%。/);
  assert.match(out, /注：以上为历史统计，不预测未来走势。/);
});

test('astock_kline：with_bars 附带最近 10 根', async () => {
  const out = await runKline({ code: '600000', with_bars: true }, {
    fetchKlines: async () => ({ code: '600000', bars: bars() }),
  });
  assert.match(out, /最近 10 根：/);
  assert.match(out, /\| 2026-10-16 \| 16\.00 \| 16\.50 \| 15\.50 \| 16\.00 \| 1,600 \|/);
  assert.match(out, /\| 2026-10-25 \| 25\.00 \| 25\.50 \| 24\.50 \| 25\.00 \| 2,500 \|/);
  assert.doesNotMatch(out, /\| 2026-10-15 \|/);
});

test('astock_kline：缺 code / 无数据', async () => {
  assert.equal(await runKline({}), '[Error] 需要 code');
  const out = await runKline({ code: '600000' }, {
    fetchKlines: async () => ({ code: '600000', bars: [] }),
  });
  assert.equal(out, '[Error] 600000 没有 day K 线数据');
});
