/**
 * 右栏面板的结构化数据（供 DSH 客户端渲染）。
 *
 * 上游 `panel.py` 的 Node 移植。**为什么不复用 `astock_panel` 的渲染**：
 * 那套输出的是 lite-work 富围栏（```kpi / ```cards / ```progress），只有
 * lite-work 的面板能画；DSH 的右栏是 React 组件，拿到 markdown 只能显示成
 * 一堆 JSON 代码块。所以这里只做**数据整形**，规则一律复用已有实现：
 *
 *     持仓卡片   ← `portfolio.snapshot()`（台账 + 实时行情）
 *     风险徽标   ← `hints.buildPositionHints()`（与 astock_hint 同一个引擎）
 *     选股结果   ← `pick-tool.scanAll()`（三套策略共用一次采集）
 *
 * 也就是说：面板上的每个数字都能在对应工具的输出里找到同一个值——这是这套
 * 面板存在的意义，一旦自己算就会有「面板没事、工具喊卖」的矛盾。
 *
 * 约定：**缺数据一律给 null，不用 0 代替**（0 会被读成"真的没有"）。
 */

import { dataCutoff } from './asof.js';
import { hintsConfig, buildPositionHints } from './hints.js';
import { lifetimePnl, snapshot } from './portfolio.js';
import { fetchQuotes } from './kline.js';
import { scanAll, sizingFrom } from './pick-tool.js';
import { STRATEGIES, DEFAULT_STRATEGY } from './quant.js';
import { earningsCalendar } from './extra-data.js';
import { readEquityCurve, maintPayload } from './maintenance.js';
import { fetchMedianChange } from './breadth.js';
import { loadPickCache, savePickCache } from './pick-cache.js';
import { defaultPlanPath, loadPlan } from './watch-plan.js';
import {
  judgeVerify, OUTCOME_LABEL, STANCE_LABEL, verifyRuleText,
} from './journal.js';

export const PANELS = ['portfolio', 'pick', 'mail', 'maint', 'trade', 'journal'];

/** 面板最多列多少只（窄栏可读性上限）。 */
export const MAX_ROWS = 12;

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function signedPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

/** 整数金额带千分位（KPI 备注只有一行的宽度，小数位省掉）。 */
function signedMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const body = Math.abs(Math.round(n)).toLocaleString('zh-CN');
  return `${n >= 0 ? '+' : '-'}${body}`;
}

function num(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 2) {
  const n = num(value);
  if (n === null) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * 面板顶部的口径行：取数时刻 + 价格性质。
 *
 * 右栏的数字是**打开这一页时**拉的行情，不是成交价、也不是收盘价；
 * 不写清楚，用户会把「现价」当成「我看到的价」。价格性质（实时/上午收盘/
 * 当日收盘/上一交易日收盘）由 asof.js 统一算，与工具和邮件同一个口径。
 */
function asOfPayload() {
  const c = dataCutoff();
  return {
    stamp: `${c.date} ${c.time}`,
    phase: c.phase,
    priceBasis: c.price_basis,
  };
}

/** YYYY-MM-DD 加天数（UTC 计算，避开夏令时/时区偏移）。 */
function addDaysText(iso, days) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  if (!y || !m || !d) return '';
  const base = Date.UTC(y, m - 1, d) + Math.trunc(Number(days) || 0) * 86400000;
  const t = new Date(base);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}

function pnlPct(price, cost) {
  if (!cost || !price) return null;
  return ((price - cost) / cost) * 100;
}

/** 单只持仓的风险徽标（严重度、文案都来自 hint 引擎）。 */
function hintBadges(position, quote, cfg, totalMv, totalEquity) {
  let items;
  try {
    items = buildPositionHints(position, quote, cfg, {
      totalMarketValue: totalMv, totalEquity,
    });
  } catch {
    // 单票算挂了不能拖垮整个面板
    return [];
  }
  return items
    .filter((h) => h.severity === 'action' || h.severity === 'urgent')
    .map((h) => ({
      level: h.severity,
      kind: h.kind,
      text: h.title || h.detail || h.kind,
    }));
}

/** 上证指数快照（失败返回空对象，**不编数字**）。 */
async function indexSnapshot(fetchQuotesFn) {
  try {
    const quotes = await fetchQuotesFn(['000001'], 'index', { useCache: true });
    if (!quotes.length) return {};
    const quote = quotes[0];
    return {
      name: quote.name || '上证指数',
      price: round(num(quote.price), 2),
      changePct: round(num(quote.change_pct), 2),
    };
  } catch {
    // 指数取不到不影响持仓卡片
    return {};
  }
}

/** 持仓面板：KPI + 每只持仓一张卡 + 自选观察。 */
export async function buildPortfolio({
  ledger, config = {}, fetchQuotes: fetchQuotesFn = fetchQuotes,
  fetchMedian = fetchMedianChange,
}) {
  const cfg = hintsConfig(config);
  let snap;
  try {
    snap = await snapshot(ledger, { includeWatch: true, fetchQuotes: fetchQuotesFn });
  } catch (error) {
    return {
      view: 'portfolio',
      ok: false,
      renderedAt: now(),
      error: `台账读取失败：${error?.message ?? error}`,
      hint: '检查插件配置里的 ledgerPath，或先用 astock_record 录入持仓。',
    };
  }

  const data = snap?.data || {};
  const positions = data.positions || [];
  const quotes = data.quotes || {};
  const watchQuotes = data.watch_quotes || {};

  const totalMv = num(data.total_market_value) || 0.0;
  const cash = num(data.cash) || 0.0;
  const equity = num(data.equity) || (totalMv + cash);
  const floatPnl = num(data.float_pnl) || 0.0;
  const todayPnl = num(data.today_pnl) || 0.0;
  const realizedPnl = num(data.realized_pnl) || 0.0;
  // 卖出流水条数：0 表示「还没卖过」，此时已实现恒为 0，与「取不到数」要分开说
  const sellCount = Math.trunc(num(data.realized_sell_count) || 0);
  // 本金（用户登记的出入金）：没有登记就按「未知」处理，退回流口径倒推
  const capitalTotal = num(data.capital_total);
  // 面板的主指标是**账户口径**盈亏（总资产 − 本金），不是浮动盈亏：
  // 亏损标的被卖掉后就不在 positions 里了，只报浮动等于让它从账上消失。
  const lifetime = lifetimePnl({
    floatPnl, realizedPnl, equity, capital: capitalTotal,
  });

  // 单票占比的真分母是账户总资产（与 hint 引擎同口径）；拿持仓市值当分母
  // 会让「只持一只股」恒为 100%，把正常仓位报成超限。
  const equityBase = equity > 0 ? equity : totalMv;
  const cap = Number(cfg.position_cap_pct) || 25.0;
  const stopPct = Math.abs(Number(cfg.stop_loss_pct) || 8.0);

  const cards = [];
  for (const p of positions.slice(0, MAX_ROWS)) {
    const code = String(p.code || '');
    const q = quotes[code] || {};
    const cost = num(p.cost_price) || 0.0;
    const shares = Math.trunc(num(p.shares) || 0);
    const price = num(q.price) || cost;
    const mv = price * shares;
    const pnl = (price - cost) * shares;
    const pct = cost ? pnlPct(price, cost) : null;
    const weight = equityBase > 0 ? (mv / equityBase) * 100.0 : 0.0;
    // 距止损「已用掉」多少（0=贴着成本，100=正好踩到止损线）
    let used = 0.0;
    if (pct !== null && pct < 0 && stopPct > 0) {
      used = Math.max(0.0, Math.min(100.0, (-pct / stopPct) * 100.0));
    }
    cards.push({
      code,
      name: String(p.name || code),
      shares,
      tradable: Math.trunc(num(p.available_today) || 0),
      cost: round(cost, 3),
      price: round(price, 3),
      changePct: round(num(q.change_pct), 2),
      pnl: round(pnl, 2),
      pnlPct: round(pct, 2),
      marketValue: round(mv, 2),
      weightPct: round(weight, 1),
      weightCapPct: round(cap, 1),
      stopUsedPct: round(used, 1),
      overWeight: weight > cap,
      badges: hintBadges(p, q, cfg, totalMv, equityBase),
    });
  }

  // 计划路径与台账同目录（defaultPlanPath 只做路径拼接，不读盘）
  const plan = loadPlan(defaultPlanPath(ledger.path));
  const buyByCode = new Map();
  for (const r of plan.rules || []) {
    if (r.op !== 'le' && r.op !== 'lt') continue;
    const code = String(r.code || '');
    const price = Number(r.price);
    if (!code || !Number.isFinite(price) || price <= 0) continue;
    if (!buyByCode.has(code)) buyByCode.set(code, []);
    buyByCode.get(code).push({
      price,
      label: String(r.label || ''),
      severity: String(r.severity || 'action'),
    });
  }

  const watch = [];
  for (const [code, q] of Object.entries(watchQuotes).slice(0, MAX_ROWS)) {
    watch.push({
      code,
      name: String(q?.name || code),
      price: round(num(q?.price), 3),
      changePct: round(num(q?.change_pct), 2),
      volumeRatio: round(num(q?.volume_ratio), 2),
      // 只在面板上展示，不参与任何买卖判断；缺规则就是空数组
      buyAt: (buyByCode.get(code) || [])
        .sort((a, b) => b.price - a.price)
        .slice(0, 3)
        .map((b) => ({ price: round(b.price, 2), label: b.label, severity: b.severity })),
    });
  }

  const todayPct = equityBase > 0 ? (todayPnl / equityBase) * 100.0 : null;
  // 浮盈比例的分母是持仓成本（不是总资产）：它回答的是"这几只赚了几个点"
  const costBasis = positions.reduce(
    (sum, p) => sum + (num(p.cost_price) || 0.0) * Math.trunc(num(p.shares) || 0),
    0,
  );
  const floatPct = costBasis > 0 ? (floatPnl / costBasis) * 100.0 : null;

  // 「今日超额」默认对**全市场涨跌中位数**：沪指被权重股拉动，
  // 指数涨而多数个股跌的时候，对沪指的"超额"会误导。中位数取不到再退回沪指。
  const index = await indexSnapshot(fetchQuotesFn);
  const indexPct = num(index.changePct);
  let medianPct = null;
  let breadthApproximate = false;
  try {
    const breadth = await fetchMedian();
    if (breadth && breadth.ok && Number.isFinite(Number(breadth.median))) {
      medianPct = Number(breadth.median);
      breadthApproximate = Boolean(breadth.approximate);
    }
  } catch {
    medianPct = null;
  }
  const benchmarkPct = medianPct !== null ? medianPct : indexPct;
  const benchmarkKind = medianPct !== null ? 'median' : (indexPct !== null ? 'index' : '');
  const excess = (todayPct !== null && benchmarkPct !== null)
    ? todayPct - benchmarkPct : null;
  const curve = readEquityCurve(ledger.path, 30);
  let curveChange = null;
  if (curve.length >= 2) {
    const first = num(curve[0].equity);
    const last = num(curve[curve.length - 1].equity);
    if (first && last !== null && first > 0) curveChange = ((last - first) / first) * 100.0;
  }

  // 口径写成悬停提示：哪个数是怎么来的，必须能对上账
  const gapText = lifetime.gap === null ? null : signedMoney(lifetime.gap);
  const lifetimeHint = `账户盈亏 = 总资产 ${signedMoney(equity)} − 净本金 `
    + `${capitalTotal !== null ? signedMoney(capitalTotal) : '（未登记）'}`
    + ` = ${signedMoney(lifetime.total)}。\n`
    + `流水盈亏 = 浮动 ${signedMoney(floatPnl)}` +
    `${floatPct !== null ? `（对持仓成本 ${signedPct(floatPct)}）` : ''}`
    + ` + 已实现 ${sellCount ? signedMoney(realizedPnl) : '0（还没有卖出流水）'}`
    + ` = ${signedMoney(lifetime.trade)}。`
    + (gapText && Math.abs(lifetime.gap) >= 0.01
      ? `\n两者差 ${gapText} 元（账实差异）：分红/利息、漏记的成交、`
        + '早期回填成本不实都会造成这个差，核对后补记就能归零。'
      : '')
    + (lifetime.source === 'capital'
      ? ''
      : '\n还没登记本金，收益率只能按「总资产 − 流水盈亏」倒推，出入金后会失真。');

  return {
    view: 'portfolio',
    ok: true,
    renderedAt: now(),
    asOf: asOfPayload(),
    empty: positions.length === 0,
    kpis: [
      {
        label: '总资产',
        value: round(equity, 2),
        unit: '元',
        delta: round(todayPnl, 2),
        deltaLabel: '今日',
        trend: todayPnl >= 0 ? 'up' : 'down',
      },
      {
        label: '持仓市值',
        value: round(totalMv, 2),
        unit: '元',
        note: equity > 0 ? `占总资产 ${Math.round((totalMv / equity) * 100)}%` : null,
      },
      {
        label: '账户盈亏',
        value: round(lifetime.total, 2),
        unit: '元',
        delta: round(lifetime.pct, 2),
        deltaLabel: '对本金',
        trend: lifetime.total >= 0 ? 'up' : 'down',
        hint: lifetimeHint,
        // 拆分放副行：一眼看出亏在「还拿着的」「已经卖掉的」，还是账实差异
        note: gapText && Math.abs(lifetime.gap) >= 0.01
          ? `浮动 ${signedMoney(floatPnl)} · 已实现 ${signedMoney(realizedPnl)} · 差 ${gapText}`
          : sellCount
            ? `浮动 ${signedMoney(floatPnl)} · 已实现 ${signedMoney(realizedPnl)}`
            : `浮动 ${signedMoney(floatPnl)} · 暂无卖出流水`,
      },
      {
        label: '可用资金',
        value: round(cash, 2),
        unit: '元',
        note: equity > 0 ? `占总资产 ${Math.round((cash / equity) * 100)}%` : null,
      },
      {
        label: '今日超额',
        value: excess !== null ? round(excess, 2) : null,
        unit: '%',
        note: benchmarkKind === 'median'
          ? `全市场中位 ${signedPct(medianPct)}${breadthApproximate ? '（样本）' : ''}`
          : benchmarkKind === 'index'
            ? `沪指 ${signedPct(indexPct)}（中位数未取到）`
            : '基准数据未取到',
        trend: excess !== null && excess >= 0 ? 'up' : 'down',
      },
      {
        label: curve.length >= 2 ? `近 ${curve.length} 日净值` : '净值曲线',
        value: curveChange !== null ? round(curveChange, 2) : null,
        unit: '%',
        note: curve.length ? `${curve.length} 个收盘记录` : '每日 15:05 自动记录',
        trend: curveChange !== null && curveChange >= 0 ? 'up' : 'down',
      },
    ],
    todayPct: round(todayPct, 2),
    excessPct: excess !== null ? round(excess, 2) : null,
    // 累计口径单独给一份：客户端要拆「浮动/已实现」时不必自己再算一遍
    pnl: {
      float: round(floatPnl, 2),
      realized: round(realizedPnl, 2),
      trade: round(lifetime.trade, 2),
      total: round(lifetime.total, 2),
      totalPct: round(lifetime.pct, 2),
      source: lifetime.source,
      gap: round(lifetime.gap, 2),
      capital: round(capitalTotal, 2),
      capitalBase: round(lifetime.capitalBase, 2),
      sellCount,
    },
    index,
    equityCurve: curve.map((item) => ({
      date: String(item.date || ''),
      equity: round(num(item.equity), 2),
    })),
    positions: cards,
    positionsTotal: positions.length,
    watch,
    watchMissing: Math.trunc(num(data.watch_count) || 0) - watch.length,
    limits: {
      stopLossPct: round(stopPct, 1),
      takeProfitPct: round(Number(cfg.take_profit_pct) || 15.0, 1),
      positionCapPct: round(cap, 1),
    },
  };
}

/** 选股面板：三套策略共用一次采集，横向对比。 */
export async function buildPick({
  ledger, config = {}, strategy = '', scanAll: scanAllFn = scanAll, fresh = false,
}) {
  const sizing = sizingFrom({}, config);
  const cash = Number(ledger.getCash().balance || 0);
  const positions = ledger.listPositions();
  let snapMv = 0;
  for (const p of positions) {
    snapMv += Number(p.cost_price || 0) * Math.trunc(Number(p.shares) || 0);
  }
  const equity = cash + snapMv;

  // 先看落盘缓存：面板打开不该每次都扫全市场（6–8 秒且容易撞限流）
  let results = null;
  let cacheAgeSec = null;
  if (!fresh) {
    const cached = loadPickCache(ledger.path, { cash, equity });
    if (cached) {
      results = cached.results;
      cacheAgeSec = cached.ageSec;
    }
  }

  if (!results) {
    try {
      results = await scanAllFn({
        cash, equity, universe: 'main', sizing, useCache: true,
      });
      savePickCache(ledger.path, results, { cash, equity });
    } catch (error) {
      return {
        view: 'pick',
        ok: false,
        renderedAt: now(),
        error: `选股失败：${error?.name ?? 'Error'}: ${error?.message ?? error}`,
        hint: '公共行情接口有限流；换网络重试，或稍后再刷新。',
      };
    }
  }

  const defaultKey = String(strategy || config.pick_strategy || DEFAULT_STRATEGY || '').trim();
  const strategies = [];
  for (const key of Object.keys(STRATEGIES)) {
    const res = results[key];
    if (!res) continue;
    const strat = STRATEGIES[key];
    const items = (res.allocations || []).slice(0, 5).map((a) => ({
      code: a.code,
      name: a.name,
      price: round(num(a.price), 3),
      score: round(num(a.score), 1),
      shares: Math.trunc(num(a.shares) || 0),
      amount: round(num(a.amount), 2),
      weightPct: round(num(a.weight_pct), 1),
      stopLoss: round(num(a.stop_loss), 2),
      takeProfit: round(num(a.take_profit), 2),
    }));
    strategies.push({
      key,
      label: strat.label,
      description: strat.description,
      isDefault: key === defaultKey,
      scanned: Math.trunc(num(res.scanned) || 0),
      candidates: Math.trunc(num(res.candidates) || 0),
      items,
      cached: Boolean(res.cached),
      cacheAgeSec: round(num(res.cache_age_sec), 0),
    });
  }

  return {
    view: 'pick',
    ok: true,
    renderedAt: now(),
    cash: round(cash, 2),
    equity: round(equity, 2),
    defaultStrategy: defaultKey,
    cacheAgeSec,
    strategies,
    // 口径提醒必须是可见文字：得分是池内相对排名，不是上涨概率
    disclaimer: '得分是候选池内相对排名，不是上涨概率；三套共用同一时点价格。',
  };
}

/** 维护面板：存档状态、最近回测、备份、净值曲线（**不联网**）。 */
export function buildMaint({ ledger, archive, config = {} }) {
  try {
    return maintPayload({ ledger, archive, config });
  } catch (error) {
    return {
      view: 'maint',
      ok: false,
      renderedAt: now(),
      error: `维护数据读取失败：${error?.name ?? 'Error'}: ${error?.message ?? error}`,
      hint: '检查台账/存档路径；数据目录不可写时也会走到这里。',
    };
  }
}

/**
 * 交易面板：录入成交、最近流水、待触发事件单（**不联网**）。
 *
 * 表单需要的上下文（费用、可用股数、今日日期）都在这里给，客户端不做二次计算——
 * 否则面板说"可卖 500"，保存时台账说"只能卖 300"，用户会以哪个为准？
 */
export function buildTrade({ ledger, tradePage = 1, planPage = 1 }) {
  try {
    const cash = ledger.getCash();
    const fee = ledger.fee || {};
    const tradeSize = 20;
    const planSize = 8;
    const tradeTotal = ledger.countTrades();
    const planTotal = ledger.countPlans({ status: 'pending' });
    const tradePages = Math.max(1, Math.ceil(tradeTotal / tradeSize));
    const planPages = Math.max(1, Math.ceil(planTotal / planSize));
    const tradeCurrent = Math.min(Math.max(1, Math.trunc(Number(tradePage) || 1)), tradePages);
    const planCurrent = Math.min(Math.max(1, Math.trunc(Number(planPage) || 1)), planPages);
    const positions = ledger.listPositions().map((row) => ({
      code: row.code,
      name: row.name,
      shares: Number(row.shares) || 0,
      available_today: Number(row.available_today) || 0,
      cost_price: round(row.cost_price, 4),
      board: row.board,
    }));
    const trades = ledger.trades({
      limit: tradeSize, offset: (tradeCurrent - 1) * tradeSize,
    }).map((row) => ({
      id: row.id,
      trade_date: row.trade_date,
      code: row.code,
      name: row.name,
      side: row.side,
      price: round(row.price, 4),
      shares: Number(row.shares) || 0,
      amount: round(row.amount, 2),
      fee: round(row.fee, 2),
      realized: row.realized === null || row.realized === undefined ? null : round(row.realized, 2),
      note: row.note || '',
    }));
    const plans = ledger.listPlans({
      status: 'pending', limit: planSize, offset: (planCurrent - 1) * planSize,
    }).map((row) => ({
      plan_id: row.plan_id,
      created_at: row.created_at,
      code: row.code,
      name: row.name,
      side: row.side,
      price: round(row.price, 4),
      shares: Number(row.shares) || 0,
      stop_loss: round(row.stop_loss, 4),
      take_profit: round(row.take_profit, 4),
      trailing: row.trailing === null || row.trailing === undefined ? null : row.trailing,
      reason: row.reason || '',
      kind: row.kind || '',
      status: row.status,
      triggerKind: row.trigger_kind || '',
      triggerPrice: round(row.trigger_price, 4),
      orderType: row.order_type || '',
      validUntil: row.valid_until || '',
      source: row.source || '',
    }));
    return {
      view: 'trade',
      ok: true,
      renderedAt: now(),
      today: (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })(),
      cash: round(cash.balance, 2),
      fee: {
        commission_rate: fee.commission_rate,
        min_commission: fee.min_commission,
        stamp_tax_rate: fee.stamp_tax_rate,
        transfer_fee_rate: fee.transfer_fee_rate,
      },
      positions,
      trades,
      plans,
      tradesPage: { page: tradeCurrent, pages: tradePages, total: tradeTotal, size: tradeSize },
      plansPage: { page: planCurrent, pages: planPages, total: planTotal, size: planSize },
      disclaimer: '这里只记你已在券商成交的单子；插件不下单、不连接券商。',
    };
  } catch (error) {
    return {
      view: 'trade',
      ok: false,
      renderedAt: now(),
      error: `交易数据读取失败：${error?.name ?? 'Error'}: ${error?.message ?? error}`,
    };
  }
}

/**
 * 判断留痕面板（档案）：**待复核优先**，其次最近记的判断。
 *
 * 排序理由：档案页的价值不在「看我记了多少」，而在「今天该审哪几条」。
 * 所以到期未判的排最前，并当场带上「现价 vs 复核条件」的判定——
 * 面板和 `astock_portfolio action=journal_list due=true` 用的是**同一个
 * judgeVerify**，不会出现面板说满足了、工具说没满足。
 */
export async function buildJournal({ ledger, fetchQuotes: fetchQuotesFn = fetchQuotes }) {
  let stats;
  let dueRows;
  let recentRows;
  try {
    stats = ledger.thesisStats({});
    dueRows = ledger.listTheses({ due: true, limit: MAX_ROWS });
    recentRows = ledger.listTheses({ limit: MAX_ROWS });
  } catch (error) {
    return {
      view: 'journal',
      ok: false,
      renderedAt: now(),
      error: `判断档案读取失败：${error?.name ?? 'Error'}: ${error?.message ?? error}`,
      hint: 'theses 表在 0.9.6 之后才有；老台账会在插件加载时自动补建，重启 DSH 再试。',
    };
  }

  // 只有「有可复算条件」的到期行才需要现价：没有价位条件的那几条本来就靠人判，
  // 为它们去拉一次行情纯属浪费——而且会让面板在断网时白等一轮。
  const verifiable = dueRows.filter(
    (row) => row.verify_kind && Number.isFinite(Number(row.verify_price)),
  );
  const codes = [...new Set(verifiable.map((row) => String(row.code || '')).filter(Boolean))];
  const quotes = {};
  if (codes.length) {
    try {
      for (const quote of (await fetchQuotesFn(codes)) || []) {
        if (quote && quote.code) quotes[String(quote.code)] = quote;
      }
    } catch {
      // 行情取不到就退化成「无法自动判定」，不影响列出待办
    }
  }

  const today = now().slice(0, 10);
  const due = dueRows.map((row) => {
    const verdict = judgeVerify(row, quotes[String(row.code || '')]);
    return {
      thesisId: String(row.thesis_id || ''),
      code: String(row.code || ''),
      name: String(row.name || ''),
      stance: String(row.stance || 'watch'),
      stanceLabel: STANCE_LABEL[row.stance] || '只观察',
      claim: String(row.claim || ''),
      basis: String(row.basis || ''),
      verifyDate: String(row.verify_date || ''),
      rule: verifyRuleText(row) || '人工判定',
      // 有没有可复算条件：决定前端是「按现价记」还是「记结果即可」
      needsPrice: Boolean(row.verify_kind) && Number.isFinite(Number(row.verify_price)),
      // 现价只用于展示判定，不参与任何买卖结论
      price: round(num(quotes[String(row.code || '')]?.price), 2),
      judgeState: verdict.state,
      judgeText: verdict.text,
      overdueDays: (() => {
        const target = String(row.verify_date || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) return null;
        const diff = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${target}T00:00:00Z`);
        return Number.isFinite(diff) ? Math.max(0, Math.round(diff / 86400000)) : null;
      })(),
      version: Number(row.version) || 1,
      outcome: String(row.outcome || 'pending'),
    };
  });

  const recent = recentRows.map((row) => ({
    thesisId: String(row.thesis_id || ''),
    code: String(row.code || ''),
    name: String(row.name || ''),
    stanceLabel: STANCE_LABEL[row.stance] || '只观察',
    claim: String(row.claim || ''),
    verifyDate: String(row.verify_date || ''),
    outcome: String(row.outcome || 'pending'),
    outcomeLabel: OUTCOME_LABEL[row.outcome] || '待复核',
    version: Number(row.version) || 1,
    priceAt: round(num(row.price_at), 2),
  }));

  const hitCount = Number(stats.hit || 0);
  const settled = Number(stats.settled || 0);

  // 表单用：标的从**台账里真实存在的**标的取（持仓优先，其次自选），
  // 不给自由输入——手打代码是小错，但记错标的等于这条档案作废。
  const formCodes = [];
  try {
    for (const row of ledger.listPositions()) {
      formCodes.push({ code: String(row.code || ''), name: String(row.name || ''), kind: '持仓' });
    }
    for (const row of ledger.listWatch()) {
      const code = String(row.code || '');
      if (!code || formCodes.some((c) => c.code === code)) continue;
      formCodes.push({ code, name: String(row.name || ''), kind: '自选' });
    }
  } catch {
    // 台账里读持仓失败不影响看档案
  }

  return {
    view: 'journal',
    ok: true,
    renderedAt: now(),
    asOf: asOfPayload(),
    today,
    empty: Number(stats.total || 0) === 0,
    kpis: [
      {
        label: '待复核',
        value: Number(stats.pending || 0),
        // 条数不要小数位：2 条比 2.00 条更像人话
        digits: 0,
        note: due.length ? `已到期 ${due.length} 条` : '暂无到期',
      },
      {
        label: '已判定',
        value: settled,
        digits: 0,
        note: settled ? `兑现 ${hitCount} / 未兑现 ${settled - hitCount}` : '还没审过',
      },
      {
        label: '兑现率',
        value: stats.hit_rate === null || stats.hit_rate === undefined
          ? null : round(stats.hit_rate, 2),
        unit: '%',
        // 分母只算已判定：作废不该拉低兑现率，待复核更不该
        note: settled ? `对 ${settled} 条已判定` : '需先复核',
      },
      {
        label: '累计判断',
        value: Number(stats.total || 0),
        digits: 0,
        note: Number(stats.void || 0) ? `${stats.void} 条已作废` : null,
      },
    ],
    due,
    recent,
    codes: formCodes,
    // 复核日默认给 30 天后：不想算的人直接提交也有一条能到期提醒的
    defaultVerifyDate: addDaysText(today, 30),
    disclaimer: '兑现率是过去判断到期条件真的满足的比例，不是上涨概率、不是胜率；'
      + '样本越小越说明不了问题。本页不预测涨跌、不给目标价。',
  };
}

/**
 * 面板表单「记一条判断」——把几个下拉/输入框拼成一条完整档案。
 *
 * 设计原则：**能替用户补的都替他补**。
 *   · 一句话没写 → 用「方向 + 条件」拼一个占位判断（记录本身有价值，细节可后补）；
 *   · 依据没写 → 标记「依据待补充」，同时把当时的行情快照存下来；
 *   · 复核日没填 → 默认 30 天后；
 *   · 标的只从台账里选 → 手打代码记错标的是这条档案最致命的错法。
 *
 * 绝不替用户编的部分：价位条件与方向。这两样必须是他自己选的。
 *
 * @param {object} ledger
 * @param {object} body 表单字段 { code, stance, claim, verify_kind, verify_price, verify_date }
 * @returns {Promise<{ok: boolean, message: string, thesis_id?: string}>}
 */
export async function recordThesisForm(ledger, body = {}, { fetchQuotes: fetchQuotesFn = fetchQuotes } = {}) {
  const stance = String(body.stance || 'watch').trim().toLowerCase();
  const kind = String(body.verify_kind || '').trim().toLowerCase();
  const priceText = String(body.verify_price ?? '').trim();
  const claim = String(body.claim || '').trim();
  const code = String(body.code || '').trim();
  const verifyDate = String(body.verify_date || '').trim();

  if (!['bull', 'bear', 'watch'].includes(stance)) {
    return { ok: false, message: '方向只能是看多 / 看空 / 只说一句' };
  }
  if (kind && !['price_below', 'price_above'].includes(kind)) {
    return { ok: false, message: '条件只能是「跌破」或「站上」' };
  }
  if (kind && priceText === '') {
    return { ok: false, message: '选了条件就要填价位（多少元）' };
  }
  if (!kind && priceText !== '') {
    return { ok: false, message: '填了价位就要选条件（跌破 / 站上）' };
  }
  const verifyPrice = priceText === '' ? null : Number(priceText);
  if (verifyPrice !== null && (!Number.isFinite(verifyPrice) || verifyPrice <= 0)) {
    return { ok: false, message: '价位必须是大于 0 的数字' };
  }
  if (verifyDate && !/^\d{4}-\d{2}-\d{2}$/.test(verifyDate)) {
    return { ok: false, message: '复核日格式应为 YYYY-MM-DD' };
  }

  // 行情只用来补「记录价 + 名称 + 快照」，取不到也照样记
  let quote = null;
  let price = null;
  if (code) {
    try {
      for (const item of (await fetchQuotesFn([code])) || []) {
        if (item && String(item.code) === code) quote = item;
      }
    } catch {
      quote = null;
    }
    const n = Number(quote && quote.price);
    if (Number.isFinite(n) && n > 0) price = n;
  }

  const ruleText = kind
    ? `${kind === 'price_below' ? '跌破' : '站上'} ${verifyPrice.toFixed(2)}`
    : '';
  // 一句话没写：用方向 + 条件拼一个能看懂的占位，别留空
  const finalClaim = claim
    || (ruleText ? `（待补充判断）${ruleText} 时再看` : `（待补充判断）${STANCE_LABEL[stance] || ''}`);

  const today = now().slice(0, 10);
  try {
    const thesis = ledger.saveThesis({
      code,
      name: String(quote?.name || ''),
      stance,
      claim: finalClaim,
      basis: '面板表单记录（依据待补充）',
      verify_date: verifyDate || addDaysText(today, 30),
      verify_kind: kind,
      verify_price: verifyPrice,
      price_at: price,
      snapshot: {
        现价: price,
        涨跌幅: quote?.change_pct ?? null,
        量比: quote?.volume_ratio ?? null,
        换手率: quote?.turnover_rate ?? null,
        数据时点: now(),
        来源: '面板表单',
      },
    });
    const label = STANCE_LABEL[stance] || '只观察';
    return {
      ok: true,
      thesis_id: thesis.thesis_id,
      message: `已记下 ${thesis.thesis_id}（${label}${ruleText ? ` · ${ruleText}` : ''}）`
        + `，复核日 ${thesis.verify_date}`,
    };
  } catch (error) {
    return { ok: false, message: `${error?.name ?? 'Error'}: ${error?.message ?? error}` };
  }
}

/**
 * 「本周披露」小块（计划页用）：只列**我的持仓/自选里**在窗口内要披露财报的。
 *
 * 为什么只做交叉、不做全市场名单：计划页是「这周我要注意什么」，
 * 全市场几千只披露对用户没用；而财务披露前后的波动放大是真实存在的，
 * 提前一天知道比当天看到涨跌有用。
 *
 * 取不到就返回 ok:false + 原因，**绝不用空列表假装「没有披露」**——
 * 这两件事对用户的意义完全相反。
 */
export async function buildEarnings({
  ledger, days = 7, calendar = earningsCalendar,
} = {}) {
  const codes = [];
  try {
    for (const row of ledger.listPositions()) codes.push(String(row.code || ''));
    for (const row of ledger.listWatch()) codes.push(String(row.code || ''));
  } catch {
    // 台账读不到：下面按空处理，但仍然要区分「没标的」与「取数失败」
  }
  const wanted = [...new Set(codes.filter(Boolean))];
  if (!wanted.length) {
    return {
      ok: true, rows: [], days, note: '台账里还没有持仓或自选，无法做披露交叉',
    };
  }
  try {
    const cal = await calendar({
      days, codes: wanted, includeRhythm: false,
    });
    return {
      ok: true,
      from: cal.from,
      to: cal.to,
      days: cal.days,
      // 只保留还没披露的：已披露的属于「回顾」，不是「这周要留心」
      rows: (cal.mine || [])
        .filter((row) => !row.published)
        .map((row) => ({
          code: row.code,
          name: row.name,
          reportType: row.report_type,
          appointDate: row.appoint_date,
          changed: Boolean(row.changed),
        })),
      published: (cal.mine || []).filter((row) => row.published).length,
    };
  } catch (error) {
    return {
      ok: false,
      rows: [],
      days,
      error: `财报日历取不到：${error?.message ?? error}`,
    };
  }
}

/** 面板总入口（未知 id 返回错误对象，不抛）。 */
export async function build({
  ledger, archive, config = {}, panel = 'portfolio', strategy = '',
  tradePage = 1, planPage = 1, ...rest
}) {
  if (panel === 'pick' || String(panel).startsWith('pick-')) {
    return buildPick({
      ledger, config, strategy, ...rest,
    });
  }
  if (panel === 'journal') return buildJournal({ ledger, ...rest });
  if (panel === 'maint') return buildMaint({ ledger, archive, config });
  if (panel === 'trade') return buildTrade({ ledger, tradePage, planPage });
  if (panel !== 'portfolio') return { ok: false, error: `未知面板 ${panel}` };
  return buildPortfolio({ ledger, config, ...rest });
}
