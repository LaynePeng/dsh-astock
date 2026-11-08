/**
 * 条件选股（东财 clist 全市场快照 + 新浪排行备源）。
 * 与 上游 `astock_data.py::screen` 的输出结构、过滤口径一致。
 */

import { fetchJson, fetchText } from './http.js';
import { toFloat } from './market.js';
import {
  f, money, pct, ratio, table,
} from './format.js';

const EM_CLIST = 'https://push2.eastmoney.com/api/qt/clist/get';
const CLIST_FIELDS = 'f2,f3,f5,f6,f8,f9,f10,f12,f14,f15,f16,f17,f18,f20,f21,f23,f62,f115';

const UNIVERSE_FS = {
  all: 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23',
  main: 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23',
  gem: 'm:0+t:80',
  star: 'm:1+t:23',
  bj: 'm:0+t:81+s:2048',
  etf: 'b:MK0021,b:MK0022,b:MK0023,b:MK0024',
};

const SORT_MAP = {
  change_pct: 'f3', price: 'f2', amount: 'f6', volume: 'f5',
  turnover: 'f8', mcap: 'f20', pe: 'f9', main_net: 'f62',
};

const SINA_RANK = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/'
  + 'Market_Center.getHQNodeData';
const SINA_COUNT = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/'
  + 'Market_Center.getHQNodeStockCount';
const SINA_NODE = {
  all: 'hs_a', main: 'hs_a', gem: 'cyb', star: 'kcb', bj: 'bj_a', etf: 'etf_hq_fund',
};
const SINA_SORT = {
  change_pct: 'changepercent', price: 'trade', amount: 'amount',
  volume: 'volume', turnover: 'turnoverratio', mcap: 'mktcap',
  pe: 'per', main_net: 'amount',
};

const EM_HEADERS = {
  referer: 'https://www.eastmoney.com/',
  connection: 'close',
  accept: '*/*',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

function num(value) {
  return toFloat(value, null);
}

function okRange(value, lo, hi) {
  if (value === null) return lo === null && hi === null;
  if (lo !== null && value < lo) return false;
  if (hi !== null && value > hi) return false;
  return true;
}

function normalizeArgs(args = {}) {
  const pick = (key) => {
    const raw = args[key];
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  return {
    universe: String(args.universe || 'all').toLowerCase(),
    sortBy: String(args.sort_by || 'change_pct').toLowerCase(),
    ascending: Boolean(args.ascending),
    limit: Math.trunc(Number(args.limit) || 20),
    minChange: pick('min_change'),
    maxChange: pick('max_change'),
    minAmount: pick('min_amount'),
    maxAmount: pick('max_amount'),
    minTurnover: pick('min_turnover'),
    maxTurnover: pick('max_turnover'),
    minMcap: pick('min_mcap'),
    maxMcap: pick('max_mcap'),
    excludeSt: args.exclude_st !== false,
  };
}

function pickRows(rows, opt) {
  const picked = [];
  const cap = Math.max(1, Math.min(opt.limit, 200));
  for (const row of rows) {
    const name = String(row.f14 || '');
    if (opt.excludeSt && name.toUpperCase().includes('ST')) continue;
    const price = num(row.f2);
    const chg = num(row.f3);
    const amount = num(row.f6);
    const turnover = num(row.f8);
    const mcap = num(row.f20);
    if (!price || chg === null) continue;
    if (!okRange(chg, opt.minChange, opt.maxChange)) continue;
    if (!okRange(amount, opt.minAmount, opt.maxAmount)) continue;
    if (!okRange(turnover, opt.minTurnover, opt.maxTurnover)) continue;
    if (!okRange(mcap, opt.minMcap, opt.maxMcap)) continue;
    picked.push({
      code: String(row.f12 || ''),
      name,
      price,
      change_pct: chg,
      volume_lot: num(row.f5),
      amount_yuan: amount,
      turnover_pct: turnover,
      pe: num(row.f9),
      pb: num(row.f23),
      total_mcap_yuan: mcap,
      float_mcap_yuan: num(row.f21),
      main_net_inflow_yuan: num(row.f62),
      volume_ratio: num(row.f10),
      high: num(row.f15),
      low: num(row.f16),
      open: num(row.f17),
      prev_close: num(row.f18),
    });
    if (picked.length >= cap) break;
  }
  return picked;
}

async function screenViaEastmoney(opt) {
  const fs = UNIVERSE_FS[opt.universe] || UNIVERSE_FS.all;
  const fid = SORT_MAP[opt.sortBy] || 'f3';
  const rows = [];
  let total = 0;
  const pageSize = 100;
  const maxPages = 60;
  for (let page = 1; page <= maxPages; page += 1) {
    const query = new URLSearchParams({
      pn: String(page),
      pz: String(pageSize),
      po: opt.ascending ? '0' : '1',
      np: '1',
      fltt: '2',
      invt: '2',
      fid,
      fs,
      fields: CLIST_FIELDS,
    });
    const json = await fetchJson(`${EM_CLIST}?${query}`, {
      headers: EM_HEADERS,
      timeoutMs: 15_000,
    });
    const node = json?.data || {};
    if (page === 1) total = Number(node.total || 0);
    let diff = node.diff || [];
    if (!Array.isArray(diff)) diff = Object.values(diff);
    if (!diff.length) break;
    rows.push(...diff);
    if (rows.length >= total || diff.length < pageSize) break;
  }
  return { rows: pickRows(rows, opt), total, source: 'eastmoney' };
}

async function screenViaSina(opt) {
  const node = SINA_NODE[opt.universe] || 'hs_a';
  const sortField = SINA_SORT[opt.sortBy] || 'changepercent';
  let universeTotal = 0;
  try {
    const text = await fetchText(`${SINA_COUNT}?node=${node}`, {
      headers: { referer: 'https://finance.sina.com.cn' },
      timeoutMs: 10_000,
    });
    universeTotal = Number(toFloat(text.trim().replace(/"/g, ''), 0)) || 0;
  } catch {
    universeTotal = 0;
  }
  const query = new URLSearchParams({
    page: '1', num: '200', sort: sortField,
    asc: opt.ascending ? '1' : '0', node, symbol: '', _s_r_a: 'page',
  });
  const text = await fetchText(`${SINA_RANK}?${query}`, {
    headers: { referer: 'https://finance.sina.com.cn' },
    timeoutMs: 15_000,
  });
  let raw;
  try {
    raw = text.trim().startsWith('[') ? JSON.parse(text) : [];
  } catch {
    throw new Error('新浪排行接口返回无法解析（接口可能变更）');
  }

  const out = [];
  const cap = Math.max(1, Math.min(opt.limit, 200));
  for (const row of raw) {
    const name = String(row.name || '');
    if (opt.excludeSt && name.toUpperCase().includes('ST')) continue;
    const price = num(row.trade);
    const chg = num(row.changepercent);
    const amount = num(row.amount);
    const turnover = num(row.turnoverratio);
    const mcapWan = num(row.mktcap);
    const mcap = mcapWan === null ? null : mcapWan * 1e4;
    if (!price || chg === null) continue;
    if (!okRange(chg, opt.minChange, opt.maxChange)) continue;
    if (!okRange(amount, opt.minAmount, opt.maxAmount)) continue;
    if (!okRange(turnover, opt.minTurnover, opt.maxTurnover)) continue;
    if (!okRange(mcap, opt.minMcap, opt.maxMcap)) continue;
    const volume = num(row.volume);
    out.push({
      code: String(row.code || ''),
      name,
      price,
      change_pct: chg,
      volume_lot: volume ? Math.round((volume / 100) * 100) / 100 : null,
      amount_yuan: amount,
      turnover_pct: turnover,
      pe: num(row.per),
      pb: num(row.pb),
      total_mcap_yuan: mcap,
      float_mcap_yuan: num(row.nmc) === null ? null : num(row.nmc) * 1e4,
      main_net_inflow_yuan: null,
      volume_ratio: null,
      high: num(row.high),
      low: num(row.low),
      open: num(row.open),
      prev_close: num(row.settlement),
    });
    if (out.length >= cap) break;
  }
  return { rows: out, total: universeTotal, source: 'sina' };
}

/** 取全市场快照（选股引擎复用；返回 rows/total/source）。 */
export async function fetchScreen(args = {}, options = {}) {
  const opt = normalizeArgs(args);
  const eastmoney = options.screenViaEastmoney || screenViaEastmoney;
  const sina = options.screenViaSina || screenViaSina;
  try {
    return await eastmoney(opt);
  } catch {
    return await sina(opt);
  }
}

/** `astock_screen` 工具输出。 */
export async function runScreen(args = {}, options = {}) {
  const opt = normalizeArgs(args);
  const eastmoney = options.screenViaEastmoney || screenViaEastmoney;
  const sina = options.screenViaSina || screenViaSina;
  let result;
  try {
    result = await eastmoney(opt);
  } catch {
    result = await sina(opt);
  }

  const sourceNote = result.source === 'sina'
    ? '\n\n注：东财接口当前被限流，已自动切换新浪排行备源——'
      + '**不含主力净流入与量比**（备源没有该字段，不是 0）。'
    : '';
  if (!result.rows.length) {
    return '没有符合条件的标的。可放宽过滤条件（如 min_amount 调小、'
      + '或去掉涨跌幅区间）。' + sourceNote;
  }

  const body = table(
    ['代码', '名称', '现价', '涨跌幅', '换手', '量比', '成交额', '总市值', '主力净额'],
    result.rows.map((row) => [
      row.code, row.name, f(row.price), pct(row.change_pct),
      ratio(row.turnover_pct), f(row.volume_ratio),
      money(row.amount_yuan), money(row.total_mcap_yuan),
      money(row.main_net_inflow_yuan),
    ]),
  );
  return `**条件选股**（${opt.universe}，全市场 ${result.total} 只，`
    + `命中 ${result.rows.length}）\n\n${body}\n\n`
    + `排序：${opt.sortBy}；筛选结果仅作研究起点，不构成推荐。${sourceNote}`;
}
