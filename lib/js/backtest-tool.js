/**
 * 回测工具层：取历史数据 → 跑回测 → 缓存结论 → 渲染。
 * 上游 `astock_backtest_tool.py` 的 Node 移植（在线取数；存档接口后续接入）。
 */

import {
  BacktestConfig, BENCHMARK_CODE, gradeRecommendation, renderBacktest, runBacktest,
} from './backtest.js';
import { fetchKlines } from './kline.js';
import { mergedBarsDicts } from './archive.js';
import { DEFAULT_STRATEGY, STRATEGIES } from './quant.js';
import { fetchScreen } from './screen.js';

const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE = new Map();
export const DEFAULT_POOL = 25;

export function clearCache() {
  CACHE.clear();
}

export function cacheInfo() {
  const now = Date.now();
  return Object.fromEntries([...CACHE.entries()].map(([k, v]) => [k, Math.round((now - v.at) / 100) / 10]));
}

async function defaultCandidates(poolSize, ledger) {
  try {
    const snap = await fetchScreen({
      universe: 'main', sort_by: 'amount', limit: poolSize * 2,
    });
    if (snap.rows?.length) return snap.rows;
  } catch {
    // 快照被限流 → 退回台账
  }
  const fallback = [];
  if (ledger) {
    for (const p of ledger.listPositions()) {
      fallback.push({ code: p.code, name: p.name || p.code });
    }
    for (const w of ledger.listWatch()) {
      fallback.push({ code: w.code, name: w.name || w.code });
    }
  }
  return fallback.slice(0, poolSize);
}

async function loadBars(code, {
  kind = 'stock', limit = 640, archive = null, fetchK = fetchKlines,
} = {}) {
  const archived = archive ? archive.loadBars(code, { adjust: 'raw', limit: limit * 2 }) : [];
  let online = [];
  try {
    const result = await fetchK(code, {
      period: 'day', limit, adjust: 'none', kind,
    });
    online = result.bars || [];
  } catch {
    if (!archived.length) throw new Error(`${code} 历史 K 线取数失败`);
  }
  if (!online.length) return archived;
  if (archive && online.length) {
    try { archive.saveBars(code, online, 'raw', 'online'); } catch { /* 存档失败不影响回测 */ }
  }
  return archived.length ? mergedBarsDicts(archived, online) : online;
}

/** 按候选顺序取历史 K 线。返回 { pool, failed }。 */
export async function fetchUniverse(candidates, {
  poolSize = DEFAULT_POOL, fetchKlines: fetchK = fetchKlines, archive = null,
} = {}) {
  const pool = [];
  let failed = 0;
  for (const row of (candidates || []).slice(0, poolSize)) {
    const code = String(row.code || '');
    if (!code) continue;
    try {
      const bars = await loadBars(code, { limit: 640, archive, fetchK });
      if (!bars.length) {
        failed += 1;
        continue;
      }
      pool.push({
        code, name: String(row.name || code), bars,
        origin: archive && archive.loadBars(code, { adjust: 'raw', limit: 1 }).length
          ? 'merged' : 'online',
      });
    } catch {
      failed += 1;
    }
  }
  return { pool, failed };
}

/** 基准（沪深300）日 K。 */
export async function fetchBenchmark({ fetchKlines: fetchK = fetchKlines, archive = null } = {}) {
  try {
    return await loadBars(BENCHMARK_CODE, {
      limit: 640, kind: 'index', archive, fetchK,
    });
  } catch {
    return [];
  }
}

function cfgHash(cfg) {
  return JSON.stringify(cfg.asDict());
}

/** 跑一轮回测。 */
export async function run(strategyKey, {
  poolSize = DEFAULT_POOL,
  candidates = null,
  cfg = new BacktestConfig(),
  useCache = true,
  pool = null,
  bench = null,
  ledger = null,
  archive = null,
  fetchKlines: fetchK = fetchKlines,
} = {}) {
  const key = `${strategyKey}|${poolSize}|${cfgHash(cfg)}`;
  if (useCache) {
    const hit = CACHE.get(key);
    if (hit && Date.now() - hit.at <= CACHE_TTL_MS) {
      return {
        result: hit.value.result,
        recommendation: hit.value.recommendation,
        fetch_failed: hit.value.fetch_failed,
        cached: true,
        cache_age_sec: Math.round((Date.now() - hit.at) / 100) / 10,
      };
    }
  }

  let failed = 0;
  if (pool === null) {
    let cands = candidates;
    if (cands === null) cands = await defaultCandidates(poolSize, ledger);
    if (!cands.length) {
      throw new Error('无法构建回测池：全市场快照接口被限流，且台账里也没有持仓/自选股。'
        + '请等 30 秒后重试，或先用 astock_record / astock_watch 录入标的');
    }
    const got = await fetchUniverse(cands, { poolSize, fetchKlines: fetchK, archive });
    pool = got.pool;
    failed = got.failed;
  }
  if (pool.length < 4) throw new Error(`仅取到 ${pool.length} 只标的历史数据，不足以回测`);

  if (bench === null) bench = await fetchBenchmark({ fetchKlines: fetchK, archive });
  const result = runBacktest(strategyKey, pool, bench, cfg);
  const recommendation = gradeRecommendation(result);
  const value = { result, recommendation, fetch_failed: failed };
  CACHE.set(key, { at: Date.now(), value });
  return {
    ...value, cached: false, cache_age_sec: 0, pool_size: poolSize,
  };
}

/** 一次取数、多套策略回测。 */
export async function runAll({
  poolSize = DEFAULT_POOL,
  candidates = null,
  cfg = new BacktestConfig(),
  strategies = null,
  useCache = true,
  ledger = null,
  archive = null,
  fetchKlines: fetchK = fetchKlines,
} = {}) {
  const keys = (strategies || Object.keys(STRATEGIES)).filter((k) => STRATEGIES[k]);
  if (!keys.length) throw new Error('没有可用的策略');
  const out = {};
  const pending = [];
  if (useCache) {
    for (const key of keys) {
      const hit = getCached(key);
      if (hit && (hit.pool_size === null || hit.pool_size === poolSize)) out[key] = hit;
      else pending.push(key);
    }
  } else pending.push(...keys);
  if (!pending.length) return out;

  let cands = candidates;
  if (cands === null) cands = await defaultCandidates(poolSize, ledger);
  if (!cands.length) {
    throw new Error('无法构建回测池：全市场快照接口被限流，且台账里也没有持仓/自选股。'
      + '请等 30 秒后重试，或先用 astock_record / astock_watch 录入标的');
  }
  const got = await fetchUniverse(cands, { poolSize, fetchKlines: fetchK, archive });
  if (got.pool.length < 4) {
    throw new Error(`仅取到 ${got.pool.length} 只标的历史数据，不足以回测`);
  }
  const bench = await fetchBenchmark({ fetchKlines: fetchK, archive });
  for (const key of pending) {
    const res = await run(key, {
      poolSize, cfg, useCache: false, pool: got.pool, bench, fetchKlines: fetchK, archive,
    });
    res.fetch_failed = got.failed;
    res.pool_size = poolSize;
    out[key] = res;
  }
  return out;
}

/** 只取缓存（面板用）。 */
export function getCached(strategyKey) {
  let best = null;
  for (const [key, val] of CACHE.entries()) {
    if (!key.startsWith(`${strategyKey}|`)) continue;
    if (!best || val.at > best.at) best = { key, at: val.at, value: val.value };
  }
  if (!best) return null;
  const { result, recommendation, fetch_failed: failed } = best.value;
  let poolSize = null;
  try {
    poolSize = Number(best.key.split('|')[1]) || null;
  } catch {
    poolSize = null;
  }
  return {
    result,
    recommendation,
    fetch_failed: failed,
    cached: true,
    cache_age_sec: Math.round((Date.now() - best.at) / 100) / 10,
    pool_size: poolSize,
  };
}

export function render(result, recommendation, detailPeriods = 0, fetchFailed = 0) {
  let text = renderBacktest(result, recommendation, detailPeriods);
  if (fetchFailed) text += `\n\n_（${fetchFailed} 只标的因取数失败未纳入回测）_`;
  return text;
}

/** `astock_backtest` 工具输出。 */
export async function runBacktestTool(args = {}, options = {}) {
  const config = options.config || {};
  const strategy = String(args.strategy || config.pick_strategy || DEFAULT_STRATEGY).toLowerCase();
  if (!STRATEGIES[strategy]) {
    return `[Error] 未知策略 ${strategy}；可选：${Object.keys(STRATEGIES).join('、')}`;
  }
  const cfg = new BacktestConfig();
  for (const key of ['rebalance_days', 'top_k', 'hold_days']) {
    const v = args[key];
    if (v !== null && v !== undefined && v !== '') {
      const n = Math.trunc(Number(v));
      if (Number.isFinite(n)) cfg[key] = n;
    }
  }
  cfg.rebalance_days = Math.max(2, Math.min(cfg.rebalance_days, 60));
  cfg.top_k = Math.max(1, Math.min(cfg.top_k, 10));
  cfg.hold_days = Math.max(1, Math.min(cfg.hold_days, 60));
  const poolSize = Math.trunc(Number(args.pool_size) || DEFAULT_POOL);

  let out;
  try {
    out = await (options.run || run)(strategy, {
      poolSize: Math.max(6, Math.min(poolSize, 60)),
      cfg,
      useCache: !args.fresh,
      ledger: options.ledger,
      archive: options.archive,
      fetchKlines: options.fetchKlines,
    });
  } catch (error) {
    return `[Error] ${error?.message ?? error}`;
  }
  const detail = Math.trunc(Number(args.detail_periods) || 0);
  return render(out.result, out.recommendation,
    Math.max(0, Math.min(detail, 30)), out.fetch_failed || 0);
}
