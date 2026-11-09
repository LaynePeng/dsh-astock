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

import { hintsConfig, buildPositionHints } from './hints.js';
import { snapshot } from './portfolio.js';
import { fetchQuotes } from './kline.js';
import { scanAll, sizingFrom } from './pick-tool.js';
import { STRATEGIES, DEFAULT_STRATEGY } from './quant.js';
import { readEquityCurve, maintPayload } from './maintenance.js';
import { loadPickCache, savePickCache } from './pick-cache.js';

export const PANELS = ['portfolio', 'pick', 'mail', 'maint', 'trade'];

/** 面板最多列多少只（窄栏可读性上限）。 */
export const MAX_ROWS = 12;

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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
}) {
  const cfg = hintsConfig(config);
  let snap;
  try {
    snap = await snapshot(ledger, { includeWatch: true });
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

  const watch = [];
  for (const [code, q] of Object.entries(watchQuotes).slice(0, MAX_ROWS)) {
    watch.push({
      code,
      name: String(q?.name || code),
      price: round(num(q?.price), 3),
      changePct: round(num(q?.change_pct), 2),
      volumeRatio: round(num(q?.volume_ratio), 2),
    });
  }

  const todayPct = equityBase > 0 ? (todayPnl / equityBase) * 100.0 : null;
  // 浮盈比例的分母是持仓成本（不是总资产）：它回答的是"这几只赚了几个点"
  const costBasis = positions.reduce(
    (sum, p) => sum + (num(p.cost_price) || 0.0) * Math.trunc(num(p.shares) || 0),
    0,
  );
  const floatPct = costBasis > 0 ? (floatPnl / costBasis) * 100.0 : null;

  // 「今日超额」= 持仓当日涨幅 − 上证指数当日涨幅。指数取不到时给 null
  // （不拿 0 冒充「持平」）。
  const index = await indexSnapshot(fetchQuotesFn);
  const indexPct = num(index.changePct);
  const excess = (todayPct !== null && indexPct !== null)
    ? todayPct - indexPct : null;
  const curve = readEquityCurve(ledger.path, 30);
  let curveChange = null;
  if (curve.length >= 2) {
    const first = num(curve[0].equity);
    const last = num(curve[curve.length - 1].equity);
    if (first && last !== null && first > 0) curveChange = ((last - first) / first) * 100.0;
  }

  return {
    view: 'portfolio',
    ok: true,
    renderedAt: now(),
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
        label: '浮动盈亏',
        value: round(floatPnl, 2),
        unit: '元',
        delta: round(floatPct, 2),
        deltaLabel: '对成本',
        trend: floatPnl >= 0 ? 'up' : 'down',
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
        note: indexPct !== null
          ? `沪指 ${indexPct >= 0 ? '+' : ''}${indexPct.toFixed(2)}%`
          : '沪指数据未取到',
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
  if (panel === 'maint') return buildMaint({ ledger, archive, config });
  if (panel === 'trade') return buildTrade({ ledger, tradePage, planPage });
  if (panel !== 'portfolio') return { ok: false, error: `未知面板 ${panel}` };
  return buildPortfolio({ ledger, config, ...rest });
}
