/**
 * `astock_kline` K 线摘要（JS 版）——与 Python `_tool_kline` 输出对齐。
 */

import { fetchKlines } from './kline.js';
import { pctChange } from './market.js';
import {
  compensatedSum, pyRound,
} from './formula.js';
import {
  f, pct, table,
} from './format.js';

/**
 * @param {object} args { code, period?, limit?, adjust?, with_bars? }
 * @param {{fetchKlines?: Function}} [options]
 */
export async function runKline(args = {}, options = {}) {
  const rawCode = String(args.code || '').trim();
  if (!rawCode) return '[Error] 需要 code';
  const period = String(args.period || 'day');
  const limit = Math.trunc(Number(args.limit) || 120);
  const adjust = String(args.adjust || 'qfq');
  const fetchK = options.fetchKlines || fetchKlines;
  const result = await fetchK(rawCode, {
    period, limit, adjust, useCache: true,
  });
  const bars = result?.bars || [];
  const code = result?.code || rawCode;
  if (!bars.length) return `[Error] ${code} 没有 ${period} K 线数据`;

  const closes = bars.map((bar) => bar.close).filter((value) => value);
  const vols = bars.map((bar) => bar.volume_lot).filter((value) => value);

  const ma = (n) => {
    if (closes.length < n) return null;
    return pyRound(compensatedSum(closes.slice(-n)) / n, 3);
  };

  const last = bars[bars.length - 1];
  const first = bars[0];
  const hi = Math.max(...bars.map((bar) => bar.high));
  const lo = Math.min(...bars.map((bar) => bar.low));
  const totalChg = pctChange(last.close, first.close);

  const recent = vols.slice(-5);
  const prev = vols.length >= 20 ? vols.slice(-20, -5) : vols.slice(0, -5);
  const prevSum = compensatedSum(prev);
  const volRatio = (recent.length && prev.length && prevSum > 0)
    ? pyRound((compensatedSum(recent) / recent.length) / (prevSum / prev.length), 2)
    : null;
  const pos = pctChange(last.close, lo);

  const out = [
    `**${code} ${period} K 线**（${bars.length} 根，${first.date} → ${last.date}，`
    + `复权：${period.endsWith('m') ? '不复权' : adjust}）`,
    '',
    table(['项目', '数值'], [
      ['最新收盘', f(last.close)],
      ['区间涨跌幅', pct(totalChg)],
      ['区间最高 / 最低', `${f(hi)} / ${f(lo)}`],
      ['现价距区间低点', pct(pos)],
      ['MA5 / MA10 / MA20 / MA60',
        [5, 10, 20, 60].map((n) => f(ma(n), 3)).join(' / ')],
      ['近 5 根均量较前 5 根', volRatio ? `${f(volRatio)} 倍` : '-'],
    ]),
  ];

  const mx = ma(20);
  if (mx) {
    const rel = last.close > mx ? '上方' : '下方';
    out.push('', `现价位于 MA20 ${rel}（MA20=${Number(mx).toFixed(3)}，`
      + `现价 ${Number(last.close).toFixed(3)}），偏离 ${pct(pctChange(last.close, mx))}。`);
  }

  if (args.with_bars) {
    out.push('', '最近 10 根：', table(
      ['日期', '开', '高', '低', '收', '量(手)'],
      bars.slice(-10).map((bar) => [
        bar.date, f(bar.open), f(bar.high), f(bar.low), f(bar.close),
        f(bar.volume_lot, 0),
      ]),
    ));
  }

  out.push('', '注：以上为历史统计，不预测未来走势。');
  return out.join('\n');
}
