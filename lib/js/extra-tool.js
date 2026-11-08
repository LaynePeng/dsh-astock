/**
 * `astock_extra` 扩展数据面（第一批 11 个 action）。
 * 未覆盖的 action 返回 null，由 plugin 回退 Python。
 */

import {
  blockTrade, boardFundFlow, chinabondYield, chipDistribution, cninfoAnnouncements,
  conceptBlocks, convertibleBonds, datacenter, dividendHistory, earningsForecast,
  eastmoneyReports, equityPledge, holderCount, holderTrades, industryRank,
  institutionSurvey, ipoCalendar, klineWithTurnover, lhbMarket, lhbStock,
  limitSentiment, lockupExpiry, lprHistory, marginTrading, nbsPmi, repoFixing,
  shareBuyback, sinaFinancialReport, stStocks, thsHotList, thsLimitReason,
  thsStrong, tradingCalendar,
} from './extra-data.js';
import { normalizeCode, pctChange } from './market.js';
import {
  f, money, pct, ratio, table,
} from './format.js';

function num(value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '-';
}

function rawNum(value) {
  if (value === null || value === undefined) return '-';
  return String(value);
}

export async function runExtra(args = {}, options = {}) {
  const action = String(args.action || '').trim().toLowerCase();
  if (!action) {
    return '[Error] 需要 action。打板情绪=limit_sentiment / 题材归因=strong / '
      + '热榜=hot / 行业排名=industry / 板块资金流=board_flow / ST 名单=st / '
      + '两融=margin / 大宗=block_trade / 股东户数=holders / 分红=dividend / '
      + '解禁=lockup / 龙虎榜=lhb / 板块归属=concepts / 筹码分布=chips / '
      + '事件数据=events / 研究资料=docs / 宏观利率=macro';
  }
  const api = { ...defaults(), ...options };
  switch (action) {
    case 'hot': return hot(api, args);
    case 'industry': return industry(api, args);
    case 'board_flow': return boardFlow(api, args);
    case 'st': return st(api, args);
    case 'margin': return margin(api, args);
    case 'block_trade': return blockTradeAction(api, args);
    case 'holders': return holders(api, args);
    case 'dividend': return dividend(api, args);
    case 'lockup': return lockup(api, args);
    case 'lhb': return lhb(api, args);
    case 'concepts': return concepts(api, args);
    case 'chips': return chips(api, args);
    case 'events': return eventsData(api, args);
    case 'docs': return docs(api, args);
    case 'macro': return macro(api, args);
    case 'limit_sentiment': return limitSentimentAction(api, args);
    case 'strong': return strong(api, args);
    default:
      return `[Error] 未知 action=${action}。可用：limit_sentiment / strong / hot / `
        + 'industry / board_flow / st / margin / block_trade / holders / dividend / '
        + 'lockup / lhb / concepts / chips / events / docs / macro';
  }
}

function defaults() {
  return {
    thsHotList,
    industryRank,
    boardFundFlow,
    stStocks,
    marginTrading,
    blockTrade,
    holderCount,
    dividendHistory,
    lockupExpiry,
    lhbStock,
    lhbMarket,
    conceptBlocks,
    klineWithTurnover,
    chipDistribution,
    earningsForecast,
    institutionSurvey,
    holderTrades,
    shareBuyback,
    equityPledge,
    ipoCalendar,
    convertibleBonds,
    cninfoAnnouncements,
    eastmoneyReports,
    sinaFinancialReport,
    lprHistory,
    nbsPmi,
    chinabondYield,
    repoFixing,
    tradingCalendar,
    limitSentiment,
    thsLimitReason,
    thsStrong,
  };
}

async function hot(api, args) {
  const period = ['hour', 'day'].includes(String(args.period || 'hour').toLowerCase())
    ? String(args.period || 'hour').toLowerCase() : 'hour';
  const limit = Math.max(1, Math.min(Math.trunc(Number(args.limit) || 20), 100));
  let rows = await api.thsHotList(period);
  if (!rows.length) return '同花顺热榜当前无数据。';
  rows = rows.slice(0, limit);
  const body = table(
    ['排名', '名称(代码)', '人气值', '涨跌幅', '排名变化', '概念', '标签'],
    rows.map((r) => [
      r.rank || '-', `${r.name}(${r.code})`, f(r.heat, 0), pct(r.change_pct),
      (typeof r.rank_change === 'number' && r.rank_change > 0 ? '+' : '')
        + (r.rank_change ?? '-'),
      (r.concepts || []).join('、') || '-', r.tag || '-',
    ]),
  );
  return `**人气热榜**（同花顺${period === 'hour' ? '小时' : '日'}榜，前 ${rows.length}）\n\n`
    + `${body}\n\n注：人气值是散户关注度（crowd 级证据），热度高不等于该涨。`;
}

async function industry(api, args) {
  const topN = Math.max(3, Math.min(Math.trunc(Number(args.top_n) || 10), 30));
  const res = await api.industryRank(topN);
  const rowsOf = (items) => items.map((r) => [
    String(r.rank), r.name, pct(r.change_pct),
    `${r.up_count || 0}涨/${r.down_count || 0}跌`,
    r.leader ? `${r.leader}(${pct(r.leader_change_pct)})` : '-',
  ]);
  const headers = ['排名', '行业', '涨跌幅', '涨跌家数', '领涨股'];
  return `**行业板块排名**（共 ${res.total} 个行业）\n\n涨幅榜 TOP：\n\n`
    + `${table(headers, rowsOf(res.top))}\n\n跌幅榜 TOP：\n\n`
    + `${table(headers, rowsOf([...res.bottom].reverse()))}\n\n`
    + '注：板块涨跌幅是该板块成分股加权结果，用于定位当日资金偏好，'
    + '不代表板块内每只个股同向。';
}

async function boardFlow(api, args) {
  const btype = String(args.board_type || 'industry').toLowerCase();
  const period = String(args.period || 'today').toLowerCase();
  const topN = Math.max(3, Math.min(Math.trunc(Number(args.top_n) || 15), 50));
  let res;
  try {
    res = await api.boardFundFlow(btype, period, topN);
  } catch (error) {
    return `[Error] ${error?.message ?? error}`;
  }
  const labels = { industry: '行业', concept: '概念', region: '地域' };
  const plabel = { today: '今日', '5d': '5日', '10d': '10日' };
  if (!res.rows.length) {
    return `${labels[btype] || btype}板块 ${plabel[period] || period} 资金流为空。`;
  }
  const body = table(
    ['排名', '板块', '涨跌幅', '主力净额', '主力净占比', '领涨股'],
    res.rows.map((r) => [
      String(r.rank), r.name, pct(r.change_pct), money(r.main_net_yuan),
      r.main_pct === null || r.main_pct === undefined ? '-' : ratio(r.main_pct),
      r.leader || '-',
    ]),
  );
  return `**${labels[btype] || btype}板块资金流**（${plabel[period] || period}，`
    + `共 ${res.total} 个，按主力净额降序）\n\n${body}\n\n`
    + '注：主力净额 = 超大单 + 大单，单位已换算；'
    + '该数值是结果而非原因，流入不等于后续上涨。'
    + '板块级只有 今日/5日/10日（3 日档个股级才有）。';
}

async function st(api, args) {
  let rows = await api.stStocks();
  const market = String(args.market || '').trim().toLowerCase();
  if (['sh', 'sz', 'bj'].includes(market)) rows = rows.filter((r) => r.market === market);
  const limit = Math.max(1, Math.min(Math.trunc(Number(args.limit) || 50), 200));
  const shown = rows.slice(0, limit);
  if (!shown.length) return `ST 名单里没有${market ? '该市场' : ''}的记录。`;
  return `**ST / *ST 名单**（${market ? market.toUpperCase() : '全部'}，`
    + `共 ${rows.length} 只，显示前 ${shown.length}）\n\n`
    + `${table(['名称(代码)', '市场', '类型', '现价', '涨跌幅'], shown.map((r) => [
      `${r.name}(${r.code})`, r.market.toUpperCase(), r.st_type,
      f(r.price), pct(r.change_pct),
    ]))}\n\n注：ST / *ST 涨跌停限制为 ±5%（主板口径），`
    + '`astock_hint` 计算止损止盈时会按此口径。'
    + '名单随风险警示变动，非交易日与盘后可能滞后。';
}

async function margin(api, args) {
  const code = String(args.code || '').trim();
  if (!code) return '[Error] 需要 code';
  const { code: norm } = normalizeCode(code);
  const days = Math.max(2, Math.min(Math.trunc(Number(args.days) || 10), 60));
  let rows = await api.marginTrading(norm, days);
  if (!rows.length) {
    return `${norm} 没有两融数据（可能不是两融标的、或该市场不覆盖）。`
      + '两融标的名录可查交易所公告。';
  }
  rows = rows.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  const latest = rows[rows.length - 1];
  let trendPct = null;
  if (rows.length >= 2 && latest.fin_balance_yuan && rows[0].fin_balance_yuan) {
    trendPct = pctChange(latest.fin_balance_yuan, rows[0].fin_balance_yuan);
  }
  const lines = [`**${norm} 两融余额**（${rows.length} 个交易日）`, ''];
  lines.push(table(['项目', '数值'], [
    ['最新日期', latest.date || '-'],
    ['融资余额', money(latest.fin_balance_yuan)],
    ['融券余额', money(latest.sec_balance_yuan)],
    ['两融余额合计', money(latest.total_balance_yuan)],
    ['区间融资余额变化', pct(trendPct)],
  ]));
  lines.push('', table(
    ['日期', '融资余额', '融资买入', '融资净买', '融券余额'],
    [...rows].reverse().map((r) => [
      r.date || '-', money(r.fin_balance_yuan), money(r.fin_buy_yuan),
      money(r.fin_net_buy_yuan), money(r.sec_balance_yuan),
    ]),
  ));
  lines.push('', '注：两融余额反映杠杆资金持仓意愿，数据 T+1 披露（当日盘后才会出现今天的数据）。');
  return lines.join('\n');
}

async function blockTradeAction(api, args) {
  const code = String(args.code || '').trim();
  if (!code) return '[Error] 需要 code';
  const { code: norm } = normalizeCode(code);
  const rows = await api.blockTrade(norm, Math.max(1, Math.min(Math.trunc(Number(args.limit) || 15), 50)));
  if (!rows.length) return `${norm} 近期没有大宗交易记录（不是数据缺失）。`;
  return `**${norm} 大宗交易**（${rows.length} 笔）\n\n`
    + `${table(['日期', '成交价', '当日收盘', '溢价率', '成交量(股)', '成交额', '买方', '卖方'],
      rows.map((r) => [
        r.date || '-', f(r.price), f(r.close), pct(r.premium_pct),
        f(r.volume, 0), money(r.amount_yuan),
        (r.buyer || '-').slice(0, 14), (r.seller || '-').slice(0, 14),
      ]))}\n\n注：折价（负溢价）成交常见于大股东/机构减持，但单笔大宗不构成方向判断依据。`;
}

async function holders(api, args) {
  const code = String(args.code || '').trim();
  if (!code) return '[Error] 需要 code';
  const { code: norm } = normalizeCode(code);
  let rows = await api.holderCount(norm, Math.max(2, Math.min(Math.trunc(Number(args.limit) || 8), 20)));
  if (!rows.length) return `${norm} 没有股东户数数据。`;
  rows = rows.sort((a, b) => String(a.end_date || '').localeCompare(String(b.end_date || '')));
  const lines = [`**${norm} 股东户数**（${rows.length} 期）`, '',
    table(['报告期', '股东户数', '变化户数', '环比', '户均持仓市值'],
      [...rows].reverse().map((r) => [
        r.end_date || '-', f(r.holders, 0), f(r.change_num, 0),
        pct(r.change_pct), money(r.avg_hold_value_yuan),
      ]))];
  const latest = rows[rows.length - 1];
  const chg = latest.change_pct;
  if (chg !== null && chg !== undefined) {
    const verdict = chg < 0 ? '户数下降 → 筹码趋于集中（通常偏正面）'
      : chg > 0 ? '户数上升 → 筹码分散、散户增多（通常偏负面）' : '户数持平';
    lines.push('', `最新一期（${latest.end_date}）：${verdict}。`);
  }
  lines.push('', '注：股东户数按季披露（季末后数周），滞后性很强，不能当短期信号用。');
  return lines.join('\n');
}

async function dividend(api, args) {
  const code = String(args.code || '').trim();
  if (!code) return '[Error] 需要 code';
  const { code: norm } = normalizeCode(code);
  const rows = await api.dividendHistory(norm, Math.max(1, Math.min(Math.trunc(Number(args.limit) || 10), 30)));
  if (!rows.length) return `${norm} 没有分红送转记录。`;
  return `**${norm} 分红送转**（${rows.length} 次）\n\n`
    + `${table(['除权除息日', '报告期', '每股派息(税前)', '每10股送股', '每10股转增', '进度'],
      rows.map((r) => [
        r.ex_date || '-', r.report_date || '-', f(r.bonus_rmb_per_share, 3),
        f(r.bonus_per_10), f(r.transfer_per_10), r.progress || '-',
      ]))}\n\n注：每股派息是**税前**口径，实际到账要扣红利税（持股期限不同税率不同）。`
    + '除权除息日当天股价会按分红金额下调，不是「白跌」。';
}

async function lockup(api, args) {
  const code = String(args.code || '').trim();
  if (!code) return '[Error] 需要 code';
  const { code: norm } = normalizeCode(code);
  const days = Math.max(7, Math.min(Math.trunc(Number(args.days) || 90), 365));
  const res = await api.lockupExpiry(norm, days);
  const lines = [`**${norm} 限售解禁**（未来窗口 ${res.window}）`, ''];
  if (res.upcoming.length) {
    lines.push(`⚠️ **未来 ${res.upcoming.length} 批待解禁**`, '',
      table(['解禁日', '类型', '解禁股数(万股)', '实际可流通(万股)', '占总股本'],
        res.upcoming.map((r) => [
          r.date || '-', r.type || '-', f(r.shares_10k, 1), f(r.able_shares_10k, 1),
          r.ratio === null || r.ratio === undefined ? '-' : ratio(r.ratio * 100),
        ])));
  } else lines.push(`未来 ${days} 天内无待解禁记录。`);
  if (res.history.length) {
    lines.push('', `**历史解禁**（最近 ${Math.min(res.history.length, 8)} 批）`, '',
      table(['解禁日', '类型', '解禁股数(万股)', '实际可流通(万股)'],
        res.history.slice(0, 8).map((r) => [
          r.date || '-', (r.type || '-').slice(0, 20),
          f(r.shares_10k, 1), f(r.able_shares_10k, 1),
        ])));
  }
  lines.push('', '注：「实际可流通」比「解禁股数」更贴近真实抛压——'
    + '公告的解禁数量常含仍未流通的部分。解禁≠立刻卖出。');
  return lines.join('\n');
}

async function lhb(api, args) {
  const code = String(args.code || '').trim();
  if (code) {
    const { code: norm } = normalizeCode(code);
    const res = await api.lhbStock(norm, Math.max(30, Math.min(Math.trunc(Number(args.days) || 180), 720)));
    if (!res.records.length) {
      return `${norm} 近 ${res.window_days} 天无龙虎榜记录`
        + '（不是数据缺失——多数标的本来就不常上榜）。';
    }
    const lines = [`**${norm} 龙虎榜**（近 ${res.window_days} 天，上榜 ${res.records.length} 次）`, '',
      table(['日期', '上榜原因', '净买入(万)', '换手率', '涨跌幅'],
        res.records.slice(0, 12).map((r) => [
          r.date || '-', (r.reason || '-').slice(0, 26),
          f(r.net_buy_wan, 1), ratio(r.turnover_pct), pct(r.change_pct),
        ]))];
    if (res.seats.buy.length || res.seats.sell.length) {
      const seatTable = (rows) => table(['营业部', '买入(万)', '卖出(万)', '净额(万)'],
        rows.map((s) => [
          s.name.slice(0, 22), f(s.buy_wan, 1), f(s.sell_wan, 1), f(s.net_wan, 1),
        ]));
      lines.push('', `**${res.latest_date} 买入席位 TOP5**`, '', seatTable(res.seats.buy),
        '', `**${res.latest_date} 卖出席位 TOP5**`, '', seatTable(res.seats.sell));
    }
    const inst = res.institution;
    if (inst.buy_wan || inst.sell_wan) {
      lines.push('', `机构专用席位：买 ${f(inst.buy_wan, 1)} 万 / `
        + `卖 ${f(inst.sell_wan, 1)} 万 / 净 ${f(inst.net_wan, 1)} 万`);
    }
    lines.push('', '注：营业部席位含游资与量化，不必然是机构；'
      + '「机构专用」代码为 0 的才是机构。');
    return lines.join('\n');
  }

  const res = await api.lhbMarket(String(args.date || '') || null, args.min_net_wan);
  if (!res.stocks.length) {
    return `${res.date} 龙虎榜无记录（非交易日，或盘后数据尚未更新）。`
      + `原始记录数 ${res.raw_records}。`;
  }
  const limit = Math.max(5, Math.min(Math.trunc(Number(args.limit) || 20), 100));
  const stocks = res.stocks.slice(0, limit);
  return `**全市场龙虎榜**（${res.date}，${res.total} 条，显示前 ${stocks.length}）\n\n`
    + `${table(['名称(代码)', '上榜原因', '收盘', '涨跌幅', '净买入(万)', '买入(万)', '卖出(万)'],
      stocks.map((s) => [
        `${s.name}(${s.code})`, (s.reason || '-').slice(0, 24), f(s.close),
        pct(s.change_pct), f(s.net_buy_wan, 1), f(s.buy_wan, 1), f(s.sell_wan, 1),
      ]))}\n\n注：龙虎榜是交易所披露的客观成交数据；`
    + '净买入为营业部合计，不等于后续涨跌。';
}

async function concepts(api, args) {
  const code = String(args.code || '').trim();
  if (!code) return '[Error] 需要 code';
  const { code: norm, venue } = normalizeCode(code);
  const res = await api.conceptBlocks(norm, venue);
  if (!res.boards.length) return `${norm} 没有板块归属数据。`;
  return `**${norm} 板块/概念归属**（共 ${res.total} 个）\n\n`
    + `${table(['板块/概念', '板块代码', '板块涨跌幅', '板块龙头'],
      res.boards.map((b) => [
        b.name, b.code, pct(b.change_pct), b.leader || '-',
      ]))}\n\n注：混合行业/概念/地域三类，板块名自解释。`
    + '「被归到某个热门概念」不等于主营相关——题材炒作常见牵强挂靠。';
}

async function chips(api, args) {
  const code = String(args.code || '').trim();
  if (!code) return '[Error] 需要 code';
  const { code: norm, venue } = normalizeCode(code);
  const days = Math.max(30, Math.min(Math.trunc(Number(args.days) || 150), 640));
  const decay = Number(args.decay) || 1.0;
  const bars = await api.klineWithTurnover(norm, venue, days, String(args.adjust || 'qfq'));
  if (!bars.length) return `${norm} 没有可用 K 线，无法计算筹码分布。`;
  const res = await api.chipDistribution(bars, 300, decay);
  const c90 = res.cost_90;
  const c70 = res.cost_70;
  const lines = [`**${norm} 筹码分布**（${res.bars} 个交易日，`
    + `${res.first_date} → ${res.last_date}，衰减系数 `
    + `${Number.isInteger(decay) ? decay.toFixed(1) : String(decay)}）`, '',
  table(['指标', '数值'], [
    ['现价', f(res.price, 3)],
    ['获利比例', `${(res.profit_ratio * 100).toFixed(1)}%`],
    ['平均成本', f(res.avg_cost, 3)],
    ['90% 成本区间', `${f(c90[0], 2)} ~ ${f(c90[1], 2)}`],
    ['70% 成本区间', `${f(c70[0], 2)} ~ ${f(c70[1], 2)}`],
    ['90% 集中度', res.concentration_90 === null ? '-' : `${(res.concentration_90 * 100).toFixed(2)}%`],
    ['70% 集中度', res.concentration_70 === null ? '-' : `${(res.concentration_70 * 100).toFixed(2)}%`],
    ['筹码峰', f(res.peak_price, 3)],
    ['窗口累计换手', ratio(res.cum_turnover_pct)],
  ])];
  const cum = res.cum_turnover_pct;
  lines.push('', '**口径提示（重要）**：', '',
    `- 本窗口累计换手 ${cum.toFixed(1)}%`
    + (cum < 100
      ? '，**不足 100%** —— 窗口之前的筹码仍大量存在，'
        + '平均成本与获利比例只代表「按本窗口成交推算的分布」，'
        + '不代表全市场真实持仓成本。窗口越短，这个偏差越大：'
        + '60 日窗口累计换手往往只有十几个百分点，'
        + '此时「获利比例」几乎只反映窗口内那段行情。'
      : '，已覆盖一轮完整换手，分布相对可靠。'),
    '- 筹码分布是按日 K 的 (最高+最低+收盘)/3 与换手率递推的**模型估算**，'
      + '不是交易所披露的真实持仓数据。',
    '- 集中度越低说明筹码越分散；筹码峰在现价上方意味着上方套牢盘较重。');
  return lines.join('\n');
}


async function eventsData(api, args) {
  const what = String(args.event || 'forecast').toLowerCase();
  const code = String(args.code || '').trim();
  const days = Math.max(1, Math.min(Math.trunc(Number(args.days) || 30), 365));
  const limit = Math.max(1, Math.min(Math.trunc(Number(args.limit) || 20), 100));
  let norm = '';
  if (code) norm = normalizeCode(code).code;

  if (what === 'forecast') {
    const rows = await api.earningsForecast(norm || null,
      String(args.report_date || '') || null, limit);
    if (!rows.length) return '没有业绩预告记录（非披露季或该股未披露）。';
    return `**业绩预告**（${rows.length} 条${norm ? `，${norm}` : '，全市场最新'}）\n\n`
      + `${table(['名称(代码)', '公告日', '报告期', '指标', '类型', '预计下限', '预计上限', '同比区间'],
        rows.map((r) => [
          `${r.name}(${r.code})`, r.notice_date || '-', r.report_date || '-',
          r.indicator || '-', r.type || '-', money(r.amount_lower_yuan),
          money(r.amount_upper_yuan),
          r.change_pct_lower === null || r.change_pct_lower === undefined
            ? '-' : `${pct(r.change_pct_lower)} ~ ${pct(r.change_pct_upper)}`,
        ]))}\n\n注：一次预告会拆成多行（「指标」不同）；金额单位为元。`
      + '预告是公司自己给的区间，不等于最终财报。';
  }

  if (what === 'survey') {
    const rows = await api.institutionSurvey(norm || null, days, limit);
    if (!rows.length) return `近 ${days} 天没有机构调研记录。`;
    return `**机构调研**（近 ${days} 天，${rows.length} 场）\n\n`
      + `${table(['名称(代码)', '公告日', '接待日', '机构家数', '方式', '接待人'],
        rows.map((r) => [
          `${r.name}(${r.code})`, r.notice_date || '-', r.survey_date || '-',
          f(r.org_count, 0), (r.way || '-').slice(0, 16), (r.receptionist || '-').slice(0, 20),
        ]))}\n\n注：调研家数多说明机构关注度高，但调研本身不含任何买卖动作。`;
  }

  if (what === 'holder_trade') {
    const direction = String(args.direction || '').trim() || null;
    const rows = await api.holderTrades(norm || null, direction, days, limit);
    if (!rows.length) return `近 ${days} 天没有股东增减持记录。`;
    return `**股东增减持**（近 ${days} 天，${rows.length} 条${direction ? `，${direction}` : ''}）\n\n`
      + `${table(['名称(代码)', '股东', '方向', '变动股数(万股)', '变动后占比', '均价', '方式', '公告日'],
        rows.map((r) => [
          `${r.name}(${r.code})`, (r.holder || '-').slice(0, 18),
          r.direction || '-', f(r.change_shares_10k, 2), ratio(r.after_pct_total),
          f(r.avg_price), r.channel || '-', r.notice_date || '-',
        ]))}\n\n注：股数单位万股，减持为负；「变动后占比」 是该股东持股占总股本 %。`
      + '均价很多公告不披露，留空不是 0。';
  }

  if (what === 'buyback' || what === 'pledge') {
    if (what === 'buyback') {
      const rows = await api.shareBuyback(norm || null, null, limit);
      if (!rows.length) return `${norm || '全市场'} 没有回购记录。`;
      return `**${norm || '全市场'} 股票回购**（${rows.length} 个方案）\n\n`
        + `${table(['进度', '方案起', '方案止', '价格上限', '金额下限', '金额上限', '已回购股数', '已回购金额', '最新公告'],
          rows.map((r) => [
            r.progress || `进度码${r.progress_code}`, r.plan_start || '-', r.plan_end || '-',
            f(r.price_cap), money(r.amount_lower_yuan), money(r.amount_upper_yuan),
            f(r.done_shares, 0), money(r.done_amount_yuan), r.latest_notice || '-',
          ]))}\n\n注：「已回购」为实施进度，方案金额区间是计划而非承诺。`
        + '回购不必然注销（也可能用于股权激励），对每股价值影响不同。';
    }
    const rows = await api.equityPledge(norm || null, limit);
    if (!rows.length) return `${norm || '全市场'} 没有质押统计记录（可能是北交所——中国结算质押只覆盖沪深）。`;
    return `**${norm || '最近统计日全市场'} 股权质押**（${rows.length} 条）\n\n`
      + `${table(['统计日', '名称(代码)', '质押比例', '质押股数(万股)', '质押市值(万元)', '质押笔数'],
        rows.map((r) => [
          r.date || '-', `${r.name || '-'}(${r.code || '-'})`,
          ratio(r.pledge_ratio_pct), f(r.pledged_shares_10k, 1),
          f(r.pledged_mktcap_10k, 1), f(r.pledge_count, 0),
        ]))}\n\n注：中国结算按周统计（通常周五）。质押比例高（>50%）意味着大股东平仓风险，`
      + '但质押比例低不代表没有风险——要看具体质押价。';
  }

  if (what === 'ipo') {
    const rows = await api.ipoCalendar(limit);
    if (!rows.length) return '新股申购日历为空。';
    return `**新股申购日历**（${rows.length} 条，按申购日倒序）\n\n`
      + `${table(['名称(代码)', '申购代码', '板块', '申购日', '上市日', '发行价', '发行PE', '行业PE', '中签率'],
        rows.map((r) => [
          `${r.name}(${r.code})`, r.apply_code || '-', r.board || '-',
          r.apply_date || '-', r.listing_date || '-', f(r.issue_price),
          f(r.issue_pe), f(r.industry_pe), ratio(r.win_rate_pct),
        ]))}\n\n注：发行价在定价前为空（不是 0）；中签率是网上申购中签率 %。`;
  }

  if (what === 'convertible') {
    let rows = await api.convertibleBonds(Boolean(args.include_delisted), 1000);
    if (norm) rows = rows.filter((r) => r.stock_code === norm || r.code === norm);
    if (!rows.length) return `没有可转债记录${norm ? `（正股 ${norm}）` : ''}。`;
    rows = rows.sort((a, b) => (a.premium_pct === null ? 1 : 0)
      - (b.premium_pct === null ? 1 : 0)
      || (a.premium_pct || 0) - (b.premium_pct || 0)).slice(0, limit);
    return `**可转债**（${rows.length} 只，按溢价率升序）\n\n`
      + `${table(['转债(代码)', '正股', '状态', '评级', '债价', '正股价', '转股价', '转股价值', '溢价率'],
        rows.map((r) => [
          `${r.name}(${r.code})`, `${r.stock_name || '-'}(${r.stock_code || '-'})`,
          r.status || '-', r.rating || '-', f(r.bond_price), f(r.stock_price),
          f(r.convert_price), f(r.convert_value), pct(r.premium_pct),
        ]))}\n\n注：转股价值 = 100 / 转股价 × 正股价；溢价率 = 债价 / 转股价值 − 1。`
      + '溢价率为负代表转股后立刻卖出比持有转债更划算（需考虑流动性）。';
  }

  return `[Error] 未知 event=${what}。可用：forecast 业绩预告 / survey 机构调研 / `
    + 'holder_trade 增减持 / buyback 回购 / pledge 质押 / ipo 新股 / convertible 可转债';
}


async function docs(api, args) {
  const what = String(args.doc || 'announce').toLowerCase();
  const code = String(args.code || '').trim();
  if (!code) return '[Error] 需要 code';
  const { code: norm, venue } = normalizeCode(code);
  const limit = Math.max(1, Math.min(Math.trunc(Number(args.limit) || 15), 50));

  if (what === 'announce') {
    const rows = await api.cninfoAnnouncements(norm, limit);
    if (!rows.length) return `${norm} 近期没有巨潮公告记录。`;
    return `**${norm} 巨潮公告**（最近 ${rows.length} 条）\n\n`
      + `${table(['披露日', '标题', '类型'],
        rows.map((r) => [r.date || '-', (r.title || '-').slice(0, 60), (r.type || '-').slice(0, 16)]))}\n\n`
      + '注：巨潮资讯是证监会指定披露平台，公告属**法定披露事实**'
      + '（可靠度最高的一档证据）。标题即原文标题，未做解读——'
      + '要点开原文看具体内容与金额。';
  }

  if (what === 'report') {
    const months = Math.max(1, Math.min(Math.trunc(Number(args.months) || 12), 60));
    const rows = await api.eastmoneyReports(norm, months, limit);
    if (!rows.length) return `${norm} 近 ${months} 个月没有研报覆盖（小市值标的常见）。`;
    return `**${norm} 个股研报**（近 ${months} 个月，${rows.length} 篇）\n\n`
      + `${table(['发布日期', '机构', '评级', '标题', '今年EPS', '明年EPS', '今年PE'],
        rows.map((r) => [
          r.date || '-', r.org || '-', r.rating || '-', (r.title || '-').slice(0, 34),
          f(r.eps_this_year), f(r.eps_next_year), f(r.pe_this_year),
        ]))}\n\n注：研报是**卖方观点**（official_view 档），不是事实。`
      + '评级集中度高是行业惯例，别把「全是买入」当成安全信号。';
  }

  if (what === 'finance') {
    const rtype = String(args.report_type || 'lrb').toLowerCase();
    if (!['fzb', 'lrb', 'llb'].includes(rtype)) {
      return '[Error] report_type 只能是 fzb(资产负债) / lrb(利润) / llb(现金流)';
    }
    const rows = await api.sinaFinancialReport(norm, venue, rtype, limit);
    if (!rows.length) return `${norm} 没有财报数据。`;
    const names = { fzb: '资产负债表', lrb: '利润表', llb: '现金流量表' };
    const lines = [`**${norm} ${names[rtype]}**（最近 ${rows.length} 期）`, ''];
    for (const rec of rows) {
      const items = rec.items || {};
      let pick = Object.keys(items).filter((k) => [
        '营业总收入', '营业收入', '净利润', '归属于母公司所有者的净利润',
        '资产总计', '负债合计', '经营活动产生的现金流量净额', '货币资金', '应收账款',
      ].includes(k));
      if (!pick.length) pick = Object.keys(items).slice(0, 8);
      lines.push(`**${rec.period}**`, '',
        table(['科目', '金额', '同比'],
          pick.slice(0, 10).map((k) => [k, String(items[k] ?? '-'), String((rec.yoy || {})[k] ?? '-')])),
        '');
    }
    lines.push('注：新浪口径，金额单位随科目（多为元）。同比字段接口不一定给，留空不是 0。');
    return lines.join('\n');
  }

  return '[Error] 未知 doc。可用：announce 巨潮公告 / report 研报 / finance 财报三表';
}


async function macro(api, args) {
  const what = String(args.macro || 'lpr').toLowerCase();

  if (what === 'lpr') {
    const rows = await api.lprHistory(Math.max(1, Math.min(Math.trunc(Number(args.days) || 24), 200)));
    const latest = rows[rows.length - 1];
    const lines = [`**LPR 贷款市场报价利率**（最近 ${rows.length} 次报价）`, '',
      table(['报价日', '1 年期', '5 年期以上'],
        [...rows].reverse().map((r) => [r.date, ratio(r.lpr_1y), ratio(r.lpr_5y)]))];
    const fnum = (v) => (v === null || v === undefined ? '-'
      : Number.isInteger(Number(v)) ? Number(v).toFixed(1) : String(v));
    lines.push('', `最新（${latest.date}）：1 年期 ${fnum(latest.lpr_1y)}%、`
      + `5 年期以上 ${fnum(latest.lpr_5y)}%。`,
    '', '注：LPR 每月 20 日报价；5 年期品种 2019-08-20 才设立，更早的行留空不是 0。');
    return lines.join('\n');
  }

  if (what === 'pmi') {
    const res = await api.nbsPmi();
    const mark = (v) => (v === null || v === undefined ? '-' : `${v.toFixed(1)}（${v >= 50 ? '扩张' : '收缩'}）`);
    return [`**PMI 采购经理指数**（${res.period || '-'}）`, '',
      table(['指标', '数值'], [
        ['制造业 PMI', mark(res.manufacturing_pmi)],
        ['非制造业商务活动', mark(res.non_manufacturing_pmi)],
        ['综合 PMI 产出', mark(res.composite_pmi)],
        ['大型企业', mark(res.pmi_large)],
        ['中型企业', mark(res.pmi_medium)],
        ['小型企业', mark(res.pmi_small)],
      ]), '', '注：50 是荣枯线，≥50 为扩张。国家统计局每月末发布，数据来自官方发布稿正文。'].join('\n');
  }

  if (what === 'yield') {
    const curve = String(args.curve || 'treasury').toLowerCase();
    const res = await api.chinabondYield(Math.max(1, Math.min(Math.trunc(Number(args.days) || 30), 360)), curve);
    const latestByCurve = {};
    for (const r of res.rows) latestByCurve[r.curve] = r;
    return [`**中债收益率曲线**（${res.start} ~ ${res.end}，${res.rows.length} 条记录）`, '',
      table(['曲线', '日期', '3月', '6月', '1年', '3年', '5年', '7年', '10年', '30年'],
        Object.values(latestByCurve).sort((a, b) => a.curve.localeCompare(b.curve))
          .map((r) => [r.curve, r.date, ...['3m', '6m', '1y', '3y', '5y', '7y', '10y', '30y']
            .map((k) => ratio(r[k]))])),
      '', '注：单位 %。中债不公布债券市场交易日历，整天缺失（非交易日）无法与「接口漏数据」区分，区间内 7 天以上 0 行才报错。'].join('\n');
  }

  if (what === 'repo') {
    const kind = String(args.kind || 'FR').toUpperCase();
    const rows = await api.repoFixing(kind);
    const tail = rows.slice(-Math.max(1, Math.min(Math.trunc(Number(args.days) || 10), 60)));
    const k = kind.toLowerCase();
    return [`**银行间回购定盘利率 ${kind}**（最近 ${tail.length} 个交易日，%）`, '',
      table(['日期', `${kind}001(隔夜)`, `${kind}007(7天)`, `${kind}014(14天)`],
        [...tail].reverse().map((r) => [
          r.date, ratio(r[`${k}001`]), ratio(r[`${k}007`]), ratio(r[`${k}014`]),
        ])),
      '', '注：来源为中国货币网/外汇交易中心官方。FR 是全市场口径，FDR 是银银间口径（约近 1 年数据）。'].join('\n');
  }

  if (what === 'calendar') {
    const now = new Date();
    const year = Math.trunc(Number(args.year) || now.getFullYear());
    const month = Math.trunc(Number(args.month) || now.getMonth() + 1);
    const res = await api.tradingCalendar(year, month);
    const closed = res.days.filter((d) => !d.is_open).map((d) => d.date);
    return [`**${year} 年 ${month} 月交易日历**（深交所官方，共 ${res.days.length} 天）`, '',
      `交易日 **${res.open_count}** 天；非交易日 ${closed.length} 天：`,
      '', closed.length ? closed.join('、') : '（无）',
      '', '注：周末调休按官方口径，不按「周末必休」推断。沪深交易日一致，此日历可用于全市场排期。'].join('\n');
  }

  return '[Error] 未知 macro。可用：lpr 利率 / pmi 采购经理指数 / yield 国债收益率曲线 / repo 回购定盘利率 / calendar 交易日历';
}


async function limitSentimentAction(api, args) {
  const date = String(args.date || '').trim() || null;
  const snap = await api.limitSentiment(date);
  const day = snap.date;
  const readable = day.length === 8 ? `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}` : day;
  if (!snap.zt_count && !snap.zb_count && !snap.dt_count) {
    return `${readable} 三张池子全为空。**多半不是交易日**（周末/节假日），`
      + '而不是「零涨停」——东方财富涨停池在非交易日返回 data=null。\n'
      + '若确认是交易日，则说明接口未更新，稍后再试。';
  }
  const lines = [`**打板情绪**（${readable}）`, ''];
  const ladder = snap.ladder || {};
  const ladderTxt = Object.keys(ladder).sort((a, b) => Number(b) - Number(a))
    .map((k) => `${k}板 ${ladder[k]} 家`).join(' / ') || '-';
  lines.push(table(['指标', '数值'], [
    ['涨停家数', String(snap.zt_count)],
    ['炸板家数', String(snap.zb_count)],
    ['跌停家数', String(snap.dt_count)],
    ['炸板率', snap.break_rate_pct === null ? '-' : `${snap.break_rate_pct}%`],
    ['最高连板', snap.max_streak ? `${snap.max_streak} 板` : '-'],
    ['连板梯队', ladderTxt],
  ]));

  let reasonMap = {};
  try {
    const reasons = await api.thsLimitReason(day);
    reasonMap = Object.fromEntries(reasons.filter((r) => r.code).map((r) => [r.code, r]));
  } catch { reasonMap = {}; }

  const zt = snap.zt_stocks.slice(0, 15);
  if (zt.length) {
    const rows = zt.map((s) => {
      const r = reasonMap[s.code] || {};
      return [
        `${s.name}(${s.code})`, f(s.price), pct(s.change_pct),
        `${s.streak_boards || '-'}板`, money(s.seal_fund_yuan),
        String(s.first_seal || '-'), r.reason || '-',
      ];
    });
    lines.push('', `**涨停前 ${rows.length} 只**（按首次封板时间）`, '',
      table(['名称(代码)', '现价', '涨跌幅', '连板', '封板资金', '首封', '涨停原因(同花顺)'], rows));
    if (!Object.keys(reasonMap).length) {
      lines.push('', '注：同花顺涨停揭秘当前不可用，涨停原因留空（不是没有原因）。');
    }
  }
  if (snap.dt_stocks.length) {
    lines.push('', '**跌停**　' + snap.dt_stocks.slice(0, 10)
      .map((s) => `${s.name}(${s.code})`).join('、'));
  }
  lines.push('', '注：炸板率 = 炸板 / (涨停 + 炸板)；只统计当日封过板的标的。'
    + '以上为当日情绪数据，不预测次日。');
  return lines.join('\n');
}

async function strong(api, args) {
  const date = String(args.date || '').trim() || null;
  const limit = Math.max(1, Math.min(Math.trunc(Number(args.limit) || 25), 100));
  let rows;
  try {
    rows = await api.thsStrong(date);
  } catch (error) {
    return `[Error] 同花顺强势股获取失败：${error?.message ?? error}`;
  }
  if (!rows.length) return '同花顺强势股当日无数据（非交易日或接口未更新）。';
  rows = rows.slice(0, limit);
  return `**当日题材归因**（同花顺热点，${rows.length} 只）\n\n`
    + `${table(['名称(代码)', '题材归因'],
      rows.map((r) => [`${r.name}(${r.code})`, r.reason || '-']))}\n\n`
    + '注：该接口只给题材标签，不含价格/涨幅——要价格请用 `astock_quote`（可批量传 codes）。'
    + '题材标签是媒体归纳，不是投资建议。';
}

export { datacenter, rawNum, num };
