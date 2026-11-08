/**
 * 选股结果的落盘缓存。
 *
 * 为什么需要：`pick-tool.scanAll()` 的缓存只在**进程内**（3 分钟 TTL）。DSH 每次
 * 面板请求、甚至宿主重启后，缓存都没了——切到「选股」就要重新扫全市场（6–8 秒，
 * 还容易撞上接口限流）。把结果落盘后，打开面板先读文件，只有用户显式点「重新扫描」
 * 或缓存过期才真扫。
 *
 * 文件与台账同目录：`pick-cache.json`。只存面板需要的字段（策略、候选、股数、
 * 止损止盈），不存原始行情——避免把几百 KB 的中间数据写进磁盘。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 默认有效期：10 分钟。盘中价格会变，但面板不是交易终端。 */
export const PICK_CACHE_TTL_MS = 10 * 60 * 1000;

export function pickCachePath(ledgerPath) {
  return path.join(path.dirname(String(ledgerPath || '')), 'pick-cache.json');
}

/** 把 scanAll 的结果裁成面板字段后落盘。 */
export function savePickCache(ledgerPath, results = {}, { cash = 0, equity = 0 } = {}) {
  const slim = {};
  for (const [key, res] of Object.entries(results || {})) {
    if (!res) continue;
    slim[key] = {
      strategy: res.strategy,
      strategy_label: res.strategy_label,
      strategy_description: res.strategy_description,
      scanned: res.scanned || 0,
      candidates: res.candidates || 0,
      allocations: (res.allocations || []).slice(0, 10),
      cached: false,
      cache_age_sec: 0,
    };
  }
  const payload = {
    savedAt: Date.now(),
    cash: Number(cash) || 0,
    equity: Number(equity) || 0,
    results: slim,
  };
  try {
    fs.mkdirSync(path.dirname(pickCachePath(ledgerPath)) || '.', { recursive: true });
    const tmp = `${pickCachePath(ledgerPath)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, pickCachePath(ledgerPath));
  } catch {
    // 落盘失败不影响本次结果（只是下次还得重扫）
  }
  return payload;
}

/**
 * 读缓存。
 *
 * @param {string} ledgerPath
 * @param {{maxAgeMs?: number, cash?: number, equity?: number}} options
 * @returns {{results: object, ageSec: number} | null}
 */
export function loadPickCache(ledgerPath, {
  maxAgeMs = PICK_CACHE_TTL_MS, cash = null, equity = null,
} = {}) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(pickCachePath(ledgerPath), 'utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || !payload.results) return null;
  const age = Date.now() - Number(payload.savedAt || 0);
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return null;
  // 资金明显变了（比如刚记了一笔成交）就重扫：股数是按现金算出来的
  if (cash !== null && Math.abs(Number(payload.cash || 0) - Number(cash)) > 1) return null;
  if (equity !== null && Math.abs(Number(payload.equity || 0) - Number(equity)) > 1) return null;
  const ageSec = Math.round(age / 1000);
  const results = {};
  for (const [key, res] of Object.entries(payload.results)) {
    results[key] = { ...res, cached: true, cache_age_sec: ageSec };
  }
  return { results, ageSec };
}
