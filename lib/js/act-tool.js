/**
 * `astock_act` 操作指示——上游 `astock_mixin_quant.py::_tool_act` 的 Node 移植。
 */

import { buildActionPlan, renderActionPlan } from './actions.js';
import { hintsConfig } from './hints.js';
import { snapshot } from './portfolio.js';
import { MAX_KLINE_CANDIDATES, STRATEGIES } from './quant.js';
import { scan } from './pick-tool.js';
import { SizingConfig } from './quant.js';

function sizingFrom(args, config) {
  const maxPos = args.max_positions ?? config.pick_max_positions ?? 5;
  const usage = args.cash_usage_pct ?? config.pick_cash_usage_pct ?? 80;
  return new SizingConfig({
    position_cap_pct: Number(config.position_cap_pct ?? 25),
    max_positions: Math.max(1, Math.min(Math.trunc(Number(maxPos) || 5), 20)),
    cash_usage_pct: Math.max(1, Math.min(Number(usage) || 80, 100)),
    cash_reserve_yuan: Math.max(0, Number(config.pick_cash_reserve_yuan ?? 0)),
  });
}

function gradeLine(rec) {
  if (!rec) return '';
  const mark = { A: '🟢', B: '🔵', C: '🟠', D: '🔴' }[rec.grade] || '⚪';
  if (rec.win_rate === null || rec.win_rate === undefined) {
    return `> ${mark} **推荐率无法判定**：${rec.reason || ''}`;
  }
  return `> ${mark} **策略推荐率 ${Math.round(rec.win_rate)}%**`
    + `（${rec.grade} 档 · ${rec.label}；历史 ${rec.sample} 期中 `
    + `${Math.round((rec.win_rate / 100) * rec.sample)} 期跑赢沪深300，`
    + `样本可信度 ${rec.confidence}）\n`
    + '> 这是**策略**的历史表现，不是这几只票各自上涨的概率。';
}

async function attachGrade(strategy, options) {
  try {
    const mod = options.backtest || await import('./backtest-tool.js');
    let cached = mod.getCached(strategy);
    if (!cached) {
      cached = await (options.backtestRun || mod.run)(strategy, {
        poolSize: 25,
        useCache: true,
        ledger: options.ledger,
        archive: options.archive,
        fetchKlines: options.fetchKlines,
      });
    }
    return gradeLine(cached?.recommendation);
  } catch {
    return '> ⚪ **推荐率暂不可用**：回测取数失败（可能接口限流）。'
      + '可稍后单独问「回测一下这个策略」。';
  }
}

/**
 * @param {object} args
 * @param {{ledger: object, config?: object, snapshot?: Function,
 *          scan?: Function, archive?: object, backtest?: object}} options
 */
export async function runAct(args = {}, options = {}) {
  const ledger = options.ledger;
  if (!ledger) return '[Error] 台账未初始化';
  const config = options.config || {};
  const strategy = String(args.strategy || config.pick_strategy || 'momentum').toLowerCase();
  const strat = STRATEGIES[strategy] || STRATEGIES.momentum;

  let snap;
  try {
    snap = await (options.snapshot || snapshot)(ledger, {
      fetchQuotes: options.fetchQuotes,
    });
  } catch (error) {
    return `[Error] 选股失败，无法生成操作指示：${error?.message ?? error}`;
  }
  const d = snap.data;
  const cash = Number(d.cash || 0);
  const totalMv = Number(d.total_market_value || 0);
  const equity = totalMv + cash;
  const sizing = sizingFrom(args, config);
  const universeRaw = String(args.universe || config.pick_universe || 'main').toLowerCase();
  const universe = ['main', 'all', 'gem', 'star'].includes(universeRaw) ? universeRaw : 'main';
  const candidateLimit = Math.max(5, Math.min(
    Math.trunc(Number(config.pick_candidates ?? MAX_KLINE_CANDIDATES)) || MAX_KLINE_CANDIDATES, 60,
  ));

  let scanResult;
  try {
    scanResult = await (options.scan || scan)(strategy, {
      cash,
      equity,
      universe,
      sizing,
      candidateLimit,
      useCache: !args.fresh,
      feeCfg: ledger.fee,
      collect: options.collect,
    });
  } catch (error) {
    return `[Error] 选股失败，无法生成操作指示：${error?.message ?? error}`;
  }

  const plan = buildActionPlan(
    d.positions || [],
    d.quotes || {},
    scanResult.allocations || [],
    cash,
    hintsConfig(config),
    {
      strategy: strat,
      totalMarketValue: totalMv,
      totalEquity: Number(d.equity || 0) || equity,
      feeCfg: ledger.fee,
    },
  );
  let text = renderActionPlan(plan, strat.label);
  if (!args.no_grade && config.backtest_auto_grade !== false) {
    const grade = await attachGrade(strategy, options);
    if (grade) text = `${grade}\n\n${text}`;
  }
  return text;
}
