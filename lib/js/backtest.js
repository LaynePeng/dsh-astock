/**
 * 回测引擎：策略历史重放 → 推荐率。上游 `astock_backtest.py` 的 Node 移植。
 * 防未来函数：每个信号日只用截止当日的数据，次日开盘买入。
 */

import { computeTechnical, rankCandidates, Scored, STRATEGIES } from './quant.js';
import { compensatedSum, pyRound } from './formula.js';

export const MIN_BARS = 90;
export const BENCHMARK_CODE = '000300';

export class BacktestConfig {
  constructor(data = {}) {
    Object.assign(this, {
      rebalance_days: 10,
      top_k: 3,
      hold_days: 10,
      cost_rate: 0.0015,
      lookback: 130,
    }, data);
  }

  asDict() {
    return {
      rebalance_days: this.rebalance_days,
      top_k: this.top_k,
      hold_days: this.hold_days,
      cost_rate: this.cost_rate,
      lookback: this.lookback,
    };
  }
}

export class PeriodResult {
  constructor(data = {}) {
    Object.assign(this, {
      date: '', entry_date: '', picks: [], names: [],
      gross_return_pct: 0, net_return_pct: 0, benchmark_pct: 0,
      excess_pct: 0, beat: false,
    }, data);
  }

  asDict() {
    return {
      date: this.date,
      entry_date: this.entry_date,
      picks: [...this.picks],
      names: [...this.names],
      net_return_pct: Math.round(this.net_return_pct * 100) / 100,
      benchmark_pct: Math.round(this.benchmark_pct * 100) / 100,
      excess_pct: Math.round(this.excess_pct * 100) / 100,
      beat: this.beat,
    };
  }
}

export class BacktestResult {
  constructor(data = {}) {
    Object.assign(this, {
      strategy: '',
      strategy_label: '',
      start_date: '',
      end_date: '',
      universe_size: 0,
      periods: [],
      equity_curve: [],
      benchmark_curve: [],
      excluded: 0,
      unavailable_factors: [],
      config: {},
      note: '',
    }, data);
  }

  get period_count() {
    return this.periods.length;
  }

  get win_rate() {
    if (!this.periods.length) return null;
    return pyRound(this.periods.filter((p) => p.beat).length / this.periods.length * 100, 1);
  }

  get avg_return_pct() {
    if (!this.periods.length) return null;
    return pyRound(compensatedSum(this.periods.map((p) => p.net_return_pct)) / this.periods.length, 2);
  }

  get avg_excess_pct() {
    if (!this.periods.length) return null;
    return pyRound(compensatedSum(this.periods.map((p) => p.excess_pct)) / this.periods.length, 2);
  }

  get total_return_pct() {
    if (!this.periods.length) return null;
    let nav = 1;
    for (const p of this.periods) nav *= (1 + p.net_return_pct / 100);
    return pyRound((nav - 1) * 100, 2);
  }

  get benchmark_return_pct() {
    if (!this.periods.length) return null;
    let nav = 1;
    for (const p of this.periods) nav *= (1 + p.benchmark_pct / 100);
    return pyRound((nav - 1) * 100, 2);
  }

  get max_drawdown_pct() {
    if (!this.equity_curve.length) return null;
    let peak = this.equity_curve[0][1];
    let worst = 0;
    for (const [, v] of this.equity_curve) {
      peak = Math.max(peak, v);
      if (peak > 0) worst = Math.min(worst, ((v - peak) / peak) * 100);
    }
    return pyRound(worst, 2);
  }

  get best_period_pct() {
    if (!this.periods.length) return null;
    return pyRound(Math.max(...this.periods.map((p) => p.net_return_pct)), 2);
  }

  get worst_period_pct() {
    if (!this.periods.length) return null;
    return pyRound(Math.min(...this.periods.map((p) => p.net_return_pct)), 2);
  }

  get complete() {
    return !this.unavailable_factors.length;
  }

  asDict() {
    return {
      strategy: this.strategy,
      strategy_label: this.strategy_label,
      start_date: this.start_date,
      end_date: this.end_date,
      universe_size: this.universe_size,
      period_count: this.period_count,
      win_rate: this.win_rate,
      avg_return_pct: this.avg_return_pct,
      avg_excess_pct: this.avg_excess_pct,
      total_return_pct: this.total_return_pct,
      benchmark_return_pct: this.benchmark_return_pct,
      max_drawdown_pct: this.max_drawdown_pct,
      best_period_pct: this.best_period_pct,
      worst_period_pct: this.worst_period_pct,
      complete: this.complete,
      unavailable_factors: [...this.unavailable_factors],
      excluded: this.excluded,
      config: { ...this.config },
      note: this.note,
    };
  }
}

/** 取截止 idx（含）的尾部窗口算因子——防未来函数的关键。 */
function windowFactors(bars, idx, lookback) {
  const start = Math.max(0, idx - lookback + 1);
  const seg = bars.slice(start, idx + 1);
  if (seg.length < 60) return null;
  const tech = computeTechnical(seg);
  return tech.bars >= 60 ? tech : null;
}

function equalWeightReturn(picks, entryIdx, exitIdx) {
  const rets = [];
  for (const p of picks) {
    const bars = p.bars;
    if (entryIdx >= bars.length || exitIdx >= bars.length) return null;
    const entry = bars[entryIdx].open || bars[entryIdx].close;
    const exit = bars[exitIdx].close;
    if (!entry || !exit || entry <= 0) return null;
    rets.push((exit - entry) / entry);
  }
  if (!rets.length) return null;
  return compensatedSum(rets) / rets.length * 100;
}

function benchmarkReturn(bench, entryIdx, exitIdx) {
  if (!bench || entryIdx >= bench.length || exitIdx >= bench.length) return 0;
  const entry = bench[entryIdx].open || bench[entryIdx].close;
  const exit = bench[exitIdx].close;
  if (!entry || !exit || entry <= 0) return 0;
  return ((exit - entry) / entry) * 100;
}

/** 滚动回测。 */
export function runBacktest(strategyKey, universe, benchmark, cfg = new BacktestConfig(), weights = null) {
  const strat = STRATEGIES[strategyKey];
  if (!strat) throw new Error(`未知策略 ${strategyKey}`);

  const unavailable = strategyKey === 'quality'
    ? ['pe_inv', 'pb_inv'].filter((f) => f in strat.weights) : [];

  const pool = [];
  let excluded = 0;
  for (const item of universe) {
    const bars = item.bars || [];
    if (bars.length < MIN_BARS) {
      excluded += 1;
      continue;
    }
    pool.push(item);
  }
  if (pool.length < cfg.top_k) {
    throw new Error(`可用历史数据的标的不足（${pool.length} 只 < 需要 ${cfg.top_k} 只），`
      + '无法回测。可减少每期买入只数，或放宽选股范围');
  }

  const benchByDate = {};
  const benchDates = [];
  (benchmark || []).forEach((b, i) => {
    benchByDate[b.date] = i;
    benchDates.push(b.date);
  });

  const commonLen = Math.min(...pool.map((p) => p.bars.length));
  if (commonLen < MIN_BARS) throw new Error('共同历史区间过短，无法回测');

  const startIdx = 60;
  const endIdx = commonLen - cfg.hold_days - 1;
  if (endIdx <= startIdx) throw new Error('历史区间不足以完成至少一期回测');

  const result = new BacktestResult({
    strategy: strat.key,
    strategy_label: strat.label,
    universe_size: pool.length,
    excluded,
    unavailable_factors: unavailable,
    config: cfg.asDict(),
  });

  const periodIdx = [];
  for (let i = startIdx; i <= endIdx; i += Math.max(1, cfg.rebalance_days)) periodIdx.push(i);
  let nav = 1;
  let benchNav = 1;
  result.equity_curve.push(['start', 1]);
  result.benchmark_curve.push(['start', 1]);

  for (const i of periodIdx) {
    const signalDate = pool[0].bars[i].date;
    const cands = [];
    for (const item of pool) {
      const bars = item.bars;
      if (i >= bars.length) continue;
      const tech = windowFactors(bars, i, cfg.lookback);
      if (!tech) continue;
      const price = bars[i].close || tech.close || 0;
      if (!price) continue;
      const row = {
        code: item.code,
        name: item.name || item.code,
        price,
        change_pct: null,
        amount_yuan: (bars[i].volume_lot || 0) * price * 100,
        total_mcap_yuan: null,
        pe: null,
        pb: null,
        turnover_pct: null,
        main_net_inflow_yuan: null,
      };
      cands.push(new Scored({
        code: item.code,
        name: item.name || item.code,
        price,
        change_pct: null,
        tech,
        row,
      }));
    }
    if (cands.length < cfg.top_k) continue;
    const ranked = rankCandidates(cands, strat, weights);
    const picks = ranked.slice(0, cfg.top_k);

    const entryIdx = i + 1;
    const exitIdx = Math.min(entryIdx + cfg.hold_days - 1, commonLen - 1);
    if (exitIdx <= entryIdx) continue;
    const pickItems = [];
    for (const s of picks) {
      const item = pool.find((x) => x.code === s.code);
      if (item) pickItems.push(item);
    }
    if (pickItems.length < cfg.top_k) continue;
    const gross = equalWeightReturn(pickItems, entryIdx, exitIdx);
    if (gross === null) continue;
    const net = gross - cfg.cost_rate * 100 * 2;

    const exitDate = pool[0].bars[Math.min(exitIdx, pool[0].bars.length - 1)].date;
    let bEntry = benchByDate[pool[0].bars[entryIdx].date];
    let bExit = benchByDate[exitDate];
    if (bEntry === undefined) {
      bEntry = undefined;
      for (let k = benchDates.length - 1; k >= 0; k -= 1) {
        if (benchDates[k] <= pool[0].bars[entryIdx].date) {
          bEntry = benchByDate[benchDates[k]];
          break;
        }
      }
    }
    if (bExit === undefined) {
      bExit = undefined;
      for (let k = benchDates.length - 1; k >= 0; k -= 1) {
        if (benchDates[k] <= exitDate) {
          bExit = benchByDate[benchDates[k]];
          break;
        }
      }
    }
    const benchRet = bEntry !== undefined && bExit !== undefined
      ? benchmarkReturn(benchmark, bEntry, bExit) : 0;

    const excess = net - benchRet;
    result.periods.push(new PeriodResult({
      date: signalDate,
      entry_date: pool[0].bars[entryIdx].date,
      picks: picks.map((s) => s.code),
      names: picks.map((s) => s.name),
      gross_return_pct: pyRound(gross, 2),
      net_return_pct: pyRound(net, 2),
      benchmark_pct: pyRound(benchRet, 2),
      excess_pct: pyRound(excess, 2),
      beat: excess > 0,
    }));

    nav *= (1 + net / 100);
    benchNav *= (1 + benchRet / 100);
    result.equity_curve.push([exitDate, Math.round(nav * 1e4) / 1e4]);
    result.benchmark_curve.push([exitDate, Math.round(benchNav * 1e4) / 1e4]);
  }

  if (!result.periods.length) {
    throw new Error('回测未产生任何有效区间（样本过少），请换策略或放宽范围');
  }
  result.start_date = result.periods[0].entry_date;
  result.end_date = result.periods[result.periods.length - 1].date;
  result.note = buildNote(result);
  return result;
}

function buildNote(result) {
  const bits = [`样本 ${result.period_count} 期、${result.universe_size} 只标的，`
    + `${result.start_date} 起。`];
  bits.push('含幸存者偏差（只含活到今天的股票），真实表现会略差于此处。');
  if (result.unavailable_factors.length) {
    const names = [...result.unavailable_factors].sort().join('、');
    bits.push(`**该策略回测不完整**：${names} 缺历史数据未参与，结论需打折看。`);
  }
  bits.push('历史不代表未来。');
  return bits.join('');
}

export class Recommendation {
  constructor(data = {}) {
    Object.assign(this, {
      grade: 'D', label: '不建议', win_rate: null, sample: 0,
      avg_excess_pct: null, max_drawdown_pct: null, reason: '', caveats: [],
    }, data);
  }

  get confidence() {
    if (this.sample >= 24) return '较充分';
    if (this.sample >= 12) return '一般';
    if (this.sample >= 5) return '偏少';
    return '过少';
  }

  asDict() {
    return {
      grade: this.grade,
      label: this.label,
      win_rate: this.win_rate,
      sample: this.sample,
      confidence: this.confidence,
      avg_excess_pct: this.avg_excess_pct,
      max_drawdown_pct: this.max_drawdown_pct,
      reason: this.reason,
      caveats: [...this.caveats],
    };
  }
}

export const GRADE_RULES = [
  ['A', '推荐', 65.0, 12],
  ['B', '可考虑', 50.0, 8],
  ['C', '谨慎', 35.0, 8],
  ['D', '不建议', 0.0, 0],
];

export function gradeRecommendation(bt) {
  const wr = bt.win_rate;
  const n = bt.period_count;
  const caveats = [];
  if (bt.unavailable_factors.length) {
    caveats.push(`策略不完整（${bt.unavailable_factors.length} 个因子缺历史数据）`);
  }
  if (bt.excluded) caveats.push(`${bt.excluded} 只标的因历史不足被排除`);
  caveats.push('含幸存者偏差，真实表现会略差');

  if (wr === null || n === 0) {
    return new Recommendation({
      grade: 'D', label: '不建议', win_rate: null, sample: 0,
      avg_excess_pct: null, max_drawdown_pct: null,
      reason: '没有可用的历史样本，无法给出推荐', caveats,
    });
  }
  if (n < 8) {
    return new Recommendation({
      grade: 'D', label: '样本不足', win_rate: wr, sample: n,
      avg_excess_pct: bt.avg_excess_pct, max_drawdown_pct: bt.max_drawdown_pct,
      reason: `仅有 ${n} 期历史样本，统计上不足以支撑结论（至少需要 8 期）`, caveats,
    });
  }
  for (const [grade, label, minWr, minN] of GRADE_RULES) {
    if (wr >= minWr && n >= minN) {
      const reason = `历史 ${n} 期中 ${Math.round((wr / 100) * n)} 期跑赢基准`
        + `（${wr.toFixed(1)}%），平均超额 ${bt.avg_excess_pct >= 0 ? '+' : ''}${bt.avg_excess_pct.toFixed(2)}%`;
      return new Recommendation({
        grade, label, win_rate: wr, sample: n,
        avg_excess_pct: bt.avg_excess_pct, max_drawdown_pct: bt.max_drawdown_pct,
        reason, caveats,
      });
    }
  }
  return new Recommendation({
    grade: 'D', label: '不建议', win_rate: wr, sample: n,
    avg_excess_pct: bt.avg_excess_pct, max_drawdown_pct: bt.max_drawdown_pct,
    reason: `历史胜率仅 ${wr.toFixed(1)}%，低于 35% 的最低门槛`, caveats,
  });
}

/** 回测报告。 */
export function renderBacktest(bt, rec, detailPeriods = 0) {
  const lines = [];
  const mark = { A: '🟢', B: '🔵', C: '🟠', D: '🔴' }[rec.grade] || '⚪';
  lines.push(`## ${mark} 回测结论：${bt.strategy_label} → **${rec.label}（${rec.grade} 档）**`, '');
  lines.push(`> ${rec.reason}`, '');

  if (rec.win_rate !== null) {
    lines.push('| 指标 | 数值 |', '|---|---|');
    lines.push(`| **推荐率（跑赢基准的期数占比）** | **${rec.win_rate.toFixed(1)}%**`
      + `（${Math.round((rec.win_rate / 100) * rec.sample)}/${rec.sample} 期）|`);
    lines.push(`| 样本可信度 | ${rec.confidence}（${rec.sample} 期）|`);
    if (bt.avg_return_pct !== null) {
      lines.push(`| 平均每期收益（扣费） | ${bt.avg_return_pct >= 0 ? '+' : ''}${bt.avg_return_pct.toFixed(2)}% |`);
    }
    if (bt.avg_excess_pct !== null) {
      lines.push(`| 平均每期超额 | ${bt.avg_excess_pct >= 0 ? '+' : ''}${bt.avg_excess_pct.toFixed(2)}% |`);
    }
    if (bt.total_return_pct !== null) {
      lines.push(`| 累计收益（策略 / 基准） | `
        + `${bt.total_return_pct >= 0 ? '+' : ''}${bt.total_return_pct.toFixed(2)}% / `
        + `${bt.benchmark_return_pct >= 0 ? '+' : ''}${bt.benchmark_return_pct.toFixed(2)}% |`);
    }
    if (bt.max_drawdown_pct !== null) {
      lines.push(`| 最大回撤 | ${bt.max_drawdown_pct.toFixed(2)}% |`);
    }
    if (bt.best_period_pct !== null) {
      lines.push(`| 最好 / 最差单期 | ${bt.best_period_pct >= 0 ? '+' : ''}${bt.best_period_pct.toFixed(2)}% / `
        + `${bt.worst_period_pct >= 0 ? '+' : ''}${bt.worst_period_pct.toFixed(2)}% |`);
    }
    lines.push(`| 回测区间 | ${bt.start_date} ~ ${bt.end_date} |`);
    lines.push(`| 参与标的 | ${bt.universe_size} 只 |`, '');
  }

  if (rec.caveats.length) {
    lines.push('### 必须知道的前提', '');
    for (const c of rec.caveats) lines.push(`- ${c}`);
    lines.push('', `_${bt.note}_`, '');
  }

  if (detailPeriods > 0 && bt.periods.length) {
    lines.push('### 逐期明细（可核对每一期选了什么、赚了多少）', '');
    lines.push('| 调仓日 | 买入 | 收益 | 基准 | 超额 |', '|---|---|---|---|---|');
    for (const p of bt.periods.slice(-detailPeriods)) {
      const names = p.names.slice(0, 3).join('、');
      const mark2 = p.beat ? '✅' : '❌';
      lines.push(`| ${p.date} | ${names} | ${p.net_return_pct >= 0 ? '+' : ''}${p.net_return_pct.toFixed(2)}% | `
        + `${p.benchmark_pct >= 0 ? '+' : ''}${p.benchmark_pct.toFixed(2)}% | `
        + `${mark2} ${p.excess_pct >= 0 ? '+' : ''}${p.excess_pct.toFixed(2)}% |`);
    }
    lines.push('');
  }

  lines.push('---', '');
  lines.push('**怎么用这个结论**：推荐率是「历史上按此策略选股，有多少期跑赢'
    + '沪深300」，**不是**某只股票上涨的概率。它衡量的是**策略**，'
    + '不是单只标的。样本期数越少，这个数字越不可靠——'
    + '所以每档都标了样本数。', '');
  lines.push('历史不代表未来，回测不构成投资建议。');
  return lines.join('\n');
}
