/**
 * 全市场涨跌中位数：取样、偶数中位、停牌兜底与缓存。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchMedianChange, resetMedianCache } from '../lib/js/breadth.js';

function stub(handler) {
  const calls = [];
  return {
    calls,
    fetchJsonImpl: async (url, options) => {
      calls.push(url);
      return handler(url, options);
    },
  };
}

test('中位数：奇数总量取正中间那条', async () => {
  resetMedianCache();
  const { calls, fetchJsonImpl } = stub((url) => {
    if (new URL(url).searchParams.get('pz') === '1') return { data: { total: 5 } };
    return { data: { diff: [{ f3: -3 }, { f3: -1 }, { f3: 0 }, { f3: 2 }, { f3: 5 }] } };
  });
  const result = await fetchMedianChange({ fetchJsonImpl, now: 1000 });
  assert.equal(result.ok, true);
  assert.equal(result.median, 0);
  assert.equal(result.total, 5);
  assert.equal(calls.length, 2);
});

test('中位数：偶数总量取中间两条均值', async () => {
  resetMedianCache();
  const { fetchJsonImpl } = stub((url) => (
    new URL(url).searchParams.get('pz') === '1' ? { data: { total: 4 } }
      : { data: { diff: [{ f3: -2 }, { f3: 0 }, { f3: 1 }, { f3: 3 }] } }
  ));
  const result = await fetchMedianChange({ fetchJsonImpl, now: 2000 });
  assert.equal(result.ok, true);
  assert.equal(result.median, 0.5);
});

test('中位数：停牌股混进来时退回样本中位并标 approximate', async () => {
  resetMedianCache();
  const { fetchJsonImpl } = stub((url) => (
    new URL(url).searchParams.get('pz') === '1' ? { data: { total: 5 } }
      : { data: { diff: [{ f3: '-' }, { f3: -1 }, { f3: 0 }, { f3: 2 }, { f3: 5 }] } }
  ));
  const result = await fetchMedianChange({ fetchJsonImpl, now: 3000 });
  assert.equal(result.ok, true);
  assert.equal(result.approximate, true);
  assert.equal(result.median, 2); // 有效值 [-1,0,2,5]，样本中位取第 3 个 = 2
});

test('中位数：接口失败返回 ok=false，不抛', async () => {
  resetMedianCache();
  const { fetchJsonImpl } = stub(() => { throw new Error('boom'); });
  const result = await fetchMedianChange({ fetchJsonImpl, now: 4000 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /boom/);
});

test('中位数：60 秒内命中缓存，不重复请求', async () => {
  resetMedianCache();
  const { calls, fetchJsonImpl } = stub((url) => (
    new URL(url).searchParams.get('pz') === '1' ? { data: { total: 3 } }
      : { data: { diff: [{ f3: -1 }, { f3: 0 }, { f3: 1 }] } }
  ));
  await fetchMedianChange({ fetchJsonImpl, now: 5000 });
  await fetchMedianChange({ fetchJsonImpl, now: 5000 + 30_000 });
  assert.equal(calls.length, 2); // 第一次 2 条请求，第二次命中缓存
});
