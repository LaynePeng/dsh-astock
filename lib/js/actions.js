/**
 * 操作指示：先卖后买 + 资金闭环。上游 `astock_actions.py` 的 Node 移植。
 * 只产出给人看的清单，不连接券商、不下单。
 */

import {
  boardOf, calcFee, feeConfig, lotSize, roundLot, roundPrice,
} from './market.js';
import { pyRound } from './formula.js';

export class SellAction {
  constructor(data = {}) {
    Object.assign(this, {
      code: '', name: '', shares: 0, price: 0, reason: '', basis: '',
      urgency: 'normal', est_amount: 0, est_fee: 0, pnl_pct: null,
    }, data);
  }

  asDict() {
    const out = {
      code: this.code,
      name: this.name,
      shares: this.shares,
      price: this.price,
      reason: this.reason,
      basis: this.basis,
      urgency: this.urgency,
      est_amount: pyRound(this.est_amount, 2),
      est_fee: pyRound(this.est_fee, 2),
    };
    if (this.pnl_pct !== null) out.pnl_pct = this.pnl_pct;
    return out;
  }
}

export class BuyAction {
  constructor(data = {}) {
    Object.assign(this, {
      code: '', name: '', shares: 0, price: 0, score: 0,
      amount: 0, fee: 0, stop_loss: null, take_profit: null, reason: '',
    }, data);
  }

  asDict() {
    const out = {
      code: this.code,
      name: this.name,
      shares: this.shares,
      price: this.price,
      score: this.score,
      amount: pyRound(this.amount, 2),
      fee: pyRound(this.fee, 2),
      reason: this.reason,
    };
    if (this.stop_loss !== null) out.stop_loss = this.stop_loss;
    if (this.take_profit !== null) out.take_profit = this.take_profit;
    return out;
  }
}

export class ActionPlan {
  constructor(data = {}) {
    Object.assign(this, {
      sells: [], buys: [], cash_before: 0, sell_proceeds: 0, buy_cost: 0,
      cash_after: 0, notes: [], blocked: false, block_reason: '',
    }, data);
  }

  asDict() {
    return {
      sells: this.sells.map((s) => s.asDict()),
      buys: this.buys.map((b) => b.asDict()),
      cash_before: Math.round(this.cash_before * 100) / 100,
      sell_proceeds: Math.round(this.sell_proceeds * 100) / 100,
      buy_cost: Math.round(this.buy_cost * 100) / 100,
      cash_after: Math.round(this.cash_after * 100) / 100,
      notes: [...this.notes],
      blocked: this.blocked,
      block_reason: this.block_reason,
    };
  }
}

/** 判定该卖什么。只依据明确规则。 */
export function decideSells(positions, quotes, pickCodes, cfg, {
  totalMarketValue = 0, totalEquity = 0, feeCfg = null,
} = {}) {
  const fee = feeCfg || feeConfig({});
  const out = [];
  const picked = new Set((pickCodes || []).map(String));
  const stopPct = Math.abs(Number(cfg?.stop_loss_pct ?? 8.0) || 8.0);
  const takePct = Math.abs(Number(cfg?.take_profit_pct ?? 15.0) || 15.0);
  const capPct = Number(cfg?.position_cap_pct ?? 25.0) || 25.0;
  const capBase = Number(totalEquity || 0) || Number(totalMarketValue || 0);

  for (const p of positions || []) {
    const code = String(p.code || '');
    if (!code) continue;
    const q = quotes[code] || {};
    const price = q.price || p.cost_price;
    if (!price || price <= 0) continue;
    const held = Math.trunc(Number(p.shares) || 0);
    const available = Math.trunc(Number(p.available_today) || 0);
    const cost = Number(p.cost_price) || 0;
    if (held <= 0) continue;

    const pnlPct = cost > 0 ? ((price - cost) / cost) * 100 : null;
    const name = String(q.name || p.name || code);

    const mk = (shares, reason, basis, urgency = 'normal') => {
      let qty = Math.min(Math.trunc(shares), available);
      if (qty <= 0) return null;
      const lot = lotSize(code);
      if (qty < held) qty = Math.max(0, Math.floor(qty / lot) * lot);
      if (qty <= 0) return null;
      const amount = roundPrice(price * qty);
      const feeTotal = calcFee(amount, 'sell', fee, boardOf(code)).total;
      return new SellAction({
        code,
        name,
        shares: qty,
        price: roundPrice(price),
        reason,
        basis,
        urgency,
        est_amount: amount,
        est_fee: feeTotal,
        pnl_pct: pnlPct !== null ? Math.round(pnlPct * 100) / 100 : null,
      });
    };

    if (pnlPct !== null && pnlPct <= -stopPct) {
      const a = mk(held, `浮亏 ${signed(pnlPct)}% 触发止损线 -${g(stopPct)}%`,
        `浮亏比例 ${signed(pnlPct)}% ≤ -${g(stopPct)}%`, 'urgent');
      if (a) out.push(a);
      continue;
    }

    if (pnlPct !== null && pnlPct >= takePct) {
      const half = roundLot(held / 2, code);
      const a = mk(half || held,
        `浮盈 ${signed(pnlPct)}% 触及止盈线 +${g(takePct)}%，减半锁利`,
        `浮盈比例 ${signed(pnlPct)}% ≥ +${g(takePct)}%`);
      if (a) out.push(a);
      continue;
    }

    if (picked.size && !picked.has(code) && pnlPct !== null && pnlPct < 0) {
      const a = mk(held,
        `不在本轮选股名单且浮亏 ${signed(pnlPct)}%，建议换仓`,
        '该标的本轮未入选 + 浮亏；腾出资金给得分更高的标的');
      if (a) out.push(a);
      continue;
    }

    if (capBase > 0 && capPct > 0) {
      const mv = held * price;
      const weight = (mv / capBase) * 100;
      if (weight > capPct) {
        const targetMv = (capPct / 100) * capBase;
        const excessShares = Math.trunc((mv - targetMv) / price);
        const a = mk(excessShares,
          `单票占比 ${weight.toFixed(1)}% 超上限 ${g(capPct)}%，减到上限内`,
          `占总资产 ${weight.toFixed(1)}% > ${g(capPct)}%`);
        if (a) out.push(a);
      }
    }
  }

  out.sort((a, b) => {
    const ua = a.urgency !== 'urgent' ? 1 : 0;
    const ub = b.urgency !== 'urgent' ? 1 : 0;
    return (ua - ub) || (b.est_amount - a.est_amount);
  });
  return out;
}

/** 把选股结果转成买入指示（数量不改）。 */
export function decideBuys(allocations, proceeds, strategy) {
  const out = [];
  for (const a of allocations || []) {
    if (a.skipped || !a.shares) continue;
    out.push(new BuyAction({
      code: a.code,
      name: a.name,
      shares: Math.trunc(a.shares),
      price: Number(a.price),
      score: Number(a.score || 0),
      amount: Number(a.amount || 0),
      fee: Number(a.fee || 0),
      stop_loss: a.stop_loss ?? null,
      take_profit: a.take_profit ?? null,
      reason: `得分 ${Number(a.score || 0).toFixed(1)}`
        + (strategy ? `；${strategy.label}` : ''),
    }));
  }
  return out;
}

/** 生成完整操作指示：先卖后买 + 资金闭环核算。 */
export function buildActionPlan(positions, quotes, allocations, cash, cfg, {
  strategy = null, totalMarketValue = 0, totalEquity = 0, feeCfg = null,
} = {}) {
  const plan = new ActionPlan({ cash_before: Number(cash || 0) });
  const pickCodes = (allocations || []).map((a) => a.code);
  const sells = decideSells(positions, quotes, pickCodes, cfg, {
    totalMarketValue,
    totalEquity: Number(totalEquity || 0)
      || (Number(totalMarketValue || 0) + Number(cash || 0)),
    feeCfg,
  });
  plan.sells = sells;
  plan.sell_proceeds = roundPrice(sells.reduce(
    (sum, s) => sum + Math.max(0, s.est_amount - s.est_fee), 0,
  ));

  const buys = decideBuys(allocations, plan.sell_proceeds, strategy);
  plan.buys = buys;
  plan.buy_cost = Math.round(buys.reduce((sum, b) => sum + b.amount + b.fee, 0) * 100) / 100;

  const available = plan.cash_before + plan.sell_proceeds;
  plan.cash_after = Math.round((available - plan.buy_cost) * 100) / 100;

  if (!sells.length && !buys.length) {
    plan.blocked = true;
    plan.block_reason = '本轮既无需卖出，也没有可买入的标的';
    appendCommonNotes(plan, positions);
    return plan;
  }

  if (plan.buy_cost > available + 1e-6) {
    plan.notes.push(
      `⚠️ 买入总额 ${thousands(plan.buy_cost)} 元超过可用资金 ${thousands(available)} 元`
      + `（差 ${thousands(plan.buy_cost - available)} 元）。`
      + '请先按卖出指示回笼资金，或减少买入数量。',
    );
    plan.blocked = true;
    plan.block_reason = '买入资金不足，需先执行卖出';
  }
  if (sells.length) {
    plan.notes.push('**必须先卖出、再买入**：A 股卖出资金当日可用于买入，'
      + '反过来先买会因资金不足而失败。');
  }
  appendCommonNotes(plan, positions);
  return plan;
}

function appendCommonNotes(plan, positions) {
  if (plan.sells.some((s) => s.urgency === 'urgent')) {
    plan.notes.push('止损卖出最优先：这些标的已触发止损线，继续持有可能扩大亏损。');
  }
  const locked = (positions || []).filter(
    (p) => Math.trunc(Number(p.shares) || 0) > Math.trunc(Number(p.available_today) || 0),
  );
  if (locked.length) {
    const totalLocked = locked.reduce(
      (sum, p) => sum + (Math.trunc(Number(p.shares) || 0) - Math.trunc(Number(p.available_today) || 0)), 0,
    );
    plan.notes.push(`有 ${locked.length} 只持仓共 ${totalLocked} 股处于 T+1 锁定`
      + '（今日买入，明日才可卖）。卖出指示已按「今日可卖」裁剪，不会让你下废单。');
  }
  plan.notes.push('本插件不连接券商、不下单。以上为操作指示，请自行在券商 App 执行。');
}

/** 渲染成"照着做"的清单。 */
export function renderActionPlan(plan, strategyLabel = '') {
  const lines = [];
  const title = `操作指示${strategyLabel ? `（${strategyLabel}）` : ''}`;
  lines.push(`## 📋 ${title}`, '');

  if (plan.blocked && !plan.sells.length && !plan.buys.length) {
    lines.push(`${plan.block_reason}。`, '');
    lines.push('_可先跑一次选股，或检查台账里是否已有持仓。_');
    return lines.join('\n');
  }

  lines.push('| 资金 | 金额 |', '|---|---|');
  lines.push(`| 当前可用现金 | ${thousands(plan.cash_before)} 元 |`);
  if (plan.sells.length) {
    lines.push(`| 卖出回笼（净额） | +${thousands(plan.sell_proceeds)} 元 |`);
  }
  if (plan.buys.length) {
    lines.push(`| 买入支出（含费） | -${thousands(plan.buy_cost)} 元 |`);
  }
  lines.push(`| **操作后现金** | **${thousands(plan.cash_after)} 元** |`, '');

  if (plan.sells.length) {
    lines.push('### 第一步：卖出（先做这个，才有钱买）', '');
    lines.push('| 标的 | 卖出股数 | 参考价 | 预计净额 | 原因 |', '|---|---|---|---|---|');
    for (const s of plan.sells) {
      const mark = s.urgency === 'urgent' ? '🔴 ' : '';
      lines.push(`| ${mark}${s.name}(${s.code}) | **${s.shares}** | `
        + `${s.price.toFixed(2)} | ${thousands(s.est_amount - s.est_fee, 0)} | `
        + `${s.reason} |`);
    }
    lines.push('');
    lines.push('**在券商 App 逐条操作**：卖出 → 输入代码 → 数量填上表股数 → '
      + '限价填参考价（或市价）→ 确认。', '');
  } else {
    lines.push('### 第一步：卖出', '', '本轮无需卖出，直接看买入清单。', '');
  }

  if (plan.buys.length) {
    lines.push('### 第二步：买入（卖出成交后再做）', '');
    lines.push('| 标的 | 买入股数 | 参考价 | 金额 | 止损价 | 止盈价 |', '|---|---|---|---|---|---|');
    for (const b of plan.buys) {
      lines.push(`| ${b.name}(${b.code}) | **${b.shares}** | ${b.price.toFixed(2)} | `
        + `${thousands(b.amount, 0)} | `
        + `${b.stop_loss ? b.stop_loss.toFixed(2) : '-'} | `
        + `${b.take_profit ? b.take_profit.toFixed(2) : '-'} |`);
    }
    lines.push('');
    if (plan.buys.some((b) => b.stop_loss || b.take_profit)) {
      lines.push('### 第三步：买入成交后，把止盈止损挂成事件单', '');
      lines.push('> 券商 App → 交易 → 条件单 / 智能单 → 新建；一张单只填一个触发条件。', '');
      lines.push('| 标的 | 事件单 | 触发条件 | 委托 |', '|---|---|---|---|');
      for (const b of plan.buys) {
        const name = `${b.name}(${b.code})`;
        if (b.stop_loss) {
          lines.push(`| ${name} | 止损 | 最新价 ≤ **${b.stop_loss.toFixed(2)}** | `
            + `卖出 ${b.shares} 股 @ ${b.stop_loss.toFixed(2)}，限价，当日有效 |`);
        }
        if (b.take_profit) {
          lines.push(`| ${name} | 止盈 | 最新价 ≥ **${b.take_profit.toFixed(2)}** | `
            + `卖出 ${b.shares} 股 @ ${b.take_profit.toFixed(2)}，限价，当日有效 |`);
        }
      }
      lines.push('', '**为什么挂事件单而不是盯盘**：触发由券商执行，'
        + '不依赖插件或模型在线；没触发就次日重挂。', '');
    }
  }

  if (plan.notes.length) {
    lines.push('### 注意事项', '');
    for (const n of plan.notes) lines.push(`- ${n}`);
    lines.push('');
  }

  lines.push('---', '');
  lines.push('**这不是自动交易**：插件不连接任何券商接口、不下单、'
    + '不生成委托文件。以上只是按既定规则算出的操作指示，'
    + '请自行复核后在券商 App 执行。');
  return lines.join('\n');
}

function signed(value) {
  const n = Number(value) || 0;
  return `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(2)}`;
}

function g(value) {
  return String(Number(value));
}

function thousands(value, digits = 2) {
  const n = Number(value) || 0;
  const negative = n < 0;
  const fixed = Math.abs(n).toFixed(digits);
  const [ip, dec] = fixed.split('.');
  const withSep = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${withSep}${dec === undefined ? '' : `.${dec}`}`;
}
