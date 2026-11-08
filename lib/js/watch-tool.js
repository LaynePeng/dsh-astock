/**
 * `astock_watch` 自选股管理（list / add / remove）。
 * `start/stop/status` 由 lib/plugin.js 的 DSH 定时任务控制器处理；
 * `plan/set_rules` 仍走 Python（DSH schedule 无 probe_config 字段）。
 */

import { fetchQuotes } from './kline.js';
import { searchSymbols } from './search.js';
import { normalizeCode } from './market.js';
import { f, pct, table } from './format.js';
import {
  applyRules, loadPlan, planView, renderSetRules, savePlan,
} from './watch-plan.js';

/**
 * @param {object} args { action, code?, name?, note? }
 * @param {{ledger: object, fetchQuotes?: Function, search?: Function}} options
 */
export async function runWatch(args = {}, options = {}) {
  const action = String(args.action || 'list').trim().toLowerCase();
  const ledger = options.ledger;
  if (!ledger) return '[Error] 台账未初始化';

  if (action === 'add') {
    const raw = String(args.code || '').trim();
    if (!raw) return '[Error] 需要 code';
    const { code } = normalizeCode(raw);
    let name = String(args.name || '').trim();
    if (!name) {
      try {
        const rows = await (options.search || searchSymbols)(code, 1);
        if (rows.length) name = rows[0].name;
      } catch {
        name = '';
      }
    }
    const res = ledger.addWatch(code, name, String(args.note || ''));
    return `✅ 已加入自选：${res.name || res.code}(${res.code})`;
  }

  if (action === 'remove') {
    const raw = String(args.code || '').trim();
    if (!raw) return '[Error] 需要 code';
    const ok = ledger.removeWatch(raw);
    return ok ? '✅ 已从自选移除' : '该代码不在自选列表中';
  }

  if (action === 'plan') {
    if (!options.planPath) return null;
    const plan = loadPlan(options.planPath);
    return planView(plan, { interval: Number(options.interval || 300) });
  }

  if (action === 'set_rules') {
    if (!options.planPath) return null;
    const current = loadPlan(options.planPath);
    const result = applyRules(current, args);
    if (result.error) return result.error;
    savePlan(options.planPath, result.plan);
    let message = '规则已保存到本地盯盘计划';
    if (typeof options.syncPrompt === 'function') {
      try {
        const synced = await options.syncPrompt(result.plan);
        if (synced?.updated) message = '规则已保存，并已同步到盯盘任务 prompt';
      } catch (error) {
        message = `规则已保存，但同步盯盘任务失败：${error?.message ?? error}`;
      }
    }
    return renderSetRules(result, {
      enabled: options.enabled !== false,
      message,
    });
  }

  const rows = ledger.listWatch();
  if (!rows.length) {
    return '自选列表为空。用 astock_watch action=add code=600000 添加。';
  }
  const quotes = {};
  try {
    const list = await (options.fetchQuotes || fetchQuotes)(rows.map((r) => r.code), 'stock');
    for (const q of list) quotes[q.code] = q;
  } catch {
    // 行情失败时仍列出自选
  }
  return table(
    ['代码', '名称', '现价', '涨跌幅', '备注'],
    rows.map((r) => {
      const q = quotes[r.code] || {};
      return [r.code, r.name || q.name || '-', f(q.price), pct(q.change_pct), r.note || ''];
    }),
  );
}
