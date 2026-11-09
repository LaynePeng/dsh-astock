/**
 * 条件单参数计算——上游 `astock_orders.py` 的 Node 移植。
 *
 * 输出「委托价 / 止损触发价 / 止盈触发价 / 跟踪回撤」四件套，
 * 用户在券商 App 照抄；插件不下单。
 */

import {
  boardOf, calcFee, feeConfig, limitPrices, lotSize, roundLot, roundPrice,
} from './market.js';

export class ConditionalOrder {
  constructor(data = {}) {
    Object.assign(this, {
      code: '',
      name: '',
      side: 'buy',
      shares: 0,
      price: 0,
      price_low: null,
      price_high: null,
      stop_loss: null,
      take_profit: null,
      trailing_pct: null,
      limit_up: null,
      limit_down: null,
      est_amount: 0,
      est_fee: 0,
      notes: [],
    }, data);
  }

  asDict() {
    const out = {
      code: this.code,
      name: this.name,
      side: this.side,
      shares: this.shares,
      price: this.price,
      est_amount: Math.round(this.est_amount * 100) / 100,
      est_fee: Math.round(this.est_fee * 100) / 100,
    };
    for (const key of ['price_low', 'price_high', 'stop_loss', 'take_profit',
      'trailing_pct', 'limit_up', 'limit_down']) {
      if (this[key] !== null && this[key] !== undefined) out[key] = this[key];
    }
    if (this.notes?.length) out.notes = [...this.notes];
    return out;
  }

  /**
   * 券商 App「条件单 / 事件单」的填写字段。
   *
   * 一张事件单只表达一个触发条件：止损一张、止盈一张、跟踪回撤一张。
   * 字段名尽量贴着券商界面（触发条件 / 委托方向 / 数量 / 委托价 / 有效期），
   * 用户照着抄，不用自己把「委托价」换算成「触发价」。
   */
  eventOrders() {
    const out = [];
    const validity = '当日有效（未触发则次日重挂）';
    const push = (label, trigger, price, orderType, note) => out.push({
      label,
      trigger,
      side: 'sell',
      shares: this.shares,
      orderType,
      price,
      validity,
      note: note || '',
    });
    if (this.stop_loss) {
      push(
        '止损',
        `最新价 ≤ ${this.stop_loss.toFixed(2)}`,
        this.stop_loss.toFixed(2),
        '限价',
        '跌破止损价自动卖出；想更快成交可把委托方式改成市价',
      );
    }
    if (this.take_profit) {
      push(
        '止盈',
        `最新价 ≥ ${this.take_profit.toFixed(2)}`,
        this.take_profit.toFixed(2),
        '限价',
        '涨到止盈价自动卖出；不按涨停裁剪，次日仍有效',
      );
    }
    if (this.trailing_pct) {
      push(
        '跟踪回撤',
        `自最高价回落 ${Number(this.trailing_pct)}%`,
        '',
        '市价',
        '只有支持「跟踪止盈/回落卖出」的券商才有这一项，没有就只挂止损',
      );
    }
    return out;
  }

  /** 把 {@link eventOrders} 渲染成可照抄的文本（hint / act 共用）。 */
  eventOrderBlock() {
    const tickets = this.eventOrders();
    if (!tickets.length) return [];
    const lines = ['  事件单（券商 App → 条件单 / 智能单）：'];
    for (const t of tickets) {
      lines.push(`    · ${t.label}：触发「${t.trigger}」→ ${t.side === 'sell' ? '卖出' : '买入'} `
        + `${this.shares} 股，${t.orderType}${t.price ? ` ${t.price}` : ''}，${t.validity}`);
      if (t.note) lines.push(`       ${t.note}`);
    }
    return lines;
  }

  orderBlock() {
    const sideCn = this.side === 'buy' ? '买入' : '卖出';
    const lines = [
      `【${this.name || this.code} ${this.code}】${sideCn}`,
      `  委托价  ${this.price.toFixed(2)}`
      + (this.price_low && this.price_high
        ? `　（挂单区间 ${this.price_low.toFixed(2)} ~ ${this.price_high.toFixed(2)}）`
        : ''),
      `  数量    ${this.shares} 股`,
      `  预估金额 ${thousands(this.est_amount)} 元　费用约 ${this.est_fee.toFixed(2)} 元`,
    ];
    lines.push(...this.eventOrderBlock());
    if (this.limit_up || this.limit_down) {
      lines.push(`  涨跌停  ${this.limit_down ?? '-'} / ${this.limit_up ?? '-'}`);
    }
    for (const note of this.notes) lines.push(`  · ${note}`);
    return lines.join('\n');
  }
}

/** 把止损/止盈价从整数关口挪开一格。 */
export function avoidRoundNumber(price, direction) {
  const p = roundPrice(price);
  if (Math.abs(p - Math.round(p)) < 0.005) {
    return roundPrice(direction === 'down' ? p - 0.01 : p + 0.01);
  }
  return p;
}

/** 止损触发价：entry × (1 - pct%)，不低于跌停价、避开整数关口。 */
export function stopLossPrice(entryPrice, pct, code, name = '', prevClose = null) {
  if (!entryPrice || entryPrice <= 0 || pct <= 0) return null;
  let raw = roundPrice(entryPrice * (1 - pct / 100));
  const lp = limitPrices(prevClose || entryPrice, code, name);
  if (lp.down && raw < lp.down) raw = roundPrice(lp.down + 0.01);
  return avoidRoundNumber(raw, 'down');
}

/** 止盈触发价：entry × (1 + pct%)，避开整数关口（不按涨停裁剪）。 */
export function takeProfitPrice(entryPrice, pct, code, name = '') {
  if (!entryPrice || entryPrice <= 0 || pct <= 0) return null;
  return avoidRoundNumber(roundPrice(entryPrice * (1 + pct / 100)), 'up');
}

/** 目标价今天是否可达（用当日涨停价比对）。 */
export function reachableToday(target, price, code, name = '', prevClose = null) {
  if (!target || !price || price <= 0) return { reachable: true, note: '' };
  const lp = limitPrices(prevClose || price, code, name);
  if (lp.up && target > lp.up) {
    return {
      reachable: false,
      note: `止盈价 ${target.toFixed(2)} 高于当日涨停 ${lp.up.toFixed(2)}，`
        + '今日不可达（次日仍有效，条件单可保留）',
    };
  }
  return { reachable: true, note: '' };
}

/** 买入条件单：股数按资金与单票上限双重约束，附止损/止盈价。 */
export function buildBuyOrder(code, name, price, budget, stopLossPct, takeProfitPct, {
  trailingPct = null,
  capAmount = null,
  feeCfg = null,
  prevClose = null,
} = {}) {
  const fee = feeCfg || feeConfig({});
  const board = boardOf(code);
  const lp = limitPrices(prevClose || price, code, name);
  const amountBudget = capAmount ? Math.min(budget, capAmount) : budget;
  const rawShares = price ? amountBudget / (price * 1.002) : 0;
  const shares = roundLot(rawShares, code);
  const amount = roundPrice(price * shares);
  const estFee = calcFee(amount, 'buy', fee, board).total;
  const order = new ConditionalOrder({
    code,
    name,
    side: 'buy',
    shares,
    price: roundPrice(price),
    limit_up: lp.up,
    limit_down: lp.down,
    est_amount: amount,
    est_fee: estFee,
  });
  if (shares <= 0) {
    const need = price * lotSize(code);
    order.notes.push(`资金不足一手（一手约需 ${thousands(need, 0)} 元），无法给出买入数量`);
    return order;
  }
  order.stop_loss = stopLossPrice(price, stopLossPct, code, name, prevClose);
  order.take_profit = takeProfitPrice(price, takeProfitPct, code, name);
  order.trailing_pct = trailingPct;
  addCommonNotes(order, price, code, true);
  return order;
}

/** 卖出条件单：数量受 T+1 可卖约束（调用方传入可卖数）。 */
export function buildSellOrder(code, name, price, shares, costPrice, stopLossPct, takeProfitPct, {
  trailingPct = null,
  feeCfg = null,
  prevClose = null,
} = {}) {
  const fee = feeCfg || feeConfig({});
  const board = boardOf(code);
  const lp = limitPrices(prevClose || price, code, name);
  const qty = Math.max(0, Math.trunc(shares));
  const amount = roundPrice(price * qty);
  const estFee = calcFee(amount, 'sell', fee, board).total;
  const order = new ConditionalOrder({
    code,
    name,
    side: 'sell',
    shares: qty,
    price: roundPrice(price),
    limit_up: lp.up,
    limit_down: lp.down,
    est_amount: amount,
    est_fee: estFee,
  });
  if (qty <= 0) {
    order.notes.push('今日可卖数量为 0（T+1 锁定），无需挂卖出单');
    return order;
  }
  if (costPrice > 0) {
    const sl = stopLossPrice(costPrice, stopLossPct, code, name, prevClose);
    const tp = takeProfitPrice(costPrice, takeProfitPct, code, name);
    if (sl !== null && sl < price) order.stop_loss = sl;
    else if (sl !== null) {
      order.notes.push(`止损线 ${sl.toFixed(2)} 已高于现价 ${price.toFixed(2)}（早已跌破），`
        + '该条件单已无意义——需人工决定是否止损');
    }
    if (tp !== null && tp > price) order.take_profit = tp;
    else if (tp !== null) {
      order.notes.push(`止盈线 ${tp.toFixed(2)} 已低于现价 ${price.toFixed(2)}（已涨过止盈位），`
        + '此时挂到价卖出会立即成交——若想继续持有，请改挂更高止盈或跟踪回撤');
    }
    order.trailing_pct = trailingPct;
    const pnl = ((price - costPrice) / costPrice) * 100;
    order.notes.push(`相对成本 ${costPrice.toFixed(3)} 当前浮动 ${signed(pnl)}%`);
  }
  addCommonNotes(order, price, code, false);
  return order;
}

function addCommonNotes(order, price, code, isBuy) {
  if (order.stop_loss && price > 0) {
    const d = ((order.stop_loss - price) / price) * 100;
    order.notes.push(`止损距现价 ${signed(d)}%`);
  }
  if (order.take_profit && price > 0) {
    const d = ((order.take_profit - price) / price) * 100;
    order.notes.push(`止盈距现价 ${signed(d)}%`);
  }
  if (isBuy && order.shares && order.shares % lotSize(code) !== 0) {
    order.notes.push('数量不是整手，券商可能拒单');
  }
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
