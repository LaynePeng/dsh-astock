/**
 * 个股资金流（东财主源 + 新浪备源）。
 * 与 上游 `astock_data.py::fetch_money_flow` 的字段口径一致。
 */

import { fetchJson, fetchText } from './http.js';
import { normalizeCode, tencentSymbol, toFloat } from './market.js';
import { compensatedSum } from './formula.js';
import { money, table } from './format.js';

const EM_FFLOW = 'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get';
const SINA_FLOW = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/'
  + 'MoneyFlow.ssl_qsfx_zjlrqs';

function num(value) {
  return toFloat(value, null);
}

async function flowViaSina(symbol, days) {
  const query = new URLSearchParams({
    page: '1',
    num: String(Math.max(1, Math.min(Math.trunc(Number(days) || 10), 60))),
    sort: 'opendate',
    asc: '0',
    daima: symbol,
    _s_r_a: 'page',
  });
  const text = await fetchText(`${SINA_FLOW}?${query}`, {
    headers: { referer: 'https://finance.sina.com.cn' },
    timeoutMs: 12_000,
  });
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out = raw.map((row) => ({
    date: String(row?.opendate || ''),
    main_net: num(row?.netamount),
    small_net: null,
    mid_net: null,
    large_net: null,
    super_net: num(row?.r0_net),
    source: 'sina',
  }));
  out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return out;
}

/**
 * @param {string} rawCode
 * @param {number} [days]
 * @param {'stock'|'index'|'etf'} [kind]
 */
export async function fetchMoneyFlow(rawCode, days = 10, kind = 'stock') {
  const { code, venue } = normalizeCode(rawCode, kind);
  const secid = `${venue === 'sh' ? '1' : '0'}.${code}`;
  const n = Math.max(1, Math.min(Math.trunc(Number(days) || 10), 120));
  const query = new URLSearchParams({
    lmt: String(n),
    klt: '101',
    secid,
    fields1: 'f1,f2,f3,f7',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65',
  });

  let rows = [];
  try {
    const json = await fetchJson(`${EM_FFLOW}?${query}`, {
      headers: {
        referer: 'https://www.eastmoney.com/',
        connection: 'close',
      },
      timeoutMs: 12_000,
    });
    rows = json?.data?.klines || [];
  } catch {
    return flowViaSina(tencentSymbol(code, venue), n);
  }

  const out = [];
  for (const line of rows) {
    const parts = String(line).split(',');
    if (parts.length < 5) continue;
    out.push({
      date: parts[0],
      main_net: num(parts[1]),
      small_net: num(parts[2]),
      mid_net: num(parts[3]),
      large_net: num(parts[4]),
      super_net: parts.length > 5 ? num(parts[5]) : null,
      source: 'eastmoney',
    });
  }
  return out;
}

/** `astock_flow` 工具输出。 */
export async function runFlow(args = {}, options = {}) {
  const code = String(args.code || '').trim();
  if (!code) return '[Error] 需要 code';
  const fetchFlow = options.fetchMoneyFlow || fetchMoneyFlow;
  const rows = await fetchFlow(code, Math.trunc(Number(args.days) || 10));
  if (!rows.length) {
    return `${code} 没有资金流数据（可能是指数/ETF 或数据源未覆盖）。`;
  }
  const totalMain = compensatedSum(rows.map((row) => row.main_net || 0));
  const body = table(
    ['日期', '主力净额', '超大单', '大单', '中单', '小单'],
    rows.map((row) => [
      row.date, money(row.main_net), money(row.super_net),
      money(row.large_net), money(row.mid_net), money(row.small_net),
    ]),
  );
  const note = rows[0]?.source === 'sina'
    ? '注：东财资金流接口当前被限流，已切新浪备源。新浪的'
      + '「主力净额」口径为当日资金净流入、与东财「超大单+大单」不完全一致；'
      + '大单/中单/小单无对应字段故留空（不是 0）。'
    : '注：主力=超大单+大单口径，资金流是结果而非原因。';
  return `**${code} 近 ${rows.length} 日资金流**（合计主力净额 ${money(totalMain)}）\n\n`
    + `${body}\n\n${note}`;
}
