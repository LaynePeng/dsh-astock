import assert from 'node:assert/strict';
import test from 'node:test';

import { companyInText, runEvents } from '../lib/js/events.js';

test('companyInText：【公司：】格式 / 句首公司名 / 搜索不到', async () => {
  const search = async () => [{ code: '600000', name: '浦发银行' }];
  assert.deepEqual(
    await companyInText('【浦发银行：拟回购股份】', { search }),
    { code: '600000', name: '浦发银行' },
  );
  assert.deepEqual(
    await companyInText('浦发银行股份有限公司发布公告', { search }),
    { code: '600000', name: '浦发银行' },
  );
  assert.equal(await companyInText('今天天气不错', { search }), null);
  assert.equal(await companyInText('【某公司：公告】', { search: async () => [] }), null);
});

test('astock_events：命中 / 资金印证 / 背离提示', async () => {
  const feed = [
    { title: '【浦发银行：拟回购股份】', summary: '浦发银行拟回购股份', as_of: '2026-11-07 10:00', source: '新浪财经·7×24' },
    { title: '【浦发银行：股东减持】', summary: '浦发银行股东减持', as_of: '2026-11-07 11:00', source: '新浪财经·7×24' },
  ];
  const out = await runEvents({ kind: '回购', limit: 1 }, {
    fetchFeed: async () => feed,
    search: async () => [{ code: '600000', name: '浦发银行' }],
    fetchMoneyFlow: async () => [{ main_net: -2e7 }],
    sleep: async () => {},
  });
  assert.match(out, /^\*\*事件驱动候选\*\*（回购，快讯流实时）/);
  assert.match(out, /- ⚠️ \*\*浦发银行（600000）\*\*｜回购：【浦发银行：拟回购股份】/);
  assert.match(out, /5日主力净流入 -0\.20 亿/);
  assert.match(out, /消息利好但资金在撤/);
  assert.match(out, /不构成投资建议/);
});

test('astock_events：无命中文案 / 利空默认跳过', async () => {
  const feed = [{ title: '【浦发银行：股东减持】', summary: '浦发银行股东减持', as_of: '', source: '' }];
  const none = await runEvents({}, {
    fetchFeed: async () => feed,
    search: async () => [{ code: '600000', name: '浦发银行' }],
    fetchMoneyFlow: async () => [],
    sleep: async () => {},
  });
  assert.match(none, /没有匹配的个股硬事件/);
  assert.match(none, /回购\/增持\/中标/);

  const bad = await runEvents({ kind: '利空' }, {
    fetchFeed: async () => feed,
    search: async () => [{ code: '600000', name: '浦发银行' }],
    fetchMoneyFlow: async () => [],
    sleep: async () => {},
  });
  assert.match(bad, /利空：/);
});
