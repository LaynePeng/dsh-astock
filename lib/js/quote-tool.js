/**
 * `astock_quote` 实时行情（JS 版）——输出与 Python `_tool_quote` 逐字对齐。
 */

import { fetchQuotes } from './kline.js';
import { marketContext } from './market.js';
import {
  f, money, pct, ratio, table,
} from './format.js';

const EMPTY_LEDGER_TEXT = '台账里没有持仓或自选股。请直接指定 codes（如 ["600000"]），'
  + '或先用 astock_watch 添加自选股。';

/**
 * @param {object} args 工具参数 { codes?, kind?, no_cache? }
 * @param {{ledger?: object, fetchQuotes?: Function}} [options]
 */
export async function runQuote(args = {}, options = {}) {
  const kind = String(args.kind || 'stock');
  let codes = (Array.isArray(args.codes) ? args.codes : [])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);

  if (!codes.length) {
    const ledger = options.ledger;
    if (!ledger) return EMPTY_LEDGER_TEXT;
    codes = ledger.ledgerCodes();
    if (!codes.length) return EMPTY_LEDGER_TEXT;
  }

  const fetchQ = options.fetchQuotes || fetchQuotes;
  const quotes = await fetchQ(codes, kind, { useCache: !args.no_cache });
  const ctx = options.marketContext ? options.marketContext() : marketContext();

  const rows = quotes.map((q) => [
    `${q.name || '-'}(${q.code})`,
    f(q.price),
    pct(q.change_pct),
    `${f(q.limit_down)} / ${f(q.limit_up)}`,
    f(q.volume_ratio),
    ratio(q.turnover),
    money(q.amount),
    money(q.total_mcap),
    q.trade_time || '-',
  ]);

  const out = [`**${quotes.length} 只行情**（${ctx.text}）`, ''];
  out.push(table(
    ['名称(代码)', '现价', '涨跌幅', '跌停/涨停', '量比', '换手', '成交额', '总市值', '时间'],
    rows,
  ));

  const halted = quotes.filter((q) => q.extra?.price_is_prev_close);
  if (halted.length) {
    out.push('', `⏸ 无成交价（停牌/未开盘）：${halted.map((q) => `${q.name}(${q.code})`).join('、')}`);
  }
  if (!ctx.open) out.push('', `注：${ctx.text}`);
  return out.join('\n');
}
