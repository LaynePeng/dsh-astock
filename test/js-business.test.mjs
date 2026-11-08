import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ABSENT, BELOW, BusinessMix, NA, PASS, Segment, THRESHOLD_PCT, UNKNOWN,
  judge, keywordsFrom, runBusiness,
} from '../lib/js/business.js';

function mix(over = {}) {
  return new BusinessMix({
    code: '002273',
    name: '水晶光电',
    report_date: '2026-06-30',
    by_product: [
      new Segment({ item: '光学元件', ratio_pct: 60.5, gross_pct: 30.2 }),
      new Segment({ item: '反光材料', ratio_pct: 20.1, gross_pct: 25.0 }),
      new Segment({ item: '新能源', ratio_pct: 3.2, gross_pct: 12.0 }),
      new Segment({ item: '其他', ratio_pct: 19.4, gross_pct: null }),
    ],
    ...over,
  });
}

test('门槛②：关键词同义词 / 公司名剔除', () => {
  assert.deepEqual(keywordsFrom('公司机器人业务取得突破'), ['机器人', '减速器', '谐波', 'RV', '精密传动', '智能装备']);
  const res = judge(mix({ name: '锡业股份' }), '锡业股份的锡产品涨价');
  assert.equal(res.result, ABSENT);
  assert.ok(res.keywords.includes('锡'));
});

test('门槛②：pass / below / absent / na / unknown', () => {
  const pass = judge(mix(), '', ['光学']);
  assert.equal(pass.result, PASS);
  assert.equal(pass.matched, '光学元件');
  assert.equal(pass.ratio_pct, 60.5);
  assert.equal(pass.passed, true);

  const below = judge(mix(), '', ['新能源']);
  assert.equal(below.result, BELOW);
  assert.equal(below.passed, false);

  const absent = judge(mix(), '', ['机器人']);
  assert.equal(absent.result, ABSENT);
  assert.match(absent.reason, /现有分部/);

  const na = judge(mix(), '公司发布回购公告');
  assert.equal(na.result, NA);
  assert.match(na.reason, /资本运作/);

  const unknown = judge(mix(), '公司发布公告');
  assert.equal(unknown.result, UNKNOWN);
  assert.match(unknown.reason, /未能从事件文本/);

  assert.equal(THRESHOLD_PCT, 5);
});

test('astock_business：单只输出 / 批量体检', async () => {
  const single = await runBusiness({ code: '002273', event: '机器人业务' }, {
    fetchMix: async () => mix(),
    fetchQuotes: async () => [{ code: '002273', name: '水晶光电' }],
  });
  assert.match(single, /^## 主营构成 · 门槛②判定：水晶光电（002273）/);
  assert.match(single, /\*\*结论：FAIL 不过（无此业务）\*\*/);
  assert.match(single, /\| 光学元件 \| \*\*60\.50%\*\* \| 30\.2% \|/);
  assert.match(single, /否定证据/);

  const batch = await runBusiness({ codes: ['002273'], event: '光学业务' }, {
    fetchMix: async () => mix(),
    fetchQuotes: async () => [{ code: '002273', name: '水晶光电' }],
  });
  assert.match(batch, /## 门槛②批量体检（1 只）/);
  assert.match(batch, /\*\*过 1 只 · 不过 0 只/);
  assert.match(batch, /\| 水晶光电（002273）\| PASS 过 \| 光学元件 60\.5% \|/);
});

test('astock_business：缺 code 文案 / 批量未指定业务', async () => {
  const empty = await runBusiness({});
  assert.match(empty, /^\[Error\] 需要 code/);

  const batch = await runBusiness({ codes: ['002273'] }, {
    fetchMix: async () => mix(),
    fetchQuotes: async () => [{ code: '002273', name: '水晶光电' }],
  });
  assert.match(batch, /未指定业务，只列主营构成/);
  assert.match(batch, /光学元件 60\.5%/);
});
