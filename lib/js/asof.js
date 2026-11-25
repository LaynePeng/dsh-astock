/**
 * 数据口径声明（as-of）——「这个数是什么时候的、怎么算的」。
 *
 * 为什么单独做：本插件的数据是**混源多时间轴**的——行情是秒级、两融是 T+1、
 * 股东户数是季报滞后数周、分部构成按中报/年报、回测只有约 2.6 年历史。
 * 不把这些时间轴写出来，用户看到「浮盈 +3%」时无法判断这是 14:57 的快照
 * 还是昨天的收盘价，看到「两融下降」也不知道那其实是前天的数据。
 *
 * 所以凡是**对外输出**（邮件报告、工具回答、面板卡片）都应该带一段口径声明。
 * 这里只做声明，不做取数：声明里出现的每个时间都从真实数据源来，
 * 取不到就写「未知」，绝不替用户编一个看起来合理的时刻。
 *
 * 三个导出层次，按篇幅选用：
 *   · `asOfLine()`  —— 一行（工具输出的开头/结尾）
 *   · `asOfBlock()` —— 一小段（报告、盘后邮件）
 *   · `SOURCE_LAG`  —— 单条数据的滞后说明（按需拼进表格注释）
 */

import { tradingStatus } from './market.js';

/**
 * 各类数据的固有滞后。
 *
 * 这里写的是**数据本身的披露节奏**，不是我们的取数延迟：两融余额由交易所
 * T+1 披露，再怎么实时轮询也只能拿到昨天的。把这层说清楚，用户才不会
 * 拿一个昨天的数当今天的信号。
 */
export const SOURCE_LAG = {
  quote: { name: '行情快照', lag: '实时报价；收盘后为当日收盘价' },
  kline: { name: 'K 线', lag: '默认前复权（除权会重算整段历史，跨分红比较务必看复权口径）' },
  flow: { name: '资金流', lag: '盘中为累计净额，收盘后才定型' },
  margin: { name: '两融余额', lag: 'T+1 盘后披露——今天查到的是昨天的' },
  holders: { name: '股东户数', lag: '按季披露（季末后数周），滞后明显' },
  segment: { name: '主营分部', lag: '按中报/年报披露，不是实时数据' },
  lhb: { name: '龙虎榜', lag: 'T 日盘后披露' },
  block: { name: '大宗交易', lag: '盘后披露，成交价与二级市场不同口径' },
  dividend: { name: '分红送转', lag: '按公告方案，实施日才真正到账' },
  lockup: { name: '限售解禁', lag: '按公告的上市流通日；解禁不等于减持' },
  forecast: { name: '业绩预告', lag: '公司主动披露的区间值，不是最终财报数' },
  report: { name: '财报', lag: '按报告期（季末）结算，披露后不再变动' },
  earnings: { name: '预约披露日', lag: '公司可变更预约日，以实际披露为准' },
  archive: { name: '本地存档', lag: '只存不复权原始价；前复权请看在线接口' },
  backtest: {
    name: '回测',
    lag: '在线历史约 2.6 年上限；不含退市股（幸存者偏差，真实表现会略差）',
  },
};

/**
 * 取数时刻与价格性质。
 *
 * 价格性质必须跟着交易时段走：盘中是实时价、午休是上午收盘价、
 * 收盘后是当日收盘价、开盘前是上一交易日收盘价。四者混用是本章最常见的误读来源。
 */
export function dataCutoff(now = new Date()) {
  const st = tradingStatus(now);
  const [date = '', clock = '00:00:00'] = String(st.now || '').split(' ');
  let priceBasis;
  if (st.open) priceBasis = '实时价（随时变动）';
  else if (st.phase === '已收盘') priceBasis = '当日收盘价';
  else if (st.phase === '午间休市') priceBasis = '上午收盘价';
  else priceBasis = '上一交易日收盘价';
  return {
    open: st.open,
    phase: st.phase,
    trading_day: st.is_trading_day !== false,
    date,
    time: clock.slice(0, 5),
    stamp: st.now,
    price_basis: priceBasis,
  };
}

/** 一行口径（工具输出用；足够短，不会把回答撑成免责声明墙）。 */
export function asOfLine(now = new Date()) {
  const c = dataCutoff(now);
  return `取数 ${c.date} ${c.time}（${c.phase}）· 价格为${c.price_basis}`;
}

/**
 * 多行口径块（报告/邮件用）。
 *
 * @param {Date} [now]
 * @param {{keys?: string[], extra?: string[], title?: string}} [options]
 *        keys: SOURCE_LAG 的键，按顺序列出本次用到的数据源滞后说明
 *        extra: 额外的自定义说明行
 */
export function asOfBlock(now = new Date(), { keys = [], extra = [], title = '数据口径' } = {}) {
  const c = dataCutoff(now);
  const lines = [
    `**【${title}】**`,
    `- 取数时间：${c.date} ${c.time}（${c.phase}）· 价格为**${c.price_basis}**`,
  ];
  for (const key of keys) {
    const item = SOURCE_LAG[key];
    if (item) lines.push(`- ${item.name}：${item.lag}`);
  }
  for (const line of extra) {
    if (String(line || '').trim()) lines.push(`- ${line}`);
  }
  lines.push('- 缺数据一律显示 `-`，**不以 0 或估计值替代**；本段不含涨跌预测。');
  return lines.join('\n');
}

/** 只挑滞后说明的纯文本句子（表格注释、行内提示用）。 */
export function lagNotes(keys = []) {
  return keys.map((key) => SOURCE_LAG[key]).filter(Boolean)
    .map((item) => `${item.name}：${item.lag}`);
}
