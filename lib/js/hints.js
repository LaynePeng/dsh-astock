/**
 * 下单提示引擎——上游 `astock_hints.py` 的 Node 移植。
 *
 * 只做规则触发的算术，不预测、不给目标价。每条提示都带 `basis`。
 */

import {
  boardOf, calcFee, feeConfig, limitPrices, lotSize, roundLot, roundPrice,
} from './market.js';

export const DISCLAIMER = '以上为按既定规则计算的结果，仅供参考，不构成投资建议；请自行复核后操作。';

export const DEFAULT_HINTS = {
  stop_loss_pct: 8.0,
  take_profit_pct: 15.0,
  trailing_pct: 10.0,
  add_step_pct: 5.0,
  add_max_times: 2,
  reduce_step_pct: 10.0,
  reduce_max_times: 2,
  position_cap_pct: 25.0,
  volume_ratio_alert: 2.0,
  drop_alert_pct: 5.0,
  rise_alert_pct: 7.0,
  enable_add: false,
  enable_reduce: false,
};

const BOOL_KEYS = new Set(['enable_add', 'enable_reduce']);
const INT_KEYS = new Set(['add_max_times', 'reduce_max_times']);

/** 设置页覆盖默认阈值（只覆盖填过的键）。 */
export function cfgNum(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

export function hintsConfig(raw = {}) {
  const cfg = { ...DEFAULT_HINTS };
  for (const key of Object.keys(DEFAULT_HINTS)) {
    const value = raw?.[key];
    if (value === null || value === undefined || value === '') continue;
    if (BOOL_KEYS.has(key)) {
      cfg[key] = value === true || value === 'true' || value === 1 || value === '1';
    } else if (INT_KEYS.has(key)) {
      const n = Number(value);
      if (Number.isFinite(n)) cfg[key] = Math.trunc(n);
    } else {
      const n = Number(value);
      if (Number.isFinite(n)) cfg[key] = n;
    }
  }
  return cfg;
}

export class Hint {
  constructor(data = {}) {
    Object.assign(this, {
      kind: '',
      code: '',
      name: '',
      severity: 'info',
      title: '',
      detail: '',
      suggestion: '',
      shares: null,
      price_low: null,
      price_high: null,
      basis: '',
      meta: null,
    }, data);
  }

  asDict() {
    const out = {
      kind: this.kind,
      code: this.code,
      name: this.name,
      severity: this.severity,
      title: this.title,
      detail: this.detail,
      suggestion: this.suggestion,
      basis: this.basis,
    };
    if (this.shares !== null) out.shares = this.shares;
    if (this.price_low !== null || this.price_high !== null) {
      out.price_range = [this.price_low, this.price_high];
    }
    if (this.meta) out.meta = this.meta;
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== null && v !== ''));
  }
}

function pnlPct(price, cost) {
  if (!cost) return null;
  return Math.round(((price - cost) / cost) * 100 * 100) / 100;
}

/** 单只持仓/自选 → 提示列表。quote 为扁平化后的行情对象。 */
export function buildPositionHints(position = {}, quote = {}, cfg = DEFAULT_HINTS, {
  highestPrice = null,
  totalMarketValue = null,
  totalEquity = null,
  watchOnly = false,
} = {}) {
  const hints = [];
  const code = String(position.code || quote.code || '');
  const name = String(position.name || quote.name || code);
  let shares = Math.trunc(Number(position.shares) || 0);
  let cost = Number(position.cost_price) || 0;
  const price = quote.price;
  const prevClose = quote.prev_close;
  if (!price) return hints;
  const positional = shares > 0 && !watchOnly;
  if (!positional) {
    shares = 0;
    cost = 0;
  }

  const pnl = positional ? pnlPct(price, cost) : null;
  const limitUp = quote.limit_up;
  const limitDown = quote.limit_down;
  const chg = quote.change_pct;

  // ① 涨跌停
  if (limitUp && Math.abs(price - limitUp) < 0.005) {
    hints.push(new Hint({
      kind: 'limit_up',
      code,
      name,
      severity: 'info',
      title: `${name} 已涨停（${limitUp.toFixed(2)}）`,
      detail: '涨停价买入需排队，卖出可立即成交；涨停打开前价格不会变化。',
      suggestion: '想卖：可挂涨停价卖出；想买：不建议追涨停排队（成交不确定）。',
      price_low: limitUp,
      price_high: limitUp,
      basis: `涨停价 = 昨收 ${prevClose} × (1+${quote.limit_pct ?? 10}%)`,
    }));
    return hints;
  }
  if (limitDown && Math.abs(price - limitDown) < 0.005) {
    hints.push(new Hint({
      kind: 'limit_down',
      code,
      name,
      severity: 'urgent',
      title: `${name} 已跌停（${limitDown.toFixed(2)}）`,
      detail: '跌停价卖出需排队，成交不确定；买入可立即成交。',
      suggestion: '止损单在跌停时难以成交，请评估是否等打开跌停再处理。',
      price_low: limitDown,
      price_high: limitDown,
      basis: `跌停价 = 昨收 ${prevClose} × (1-${quote.limit_pct ?? 10}%)`,
    }));
    if (chg !== null && chg !== undefined && chg <= -Math.abs(cfg.drop_alert_pct)) {
      hints.push(new Hint({
        kind: 'event',
        code,
        name,
        severity: 'action',
        title: `${name} 当日下跌 ${chg.toFixed(2)}%`,
        detail: `现价 ${price.toFixed(2)}，昨收 ${prevClose}，已封跌停。`,
        suggestion: '跌停打开前难以成交；先确认是否有公告/行业利空再决定。',
        basis: `当日涨跌幅 ${chg.toFixed(2)}% ≤ -${cfgNum(cfg.drop_alert_pct)}%`,
      }));
    }
    return hints;
  }

  // ② 止损 / ③ 止盈
  if (pnl !== null && pnl <= -Math.abs(cfg.stop_loss_pct)) {
    const stopPrice = roundPrice(cost * (1 - cfg.stop_loss_pct / 100));
    hints.push(new Hint({
      kind: 'stop_loss',
      code,
      name,
      severity: 'urgent',
      title: `${name} 触发止损线（浮亏 ${signed(pnl)}%）`,
      detail: `成本 ${cost.toFixed(3)}，现价 ${price.toFixed(2)}，浮亏 ${signed(pnl)}%，`
        + `已超过止损阈值 -${cfgNum(cfg.stop_loss_pct)}%。`,
      suggestion: `按计划应减仓/清仓 ${shares} 股；若不认可该止损位，`
        + '需重新设定并记录理由（避免临场改规则）。',
      shares,
      price_low: roundPrice(price * 0.995),
      price_high: roundPrice(price * 1.005),
      basis: `浮亏比例 ${signed(pnl)}% ≤ -${cfgNum(cfg.stop_loss_pct)}%`,
      meta: { pnl_pct: pnl, stop_price: stopPrice },
    }));
  } else if (pnl !== null && pnl >= Math.abs(cfg.take_profit_pct)) {
    const half = roundLot(shares / 2, code);
    let suggestion;
    let sellShares;
    if (half > 0) {
      suggestion = `可考虑减半 ${half} 股锁定利润、保留 ${shares - half} 股；或上移止盈线继续持有。`;
      sellShares = half;
    } else if (shares >= 100) {
      suggestion = `持仓 ${shares} 股不足两手，减半不合规：可按整手卖 100 股、`
        + `或一次性清仓 ${shares} 股（零股只能随清仓卖出）。`;
      sellShares = 100;
    } else {
      suggestion = `持仓仅 ${shares} 股（零股），只能一次性清仓。`;
      sellShares = shares;
    }
    hints.push(new Hint({
      kind: 'take_profit',
      code,
      name,
      severity: 'action',
      title: `${name} 触及止盈线（浮盈 ${signed(pnl)}%）`,
      detail: `成本 ${cost.toFixed(3)}，现价 ${price.toFixed(2)}，浮盈 ${signed(pnl)}%。`,
      suggestion,
      shares: sellShares,
      price_low: roundPrice(price * 0.995),
      price_high: roundPrice(price * 1.005),
      basis: `浮盈比例 ${signed(pnl)}% ≥ +${cfgNum(cfg.take_profit_pct)}%`,
      meta: { pnl_pct: pnl },
    }));
  }

  // ④ 移动止盈
  if (positional && highestPrice && highestPrice > 0 && price > 0) {
    const drawdown = ((price - highestPrice) / highestPrice) * 100;
    if (drawdown <= -Math.abs(cfg.trailing_pct) && (pnl || 0) > 0) {
      hints.push(new Hint({
        kind: 'trailing',
        code,
        name,
        severity: 'action',
        title: `${name} 自高点回撤 ${drawdown.toFixed(2)}%`,
        detail: `持仓期最高价 ${highestPrice.toFixed(2)}，现价 ${price.toFixed(2)}，`
          + `回撤 ${drawdown.toFixed(2)}%（阈值 -${cfgNum(cfg.trailing_pct)}%），仍有浮盈 ${signed(pnl)}%。`,
        suggestion: '可减仓保住浮盈，或把止损上移到成本价上方。',
        shares: roundLot(shares / 2, code) || shares,
        basis: `回撤 ${drawdown.toFixed(2)}% ≤ -${cfgNum(cfg.trailing_pct)}% 且仍浮盈`,
        meta: { highest: highestPrice, drawdown_pct: Math.round(drawdown * 100) / 100 },
      }));
    }
  }

  // ⑤ 分批加仓
  if (positional && cfg.enable_add && pnl !== null && pnl <= 0) {
    let tiers = Math.trunc(Math.abs(pnl) / Math.max(cfg.add_step_pct, 0.01));
    tiers = Math.min(tiers, cfg.add_max_times);
    if (tiers >= 1) {
      const addPct = cfg.add_step_pct;
      const addPrice = roundPrice(cost * (1 - (addPct * tiers) / 100));
      hints.push(new Hint({
        kind: 'add_position',
        code,
        name,
        severity: 'info',
        title: `${name} 处于第 ${tiers} 档加仓区间（浮亏 ${signed(pnl)}%）`,
        detail: `成本 ${cost.toFixed(3)}，现价 ${price.toFixed(2)}。按每跌 ${cfgNum(addPct)}% 加一档的`
          + `计划，第 ${tiers} 档参考价 ${addPrice.toFixed(2)}。`,
        suggestion: `如需补仓，单次不超过原持仓的一半（约 ${roundLot(shares / 2, code)} 股）；`
          + '注意加仓会拉低均价但同时放大风险。',
        shares: roundLot(shares / 2, code),
        price_low: roundPrice(addPrice * 0.99),
        price_high: addPrice,
        basis: `浮亏 ${signed(pnl)}% 落在第 ${tiers} 档（每 ${cfgNum(addPct)}% 一档）`,
      }));
    }
  }

  // ⑥ 分批减仓
  if (positional && cfg.enable_reduce && pnl !== null && pnl >= cfg.reduce_step_pct) {
    const tiers = Math.min(
      Math.trunc(pnl / Math.max(cfg.reduce_step_pct, 0.01)),
      cfg.reduce_max_times,
    );
    if (tiers >= 1) {
      const cut = roundLot(shares * Math.min(0.5, 0.25 * tiers), code)
        || roundLot(shares / 2, code);
      hints.push(new Hint({
        kind: 'reduce',
        code,
        name,
        severity: 'info',
        title: `${name} 处于第 ${tiers} 档减仓区间（浮盈 ${signed(pnl)}%）`,
        detail: `按每涨 ${cfgNum(cfg.reduce_step_pct)}% 减一档的计划，建议减 ${cut} 股。`,
        suggestion: '分批减仓可降低择时压力；减仓后记得把止损上移。',
        shares: cut,
        basis: `浮盈 ${signed(pnl)}% ≥ 第 ${tiers} 档`,
      }));
    }
  }

  // ⑦ 单票占比
  const capBase = Number(totalEquity || 0) || Number(totalMarketValue || 0);
  if (positional && capBase > 0) {
    const mv = shares * price;
    const weight = (mv / capBase) * 100;
    if (weight > cfg.position_cap_pct) {
      const targetMv = (cfg.position_cap_pct / 100) * capBase;
      hints.push(new Hint({
        kind: 'position_cap',
        code,
        name,
        severity: 'action',
        title: `${name} 单票占比 ${weight.toFixed(1)}% 超上限`,
        detail: `该股市值 ${thousands(mv, 0)} 元，占账户总资产（持仓 `
          + `${thousands(Number(totalMarketValue || 0), 0)} 元 + 可用现金）`
          + `${thousands(capBase, 0)} 元的 ${weight.toFixed(1)}%，`
          + `超过上限 ${cfgNum(cfg.position_cap_pct)}%。`,
        suggestion: `建议至少减至 ${cfgNum(cfg.position_cap_pct)}% 以内以控制单票风险。`,
        shares: roundLot((mv - targetMv) / price, code),
        basis: `占总资产 ${weight.toFixed(1)}% > 上限 ${cfgNum(cfg.position_cap_pct)}%`,
        meta: { weight_pct: Math.round(weight * 100) / 100 },
      }));
    }
  }

  // ⑧ 当日异动
  if (chg !== null && chg !== undefined) {
    if (chg <= -Math.abs(cfg.drop_alert_pct)) {
      hints.push(new Hint({
        kind: 'event',
        code,
        name,
        severity: 'action',
        title: `${name} 当日下跌 ${chg.toFixed(2)}%`,
        detail: `现价 ${price.toFixed(2)}，昨收 ${prevClose}。`,
        suggestion: '先确认是否有公告/行业消息；若属计划外下跌，按止损纪律处理而非摊平。',
        basis: `当日涨跌幅 ${chg.toFixed(2)}% ≤ -${cfgNum(cfg.drop_alert_pct)}%`,
      }));
    } else if (chg >= Math.abs(cfg.rise_alert_pct)) {
      hints.push(new Hint({
        kind: 'event',
        code,
        name,
        severity: 'info',
        title: `${name} 当日上涨 ${chg.toFixed(2)}%`,
        detail: `现价 ${price.toFixed(2)}，昨收 ${prevClose}。`,
        suggestion: '涨幅较大时不建议追高；已有持仓可考虑部分止盈。',
        basis: `当日涨跌幅 ${chg.toFixed(2)}% ≥ +${cfgNum(cfg.rise_alert_pct)}%`,
      }));
    }
  }

  // ⑨ 放量
  const vr = quote.volume_ratio;
  if (vr && vr >= cfg.volume_ratio_alert) {
    hints.push(new Hint({
      kind: 'event',
      code,
      name,
      severity: 'info',
      title: `${name} 量比 ${vr.toFixed(2)}（放量）`,
      detail: `当前成交量是近 5 日均量的 ${vr.toFixed(2)} 倍。`,
      suggestion: '放量伴随方向突破才有效；单看放量容易追高，需结合价格位置。',
      basis: `量比 ${vr.toFixed(2)} ≥ ${cfgNum(cfg.volume_ratio_alert)}`,
    }));
  }

  return hints;
}

export function buildT1Hint(position = {}, available = 0) {
  const shares = Math.trunc(Number(position.shares) || 0);
  const code = String(position.code || '');
  if (shares <= 0) return null;
  if (available >= shares) return null;
  const locked = shares - available;
  return new Hint({
    kind: 't1_locked',
    code,
    name: String(position.name || code),
    severity: 'info',
    title: `${position.name || code} 今日可卖 ${available} 股，${locked} 股 T+1 锁定`,
    detail: `持仓 ${shares} 股，其中 ${locked} 股为今日买入，按 T+1 规则明日才能卖出。`,
    suggestion: available > 0 ? `今日最多可卖 ${available} 股。` : '今日不可卖出。',
    shares: available,
    basis: 'T+1：当日买入股份次一交易日方可卖出',
  });
}

/** 买入数量估算（单票上限 + 可用资金双重约束）。 */
export function suggestBuy(code, name, price, cash, cfg = DEFAULT_HINTS, {
  existingShares = 0,
  existingCost = 0,
  totalMarketValue = null,
  feeCfg = null,
  prevClose = null,
} = {}) {
  const fee = feeCfg || feeConfig({});
  if (!price || price <= 0) throw new Error('需要有效的最新价才能估算可买数量');
  const board = boardOf(code);
  const lp = limitPrices(prevClose || price, code, name);
  const equity = Number(totalMarketValue || 0) + (Number(cash) || 0);
  const capAmount = equity > 0 ? (equity * cfg.position_cap_pct) / 100 : 0;
  const budget = capAmount > 0 ? Math.min(Number(cash) || 0, capAmount) : (Number(cash) || 0);
  const rawShares = price ? budget / (price * 1.001) : 0;
  const shares = roundLot(rawShares, code);
  const amount = roundPrice(price * shares);
  const feeBd = calcFee(amount, 'buy', fee, board);

  const reasons = [];
  if (!cash || cash <= 0) {
    reasons.push('台账可用资金为 0 元，先用 astock_portfolio action=set_cash 录入资金'
      + '（或直接按你的实际可用资金自己定数量）');
  } else if (capAmount > 0 && budget === capAmount && capAmount < cash) {
    reasons.push(`受单票占比 ${cfgNum(cfg.position_cap_pct)}% 上限限制`
      + `（组合市值 ${thousands(equity, 0)} 元）`);
  } else {
    reasons.push(`受可用资金 ${thousands(cash)} 元限制`);
  }
  if (shares === 0 && cash > 0) {
    const need = price * lotSize(code);
    reasons.push(`资金不足一手（一手约需 ${thousands(need, 0)} 元）`);
  }

  return {
    code,
    name,
    price,
    board,
    suggest_shares: shares,
    suggest_amount: amount,
    est_fee: feeBd.total,
    est_total_cost: Math.round((amount + feeBd.total) * 100) / 100,
    limit_up: lp.up,
    limit_down: lp.down,
    limit_pct: lp.pct,
    existing_shares: existingShares,
    shares_after: existingShares + shares,
    avg_cost_after: existingShares + shares
      ? Math.round(((existingCost * existingShares + amount + feeBd.total)
        / (existingShares + shares)) * 1e4) / 1e4
      : null,
    reason: reasons.join('；'),
    note: (board !== 'star'
      ? '买入需为 100 股整数倍（科创板 200 股）；'
      : '科创板买入需 200 股起；') + '以上按最新价估算，实际以委托价为准。',
  };
}

/** 卖出数量估算。ratio=0.5 表示卖一半；shares 优先。 */
export function suggestSell(position = {}, price, available, {
  ratio = null, shares = null, feeCfg = null,
} = {}) {
  const fee = feeCfg || feeConfig({});
  const code = String(position.code || '');
  const name = String(position.name || code);
  const held = Math.trunc(Number(position.shares) || 0);
  const cost = Number(position.cost_price) || 0;
  if (held <= 0) throw new Error(`${code} 当前无持仓`);
  if (price <= 0) throw new Error('需要有效的最新价才能估算卖出金额');
  let qty;
  if (shares) qty = Math.trunc(shares);
  else if (ratio) {
    const r = Math.max(0, Math.min(Number(ratio), 1));
    qty = r >= 1 ? held : roundLot(held * r, code);
    if (qty <= 0) qty = held;
  } else qty = held;
  qty = Math.min(qty, Math.max(available, 0));
  if (qty <= 0) {
    return {
      code, name, sellable: 0, reason: '今日可卖数量为 0（T+1 锁定），无法卖出',
    };
  }
  const amount = roundPrice(price * qty);
  const feeBd = calcFee(amount, 'sell', fee, boardOf(code));
  const grossPnl = (price - cost) * qty;
  return {
    code,
    name,
    sellable: available,
    suggest_shares: qty,
    remain_shares: held - qty,
    price,
    suggest_amount: amount,
    est_fee: feeBd.total,
    est_net_proceeds: Math.round((amount - feeBd.total) * 100) / 100,
    est_realized_pnl: Math.round((grossPnl - feeBd.total) * 100) / 100,
    pnl_pct: pnlPct(price, cost),
    note: '卖出零股需一次性清仓；以上按最新价估算，实际以委托价为准。',
  };
}

function signed(value) {
  const n = Number(value) || 0;
  return `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(2)}`;
}

function thousands(value, digits = 2) {
  const n = Number(value) || 0;
  const negative = n < 0;
  const fixed = Math.abs(n).toFixed(digits);
  const [intPart, dec] = fixed.split('.');
  const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${withSep}${dec === undefined ? '' : `.${dec}`}`;
}
