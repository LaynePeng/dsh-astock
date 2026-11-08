/**
 * `astock_calc` 的 JS 实现（19 个工具重写的第 1 个）。
 *
 * 与 上游 `astock_mixin_calc.py` 的输出逐段对齐；区别只在取数层：
 * 这里用腾讯 K 线（顺带拿快照），Python 版用 `astock_data` 的主备源。
 */

import { dirname, join } from 'node:path';

import { f, pct, ratio, table } from './format.js';
import * as fx from './formula.js';
import { fetchKlines, fetchQuotes } from './kline.js';
import { lotSize } from './market.js';
import { loadPlan } from './watch-plan.js';

/** 主流费率合计（佣金万 2.5 + 印花税 0.05% + 过户费 0.001%）。 */
const DEFAULT_SELL_RATE = 0.00025 + 0.0005 + 0.00001;

/** 需要自动读盯盘计划时，交给 Python 版处理（过渡期）。 */
export class NeedPythonError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NeedPythonError';
    this.code = 'NEED_PYTHON';
  }
}

/** Python 的 float 字符串：整数补 `.0`（10 → "10.0"），与上游输出对齐。 */
function pyNum(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

export async function runCalc(args = {}, options = {}) {
  const mode = String(args.mode || 'summary').trim().toLowerCase();
  if (mode === 'rule_check') return calcRuleCheck(args, options);
  if (mode === 'cost') return calcCost(args, options);
  if (mode === 'adjust') return calcAdjust(args);
  if (mode === 'ratio') return calcRatio(args);
  if (mode === 'summary' || mode === 'ma') return calcSeries(args, mode, options);
  return `[Error] 未知 mode=${JSON.stringify(mode)}。支持：summary / ma / rule_check / `
    + 'cost / adjust / ratio';
}

// ---------------------------------------------------------------- 序列类

async function calcSeries(args, mode, options) {
  const code = String(args.code || '').trim();
  if (!code) return '[Error] 需要 code';
  const period = String(args.period || 'day');
  const limit = Number(args.limit) || 120;
  const adjust = String(args.adjust || 'qfq');
  const fetchK = options.fetchKlines || fetchKlines;
  const fetchQ = options.fetchQuotes || fetchQuotes;

  let bars;
  let quote = null;
  try {
    const result = await fetchK(code, { period, limit, adjust });
    bars = result.bars || [];
    quote = result.quote || null;
  } catch (error) {
    return `[Error] ${code} 取 K 线失败：${error?.message ?? error}`;
  }
  if (!bars.length) return `[Error] ${code} 没有 ${period} K 线数据`;

  const closes = bars.map((bar) => bar.close).filter((value) => value);
  if (!closes.length) return `[Error] ${code} K 线没有有效收盘价`;

  // 现价优先实时快照；取不到就用最后一根收盘
  let price = quote?.price ?? null;
  if (price === null) {
    try {
      const quotes = await fetchQ([code]);
      price = quotes?.[0]?.price ?? null;
    } catch {
      price = null;
    }
  }

  const info = fx.summary(closes, price);
  const lastDate = bars[bars.length - 1].date;
  const head = [
    `**${code}(${code}) 技术指标**`
      + `（${period} · 复权=${adjust} · 最新 ${lastDate} · ${closes.length} 根）`,
    '',
  ];

  if (mode === 'ma') {
    const rows = [
      ['均线', 'MA5', 'MA10', 'MA20', 'MA60'],
      ['数值', f(info.ma5, 3), f(info.ma10, 3), f(info.ma20, 3), f(info.ma60, 3)],
      ['偏离', pct(info.dev_ma5_pct), pct(info.dev_ma10_pct),
        pct(info.dev_ma20_pct), pct(info.dev_ma60_pct)],
    ];
    const out = [...head, table(rows[0], rows.slice(1)), ''];
    out.push(`- 收盘/现价：**${f(info.close)}**`);
    out.push(`- 位置：${info.ma_position}`);
    if (info.alignment !== null && info.alignment !== undefined) {
      out.push(`- 均线多头排列：${info.alignment}/3`
        + (info.alignment === 3 ? '（完全多头）' : ''));
    }
    out.push('', '> 口径：均线用**前复权**（qfq）算，成交价用原始价。'
      + '含除权的标的不复权算长周期均线会**虚高**，见 mode=adjust。');
    return out.join('\n');
  }

  const rows = [
    ['均线', 'MA5', 'MA10', 'MA20', 'MA60'],
    ['数值', f(info.ma5, 3), f(info.ma10, 3), f(info.ma20, 3), f(info.ma60, 3)],
    ['偏离', pct(info.dev_ma5_pct), pct(info.dev_ma10_pct),
      pct(info.dev_ma20_pct), pct(info.dev_ma60_pct)],
  ];
  const out = [...head, table(rows[0], rows.slice(1)), ''];
  out.push('| 指标 | 数值 |\n|---|---|');
  out.push(`| 收盘/现价 | **${f(info.close)}** |`);
  out.push(`| 位置 | ${info.ma_position} |`);
  out.push(`| 多头排列 | ${info.alignment}/3 |`);
  out.push(`| RSI14 | ${f(info.rsi14)} |`);
  out.push(`| 年化波动率(20日) | ${ratio(info.volatility_20d)} |`);
  if (info.mom5 !== null && info.mom5 !== undefined) {
    out.push(`| 动量 5/20/60 日 | ${pct(info.mom5)} / ${pct(info.mom20)} / ${pct(info.mom60)} |`);
  }
  const dd = info.max_drawdown || {};
  if (dd.pct !== null && dd.pct !== undefined) {
    out.push(`| 区间最大回撤 | **${pct(dd.pct)}** (峰 ${f(dd.peak)} → 谷 ${f(dd.trough)}) |`);
  }
  out.push(`| 60 日区间 | ${f(info.low_window)} ~ ${f(info.high_window)} |`);
  out.push(`| 区间位置 | ${f(info.pos_in_range)}%（0=最低 100=最高） |`);
  out.push(`| 距区间高点 | ${pct(info.drawdown_from_high)} |`);
  out.push('', '> 以上为历史统计，不预测未来。');
  return out.join('\n');
}

// ---------------------------------------------------------------- 规则体检

async function calcRuleCheck(args, options) {
  let rules = Array.isArray(args.rules) ? args.rules : [];
  if (!rules.length) {
    const ledgerPath = options.config?.ledger_path || '';
    if (ledgerPath) {
      const planPath = join(dirname(String(ledgerPath)), 'watch-plan.json');
      rules = loadPlan(planPath).rules || [];
    }
    if (!rules.length) {
      return '[Error] 没有显式 rules，盯盘计划里也没有价位规则。'
        + '请传 rules 数组，或先用 astock_watch action=set_rules 写入规则。';
    }
  }
  const codes = [...new Set(rules.map((rule) => String(rule.code || '')).filter(Boolean))];
  const fetchQ = options.fetchQuotes || fetchQuotes;
  let quotes = [];
  try {
    quotes = await fetchQ(codes);
  } catch (error) {
    return `[Error] 取行情失败，无法体检（方向校验必须有现价）：${error?.message ?? error}`;
  }
  const priceMap = {};
  const names = {};
  for (const quote of quotes) {
    priceMap[quote.code] = quote.price;
    names[quote.code] = quote.name;
  }

  const wantMa = args.use_ma !== false;
  const maMap = {};
  if (wantMa) {
    const need = new Map();
    for (const rule of rules) {
      const code = String(rule.code || '');
      const maKey = String(rule.ma_key || '').trim();
      if (code && maKey) {
        if (!need.has(code)) need.set(code, new Set());
        need.get(code).add(maKey);
      }
    }
    const fetchK = options.fetchKlines || fetchKlines;
    for (const [code, keys] of need.entries()) {
      const perCode = {};
      for (const maKey of [...keys].sort()) {
        const n = Number(String(maKey).replace('ma', '')) || 20;
        try {
          const result = await fetchK(code, { period: 'day', limit: Math.max(n + 5, 70), adjust: 'qfq' });
          const closes = (result.bars || []).map((bar) => bar.close).filter((value) => value);
          perCode[maKey] = fx.sma(closes, n);
        } catch {
          perCode[maKey] = null;
        }
      }
      maMap[code] = perCode;
    }
  }

  const rows = fx.checkRuleSet(rules, priceMap, wantMa ? maMap : null);
  const lines = [`**规则体检**（${rows.length} 条 · 来源：入参 rules）`, ''];
  const bad = rows.filter((row) => !row.ok);
  lines.push(`结论：**${bad.length ? `⚠️ ${bad.length} 条有问题` : '✅ 全部有效'}**`);
  lines.push('');
  const tableRows = rows.map((row) => {
    const mk = wantMa ? String(row.ma_key || '') : '';
    return [
      names[row.code] || row.code,
      pyNum(row.rule_price),
      String(row.op).toUpperCase(),
      f(row.price),
      pct(row.distance_pct),
      row.direction_ok ? '✅' : '❌ 方向失效',
      mk ? mk.toUpperCase() : '-',
      row.drift_pct !== null && row.drift_pct !== undefined ? pct(row.drift_pct) : '-',
      row.suggest_price ? pyNum(row.suggest_price) : '-',
    ];
  });
  lines.push(table(
    ['标的', '规则价', '方向', '现价', '距离', '方向可达', '均线基准', '漂移', '建议价'],
    tableRows,
  ));
  if (bad.length) {
    lines.push('', '### 需要处理', '');
    for (const row of bad) {
      for (const problem of row.problems) {
        lines.push(`- **${names[row.code] || row.code}** ${row.rule_price}：${problem}`);
      }
    }
  }
  lines.push('', '> 方向可达 = 规则的 op 与现价位置是否**还能按预期触发**。'
    + '写成「跌破 38.60」但现价 38.52 已在下方，就是一条死规则——'
    + '不报错、只是永远不响。');
  return lines.join('\n');
}

// ---------------------------------------------------------------- 算账

function calcCost(args, options = {}) {
  const entry = Number(args.entry_price ?? args.cost ?? 0);
  const shares = Math.trunc(Number(args.shares ?? 0));
  if (!Number.isFinite(entry) || !Number.isFinite(shares)) {
    return '[Error] entry_price / shares 需要是数字';
  }
  if (entry <= 0 || shares <= 0) {
    return '[Error] 需要 entry_price（成本价）与 shares（股数）';
  }

  const cfg = options.config || {};
  const commission = Number(cfg.commission_rate ?? 0.00025);
  const stamp = Number(cfg.stamp_tax_rate ?? 0.0005);
  const transfer = Number(cfg.transfer_fee_rate ?? 0.00001);
  const buyFee = Number(args.buy_fee || 0);
  const sellRate = Number(args.sell_fee_rate ?? (commission + stamp + transfer));
  const lines = [`**成本与盈亏计算**（${shares} 股 @ ${pyNum(entry)}）`, ''];

  const be = fx.breakevenPrice(entry, shares, buyFee, sellRate);
  const priceRows = [['项目', '数值']];
  priceRows.push(['成本价', pyNum(entry)]);
  priceRows.push(['盈亏平衡价', `**${f(be, 4)}**`]);
  if (be) priceRows.push(['平衡价溢价', pct((be - entry) / entry * 100.0)]);
  priceRows.push(['卖出费率合计', ratio(sellRate * 100.0)]);

  const stopPct = Number(args.stop_pct || 8.0);
  const takePct = Number(args.take_pct || 15.0);
  const st = fx.stopTakePrices(entry, stopPct, takePct);
  priceRows.push([`止损价（-${pyNum(stopPct)}%）`, f(st.stop)]);
  priceRows.push([`止盈价（+${pyNum(takePct)}%）`, f(st.take)]);
  lines.push(table(priceRows[0], priceRows.slice(1)));

  if (st.stop && st.take) {
    const rr = fx.riskRewardRatio(entry, st.stop, st.take);
    lines.push('', `- **盈亏比**：${f(rr)}`
      + (rr !== null && rr < 1 ? '（<1，赚得比亏得少，位置不划算）' : ''));
  }

  if (args.cash !== null && args.cash !== undefined) {
    const lot = lotSize(String(args.code || '600000'));
    const sz = fx.positionShares(
      Number(args.cash),
      Number(args.price ?? entry),
      {
        equity: args.equity !== null && args.equity !== undefined ? Number(args.equity) : null,
        maxPositionPct: args.max_position_pct !== null && args.max_position_pct !== undefined
          ? Number(args.max_position_pct) : null,
        lot,
        cashUsagePct: Number(args.cash_usage_pct || 100.0),
      },
    );
    lines.push('', '**可买股数**', '');
    lines.push(`- ${sz.shares} 股（约 ${f(sz.amount)} 元），`
      + `受限于「${sz.binding}」，买入后剩余现金 ${f(sz.cash_left)} 元`);
    if (sz.shares <= 0) lines.push('- ⚠️ 买不到一手：现金或单票上限不足。');
  }

  lines.push('', '> 平衡价的含义：**涨回成本价不等于回本**，还要覆盖来回手续费。'
    + '实际费用以券商为准，本表按主流费率估算。');
  return lines.join('\n');
}

function calcAdjust(args) {
  const prevClose = Number(args.prev_close || 0);
  const dividend = Number(args.dividend_per_share || 0);
  const n = Math.trunc(Number(args.ma_period || 60));
  if (!Number.isFinite(prevClose) || !Number.isFinite(dividend) || !Number.isFinite(n)) {
    return '[Error] prev_close / dividend_per_share / ma_period 需要是数字';
  }
  if (prevClose <= 0) return '[Error] need args';

  const factor = fx.dividendAdjustFactor(prevClose, dividend);
  const distortion = fx.maDistortionEstimate(prevClose, dividend, n);
  const lines = [`**除权影响估算**（除权前收盘 ${pyNum(prevClose)}，每股派现 ${pyNum(dividend)}）`, ''];
  const rows = [['项目', '数值'],
    ['前复权调整因子', String(factor)],
    ['除权前价格应打折扣', ratio((1 - factor) * 100.0)]];
  if (distortion !== null) {
    rows.push([`不复权算 MA${n} 约虚高`, `**${ratio(Math.abs(distortion))}**`]);
  }
  lines.push(table(rows[0], rows.slice(1)));
  lines.push('', '**结论**：',
    '- 用**前复权（qfq）**算均线才是真实的级别；不复权会让除权前的价格偏高，均线整体**虚高**。',
    '- 但**止损价、成交价必须用原始价**——券商申报的就是那个数。',
    '', '> 两者不可混用：**均线看复权，价位看原始**。');
  return lines.join('\n');
}

function calcRatio(args) {
  const ret = Number(args.total_return_pct);
  const dd = Number(args.max_drawdown_pct);
  if (!Number.isFinite(ret) || !Number.isFinite(dd)) {
    return '[Error] 需要 total_return_pct（累计收益%，可为负）与 '
      + 'max_drawdown_pct（最大回撤%，填负数）';
  }
  const r = fx.riskAdjustedRatio(ret, dd);
  const lines = ['**收益 / 回撤比**（选策略先看回撤，再看收益）', ''];
  const rows = [['项目', '数值'],
    ['累计收益', pct(ret)],
    ['最大回撤', pct(dd)],
    ['收益/回撤比', r !== null ? `**${f(r)}**` : '-']];
  lines.push(table(rows[0], rows.slice(1)));
  if (r === null) {
    lines.push('', '回撤缺失或为 0，无法计算（不能除以 0 说「无穷好」）。');
  } else {
    lines.push('', '**怎么用**：这个数越大，说明每承担 1 单位回撤换来的收益越多。'
      + '回撤大的策略即使累计收益更高，**你可能在中途就扛不住卖掉**，实盘拿不到回测的数。');
  }
  return lines.join('\n');
}
