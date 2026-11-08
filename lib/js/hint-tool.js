/**
 * `astock_hint` 下单提示——上游 `astock_mixin_hint.py` 的 Node 移植。
 *
 * 组合：持仓快照 + 行情 + 规则提示 + 买卖数量估算 + 条件单参数落库。
 * 舆情背离段在 sentiment 模块迁移后接入（当前不查）。
 */

import { fetchKlines, fetchQuotes } from './kline.js';
import { marketContext, normalizeCode } from './market.js';
import {
  buildPositionHints, buildT1Hint, cfgNum, DISCLAIMER, hintsConfig,
  suggestBuy, suggestSell,
} from './hints.js';
import { buildBuyOrder, buildSellOrder } from './orders.js';
import { snapshot } from './portfolio.js';
import {
  f, pct, table,
} from './format.js';

function signed(value) {
  const n = Number(value) || 0;
  return `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(2)}`;
}

/** 把 Quote 对象压成 hint 规则需要的扁平结构（等价 Python `as_dict()`）。 */
export function quoteDict(quote = {}) {
  return {
    code: quote.code,
    name: quote.name,
    price: quote.price,
    prev_close: quote.prev_close,
    change: quote.change,
    change_pct: quote.change_pct,
    limit_up: quote.limit_up,
    limit_down: quote.limit_down,
    volume_ratio: quote.volume_ratio,
    limit_pct: quote.extra?.limit_pct ?? quote.limit_pct,
  };
}

/**
 * @param {object} args { code?, buy?, sell_ratio?, no_sentiment? }
 * @param {{ledger: object, config?: object, fetchQuotes?: Function,
 *          fetchKlines?: Function, sentimentFlags?: Function}} options
 */
export async function runHint(args = {}, options = {}) {
  const ledger = options.ledger;
  if (!ledger) return '[Error] 台账未初始化';
  const only = String(args.code || '').trim();
  const wantBuy = Boolean(args.buy);
  const sellRatio = args.sell_ratio;
  const cfg = hintsConfig(options.config || {});

  const snap = await snapshot(ledger, {
    fetchQuotes: options.fetchQuotes,
  });
  const data = snap.data;
  const posByCode = Object.fromEntries(data.positions.map((p) => [p.code, p]));

  let codes = [];
  if (only) {
    codes = [normalizeCode(only).code];
  } else {
    codes = data.positions.map((p) => p.code);
    for (const item of ledger.listWatch()) {
      if (!codes.includes(item.code)) codes.push(item.code);
    }
  }
  if (!codes.length) {
    return '台账里没有持仓或自选股，没有可提示的对象。'
      + '可以先用 astock_record 录入持仓，或 astock_watch 添加自选股。';
  }

  const quotes = { ...data.quotes };
  const missing = codes.filter((code) => !quotes[code]);
  if (missing.length) {
    try {
      const fetched = await (options.fetchQuotes || fetchQuotes)(missing, 'stock');
      for (const quote of fetched) quotes[quote.code] = quote;
    } catch (error) {
      return `[Error] 行情获取失败，无法生成提示：${error?.message ?? error}`;
    }
  }

  const highest = await highestPrices(Object.keys(quotes), options.fetchKlines || fetchKlines);
  const lines = [`**下单提示**（${marketContextText()}）`, ''];
  const allHints = [];
  const totalMv = Number(data.total_market_value) || 0;
  const totalEquity = Number(data.equity) || (totalMv + Number(data.cash || 0));

  for (const code of codes) {
    const rawQuote = quotes[code];
    if (!rawQuote) continue;
    const quote = quoteDict(rawQuote);
    const pos = posByCode[code];
    if (pos) {
      const hs = buildPositionHints(pos, quote, cfg, {
        highestPrice: highest[code],
        totalMarketValue: totalMv,
        totalEquity,
      });
      const t1 = buildT1Hint(pos, Math.trunc(Number(pos.available_today) || 0));
      if (t1) hs.push(t1);
      allHints.push(...hs);
      if (hs.length) {
        lines.push(`**${pos.name || code}(${code})**`);
        for (const hint of hs) {
          lines.push(`- ${hint.title}｜${hint.suggestion}（依据：${hint.basis}）`);
        }
        lines.push('');
      } else {
        const pnl = pct(quote.price ? ((quote.price - pos.cost_price) / pos.cost_price) * 100 : null);
        lines.push(`**${pos.name || code}(${code})**：`
          + `现价 ${f(quote.price)}，浮盈 ${pnl}，`
          + `未触发任何规则区间（止损 -${cfgNum(cfg.stop_loss_pct)}% / `
          + `止盈 +${cfgNum(cfg.take_profit_pct)}%）。`);
        lines.push('');
      }
    } else {
      const hs = buildPositionHints({ code }, quote, cfg, { watchOnly: true });
      if (hs.length) {
        lines.push(`**${quote.name || code}(${code})**（自选）`);
        for (const hint of hs) lines.push(`- ${hint.title}｜${hint.suggestion}`);
        lines.push('');
      }
    }

    if (pos && sellRatio !== null && sellRatio !== undefined) {
      let ratio = Number(sellRatio);
      if (!Number.isFinite(ratio)) ratio = 1;
      const est = suggestSell(pos, quote.price || 0,
        Math.trunc(Number(pos.available_today) || 0), { ratio, feeCfg: ledger.fee });
      if (est.suggest_shares) {
        lines.push(table(['卖出估算', '数值'], [
          ['建议卖出', `${est.suggest_shares} 股（剩余 ${est.remain_shares}）`],
          ['预计金额', `${f(est.suggest_amount)} 元`],
          ['预计费用', `${Number(est.est_fee).toFixed(2)} 元`],
          ['预计净收入', `${f(est.est_net_proceeds)} 元`],
          ['预计已实现盈亏', `${signed(est.est_realized_pnl)} 元`],
        ]));
        lines.push('');
      }
    }

    if (wantBuy && quote.price) {
      const est = suggestBuy(
        code, quote.name || code, quote.price,
        Number(data.cash) || 0, cfg,
        {
          existingShares: pos ? Math.trunc(pos.shares) : 0,
          existingCost: pos ? Number(pos.cost_price) : 0,
          totalMarketValue: totalMv,
          feeCfg: ledger.fee,
          prevClose: quote.prev_close,
        },
      );
      lines.push(table(['买入估算', '数值'], [
        ['参考价', `${Number(est.price).toFixed(2)}`],
        ['建议股数', `${est.suggest_shares} 股（${est.reason}）`],
        ['预计金额', `${f(est.suggest_amount)} 元`],
        ['预计费用', `${Number(est.est_fee).toFixed(2)} 元`],
        ['预计总成本', `${f(est.est_total_cost)} 元`],
        ['买入后成本价', f(est.avg_cost_after, 3)],
        ['涨停 / 跌停价', `${f(est.limit_up)} / ${f(est.limit_down)}`],
      ]));
      lines.push(`注：${est.note}`);
      lines.push('');
    }
  }

  if (!allHints.length && !only) {
    lines.splice(2, 0, '本次扫描未触发任何规则信号（止损/止盈/回撤/涨跌停/异动）。\n');
  }

  if (!args.no_sentiment && typeof options.sentimentFlags === 'function') {
    const flagCodes = codes.filter((code) => posByCode[code]);
    const flags = await options.sentimentFlags(flagCodes.length ? flagCodes : codes.slice(0, 1));
    if (flags?.length) {
      lines.push('', '### 舆情参考（背离信号优先）', ...flags, '');
    }
  }

  const [planLines, planIds] = await buildOrderPlans(
    codes, posByCode, quotes, data, wantBuy, cfg, ledger,
  );
  if (planLines.length) {
    lines.push('', '### 可照抄的条件单（挂一次，不用盯盘）', ...planLines);
    if (planIds.length) {
      lines.push('', `_计划号：${planIds.join('、')}。成交后用 astock_sync `
        + '把回单粘回来即可自动匹配这条计划。_');
    }
  }
  lines.push(DISCLAIMER);
  return lines.join('\n');
}

async function buildOrderPlans(codes, posByCode, quotes, data, wantBuy, cfg, ledger) {
  const cash = Number(data.cash || 0);
  const totalMv = Number(data.total_market_value || 0);
  const capAmount = totalMv + cash > 0
    ? ((totalMv + cash) * cfg.position_cap_pct) / 100
    : 0;
  const out = [];
  const ids = [];
  for (const code of codes.slice(0, 6)) {
    const quote = quotes[code] || {};
    const price = quote.price;
    if (!price) continue;
    const pos = posByCode[code];
    const name = quote.name || pos?.name || code;
    let order = null;
    if (pos) {
      const avail = Math.trunc(Number(pos.available_today) || 0);
      order = buildSellOrder(
        code, name, Number(price), avail, Number(pos.cost_price) || 0,
        cfg.stop_loss_pct, cfg.take_profit_pct,
        {
          trailingPct: cfg.trailing_pct,
          feeCfg: ledger.fee,
          prevClose: quote.prev_close,
        },
      );
    } else if (wantBuy) {
      order = buildBuyOrder(
        code, name, Number(price), cash,
        cfg.stop_loss_pct, cfg.take_profit_pct,
        {
          trailingPct: cfg.trailing_pct,
          capAmount,
          feeCfg: ledger.fee,
          prevClose: quote.prev_close,
        },
      );
    }
    if (!order || order.shares <= 0) {
      if (order && order.notes.length) out.push(order.orderBlock());
      continue;
    }
    let pid = '';
    try {
      const plan = ledger.savePlan({
        code,
        name,
        side: order.side,
        price: order.price,
        shares: order.shares,
        stop_loss: order.stop_loss,
        take_profit: order.take_profit,
        trailing: order.trailing_pct,
        reason: '条件单参数（由 astock_hint 生成）',
        kind: 'conditional_order',
      });
      pid = plan.plan_id || '';
    } catch {
      pid = '';
    }
    let block = order.orderBlock();
    if (pid) {
      block += `\n  计划号  ${pid}`;
      ids.push(pid);
    }
    out.push(block);
  }
  return [out, ids];
}

async function highestPrices(codes, fetchK) {
  const out = {};
  for (const code of codes.slice(0, 20)) {
    try {
      const result = await fetchK(code, { period: 'day', limit: 60, adjust: 'qfq' });
      const bars = result?.bars || [];
      if (bars.length) out[code] = Math.max(...bars.map((bar) => bar.high));
    } catch {
      // 单只取不到不影响其它标的
    }
  }
  return out;
}

function marketContextText() {
  return marketContext().text;
}
