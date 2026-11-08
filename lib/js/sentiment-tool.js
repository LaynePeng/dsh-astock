/**
 * `astock_sentiment` 工具层——上游 `astock_mixin_sync.py::_tool_sentiment` 的 JS 移植。
 */

import { fetchQuotes } from './kline.js';
import { normalizeCode } from './market.js';
import { searchSymbols } from './search.js';
import { collect } from './sentiment-data.js';
import {
  render, renderBrief, renderConflictLines, summarize,
} from './sentiment.js';

/**
 * @param {object} args { code, scope?, days?, brief? }
 * @param {{fetchQuotes?: Function, collect?: Function, search?: Function}} [options]
 */
export async function runSentiment(args = {}, options = {}) {
  const codeRaw = String(args.code || '').trim();
  if (!codeRaw) {
    return '[Error] 需要 code。舆情按标的维度分析——'
      + '要查行业/宏观事件请传 scope 含 feed 并给出可关联的标的代码。'
      + '跑持仓+自选全量请传 code=portfolio。';
  }
  if (codeRaw.toLowerCase() === 'portfolio') {
    return portfolioReport(args, options);
  }
  const { code } = normalizeCode(codeRaw);
  let scope = args.scope || [];
  if (typeof scope === 'string') {
    scope = scope.replace(/，/g, ',').split(',').map((s) => s.trim()).filter(Boolean);
  }
  const days = Math.trunc(Number(args.days) || 7);

  let name = '';
  try {
    const quotes = await (options.fetchQuotes || fetchQuotes)([code], 'stock');
    if (quotes.length) name = quotes[0].name || '';
  } catch {
    name = '';
  }
  if (!name) {
    try {
      const rows = await (options.search || searchSymbols)(code, 1);
      if (rows.length) name = rows[0].name;
    } catch {
      name = '';
    }
  }

  let collected;
  try {
    collected = await (options.collect || collect)(code, name, scope, days);
  } catch (error) {
    return `[Error] 舆情数据采集失败：${error?.name || 'Error'}: ${error?.message ?? error}。`
      + '可先用 astock_quote / astock_kline 看行情，稍后重试舆情。';
  }

  const report = summarize(collected.items, code, name, collected.errors, collected.extras);
  if (args.brief) {
    const out = [renderBrief(report)];
    const conflicts = renderConflictLines(report);
    if (conflicts.length) {
      out.push('', '**信号背离**：', ...conflicts.map((c) => `- ${c}`));
    }
    if (Object.keys(collected.errors).length) {
      out.push('', '数据缺口：' + Object.entries(collected.errors)
        .map(([k, v]) => `${k}=${v}`).join('；'));
    }
    return out.join('\n');
  }
  return render(report, collected.items, collected.extras);
}

/** 持仓 + 自选的全量舆情报告（DSH 本地版）。 */
async function portfolioReport(args, options) {
  const ledger = options.ledger;
  if (!ledger) return '[Error] 组合舆情需要台账，但台账未初始化。';
  const positions = ledger.listPositions();
  const watch = ledger.listWatch();
  const seen = new Set();
  const items = [];
  for (const p of positions) {
    if (p.code && !seen.has(p.code)) {
      seen.add(p.code);
      items.push({ code: p.code, name: p.name || p.code, held: true });
    }
  }
  for (const w of watch) {
    if (w.code && !seen.has(w.code)) {
      seen.add(w.code);
      items.push({ code: w.code, name: w.name || w.code, held: false });
    }
  }
  if (!items.length) {
    return '台账里没有持仓或自选股，没有可分析的标的。'
      + '先用 astock_record 录入持仓，或 astock_watch 添加自选。';
  }
  const days = Math.trunc(Number(args.days) || 7);
  const lines = [`## 持仓+自选舆情报告（${items.length} 只）`, '',
    '> 每只只给一句话结论 + 背离；完整证据用 `astock_sentiment code=XXX`。'
    + '本报告不预测涨跌、不给评级。', ''];
  for (const item of items) {
    try {
      const collected = await (options.collect || collect)(
        item.code, item.name, args.scope || [], days,
      );
      const report = summarize(collected.items, item.code, item.name,
        collected.errors, collected.extras);
      lines.push(`### ${item.name}(${item.code})${item.held ? '' : '（自选）'}`,
        '', renderBrief(report));
      for (const c of report.conflicts.slice(0, 2)) {
        lines.push(`- ⚠️ ${c.title}：${c.detail}`);
      }
      const gaps = Object.entries(collected.errors || {});
      if (gaps.length) {
        lines.push(`- 数据缺口：${gaps.map(([k, v]) => `${k}=${v}`).join('；')}`);
      }
      lines.push('');
    } catch (error) {
      lines.push(`### ${item.name}(${item.code})`, '',
        `- 采集失败：${error?.message ?? error}`, '');
    }
  }
  lines.push('---', '以上仅供参考，不构成投资建议。');
  return lines.join('\n');
}
