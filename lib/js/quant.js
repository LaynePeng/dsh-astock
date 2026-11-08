/**
 * 量化选股引擎：全市场扫描 → 多因子打分 → 仓位分配。
 * 上游 `astock_quant.py` 的 Node 移植。打分为候选池内相对排名，不是概率。
 */

import {
  boardOf, calcFee, feeConfig, limitPct, lotSize, roundPrice,
} from './market.js';
import { compensatedSum, pyRound } from './formula.js';

export const DISCLAIMER = '以上为按既定因子与权重计算出的**排序与仓位换算**，不构成投资建议；'
  + '得分为候选池内相对排名，不代表上涨概率或预期收益。请自行复核后决策。';

export const MAX_KLINE_CANDIDATES = 30;

function safeDiv(a, b, fallback = null) {
  if (a === null || a === undefined || b === null || b === undefined || b === 0) return fallback;
  const n = Number(a) / Number(b);
  return Number.isFinite(n) ? n : fallback;
}

function mean(values) {
  const vals = values.filter((v) => v !== null && v !== undefined).map(Number);
  return vals.length ? compensatedSum(vals) / vals.length : null;
}

function stdev(values) {
  const vals = values.filter((v) => v !== null && v !== undefined).map(Number);
  if (vals.length < 2) return null;
  const m = compensatedSum(vals) / vals.length;
  const variance = compensatedSum(vals.map((v) => (v - m) ** 2)) / (vals.length - 1);
  return Math.sqrt(variance);
}

/** RSI（Wilder 简化口径：算术平均涨跌幅）。 */
export function computeRsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (gains + losses === 0) return 50.0;
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100.0;
  const rs = avgGain / avgLoss;
  return pyRound(100.0 - 100.0 / (1.0 + rs), 2);
}

/** 从日 K 数组算技术因子。 */
export function computeTechnical(bars) {
  const closes = [];
  const highs = [];
  const lows = [];
  const vols = [];
  for (const bar of bars || []) {
    const c = bar.close;
    if (!c || c <= 0) continue;
    closes.push(Number(c));
    highs.push(Number(bar.high || c));
    lows.push(Number(bar.low || c));
    vols.push(Number(bar.volume_lot || 0));
  }
  const out = { bars: closes.length };
  if (closes.length < 2) return out;

  const last = closes[closes.length - 1];
  out.close = roundPrice(last);

  const ma = (n) => {
    if (closes.length < n) return null;
    return roundPrice(compensatedSum(closes.slice(-n)) / n);
  };
  for (const n of [5, 10, 20, 60]) out[`ma${n}`] = ma(n);

  for (const n of [5, 20, 60]) {
    if (closes.length > n) {
      const base = closes[closes.length - (n + 1)];
      out[`mom${n}`] = base ? pyRound(((last - base) / base) * 100, 2) : null;
    } else out[`mom${n}`] = null;
  }

  const window = Math.min(60, closes.length);
  const segHigh = Math.max(...highs.slice(-window));
  const segLow = Math.min(...lows.slice(-window));
  out.high_window = roundPrice(segHigh);
  out.low_window = roundPrice(segLow);
  const span = segHigh - segLow;
  out.pos_in_range = span > 0 ? pyRound(((last - segLow) / span) * 100, 2) : null;
  out.drawdown_from_high = segHigh ? pyRound(((last - segHigh) / segHigh) * 100, 2) : null;

  const v5 = vols.length >= 5 ? mean(vols.slice(-5)) : null;
  const v20 = vols.length >= 20 ? mean(vols.slice(-20)) : null;
  const ratio = safeDiv(v5, v20);
  out.vol_ratio_5_20 = ratio ? pyRound(ratio, 3) : null;

  let alignment = 0;
  if (out.ma5 && last > out.ma5) alignment += 1;
  if (out.ma5 && out.ma10 && out.ma5 > out.ma10) alignment += 1;
  if (out.ma10 && out.ma20 && out.ma10 > out.ma20) alignment += 1;
  out.ma_alignment = closes.length >= 20 ? alignment : null;
  if (out.ma20) out.above_ma20_pct = pyRound(((last - out.ma20) / out.ma20) * 100, 2);

  const rets = [];
  for (let i = Math.max(1, closes.length - 20); i < closes.length; i += 1) {
    const prev = closes[i - 1];
    if (prev) rets.push((closes[i] - prev) / prev);
  }
  const sd = stdev(rets);
  out.volatility_20d = sd !== null ? pyRound(sd * Math.sqrt(244) * 100, 2) : null;
  out.rsi14 = computeRsi(closes);
  return out;
}

function fPeInv(row) {
  const pe = row.pe;
  return pe === null || pe === undefined || pe <= 0 ? null : 1.0 / pe;
}

function fPbInv(row) {
  const pb = row.pb;
  return pb === null || pb === undefined || pb <= 0 ? null : 1.0 / pb;
}

function fMcapLog(row) {
  const v = row.total_mcap_yuan;
  return v && v > 0 ? Math.log10(v) : null;
}

function fAmount(row) {
  const v = row.amount_yuan;
  return v && v > 0 ? Math.log10(v) : null;
}

function fTurnoverSweet(row) {
  const t = row.turnover_pct;
  if (t === null || t === undefined || t < 0) return null;
  const lo = 1.0;
  const hi = 8.0;
  if (t < lo) return -(lo - t);
  if (t > hi) return -(t - hi);
  return -Math.abs(t - (lo + hi) / 2) * 0.1;
}

export const FACTORS = {
  mom20: { key: 'mom20', label: '20日动量', direction: 1, unit: '%', getter: (r, t) => t.mom20 },
  mom60: { key: 'mom60', label: '60日动量', direction: 1, unit: '%', getter: (r, t) => t.mom60 },
  ma_alignment: { key: 'ma_alignment', label: '均线多头排列', direction: 1, unit: '档', getter: (r, t) => t.ma_alignment },
  vol_surge: { key: 'vol_surge', label: '量能放大', direction: 1, unit: '倍', getter: (r, t) => t.vol_ratio_5_20 },
  near_high: { key: 'near_high', label: '接近区间高点', direction: 1, unit: '%', getter: (r, t) => t.pos_in_range },
  low_pos: { key: 'low_pos', label: '处于区间低位', direction: -1, unit: '%', getter: (r, t) => t.pos_in_range },
  rsi_low: { key: 'rsi_low', label: 'RSI 超卖', direction: -1, unit: '', getter: (r, t) => t.rsi14 },
  low_vol: { key: 'low_vol', label: '低波动', direction: -1, unit: '%', getter: (r, t) => t.volatility_20d },
  shallow_dd: { key: 'shallow_dd', label: '回撤小', direction: 1, unit: '%', getter: (r, t) => t.drawdown_from_high },
  pe_inv: { key: 'pe_inv', label: '低市盈率', direction: 1, unit: '', getter: fPeInv },
  pb_inv: { key: 'pb_inv', label: '低市净率', direction: 1, unit: '', getter: fPbInv },
  mcap_log: { key: 'mcap_log', label: '大市值', direction: 1, unit: '元', getter: fMcapLog },
  liquidity: { key: 'liquidity', label: '成交额', direction: 1, unit: '元', getter: fAmount },
  turnover_sweet: { key: 'turnover_sweet', label: '换手适中', direction: 1, unit: '%', getter: fTurnoverSweet },
  main_net: { key: 'main_net', label: '主力净流入', direction: 1, unit: '元', getter: (r) => r.main_net_inflow_yuan },
};

export const STRATEGIES = {
  momentum: {
    key: 'momentum',
    label: '趋势动量',
    description: '追强势：站上均线 + 中期动量为正 + 放量 + 接近区间高点。'
      + '趋势市有效，震荡市易被假突破反复打脸。',
    weights: {
      mom60: 0.30, mom20: 0.12, ma_alignment: 0.20, vol_surge: 0.14, near_high: 0.14, liquidity: 0.10,
    },
    filters: {
      min_amount_yuan: 1e8, max_change_pct: 9.5, min_change_pct: -2.0, min_bars: 60,
    },
    stop_loss_pct: 8.0,
    take_profit_pct: 15.0,
  },
  reversal: {
    key: 'reversal',
    label: '均值回归',
    description: '抄超跌：跌到区间低位 + RSI 超卖 + 低波动 + 估值不高。'
      + '逆势低吸，需承受继续下跌，务必带止损。'
      + '**实测警示**：该策略在 2024-03~2026-10 的 A 股样本里'
      + '表现最差（胜率 36.8%、最大回撤 -51.6%），'
      + '说明这段行情里「抄底」是亏钱的——用它前请先看回测。',
    weights: {
      low_pos: 0.26, rsi_low: 0.22, low_vol: 0.16, pb_inv: 0.14, liquidity: 0.12, shallow_dd: 0.10,
    },
    filters: { min_amount_yuan: 5e7, max_change_pct: 3.0, min_bars: 40 },
    stop_loss_pct: 6.0,
    take_profit_pct: 12.0,
  },
  quality: {
    key: 'quality',
    label: '质量价值',
    description: '买稳健：低 PE/PB + 大市值 + 低波动 + 换手适中。'
      + '涨得慢但回撤小，不需要盯盘，适合长期持有。'
      + '**实测**：三套里唯一累计正收益且回撤最小'
      + '（-17.8% vs 动量 -28.8% / 回归 -51.6%），'
      + '但仅与基准持平——适合「不亏钱优先」的人。',
    weights: {
      pe_inv: 0.24, pb_inv: 0.18, mcap_log: 0.20, low_vol: 0.20, turnover_sweet: 0.10, liquidity: 0.08,
    },
    filters: {
      min_amount_yuan: 5e7, min_mcap_yuan: 1e10, max_change_pct: 20.0, min_bars: 60,
    },
    stop_loss_pct: 10.0,
    take_profit_pct: 20.0,
  },
};

export const DEFAULT_STRATEGY = 'momentum';

export class Scored {
  constructor(data = {}) {
    Object.assign(this, {
      code: '', name: '', price: 0, change_pct: null, score: 0,
      factor_pcts: {}, contributions: {}, factor_values: {}, missing_factors: [],
      tech: {}, row: {},
    }, data);
  }

  asDict() {
    return {
      code: this.code,
      name: this.name,
      price: this.price,
      change_pct: this.change_pct,
      score: this.score,
      factor_values: { ...this.factor_values },
      contributions: Object.fromEntries(Object.entries(this.contributions)
        .map(([k, v]) => [k, Math.round(v * 100) / 100])),
      missing_factors: [...this.missing_factors],
    };
  }

  explain(top = 3) {
    if (!Object.keys(this.contributions).length) return '无有效因子';
    const items = Object.entries(this.contributions).sort((a, b) => b[1] - a[1]).slice(0, top);
    return items.map(([key, contrib]) => {
      const factor = FACTORS[key];
      const label = factor ? factor.label : key;
      const val = this.factor_values[key];
      if (val === null || val === undefined) return `${label}→贡献 ${contrib.toFixed(1)}`;
      return `${label}(${fmtFactor(key, val)})→贡献 ${contrib.toFixed(1)}`;
    }).join('；');
  }
}

function gFormat(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e-4 && abs < 1e6) {
    return String(Number(n.toPrecision(6)));
  }
  return n.toExponential(5).replace(/\.?0+e/, 'e');
}

export function fmtFactor(key, val) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return String(val);
  if (key === 'liquidity') return `${(10 ** val / 1e8).toFixed(2)}亿`;
  if (key === 'mcap_log') return `${(10 ** val / 1e8).toFixed(0)}亿`;
  if (key === 'pe_inv' || key === 'pb_inv') return val ? `${gFormat(1 / val)} 倍` : '-';
  if (key === 'main_net') return `${val / 1e8 >= 0 ? '+' : ''}${(val / 1e8).toFixed(2)}亿`;
  const unit = FACTORS[key]?.unit || '';
  return `${gFormat(val)}${unit}`;
}

/** {key: 数值} → 池内百分位；direction<0 表示越小越好。 */
export function percentiles(values, direction = 1) {
  const items = Object.entries(values).sort((a, b) => a[1] - b[1]);
  const n = items.length;
  if (!n) return {};
  if (n === 1) return { [items[0][0]]: 1.0 };
  const out = {};
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && Math.abs(items[j + 1][1] - items[i][1]) < 1e-12) j += 1;
    const avgRank = (i + j) / 2.0;
    let p = avgRank / (n - 1);
    if (direction < 0) p = 1.0 - p;
    for (let k = i; k <= j; k += 1) out[items[k][0]] = p;
    i = j + 1;
  }
  return out;
}

/** 池内多因子打分并降序返回（原地写 Scored）。 */
export function rankCandidates(candidates, strategy, weights = null) {
  if (!candidates.length) return [];
  let w = weights || strategy.weights;
  w = Object.fromEntries(Object.entries(w || {})
    .filter(([k, v]) => Number(v) > 0 && FACTORS[k])
    .map(([k, v]) => [k, Number(v)]));
  if (!Object.keys(w).length) return [...candidates];

  const factorPcts = {};
  for (const key of Object.keys(w)) {
    const factor = FACTORS[key];
    const raw = {};
    for (const c of candidates) {
      let val;
      try {
        val = factor.getter(c.row, c.tech);
      } catch {
        val = null;
      }
      c.factor_values[key] = val;
      if (val === null || val === undefined) {
        c.missing_factors.push(key);
        continue;
      }
      raw[c.code] = Number(val);
    }
    factorPcts[key] = percentiles(raw, factor.direction);
  }

  const totalWeight = compensatedSum(Object.values(w));
  for (const c of candidates) {
    const present = Object.fromEntries(Object.entries(w)
      .filter(([key]) => factorPcts[key] && c.code in factorPcts[key]));
    const denom = compensatedSum(Object.values(present));
    if (denom <= 0 || totalWeight <= 0) {
      c.score = 0;
      c.contributions = {};
      continue;
    }
    let score = 0;
    const contributions = {};
    for (const [key, wt] of Object.entries(present)) {
      const pct = factorPcts[key][c.code];
      c.factor_pcts[key] = pct;
      const contrib = pct * (wt / denom) * 100;
      contributions[key] = contrib;
      score += contrib;
    }
    c.contributions = contributions;
    c.score = pyRound(score, 2);
  }
  return [...candidates].sort((a, b) => (b.score - a.score) || a.code.localeCompare(b.code));
}

/** 策略硬门槛。 */
export function passesFilters(row, tech, strategy) {
  const flt = strategy.filters || {};
  const price = row.price;
  if (!price || price <= 0) return [false, '无有效价格（停牌或退市）'];
  const name = String(row.name || '');
  if (name.toUpperCase().includes('ST')) return [false, 'ST/风险警示股，策略默认排除'];

  const bars = tech.bars || 0;
  const needBars = Math.trunc(flt.min_bars || 0);
  if (needBars && bars < needBars) return [false, `历史数据不足（${bars} 根 < 需要 ${needBars} 根）`];

  const amount = row.amount_yuan;
  if (flt.min_amount_yuan && (amount === null || amount === undefined || amount < flt.min_amount_yuan)) {
    return [false, `成交额 ${Math.round(amount || 0).toLocaleString('en-US')} 元低于门槛 `
      + `${Math.round(flt.min_amount_yuan).toLocaleString('en-US')} 元（流动性不足）`];
  }
  const mcap = row.total_mcap_yuan;
  if (flt.min_mcap_yuan && (mcap === null || mcap === undefined || mcap < flt.min_mcap_yuan)) {
    return [false, `总市值低于门槛 ${(flt.min_mcap_yuan / 1e8).toFixed(1)} 亿`];
  }

  const chg = row.change_pct;
  const code = String(row.code || '');
  let lp = null;
  try {
    lp = limitPct(code, name);
  } catch {
    lp = null;
  }
  if (lp && chg !== null && chg !== undefined) {
    if (Math.abs(chg - lp) < 0.15) return [false, `已涨停（${chg.toFixed(2)}%），当日买入成交不确定`];
    if (Math.abs(chg + lp) < 0.15) return [false, `已跌停（${chg.toFixed(2)}%），不宜接刀`];
  }
  if (chg !== null && chg !== undefined) {
    if (flt.max_change_pct !== undefined && flt.max_change_pct !== null && chg > flt.max_change_pct) {
      return [false, `当日涨幅 ${chg.toFixed(2)}% 超过上限 ${flt.max_change_pct}%（不追高）`];
    }
    if (flt.min_change_pct !== undefined && flt.min_change_pct !== null && chg < flt.min_change_pct) {
      return [false, `当日跌幅 ${chg.toFixed(2)}% 超过下限 ${flt.min_change_pct}%（不接下跌中的刀）`];
    }
  }
  return [true, ''];
}

export class SizingConfig {
  constructor(data = {}) {
    Object.assign(this, {
      position_cap_pct: 25.0,
      max_positions: 5,
      cash_usage_pct: 80.0,
      cash_reserve_yuan: 0.0,
    }, data);
  }

  asDict() {
    return {
      position_cap_pct: this.position_cap_pct,
      max_positions: this.max_positions,
      cash_usage_pct: this.cash_usage_pct,
      cash_reserve_yuan: this.cash_reserve_yuan,
    };
  }
}

export class Allocation {
  constructor(data = {}) {
    Object.assign(this, {
      code: '', name: '', price: 0, score: 0, shares: 0, amount: 0, fee: 0,
      stop_loss: null, take_profit: null, weight_pct: 0, reason: '',
      skipped: false, skip_reason: '',
    }, data);
  }

  asDict() {
    const out = {
      code: this.code,
      name: this.name,
      price: this.price,
      score: this.score,
      shares: this.shares,
      amount: Math.round(this.amount * 100) / 100,
      fee: Math.round(this.fee * 100) / 100,
      weight_pct: Math.round(this.weight_pct * 100) / 100,
    };
    if (this.stop_loss !== null) out.stop_loss = this.stop_loss;
    if (this.take_profit !== null) out.take_profit = this.take_profit;
    if (this.reason) out.reason = this.reason;
    if (this.skipped) {
      out.skipped = true;
      out.skip_reason = this.skip_reason;
    }
    return out;
  }
}

/** 把打分结果换算成具体股数。 */
export function sizePositions(scored, cash, equity, cfg = new SizingConfig(), {
  feeCfg = null, strategy = null, stopLossPct = null, takeProfitPct = null,
} = {}) {
  const fee = feeCfg || feeConfig({});
  const stopPct = stopLossPct !== null && stopLossPct !== undefined
    ? stopLossPct : (strategy ? strategy.stop_loss_pct : 8.0);
  const tpPct = takeProfitPct !== null && takeProfitPct !== undefined
    ? takeProfitPct : (strategy ? strategy.take_profit_pct : 15.0);

  const cashN = Math.max(0, Number(cash) || 0);
  const equityN = Math.max(0, Number(equity) || 0);
  const usage = Math.max(0, Math.min(100, Number(cfg.cash_usage_pct))) / 100;
  let budget = cashN * usage;
  if (cfg.cash_reserve_yuan > 0) {
    budget = Math.min(budget, Math.max(0, cashN - Number(cfg.cash_reserve_yuan)));
  }
  const capAmount = equityN > 0 ? (equityN * Math.max(0, cfg.position_cap_pct)) / 100 : 0;

  const picks = [...scored].slice(0, Math.max(0, Math.trunc(cfg.max_positions)));
  const taken = [];
  const skipped = [];

  const lot = (code) => lotSize(code);
  const affordable = (code, price, target) => {
    const step = lot(code);
    const raw = price > 0 ? target / (price * 1.002) : 0;
    let shares = Math.floor(raw / step) * step;
    let guard = 0;
    while (shares > 0 && guard < 64) {
      const amount = roundPrice(price * shares);
      const feeTotal = calcFee(amount, 'buy', fee, boardOf(code)).total;
      if (amount + feeTotal <= target + 1e-6) return [shares, amount, feeTotal];
      shares -= step;
      guard += 1;
    }
    return [0, 0, 0];
  };

  let remainingCash = budget;
  let remainingScore = compensatedSum(picks.map((s) => Math.max(0, s.score)));

  for (const c of picks) {
    const alloc = new Allocation({
      code: c.code, name: c.name, price: Number(c.price || 0), score: c.score,
    });
    if (!c.price || c.price <= 0) {
      alloc.skipped = true;
      alloc.skip_reason = '无有效价格';
      skipped.push(alloc);
      remainingScore -= Math.max(0, c.score);
      continue;
    }
    const shareOfScore = remainingScore > 0
      ? Math.max(0, c.score) / remainingScore
      : 1 / Math.max(1, picks.length);
    let target = remainingCash * shareOfScore;
    if (capAmount > 0) target = Math.min(target, capAmount);
    const [shares, amount, feeTotal] = affordable(c.code, Number(c.price), target);
    if (shares <= 0) {
      const step = lot(c.code);
      alloc.skipped = true;
      alloc.skip_reason = `预算 ${Math.round(target).toLocaleString('en-US')} 元不足一手`
        + `（一手约需 ${Math.round(c.price * step).toLocaleString('en-US')} 元）`;
      skipped.push(alloc);
      remainingScore -= Math.max(0, c.score);
      continue;
    }
    alloc.shares = shares;
    alloc.amount = amount;
    alloc.fee = feeTotal;
    alloc.stop_loss = roundPrice(c.price * (1 - stopPct / 100));
    alloc.take_profit = roundPrice(c.price * (1 + tpPct / 100));
    remainingCash -= (amount + feeTotal);
    remainingScore -= Math.max(0, c.score);
    taken.push(alloc);
  }

  for (let round = 0; round < 2; round += 1) {
    if (remainingCash < 100 || !taken.length) break;
    const pool = taken.filter((a) => capAmount <= 0 || a.amount < capAmount - 1);
    if (!pool.length) break;
    const totalScore = compensatedSum(pool.map((a) => Math.max(0.1, a.score)));
    let progressed = false;
    for (const a of pool) {
      if (remainingCash < 100) break;
      let want = remainingCash * (Math.max(0.1, a.score) / totalScore);
      if (capAmount > 0) want = Math.min(want, capAmount - a.amount);
      if (want <= 0) continue;
      const [addShares, addAmount, addFee] = affordable(a.code, a.price, want);
      if (addShares <= 0) continue;
      a.shares += addShares;
      a.amount = roundPrice(a.price * a.shares);
      a.fee = calcFee(a.amount, 'buy', fee, boardOf(a.code)).total;
      remainingCash -= (addAmount + addFee);
      progressed = true;
    }
    if (!progressed) break;
  }

  for (const a of taken) {
    a.weight_pct = equityN > 0 ? (a.amount / equityN) * 100 : 0;
    a.reason = `得分 ${a.score.toFixed(1)}，买入 ${a.shares} 股`
      + `（占权益 ${a.weight_pct.toFixed(1)}%）`;
  }

  const budgetSource = (usage < 1 ? '现金使用比例' : '全部可用现金')
    + (cfg.cash_reserve_yuan > 0 && cashN - cfg.cash_reserve_yuan < cashN * usage
      ? '（受保留现金约束）' : '');
  const summary = {
    budget: Math.round(budget * 100) / 100,
    budget_source: budgetSource,
    cash: Math.round(cashN * 100) / 100,
    equity: Math.round(equityN * 100) / 100,
    allocated_amount: Math.round(compensatedSum(taken.map((a) => a.amount)) * 100) / 100,
    allocated_fee: Math.round(compensatedSum(taken.map((a) => a.fee)) * 100) / 100,
    remaining_cash: Math.round(remainingCash * 100) / 100,
    position_cap_amount: Math.round(capAmount * 100) / 100,
    position_cap_pct: cfg.position_cap_pct,
    position_count: taken.length,
    skipped_count: skipped.length,
    stop_loss_pct: stopPct,
    take_profit_pct: tpPct,
  };
  return [taken, skipped, summary];
}
