/**
 * 全市场涨跌中位数（东财 clist）。
 *
 * 「跑赢沪指」的问题是沪指被权重股拉动：指数涨 1%，可能六成个股在跌。
 * 中位数回答的是更朴素的问题——**今天一半以上的股票涨了多少**。
 *
 * 取数只用两次请求：
 *   1. pz=1 拿到全市场总数 total；
 *   2. 按涨幅升序取中位所在的那 100 条，取第 mid 条。
 * 结果缓存 60 秒，面板刷新不会每次都打接口。
 */

import { fetchJson } from './http.js';

const CLIST = 'https://push2.eastmoney.com/api/qt/clist/get';
const FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';
const UT = 'bd1d9ddb04089700cf9c27f6f7426281';
const PAGE = 100;
const DEFAULT_TTL_MS = 60_000;

let cache = { at: 0, value: null };

function clistUrl(page, size) {
  const query = new URLSearchParams({
    pn: String(page),
    pz: String(size),
    po: '0', // 涨幅升序：第 mid 条就是中位数
    np: '1',
    ut: UT,
    fltt: '2',
    invt: '2',
    fid: 'f3',
    fs: FS,
    fields: 'f3,f12',
  });
  return `${CLIST}?${query.toString()}`;
}

/** 测试用：清掉模块级缓存。 */
export function resetMedianCache() {
  cache = { at: 0, value: null };
}

/**
 * 取全市场涨幅中位数。
 *
 * @returns {Promise<{ok: boolean, median?: number, total?: number,
 *   approximate?: boolean, sampledAt?: string, reason?: string}>} **绝不抛**
 */
export async function fetchMedianChange({
  ttlMs = DEFAULT_TTL_MS,
  fetchJsonImpl = fetchJson,
  now = Date.now(),
} = {}) {
  if (cache.value && now - cache.at < ttlMs) return cache.value;

  try {
    const head = await fetchJsonImpl(clistUrl(1, 1), {
      headers: { referer: 'https://quote.eastmoney.com/' },
    });
    const total = Number(head?.data?.total);
    if (!Number.isFinite(total) || total <= 0) throw new Error('全市场快照为空');

    const even = total % 2 === 0;
    // 1-based 的中位序号：奇数取正中间，偶数取中间两个的下标
    const mid = even ? total / 2 : (total + 1) / 2;
    const page = Math.min(Math.ceil(mid / PAGE), Math.ceil(total / PAGE));
    const payload = await fetchJsonImpl(clistUrl(page, PAGE), {
      headers: { referer: 'https://quote.eastmoney.com/' },
    });
    const rows = Array.isArray(payload?.data?.diff) ? payload.data.diff : [];
    const values = rows.map((row) => Number(row?.f3)).filter((value) => Number.isFinite(value));
    if (!values.length) throw new Error('中位数取样为空');

    const index = mid - 1 - (page - 1) * PAGE;
    // 停牌股（f3 为 '-'）会打乱序号：能对上就用精确下标，对不上退回样本中位并标注
    const exact = values.length === rows.length;
    let median;
    if (exact) {
      median = even && Number.isFinite(values[index + 1])
        ? (values[index] + values[index + 1]) / 2
        : values[index];
    } else {
      median = values[Math.floor(values.length / 2)];
    }
    if (!Number.isFinite(median)) throw new Error('中位数取样失败');

    const result = {
      ok: true,
      median: Math.round(median * 100) / 100,
      total,
      approximate: !exact,
      sampledAt: new Date(now).toISOString(),
    };
    cache = { at: now, value: result };
    return result;
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) };
  }
}
