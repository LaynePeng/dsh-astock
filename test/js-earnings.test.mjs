/**
 * 财报预约披露日历（astock_extra action=earnings）。
 *
 * 这个功能的价值不在「列出全市场」，而在**按人切**：我的持仓/自选里
 * 谁在窗口内披露，以及这个窗口的披露节奏。所以测试重点验证尽调顺序，
 * 而不是把两千行代码原样搬上来。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { runExtra } from '../lib/js/extra-tool.js';

/** 校准过的新结构：total 是接口准确总数，rhythm 是逐日只数，mine 是命中交集。 */
function calStub({ total = 3, rhythm = [], mine = [], days = 3, truncated = false } = {}) {
  return async () => ({
    from: '2026-11-26',
    to: '2026-11-28',
    days,
    total,
    rhythm: rhythm.length ? rhythm : [
      { date: '2026-11-26', total: 1 },
      { date: '2026-11-27', total: 1 },
      { date: '2026-11-28', total: 1 },
    ],
    rhythm_truncated: truncated,
    mine,
  });
}

function fakeLedger({ positions = [], watch = [] } = {}) {
  return {
    listPositions: () => positions,
    listWatch: () => watch,
  };
}

const ROWS = [
  {
    code: '600000', name: '浦发银行', report_date: '2026-09-30', report_type: '2026年三季报',
    board: '银行', appoint_date: '2026-11-26', actual_date: '', published: false, changed: false,
  },
  {
    code: '000001', name: '平安银行', report_date: '2026-09-30', report_type: '2026年三季报',
    board: '银行', appoint_date: '2026-11-27', actual_date: '2026-11-27', published: true, changed: true,
  },
  {
    code: '300750', name: '宁德时代', report_date: '2026-09-30', report_type: '2026年三季报',
    board: '电池', appoint_date: '2026-11-28', actual_date: '', published: false, changed: false,
  },
];

test('earnings：窗口内有持仓时，持仓那几只单独列出', async () => {
  const out = await runExtra({ action: 'earnings', days: 3 }, {
    earningsCalendar: calStub({ mine: [ROWS[0]] }),
    ledger: fakeLedger({ positions: [{ code: '600000', name: '浦发银行', shares: 1000 }] }),
  });
  assert.match(out, /财报预约披露.*2026-11-26 ~ 2026-11-28（3 天）/);
  assert.match(out, /窗口内共 \*\*3\*\* 只预约披露/);
  assert.match(out, /### 你的持仓 \/ 自选/);
  assert.match(out, /\| 600000 \| 浦发银行 \| 2026-11-26 \| 2026年三季报 \| 待披露 \|/);
  assert.match(out, /命中 1 只/);
  // 逐日节奏：证明是「节奏」而不是代码堆砌
  assert.match(out, /### 逐日节奏/);
  assert.match(out, /\| 2026-11-27 \| 1 \|/);
  // 口径：预约日可改期，不能当成铁板日程
  assert.match(out, /可以改期/);
  assert.match(out, /以实际披露日为准/);
});

test('earnings：自选也参与交叉，已披露的显示实际披露日', async () => {
  const out = await runExtra({ action: 'earnings' }, {
    earningsCalendar: calStub({ mine: [ROWS[1]] }),
    ledger: fakeLedger({ watch: [{ code: '000001', name: '平安银行' }] }),
  });
  assert.match(out, /已披露（2026-11-27）/);
  assert.match(out, /命中 1 只/);
});

test('earnings：窗口内没有我的标的时，明确说不交叉，不硬凑', async () => {
  const out = await runExtra({ action: 'earnings' }, {
    earningsCalendar: calStub({ mine: [] }),
    ledger: fakeLedger({ positions: [{ code: '601398', name: '工商银行', shares: 500 }] }),
  });
  assert.match(out, /都不在这个窗口内披露/);
});

test('earnings：没有台账时降级为全市场日历，不报错', async () => {
  const out = await runExtra({ action: 'earnings' }, { earningsCalendar: calStub({ mine: [] }) });
  assert.match(out, /还没有持仓或自选/);
  assert.match(out, /### 逐日节奏/);
});

test('earnings：空窗口给出明确说明而不是空表', async () => {
  const out = await runExtra({ action: 'earnings' }, { earningsCalendar: calStub({ total: 0, mine: [] }) });
  assert.match(out, /没有预约披露记录/);
  assert.match(out, /披露截止/);
  assert.match(out, /还没生成预约日/);
});

test('earnings：取数失败转成可读错误', async () => {
  const out = await runExtra({ action: 'earnings' }, {
    earningsCalendar: async () => { throw new Error('接口超时'); },
  });
  assert.match(out, /\[Error\].*接口超时/);
});
