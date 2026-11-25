/**
 * 数据口径声明（as-of）：价格性质必须跟着交易时段走。
 *
 * 这条规则看着琐碎，但它是「浮盈 +3%」到底代表哪个时刻的唯一线索：
 * 盘中是实时价、午休是上午收盘价、收盘后是当日收盘价、开盘前是上一交易日收盘价。
 * 四者混用是本章最常见的误读来源，所以逐个时段钉死。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SOURCE_LAG, asOfBlock, asOfLine, dataCutoff, lagNotes,
} from '../lib/js/asof.js';

/** 北京时间 → Date（测试里显式给时区，不依赖本机 tz）。 */
function cn(iso) {
  return new Date(`${iso}+08:00`);
}

test('盘中：上午连续竞价 → 实时价', () => {
  const c = dataCutoff(cn('2026-11-25T10:00:00'));
  assert.equal(c.phase, '上午连续竞价');
  assert.equal(c.open, true);
  assert.equal(c.date, '2026-11-25');
  assert.equal(c.time, '10:00');
  assert.equal(c.price_basis, '实时价（随时变动）');
});

test('午间休市 → 上午收盘价（不是实时价，也不是当日收盘价）', () => {
  const c = dataCutoff(cn('2026-11-25T12:00:00'));
  assert.equal(c.phase, '午间休市');
  assert.equal(c.open, false);
  assert.equal(c.price_basis, '上午收盘价');
});

test('收盘后 → 当日收盘价', () => {
  const c = dataCutoff(cn('2026-11-25T18:45:00'));
  assert.equal(c.phase, '已收盘');
  assert.equal(c.time, '18:45');
  assert.equal(c.price_basis, '当日收盘价');
});

test('开盘前 → 上一交易日收盘价（别把昨天收盘价说成今天）', () => {
  const c = dataCutoff(cn('2026-11-25T08:10:00'));
  assert.equal(c.phase, '开盘前');
  assert.equal(c.price_basis, '上一交易日收盘价');
});

test('周末 → 非交易日，价格同样是上一交易日收盘价', () => {
  const c = dataCutoff(cn('2026-11-28T10:00:00'));
  assert.equal(c.trading_day, false);
  assert.equal(c.price_basis, '上一交易日收盘价');
});

test('asOfLine 带日期、时刻、时段与价格性质', () => {
  const line = asOfLine(cn('2026-11-25T14:58:00'));
  assert.match(line, /取数 2026-11-25 14:58/);
  assert.match(line, /已收盘|收盘集合竞价|下午连续竞价/);
  assert.match(line, /价格为/);
});

test('asOfBlock 只列本次用到的数据源，未知键忽略', () => {
  const text = asOfBlock(cn('2026-11-25T18:45:00'), {
    keys: ['margin', 'holders', '不存在的键'],
  });
  assert.match(text, /数据口径/);
  assert.match(text, /两融余额：T\+1/);
  assert.match(text, /股东户数：按季披露/);
  assert.ok(!text.includes('不存在的键'));
  // 「缺数据不用 0 代替」这条底线必须出现，它是本模块存在的理由
  assert.match(text, /不以 0 或估计值替代/);
});

test('asOfBlock 支持自定义标题与额外说明行', () => {
  const text = asOfBlock(cn('2026-11-25T18:45:00'), {
    title: '本页口径',
    extra: ['分部构成按中报/年报披露', '   '],
  });
  assert.match(text, /【本页口径】/);
  assert.match(text, /分部构成按中报\/年报披露/);
  // 空白行不该变成空 bullet
  assert.ok(!/-\s*$/.test(text.split('\n').pop() || ''));
});

test('lagNotes 只返回句子，不做成表格', () => {
  const notes = lagNotes(['quote', 'backtest']);
  assert.equal(notes.length, 2);
  assert.match(notes[0], /行情快照/);
  assert.match(notes[1], /幸存者偏差/);
});

test('SOURCE_LAG 覆盖插件里所有混源时间轴（少一个就是一处误导）', () => {
  for (const key of ['quote', 'margin', 'holders', 'segment', 'lhb',
    'forecast', 'report', 'earnings', 'backtest']) {
    assert.ok(SOURCE_LAG[key], `${key} 缺滞后说明`);
    assert.ok(SOURCE_LAG[key].lag.trim().length > 0);
  }
});

test('盘后复盘邮件：正文和 HTML 都带口径声明（混源时间轴必须写明）', async () => {
  const { buildReport } = await import('../lib/js/report.js');
  const now = cn('2026-11-25T15:30:00');
  const report = await buildReport({}, {}, {
    now,
    sentimentLimit: 0,
    collectSentiment: async () => ({ items: [] }),
    snapshot: async () => ({
      data: {
        positions: [{
          code: '600000', name: '浦发银行', shares: 1000, cost_price: 9, price: 9.5,
        }],
        quotes: { 600000: { code: '600000', price: 9.5, change_pct: 1 } },
        equity: 9500, cash: 0, total_market_value: 9500,
        float_pnl: 500, today_pnl: 100, realized_pnl: 0, total_fee: 0,
      },
    }),
    indexQuote: async () => null,
  });
  // 取数时刻 + 价格性质，放在最前面才能在读数字之前校正预期
  assert.match(report.text, /取数 2026-11-25 15:30（已收盘）· 价格为当日收盘价/);
  assert.match(report.text, /两融余额：T\+1/);
  assert.match(report.text, /股东户数：按季披露/);
  assert.match(report.html, /价格为当日收盘价/);
  assert.match(report.html, /两融 T\+1/);
  assert.equal(report.subject.includes('盘后复盘 2026-11-25'), true);
});
