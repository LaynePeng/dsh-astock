/**
 * 量化选股工具层：取数 → 打分 → 股数换算 → 富围栏渲染。
 * 上游 `astock_quant_tool.py` + `astock_rich.render_pick` 的 Node 移植。
 */

import { fetchKlines } from './kline.js';
import {
  Allocation, computeTechnical, DEFAULT_STRATEGY, DISCLAIMER, MAX_KLINE_CANDIDATES,
  passesFilters, rankCandidates, Scored, sizePositions, SizingConfig, STRATEGIES,
} from './quant.js';
import { fetchScreen } from './screen.js';
import { snapshot } from './portfolio.js';
import { f, table } from './format.js';

const CACHE_TTL_MS = 180_000;
const CACHE = new Map();

export function clearCache() {
  CACHE.clear();
}

function cacheKey(strategy, universe, candidateLimit, sizing, cash, equity, weights) {
  const w = weights ? JSON.stringify(Object.entries(weights).sort()) : '';
  return `${strategy}|${universe}|${candidateLimit}|${sizing.max_positions}|`
    + `${sizing.position_cap_pct}|${sizing.cash_usage_pct}|`
    + `${Math.round(cash * 100) / 100}|${Math.round(equity * 100) / 100}|${w}`;
}

/** 取数层：全市场快照 → 前 N 只日 K → 原始候选池。 */
export async function collect(universe = 'main', {
  candidateLimit = MAX_KLINE_CANDIDATES, prefilterLimit = 300, fetchKlines: fetchK = fetchKlines,
} = {}) {
  const snap = await fetchScreen({
    universe, sort_by: 'amount', limit: prefilterLimit, exclude_st: true,
  });
  let rows = [...(snap.rows || [])];
  const scanned = Number(snap.total || 0);
  if (!rows.length) throw new Error('全市场快照返回空（接口可能限流），请稍后重试');
  rows = rows.slice(0, Math.max(1, candidateLimit));
  const techs = {};
  let fetchFailed = 0;
  for (const row of rows) {
    const code = String(row.code || '');
    if (!code) continue;
    try {
      const result = await fetchK(code, { period: 'day', limit: 120 });
      techs[code] = computeTechnical(result.bars || []);
    } catch {
      fetchFailed += 1;
    }
  }
  return {
    rows, techs, scanned, fetch_failed: fetchFailed, universe,
  };
}

/** 打分层：在一份采集结果上跑单套策略（纯计算）。 */
export function evaluate(collected, strategyKey, {
  cash, equity, sizing = new SizingConfig(), weights = null, feeCfg = null,
} = {}) {
  const strat = STRATEGIES[strategyKey];
  if (!strat) {
    throw new Error(`未知策略 ${strategyKey}；可选：${Object.keys(STRATEGIES).join('、')}`);
  }
  const scoredAll = [];
  const rejected = [];
  for (const row of collected.rows || []) {
    const code = String(row.code || '');
    const tech = (collected.techs || {})[code];
    if (!code || !tech) continue;
    const [ok, why] = passesFilters(row, tech, strat);
    if (!ok) {
      rejected.push({ code, name: String(row.name || ''), reason: why });
      continue;
    }
    scoredAll.push(new Scored({
      code,
      name: String(row.name || code),
      price: Number(row.price || tech.close || 0),
      change_pct: row.change_pct,
      tech,
      row,
    }));
  }
  const ranked = rankCandidates(scoredAll, strat, weights);
  const [taken, skipped, summary] = sizePositions(ranked, cash, equity, sizing, {
    feeCfg, strategy: strat,
  });
  return {
    strategy: strat.key,
    strategy_label: strat.label,
    strategy_description: strat.description,
    scanned: collected.scanned || 0,
    prefiltered: (collected.rows || []).length,
    candidates: scoredAll.length,
    fetch_failed: collected.fetch_failed || 0,
    ranked,
    top: ranked.slice(0, 10),
    allocations: taken,
    skipped,
    summary,
    rejected_sample: rejected.slice(0, 8),
    generated_at: nowStamp(),
    cached: false,
    cache_age_sec: 0,
    universe: collected.universe || 'main',
  };
}

export async function scan(strategyKey, {
  cash, equity, universe = 'main', sizing = new SizingConfig(), weights = null,
  candidateLimit = MAX_KLINE_CANDIDATES, prefilterLimit = 300,
  feeCfg = null, useCache = true, collect: collectFn = collect,
} = {}) {
  const strat = STRATEGIES[strategyKey];
  if (!strat) {
    throw new Error(`未知策略 ${strategyKey}；可选：${Object.keys(STRATEGIES).join('、')}`);
  }
  const key = cacheKey(strat.key, universe, candidateLimit, sizing, cash, equity, weights);
  if (useCache) {
    const hit = CACHE.get(key);
    if (hit && Date.now() - hit.at <= CACHE_TTL_MS) {
      return {
        ...hit.value,
        cached: true,
        cache_age_sec: Math.round((Date.now() - hit.at) / 100) / 10,
      };
    }
  }
  const collected = await collectFn(universe, { candidateLimit, prefilterLimit });
  const result = evaluate(collected, strat.key, {
    cash, equity, sizing, weights, feeCfg,
  });
  CACHE.set(key, { at: Date.now(), value: result });
  return result;
}

export async function scanAll({
  cash, equity, universe = 'main', sizing = new SizingConfig(),
  candidateLimit = MAX_KLINE_CANDIDATES, prefilterLimit = 300,
  strategies = null, feeCfg = null, useCache = true, collect: collectFn = collect,
} = {}) {
  const keys = (strategies || Object.keys(STRATEGIES)).filter((k) => STRATEGIES[k]);
  if (!keys.length) throw new Error('没有可用的策略');
  const out = {};
  const pending = [];
  const now = Date.now();
  for (const key of keys) {
    if (!useCache) {
      pending.push(key);
      continue;
    }
    const hit = CACHE.get(cacheKey(key, universe, candidateLimit, sizing, cash, equity, null));
    if (hit && now - hit.at <= CACHE_TTL_MS) {
      out[key] = {
        ...hit.value,
        cached: true,
        cache_age_sec: Math.round((now - hit.at) / 100) / 10,
      };
    } else pending.push(key);
  }
  if (!pending.length) return out;

  const collected = await collectFn(universe, { candidateLimit, prefilterLimit });
  const stamp = Date.now();
  for (const key of pending) {
    const res = evaluate(collected, key, {
      cash, equity, sizing, feeCfg,
    });
    CACHE.set(cacheKey(key, universe, candidateLimit, sizing, cash, equity, null),
      { at: stamp, value: res });
    out[key] = res;
  }
  return out;
}

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fence(name, payload) {
  return `\`\`\`${name}\n${JSON.stringify(payload)}\n\`\`\``;
}

function clip(text, limit) {
  const t = String(text ?? '').trim();
  if (t.length <= limit) return t;
  return `${t.slice(0, Math.max(1, limit - 1))}…`;
}

function moneyYuan(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return `${f(n, 0)} 元`;
}

function moneyShort(value) {
  const n = Number(value || 0);
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return f(n, 0);
}

function gNum(value) {
  return String(Number(value));
}

function scoreTone(score) {
  if (score === null || score === undefined) return 'neutral';
  return score >= 70 ? 'good' : score >= 50 ? 'neutral' : 'bad';
}

function stopTake(a) {
  const sl = a.stop_loss ? a.stop_loss.toFixed(2) : '-';
  const tp = a.take_profit ? a.take_profit.toFixed(2) : '-';
  return `止损 ${sl} / 止盈 ${tp}`;
}

function pickLine(a) {
  return `${a.shares} 股 ≈ ${moneyYuan(a.amount)}（占权益 ${a.weight_pct.toFixed(1)}%）`;
}

function riskLine(summary) {
  const sl = summary.stop_loss_pct;
  const tp = summary.take_profit_pct;
  if (sl === null || sl === undefined) {
    return tp === null || tp === undefined ? '见明细表' : `止盈 ${gNum(tp)}%`;
  }
  if (tp === null || tp === undefined) return `止损 ${gNum(sl)}%`;
  return `止损 ${gNum(sl)}% / 止盈 ${gNum(tp)}%`;
}

/** 单策略选股富围栏报告。 */
export function renderPick(result, maxRows = 10) {
  const strat = STRATEGIES[result.strategy] || STRATEGIES[DEFAULT_STRATEGY];
  const allocations = (result.allocations || []).slice(0, maxRows);
  const skipped = result.skipped || [];
  const summary = result.summary || {};
  const out = [`**量化选股 + 买入计划**（策略：${strat.label}）`, '',
    `> ${strat.description}`, ''];
  out.push(fence('kpi', {
    items: [
      {
        label: '全市场扫描', value: `${Number(result.scanned || 0).toLocaleString('en-US')} 只`,
        note: `过门槛 ${Number(result.candidates || 0)} 只`, trend: 'flat',
      },
      {
        label: '本轮可买', value: `${allocations.length} 只`,
        delta: skipped.length ? `另 ${skipped.length} 只资金不足` : '无资金不足', trend: 'flat',
      },
      {
        label: '计划投入', value: moneyYuan(summary.allocated_amount),
        delta: `预算 ${moneyYuan(summary.budget)}`, trend: 'flat',
      },
      {
        label: '买入后剩余', value: moneyYuan(summary.remaining_cash),
        delta: `费用约 ${f(summary.allocated_fee)} 元`, trend: 'flat',
      },
    ],
  }), '');

  if (!allocations.length) {
    out.push('**本轮没有产生可执行的买入计划。**', '');
    if (skipped.length) {
      out.push('**资金不足导致全部跳过**：', '');
      for (const a of skipped.slice(0, maxRows)) {
        out.push(`- ${a.name}(${a.code}) 现价 ${a.price.toFixed(2)}：${a.skip_reason}`);
      }
      out.push('');
      out.push(`可用资金 ${moneyYuan(summary.cash)}，本轮预算 ${moneyYuan(summary.budget)}。`
        + '可提高「现金使用比例」、减少「本轮最多买几只」，'
        + '或用 `astock_portfolio action=set_cash` 校准资金。');
    } else {
      out.push('可能原因：过滤门槛过严（成交额/市值）、当日普涨导致涨幅超上限'
        + '被剔除、或该策略近期无符合条件的标的。'
        + '可换 strategy，或放宽设置页的「最低成交额门槛」。');
    }
    out.push('', DISCLAIMER);
    return out.join('\n');
  }

  const cards = allocations.map((a) => ({
    title: clip(`${a.name} ${a.price.toFixed(2)}`, 80),
    desc: clip(`${pickLine(a)}\n${stopTake(a)} · 得分 ${a.score.toFixed(1)}`, 200),
    tag: clip(`${a.shares} 股`, 20),
    tone: scoreTone(a.score),
  }));
  out.push(fence('board', {
    columns: [{ name: `买入清单（照此填单）· ${allocations.length} 只`, cards }],
  }), '');

  out.push('**明细核对**', '');
  out.push(fence('table', {
    columns: ['标的', '参考价', '股数', '金额', '占比', '得分', '止损', '止盈'],
    rows: allocations.map((a) => [
      `${a.name}(${a.code})`, a.price.toFixed(2), String(a.shares),
      f(a.amount, 0), `${a.weight_pct.toFixed(1)}%`, a.score.toFixed(1),
      a.stop_loss ? a.stop_loss.toFixed(2) : '-',
      a.take_profit ? a.take_profit.toFixed(2) : '-',
    ]),
  }), '');

  out.push('**资金口径**', '');
  out.push(`- 可用现金 ${moneyYuan(summary.cash)}｜账户总权益 ${moneyYuan(summary.equity)}`);
  out.push(`- 本轮预算 ${moneyYuan(summary.budget)}（${summary.budget_source || '现金使用比例'}）`);
  out.push(`- 单票上限 ${moneyYuan(summary.position_cap_amount)}`
    + (summary.position_cap_pct ? `（${gNum(summary.position_cap_pct)}% × 总权益）` : ''));
  out.push(`- 止损止盈口径：${riskLine(summary)}`, '');

  if (skipped.length) {
    out.push(`**因资金不足跳过 ${skipped.length} 只**（本身过了策略筛选，只是预算不够买一手）`, '');
    for (const a of skipped.slice(0, maxRows)) {
      out.push(`- ${a.name}(${a.code}) 现价 ${a.price.toFixed(2)}：${a.skip_reason}`);
    }
    out.push('', '想买其中某只：单独问「XXX 买多少」，'
      + '或 `astock_hint code=XXX buy=true`。', '');
  }

  const note = cacheNote(result);
  if (note) out.push(note, '');
  out.push(DISCLAIMER);
  return out.join('\n');
}

function cacheNote(result) {
  const notes = [];
  if (result.cached && result.cache_age_sec) {
    notes.push(`（结果取自 ${Math.round(result.cache_age_sec)} 秒前的缓存；要最新的一轮加 \`fresh=true\`）`);
  }
  if (result.fetch_failed) notes.push(`（${Math.round(result.fetch_failed)} 只 K 线拉取失败已跳过）`);
  return notes.join(' ');
}

/** 只出得分排行。 */
export function renderRanking(result, n = 10) {
  const ranked = result.top || [];
  if (!ranked.length) return '本轮没有候选通过策略筛选。';
  const rows = ranked.slice(0, n).map((c, i) => [
    String(i + 1), `${c.name}(${c.code})`, c.price.toFixed(2),
    c.change_pct === null || c.change_pct === undefined ? '-' : `${c.change_pct >= 0 ? '+' : ''}${c.change_pct.toFixed(2)}%`,
    c.score.toFixed(1), c.explain(2),
  ]);
  return [`**得分排行**（${result.strategy_label || result.strategy}，`
    + `候选 ${result.candidates} 只，按分数降序）`, '',
  fence('table', {
    columns: ['#', '标的', '现价', '涨跌', '得分', '主要贡献因子'], rows,
  }), '',
  '得分 = 候选池内各因子百分位 × 权重，**是相对排名不是上涨概率**。'
    + '想看具体买多少股，用 `astock_pick`（不传 rank_only）。'].join('\n');
}

/** 三策略对比。 */
export function renderCompare(results, maxRows = 5) {
  const keys = Object.keys(STRATEGIES).filter((k) => results[k]);
  if (!keys.length) {
    return '**量化选股 · 三策略对比**\n\n尚未生成选股结果。点设置页「立即跑一轮选股」，'
      + '或在对话里说「帮我选股」。\n\n_面板只读缓存、不会自动扫全市场_';
  }
  const first = results[keys[0]];
  const pickedBy = {};
  const metaByCode = {};
  for (const key of keys) {
    for (const a of results[key].allocations || []) {
      if (!pickedBy[a.code]) pickedBy[a.code] = [];
      pickedBy[a.code].push(key);
      metaByCode[a.code] = a;
    }
  }
  const multi = Object.keys(pickedBy).filter((code) => pickedBy[code].length > 1);
  const totalPicks = keys.reduce((sum, k) => sum + (results[k].allocations || []).length, 0);
  const scanned = Number(first.scanned || 0);
  const age = Math.max(...keys.map((k) => Number(results[k].cache_age_sec || 0)));
  const out = ['**量化选股 · 三策略对比**', '',
    `扫描 ${scanned.toLocaleString('en-US')} 只｜${first.generated_at || '-'} 生成｜${Math.round(age)}s 前`, ''];
  out.push(fence('kpi', {
    items: [
      { label: '扫描规模', value: `${scanned.toLocaleString('en-US')} 只`, trend: 'flat' },
      {
        label: '三套共选出', value: `${totalPicks} 只次`,
        note: `去重后 ${Object.keys(pickedBy).length} 只`, trend: 'flat',
      },
      {
        label: '多套共识', value: `${multi.length} 只`,
        delta: multi.length ? '分歧小、更值得看' : '三套各选各的，分歧大', trend: 'flat',
      },
      { label: '数据新鲜度', value: `${Math.round(age)}s`, note: '过期请重跑', trend: 'flat' },
    ],
  }), '');

  const columns = keys.map((key) => {
    const strat = STRATEGIES[key];
    const allocs = (results[key].allocations || []).slice(0, maxRows);
    const cards = allocs.map((a) => {
      const others = pickedBy[a.code].filter((k) => k !== key).map((k) => STRATEGIES[k].label);
      return {
        title: clip(`${a.name} ${a.price.toFixed(2)}`, 80),
        desc: clip(`${pickLine(a)}\n${stopTake(a)} · 得分 ${a.score.toFixed(1)}`
          + (others.length ? `｜另被 ${others.join('/')} 选中` : ''), 200),
        tag: clip(`${a.shares} 股`, 20),
        tone: others.length ? 'good' : scoreTone(a.score),
      };
    });
    if (!cards.length) {
      const skipped = results[key].skipped || [];
      cards.push({
        title: `${strat.label}：无入选`,
        desc: skipped.length ? `${skipped.length} 只过筛但资金不足一手`
          : `无标的过门槛（候选 ${results[key].candidates || 0} 只）`,
        tag: '空缺',
        tone: 'neutral',
      });
    }
    return { name: clip(strat.label, 80), cards };
  });
  out.push(fence('board', { columns }), '');

  if (multi.length) {
    out.push(`**多套同时选中 ${multi.length} 只**（分歧小、更值得看）`, '');
    for (const code of multi.slice(0, maxRows + 3)) {
      const a = metaByCode[code];
      const labels = pickedBy[code].map((k) => STRATEGIES[k].label).join('/');
      out.push(`- ${a.name}(${code}) 现价 ${a.price.toFixed(2)}｜${labels}`
        + `｜${a.shares} 股 · 得分 ${a.score.toFixed(1)}`);
    }
    out.push('');
  } else if (Object.keys(pickedBy).length) {
    out.push('> 三套策略各自选了不同标的——**没有共识**，'
      + '说明当前市况分歧较大，建议先看回测推荐率再决定用哪套。', '');
  }
  out.push('_得分是候选池内的相对排名，**不是上涨概率**；'
    + '股数按当前现金与单票上限换算，价格以实际成交为准。_');
  return out.join('\n');
}

/** 仓位参数（面板与工具共用同一套换算，避免面板算一套、工具算一套）。 */
export function sizingFrom(args, config) {
  const maxPos = args.max_positions ?? config.pick_max_positions ?? 5;
  const usage = args.cash_usage_pct ?? config.pick_cash_usage_pct ?? 80;
  return new SizingConfig({
    position_cap_pct: Number(config.position_cap_pct ?? 25),
    max_positions: Math.max(1, Math.min(Math.trunc(Number(maxPos) || 5), 20)),
    cash_usage_pct: Math.max(1, Math.min(Number(usage) || 80, 100)),
    cash_reserve_yuan: Math.max(0, Number(config.pick_cash_reserve_yuan ?? 0)),
  });
}

/** `astock_pick` 工具输出。 */
export async function runPick(args = {}, options = {}) {
  const config = options.config || {};
  const ledger = options.ledger;
  if (!ledger) return '[Error] 台账未初始化';
  const strategy = String(args.strategy || config.pick_strategy || DEFAULT_STRATEGY).toLowerCase();
  if (!STRATEGIES[strategy]) {
    return `[Error] 未知策略 ${strategy}；可选：${Object.keys(STRATEGIES).join('、')}`;
  }
  const sizing = sizingFrom(args, config);
  const universeRaw = String(args.universe || config.pick_universe || 'main').toLowerCase();
  const universe = ['main', 'all', 'gem', 'star'].includes(universeRaw) ? universeRaw : 'main';
  const candidateLimit = Math.max(5, Math.min(
    Math.trunc(Number(config.pick_candidates ?? MAX_KLINE_CANDIDATES)) || MAX_KLINE_CANDIDATES, 60,
  ));
  const useCache = !args.fresh;

  let snap;
  try {
    snap = await (options.snapshot || snapshot)(ledger, {
      fetchQuotes: options.fetchQuotes,
    });
  } catch (error) {
    return `[Error] 选股扫描失败：${error?.message ?? error}`;
  }
  const cash = Number(snap.data.cash || 0);
  const equity = Number(snap.data.total_market_value || 0) + cash;

  if (args.compare) {
    let results;
    try {
      results = await (options.scanAll || scanAll)({
        cash, equity, universe, sizing, candidateLimit, useCache,
        feeCfg: ledger.fee, collect: options.collect,
      });
    } catch (error) {
      return `[Error] 选股扫描失败：${error?.message ?? error}`;
    }
    return renderCompare(results, 5);
  }

  let result;
  try {
    result = await (options.scan || scan)(strategy, {
      cash, equity, universe, sizing, candidateLimit, useCache,
      feeCfg: ledger.fee, collect: options.collect,
    });
  } catch (error) {
    return `[Error] 选股扫描失败：${error?.message ?? error}`;
  }
  if (args.rank_only) {
    return renderRanking(result, Math.max(1, Math.min(Math.trunc(Number(args.top_n) || 10), 20)));
  }
  let text = renderPick(result);
  if (!args.no_grade && config.backtest_auto_grade !== false) {
    const grade = await attachGrade(strategy, options);
    if (grade) text = `${grade}\n\n---\n\n${text}`;
  }
  return text;
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
        fetchKlines: options.fetchKlines,
      });
    }
    return gradeLine(cached?.recommendation);
  } catch {
    return '> ⚪ **推荐率暂不可用**：回测取数失败（可能接口限流）。'
      + '可稍后单独问「回测一下这个策略」。';
  }
}

export { table, Allocation };
