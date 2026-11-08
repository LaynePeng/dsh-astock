/**
 * 扩展数据面（第一批）：热榜 / 行业排名 / 板块资金流 / ST / 两融 / 大宗 /
 * 股东户数 / 分红 / 解禁 / 龙虎榜 / 板块归属。
 * 上游 `astock_extra_data.py` 的 Node 移植。
 */

import { fetchJson, fetchText } from './http.js';
import { toFloat } from './market.js';

const DC_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const EM_CLIST = 'https://push2.eastmoney.com/api/qt/clist/get';
const EM_SLIST = 'https://push2.eastmoney.com/api/qt/slist/get';
const THS_HOT_LIST = 'https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock';

const H_DC = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  referer: 'https://data.eastmoney.com/',
  accept: '*/*',
  connection: 'close',
};
const H_QUOTE = { ...H_DC, referer: 'https://quote.eastmoney.com/' };

function day(raw) {
  const t = String(raw || '').trim();
  return t ? t.slice(0, 10) : '';
}

function num(raw) {
  return toFloat(raw, null);
}

/** 东财数据中心统一查询。 */
export async function datacenter(report, {
  filter = '', sortColumns = '', sortTypes = '-1', pageSize = 50, limit = 0, columns = 'ALL',
  extra = null,
} = {}) {
  const size = Math.max(1, Math.min(Number(pageSize) || 50, 500));
  const want = Number(limit) || size;
  const rows = [];
  let page = 1;
  let pagesTotal = 1;
  for (;;) {
    const query = new URLSearchParams({
      reportName: report,
      columns,
      filter,
      pageNumber: String(page),
      pageSize: String(size),
      sortColumns,
      sortTypes,
      source: 'WEB',
      client: 'WEB',
    });
    if (extra) {
      for (const [key, value] of Object.entries(extra)) query.set(key, String(value));
    }
    const payload = await fetchJson(`${DC_URL}?${query}`, { headers: H_DC, timeoutMs: 15_000 });
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error(`东财 ${report} 返回的不是 JSON 对象`);
    }
    if (payload.code === 9201) {
      if (page === 1) {
        if (filter) return [];
        throw new Error(`东财 ${report} 全市场查询返回空（无过滤条件），接口口径可能已变`);
      }
      throw new Error(`东财 ${report} 第 ${page} 页返回「数据为空」，已取 ${rows.length} 条，结果不完整`);
    }
    if (payload.code !== 0) {
      throw new Error(`东财 ${report} 返回错误 ${payload.code}：${payload.message}`);
    }
    const result = payload.result || {};
    const block = result.data || [];
    if (!Array.isArray(block)) throw new Error(`东财 ${report} 的 data 不是列表，格式可能已变`);
    pagesTotal = Number(result.pages || 1);
    rows.push(...block.filter((r) => r && typeof r === 'object'));
    if (!block.length || page >= pagesTotal || rows.length >= want) break;
    page += 1;
  }
  return rows.slice(0, want);
}

/** 东财 clist 翻页 → {rows, total}。 */
export async function clistAll(fs, fields, {
  pageSize = 100, limit = 0, sortBy = '', ascending = false,
} = {}) {
  const size = Math.max(1, Math.min(Number(pageSize) || 100, 200));
  const rows = [];
  let total = 0;
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({
      pn: String(page),
      pz: String(size),
      po: ascending ? '0' : '1',
      np: '1',
      fltt: '2',
      invt: '2',
      fid: sortBy || 'f12',
      fs,
      fields,
    });
    const payload = await fetchJson(`${EM_CLIST}?${query}`, { headers: H_QUOTE, timeoutMs: 15_000 });
    const node = payload?.data || {};
    if (!node || typeof node !== 'object' || !Object.keys(node).length) {
      throw new Error(`东财 clist 返回异常（fs=${fs}）`);
    }
    total = Number(node.total || 0);
    let diff = node.diff || [];
    if (!Array.isArray(diff)) diff = Object.values(diff);
    if (!Array.isArray(diff)) throw new Error(`东财 clist 的 diff 不是列表（fs=${fs}）`);
    rows.push(...diff.filter((r) => r && typeof r === 'object'));
    if (!diff.length || rows.length >= total || (limit && rows.length >= limit)) break;
  }
  return { rows: limit ? rows.slice(0, limit) : rows, total };
}

export async function thsHotList(period = 'hour') {
  const query = new URLSearchParams({ stock_type: 'a', type: period, list_type: 'normal' });
  const payload = await fetchJson(`${THS_HOT_LIST}?${query}`, {
    headers: { 'user-agent': H_DC['user-agent'] },
    timeoutMs: 15_000,
  });
  const list = payload?.data?.stock_list || [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const tag = item.tag || {};
    out.push({
      rank: item.order,
      code: String(item.code || ''),
      name: String(item.name || ''),
      heat: num(item.rate),
      change_pct: num(item.rise_and_fall),
      rank_change: item.hot_rank_chg,
      concepts: (tag.concept_tag || []).map(String),
      tag: String(tag.popularity_tag || ''),
    });
  }
  return out;
}

export async function industryRank(topN = 20) {
  const { rows, total } = await clistAll(
    'm:90+t:2',
    'f2,f3,f4,f12,f13,f14,f104,f105,f128,f136,f140,f204',
    { pageSize: 200, sortBy: 'f3' },
  );
  const out = rows.map((item, i) => ({
    rank: i + 1,
    name: String(item.f14 || ''),
    code: String(item.f12 || ''),
    change_pct: num(item.f3),
    up_count: item.f104,
    down_count: item.f105,
    leader: String(item.f128 || ''),
    leader_code: String(item.f140 || ''),
    leader_change_pct: num(item.f136),
  }));
  const n = Math.max(1, Math.min(Number(topN) || 20, out.length || 1));
  return { total: total || out.length, top: out.slice(0, n), bottom: out.slice(-n) };
}

const BOARD_FS = { industry: 'm:90+t:2', concept: 'm:90+t:3', region: 'm:90+t:1' };
const BOARD_PERIOD = {
  today: ['f62', 'f62', 'f184', 'f3', 'f204'],
  '5d': ['f164', 'f164', 'f165', 'f109', 'f257'],
  '10d': ['f174', 'f174', 'f175', 'f160', 'f128'],
};

export async function boardFundFlow(boardType = 'industry', period = 'today', topN = 20) {
  if (!BOARD_FS[boardType]) throw new Error(`board_type 只能是 ${Object.keys(BOARD_FS).join('/')}`);
  if (!BOARD_PERIOD[period]) throw new Error(`period 只能是 ${Object.keys(BOARD_PERIOD).join('/')}`);
  const [fid, fMain, fPct, fChg, fLeader] = BOARD_PERIOD[period];
  const fields = [...new Set(['f12', 'f14', fChg, fMain, fPct, fLeader])].join(',');
  const { rows, total } = await clistAll(BOARD_FS[boardType], fields, {
    pageSize: 200, limit: Math.max(20, Math.min(Number(topN) || 20, 200)), sortBy: fid,
  });
  const out = rows.map((it, i) => ({
    rank: i + 1,
    name: String(it.f14 || ''),
    code: String(it.f12 || ''),
    change_pct: num(it[fChg]),
    main_net_yuan: num(it[fMain]),
    main_pct: num(it[fPct]),
    leader: String(it[fLeader] || ''),
  }));
  return {
    board_type: boardType,
    period,
    total: total || out.length,
    rows: out.slice(0, Math.max(1, Number(topN) || 20)),
  };
}

export async function stStocks() {
  const shsz = (await clistAll('m:0+f:4,m:1+f:4', 'f12,f13,f14,f2,f3', { pageSize: 200 })).rows;
  const bj = (await clistAll('m:0+t:81+s:2048', 'f12,f13,f14,f2,f3', { pageSize: 200 })).rows;
  const out = [];
  for (const rec of shsz) {
    const name = String(rec.f14 || '').trim();
    if (!name) continue;
    out.push({
      code: String(rec.f12 || ''),
      name,
      market: rec.f13 === 1 ? 'sh' : 'sz',
      st_type: name.startsWith('*') ? '*ST' : 'ST',
      price: num(rec.f2),
      change_pct: num(rec.f3),
    });
  }
  for (const rec of bj) {
    const name = String(rec.f14 || '').trim();
    if (!name.toUpperCase().includes('ST')) continue;
    out.push({
      code: String(rec.f12 || ''),
      name,
      market: 'bj',
      st_type: name.startsWith('*') ? '*ST' : 'ST',
      price: num(rec.f2),
      change_pct: num(rec.f3),
    });
  }
  if (!out.length) throw new Error('ST 名单为空，接口口径可能已变（不能当成「今天没有 ST」）');
  return out;
}

export async function marginTrading(code, limit = 30) {
  const rows = await datacenter('RPTA_WEB_RZRQ_GGMX', {
    filter: `(scode="${code}")`, sortColumns: 'DATE', sortTypes: '-1', limit,
  });
  return rows.map((r) => ({
    date: day(r.DATE),
    fin_balance_yuan: num(r.RZYE),
    fin_buy_yuan: num(r.RZMRE),
    fin_repay_yuan: num(r.RZCHE),
    sec_balance_yuan: num(r.RQYE),
    total_balance_yuan: num(r.RZRQYE),
    fin_net_buy_yuan: num(r.RZJME),
  }));
}

export async function blockTrade(code, limit = 20) {
  const rows = await datacenter('RPT_DATA_BLOCKTRADE', {
    filter: `(SECURITY_CODE="${code}")`, sortColumns: 'TRADE_DATE', sortTypes: '-1', limit,
  });
  return rows.map((r) => {
    const close = num(r.CLOSE_PRICE);
    const deal = num(r.DEAL_PRICE);
    return {
      date: day(r.TRADE_DATE),
      price: deal,
      close,
      premium_pct: close && deal ? Math.round((deal / close - 1) * 10000) / 100 : null,
      volume: num(r.DEAL_VOLUME),
      amount_yuan: num(r.DEAL_AMT),
      buyer: String(r.BUYER_NAME || ''),
      seller: String(r.SELLER_NAME || ''),
    };
  });
}

export async function holderCount(code, limit = 10) {
  const rows = await datacenter('RPT_HOLDERNUMLATEST', {
    filter: `(SECURITY_CODE="${code}")`, sortColumns: 'END_DATE', sortTypes: '-1', limit,
  });
  return rows.map((r) => ({
    end_date: day(r.END_DATE),
    holders: num(r.HOLDER_NUM),
    change_num: num(r.HOLDER_NUM_CHANGE),
    change_pct: num(r.HOLDER_NUM_RATIO),
    avg_hold_value_yuan: num(r.AVG_MARKET_CAP),
  }));
}

export async function dividendHistory(code, limit = 20) {
  const rows = await datacenter('RPT_SHAREBONUS_DET', {
    filter: `(SECURITY_CODE="${code}")`, sortColumns: 'EX_DIVIDEND_DATE', sortTypes: '-1', limit,
  });
  return rows.map((r) => ({
    ex_date: day(r.EX_DIVIDEND_DATE),
    report_date: day(r.REPORT_DATE),
    bonus_rmb_per_share: num(r.PRETAX_BONUS_RMB),
    bonus_per_10: num(r.BONUS_RATIO),
    transfer_per_10: num(r.IT_RATIO),
    progress: String(r.ASSIGN_PROGRESS || ''),
  }));
}

export async function lockupExpiry(code, forwardDays = 90) {
  const base = new Date();
  const end = new Date(base.getTime() + Math.max(1, forwardDays) * 86400000);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    + `-${String(d.getDate()).padStart(2, '0')}`;
  const normalize = (rows) => rows.map((r) => ({
    date: day(r.FREE_DATE),
    type: String(r.FREE_SHARES_TYPE || ''),
    shares_10k: num(r.FREE_SHARES),
    able_shares_10k: num(r.ABLE_FREE_SHARES),
    ratio: num(r.FREE_RATIO),
  }));
  const history = await datacenter('RPT_LIFT_STAGE', {
    filter: `(SECURITY_CODE="${code}")`, sortColumns: 'FREE_DATE', sortTypes: '-1', limit: 15,
  });
  const upcoming = await datacenter('RPT_LIFT_STAGE', {
    filter: `(SECURITY_CODE="${code}")(FREE_DATE>='${iso(base)}')(FREE_DATE<='${iso(end)}')`,
    sortColumns: 'FREE_DATE', sortTypes: '1', limit: 20,
  });
  return {
    history: normalize(history),
    upcoming: normalize(upcoming),
    window: `${iso(base)} ~ ${iso(end)}`,
  };
}

export async function lhbStock(code, lookBackDays = 180) {
  const end = new Date();
  const start = new Date(end.getTime() - Math.max(1, lookBackDays) * 86400000);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    + `-${String(d.getDate()).padStart(2, '0')}`;
  const raw = await datacenter('RPT_DAILYBILLBOARD_DETAILSNEW', {
    filter: `(TRADE_DATE>='${iso(start)}')(TRADE_DATE<='${iso(end)}')(SECURITY_CODE="${code}")`,
    sortColumns: 'TRADE_DATE', sortTypes: '-1', limit: 50,
  });
  const records = raw.map((r) => {
    const net = num(r.BILLBOARD_NET_AMT);
    return {
      date: day(r.TRADE_DATE),
      reason: String(r.EXPLANATION || r.EXPLAIN || ''),
      net_buy_wan: net === null ? null : Math.round((net / 1e4) * 10) / 10,
      turnover_pct: num(r.TURNOVERRATE),
      change_pct: num(r.CHANGE_RATE),
    };
  });
  let buyRaw = [];
  let sellRaw = [];
  const seats = { buy: [], sell: [] };
  const latest = records[0]?.date || null;
  if (latest) {
    const seatRows = async (report, sortCol) => datacenter(report, {
      filter: `(TRADE_DATE='${latest}')(SECURITY_CODE="${code}")`,
      sortColumns: sortCol, sortTypes: '-1', limit: 10,
    });
    buyRaw = await seatRows('RPT_BILLBOARD_DAILYDETAILSBUY', 'BUY');
    sellRaw = await seatRows('RPT_BILLBOARD_DAILYDETAILSSELL', 'SELL');
    for (const [side, rows] of [['buy', buyRaw], ['sell', sellRaw]]) {
      for (const r of rows.slice(0, 5)) {
        seats[side].push({
          name: String(r.OPERATEDEPT_NAME || ''),
          buy_wan: Math.round(((num(r.BUY) || 0) / 1e4) * 10) / 10,
          sell_wan: Math.round(((num(r.SELL) || 0) / 1e4) * 10) / 10,
          net_wan: Math.round(((num(r.NET) || 0) / 1e4) * 10) / 10,
        });
      }
    }
  }
  const inst = { buy_wan: 0, sell_wan: 0 };
  for (const [rows, side] of [[buyRaw, 'buy'], [sellRaw, 'sell']]) {
    for (const r of rows) {
      if (String(r.OPERATEDEPT_CODE || '') === '0') {
        const amt = side === 'buy' ? num(r.BUY) : num(r.SELL);
        inst[`${side}_wan`] += Math.round(((amt || 0) / 1e4) * 10) / 10;
      }
    }
  }
  inst.net_wan = Math.round((inst.buy_wan - inst.sell_wan) * 10) / 10;
  return {
    records, seats, institution: inst, latest_date: latest, window_days: lookBackDays,
  };
}

export async function lhbMarket(date = null, minNetWan = null) {
  const d = date || new Date();
  const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`
    + `-${String(x.getDate()).padStart(2, '0')}`;
  const dayText = typeof d === 'string' ? d : iso(d);
  const rows = await datacenter('RPT_DAILYBILLBOARD_DETAILSNEW', {
    filter: `(TRADE_DATE>='${dayText}')(TRADE_DATE<='${dayText}')`,
    sortColumns: 'BILLBOARD_NET_AMT', sortTypes: '-1', limit: 500,
  });
  const stocks = [];
  let actual = dayText;
  rows.forEach((r, i) => {
    if (i === 0) actual = day(r.TRADE_DATE) || dayText;
    const netWan = Math.round(((num(r.BILLBOARD_NET_AMT) || 0) / 1e4) * 10) / 10;
    if (minNetWan !== null && minNetWan !== undefined && netWan < Number(minNetWan)) return;
    stocks.push({
      code: String(r.SECURITY_CODE || ''),
      name: String(r.SECURITY_NAME_ABBR || ''),
      reason: String(r.EXPLANATION || r.EXPLAIN || ''),
      close: num(r.CLOSE_PRICE),
      change_pct: num(r.CHANGE_RATE),
      net_buy_wan: netWan,
      buy_wan: Math.round(((num(r.BILLBOARD_BUY_AMT) || 0) / 1e4) * 10) / 10,
      sell_wan: Math.round(((num(r.BILLBOARD_SELL_AMT) || 0) / 1e4) * 10) / 10,
      turnover_pct: num(r.TURNOVERRATE),
    });
  });
  return {
    date: actual, total: stocks.length, stocks, raw_records: rows.length,
  };
}

export async function conceptBlocks(code, venue = 'sh') {
  const secid = `${venue === 'sh' ? '1' : '0'}.${code}`;
  const query = new URLSearchParams({
    fltt: '2', invt: '2', secid, spt: '3', pi: '0', pz: '200', po: '1',
    fields: 'f12,f14,f3,f128,f140',
  });
  const payload = await fetchJson(`${EM_SLIST}?${query}`, { headers: H_QUOTE, timeoutMs: 15_000 });
  let diff = payload?.data?.diff || {};
  if (!Array.isArray(diff)) diff = Object.values(diff);
  const boards = [];
  for (const it of diff) {
    if (!it || typeof it !== 'object') continue;
    boards.push({
      name: String(it.f14 || ''),
      code: String(it.f12 || ''),
      change_pct: num(it.f3),
      leader: String(it.f128 || ''),
    });
  }
  return {
    total: boards.length, boards, tags: boards.map((b) => b.name).filter(Boolean),
  };
}

const EM_KLINE = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';

/** 带换手率的日 K（东财 f61），筹码分布专用。 */
export async function klineWithTurnover(code, venue = 'sh', days = 150, adjust = 'qfq') {
  const fqt = { qfq: '1', hfq: '2', none: '0' }[String(adjust || 'qfq').toLowerCase()] || '1';
  const query = new URLSearchParams({
    secid: `${venue === 'sh' ? '1' : '0'}.${code}`,
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
    klt: '101',
    fqt,
    end: '20500101',
    lmt: String(Math.max(1, Math.min(Number(days) || 150, 640))),
  });
  const payload = await fetchJson(`${EM_KLINE}?${query}`, { headers: H_QUOTE, timeoutMs: 15_000 });
  const lines = payload?.data?.klines || [];
  const out = [];
  for (const raw of lines) {
    const p = String(raw).split(',');
    if (p.length < 11) continue;
    out.push({
      date: p[0],
      open: num(p[1]) || 0,
      close: num(p[2]) || 0,
      high: num(p[3]) || 0,
      low: num(p[4]) || 0,
      volume_lot: num(p[5]) || 0,
      amount_yuan: num(p[6]),
      change_pct: num(p[8]),
      turnover_pct: num(p[10]),
    });
  }
  return out;
}

function triangularWeights(grid, low, high, avg) {
  const n = grid.length;
  const w = new Array(n).fill(0);
  if (high < low || ![low, high, avg].every(Number.isFinite)) return w;
  if (high - low < 1e-9) {
    let best = 0;
    let bestDiff = Infinity;
    grid.forEach((g, i) => {
      const d = Math.abs(g - low);
      if (d < bestDiff) { best = i; bestDiff = d; }
    });
    w[best] = 1;
    return w;
  }
  avg = Math.min(Math.max(avg, low), high);
  for (let i = 0; i < n; i += 1) {
    const g = grid[i];
    if (g >= low && g <= avg) w[i] = avg - low > 1e-9 ? (g - low) / (avg - low) : 1;
    else if (g > avg && g <= high) w[i] = high - avg > 1e-9 ? (high - g) / (high - avg) : 1;
  }
  const total = w.reduce((a, b) => a + b, 0);
  if (total > 0) return w.map((x) => x / total);
  let best = 0;
  let bestDiff = Infinity;
  grid.forEach((g, i) => {
    const d = Math.abs(g - avg);
    if (d < bestDiff) { best = i; bestDiff = d; }
  });
  w[best] = 1;
  return w;
}

/** 筹码分布（CYQ）。 */
export function chipDistribution(bars, gridSize = 300, decay = 1.0) {
  const need = ['date', 'high', 'low', 'close', 'turnover_pct'];
  const rows = (bars || []).filter((b) => need.every((k) => b[k] !== null && b[k] !== undefined))
    .filter((b) => (b.high || 0) > 0 && (b.low || 0) > 0)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!rows.length) {
    throw new Error('筹码分布需要同时有 high/low/close/turnover_pct 的 K 线，当前有效行数为 0');
  }
  const lo = Math.min(...rows.map((b) => Number(b.low)));
  const hi = Math.max(...rows.map((b) => Number(b.high)));
  const pad = (hi - lo) * 0.02 || Math.max(lo * 0.02, 0.01);
  const grid = Array.from({ length: gridSize }, (_, i) => lo - pad
    + (hi + pad - (lo - pad)) * i / Math.max(1, gridSize - 1));

  let chips = null;
  for (const b of rows) {
    let t = (Number(b.turnover_pct) / 100) * Number(decay || 1);
    t = Math.min(Math.max(t, 0), 1);
    const avg = (Number(b.high) + Number(b.low) + Number(b.close)) / 3;
    const w = triangularWeights(grid, Number(b.low), Number(b.high), avg);
    if (w.reduce((a, c) => a + c, 0) <= 0) continue;
    if (chips === null) {
      chips = [...w];
      continue;
    }
    chips = chips.map((c, i) => c * (1 - t) + w[i] * t);
  }
  if (chips === null) throw new Error('所有交易日的价格区间都无效，无法构建筹码分布');
  const total = chips.reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error('筹码总量为 0，无法计算指标');
  chips = chips.map((c) => c / total);

  const price = Number(rows[rows.length - 1].close);
  const cum = [];
  let acc = 0;
  for (const c of chips) {
    acc += c;
    cum.push(acc);
  }
  const priceAt = (q) => {
    if (q <= cum[0]) return grid[0];
    for (let i = 1; i < cum.length; i += 1) {
      if (cum[i] >= q) {
        const span = cum[i] - cum[i - 1];
        if (span <= 1e-12) return grid[i];
        return grid[i - 1] + (grid[i] - grid[i - 1]) * ((q - cum[i - 1]) / span);
      }
    }
    return grid[grid.length - 1];
  };
  const [p05, p15, p85, p95] = [0.05, 0.15, 0.85, 0.95].map(priceAt);
  let peak = grid[0];
  let peakWeight = -Infinity;
  chips.forEach((c, i) => {
    if (c > peakWeight) { peakWeight = c; peak = grid[i]; }
  });
  return {
    price,
    profit_ratio: chips.reduce((sum, c, i) => sum + (grid[i] <= price ? c : 0), 0),
    avg_cost: chips.reduce((sum, c, i) => sum + grid[i] * c, 0),
    cost_90: [p05, p95],
    cost_70: [p15, p85],
    concentration_90: p95 + p05 ? (p95 - p05) / (p95 + p05) : null,
    concentration_70: p85 + p15 ? (p85 - p15) / (p85 + p15) : null,
    peak_price: peak,
    bars: rows.length,
    first_date: String(rows[0].date),
    last_date: String(rows[rows.length - 1].date),
    cum_turnover_pct: rows.reduce((sum, b) => sum + Number(b.turnover_pct), 0),
  };
}


export async function earningsForecast(code = null, reportDate = null, limit = 50) {
  const parts = [];
  if (code) parts.push(`(SECURITY_CODE="${code}")`);
  if (reportDate) parts.push(`(REPORT_DATE='${reportDate}')`);
  const rows = await datacenter('RPT_PUBLIC_OP_NEWPREDICT', {
    filter: parts.join(''),
    sortColumns: 'NOTICE_DATE,SECURITY_CODE,REPORT_DATE,PREDICT_FINANCE_CODE',
    sortTypes: '-1,1,-1,1', limit,
  });
  return rows.map((r) => ({
    code: String(r.SECURITY_CODE || ''),
    name: String(r.SECURITY_NAME_ABBR || ''),
    notice_date: day(r.NOTICE_DATE),
    report_date: day(r.REPORT_DATE),
    indicator: String(r.PREDICT_FINANCE || ''),
    type: String(r.PREDICT_TYPE || ''),
    amount_lower_yuan: num(r.PREDICT_AMT_LOWER),
    amount_upper_yuan: num(r.PREDICT_AMT_UPPER),
    change_pct_lower: num(r.ADD_AMP_LOWER),
    change_pct_upper: num(r.ADD_AMP_UPPER),
    prior_year_yuan: num(r.PREYEAR_SAME_PERIOD),
    reason: String(r.CHANGE_REASON_EXPLAIN || ''),
  }));
}

export async function institutionSurvey(code = null, days = 30, limit = 30) {
  const parts = ['(IS_SOURCE="1")', '(NUMBERNEW="1")'];
  if (code) parts.push(`(SECURITY_CODE="${code}")`);
  if (days) {
    const start = new Date(Date.now() - Math.max(1, days) * 86400000);
    parts.push(`(NOTICE_DATE>='${day(start)}')`);
  }
  const rows = await datacenter('RPT_ORG_SURVEYNEW', {
    filter: parts.join(''),
    sortColumns: 'NOTICE_DATE,SECURITY_CODE,RECEIVE_START_DATE',
    sortTypes: '-1,1,-1', limit,
  });
  return rows.map((r) => ({
    code: String(r.SECURITY_CODE || ''),
    name: String(r.SECURITY_NAME_ABBR || ''),
    notice_date: day(r.NOTICE_DATE),
    survey_date: day(r.RECEIVE_START_DATE),
    org_count: num(r.SUM),
    way: String(r.RECEIVE_WAY_EXPLAIN || ''),
    place: String(r.RECEIVE_PLACE || ''),
    receptionist: String(r.RECEPTIONIST || ''),
  }));
}

export async function holderTrades(code = null, direction = null, days = 60, limit = 50) {
  if (direction && !['增持', '减持'].includes(direction)) {
    throw new Error('direction 只能是 增持 / 减持 / 留空');
  }
  const parts = [];
  if (code) parts.push(`(SECURITY_CODE="${code}")`);
  if (direction) parts.push(`(DIRECTION="${direction}")`);
  if (days) {
    const start = new Date(Date.now() - Math.max(1, days) * 86400000);
    parts.push(`(NOTICE_DATE>='${day(start)}')`);
  }
  const rows = await datacenter('RPT_SHARE_HOLDER_INCREASE', {
    filter: parts.join(''),
    sortColumns: 'NOTICE_DATE,SECURITY_CODE,HOLDER_NAME,START_DATE,END_DATE',
    sortTypes: '-1,1,1,1,1', limit,
  });
  return rows.map((r) => {
    const signed = num(r.CHANGE_NUM_SYMBOL);
    const side = String(r.DIRECTION || '');
    if (signed !== null && ['增持', '减持'].includes(side) && ((signed < 0) !== (side === '减持'))) {
      throw new Error(`东财增减持方向与股数符号不一致：${r.SECURITY_CODE} ${r.HOLDER_NAME}（${side} / ${signed}）`);
    }
    return {
      code: String(r.SECURITY_CODE || ''),
      name: String(r.SECURITY_NAME_ABBR || ''),
      holder: String(r.HOLDER_NAME || ''),
      direction: side,
      change_shares_10k: signed,
      after_pct_total: num(r.HOLD_RATIO),
      avg_price: num(r.TRADE_AVERAGE_PRICE),
      channel: String(r.MARKET || ''),
      start_date: day(r.START_DATE),
      end_date: day(r.END_DATE),
      notice_date: day(r.NOTICE_DATE),
    };
  });
}

export const BUYBACK_PROGRESS = {
  '001': '董事会预案', '002': '股东大会通过', '003': '股东大会否决',
  '004': '实施中', '005': '停止实施', '006': '完成实施',
};

export async function shareBuyback(code = null, progress = null, limit = 50) {
  const codeMap = Object.fromEntries(Object.entries(BUYBACK_PROGRESS).map(([k, v]) => [v, k]));
  if (progress && !codeMap[progress]) throw new Error(`progress 只能是 ${Object.keys(codeMap).join(' / ')}`);
  const parts = [];
  if (code) parts.push(`(DIM_SCODE="${code}")`);
  if (progress) parts.push(`(REPURPROGRESS="${codeMap[progress]}")`);
  const rows = await datacenter('RPTA_WEB_GETHGLIST_NEW', {
    filter: parts.join(''), sortColumns: 'UPD,DIM_SCODE,REPURCODE', sortTypes: '-1,1,1', limit,
  });
  return rows.map((r) => {
    const pcode = String(r.REPURPROGRESS || '');
    return {
      code: String(r.DIM_SCODE || ''),
      name: String(r.SECURITYSHORTNAME || ''),
      progress: BUYBACK_PROGRESS[pcode] || '',
      progress_code: pcode,
      plan_start: day(r.REPURSTARTDATE),
      plan_end: day(r.REPURENDDATE),
      price_cap: num(r.REPURPRICECAP),
      amount_lower_yuan: num(r.REPURAMOUNTLOWER),
      amount_upper_yuan: num(r.REPURAMOUNTLIMIT),
      done_shares: num(r.REPURNUM),
      done_amount_yuan: num(r.REPURAMOUNT),
      latest_notice: day(r.UPDATEDATE),
    };
  });
}

export async function equityPledge(code = null, limit = 50) {
  const report = 'RPT_CSDC_LIST';
  let rows;
  if (code) {
    rows = await datacenter(report, {
      filter: `(SECURITY_CODE="${code}")`, sortColumns: 'TRADE_DATE', sortTypes: '-1', limit,
    });
  } else {
    const latest = await datacenter(report, { sortColumns: 'TRADE_DATE', sortTypes: '-1', limit: 1 });
    if (!latest.length) throw new Error('东财质押统计返回 0 行，接口口径可能已变');
    const d = day(latest[0].TRADE_DATE);
    rows = await datacenter(report, {
      filter: `(TRADE_DATE='${d}')`, sortColumns: 'PLEDGE_RATIO,SECURITY_CODE',
      sortTypes: '-1,1', limit,
    });
  }
  return rows.map((r) => {
    const total = num(r.REPURCHASE_BALANCE);
    const free = num(r.REPURCHASE_UNLIMITED_BALANCE);
    const locked = num(r.REPURCHASE_LIMITED_BALANCE);
    if (total !== null && free !== null && locked !== null
      && Math.abs(free + locked - total) > Math.max(1, total * 0.001)) {
      throw new Error(`东财质押数据「无限售 + 限售 ≠ 合计」：${r.SECURITY_CODE} ${r.TRADE_DATE}`);
    }
    return {
      date: day(r.TRADE_DATE),
      code: String(r.SECURITY_CODE || ''),
      name: String(r.SECURITY_NAME_ABBR || ''),
      industry: String(r.INDUSTRY || ''),
      pledge_ratio_pct: num(r.PLEDGE_RATIO),
      pledged_shares_10k: total,
      pledged_mktcap_10k: num(r.PLEDGE_MARKET_CAP),
      pledge_count: num(r.PLEDGE_DEAL_NUM),
    };
  });
}

export async function ipoCalendar(limit = 50) {
  const rows = await datacenter('RPTA_APP_IPOAPPLY', {
    sortColumns: 'APPLY_DATE,SECURITY_CODE', sortTypes: '-1,-1', limit,
  });
  return rows.map((r) => {
    const price = num(r.ISSUE_PRICE);
    return {
      code: String(r.SECURITY_CODE || ''),
      name: String(r.SECURITY_NAME || r.SECURITY_NAME_ABBR || ''),
      apply_code: String(r.APPLY_CODE || ''),
      exchange: String(r.TRADE_MARKET || ''),
      board: String(r.MARKET || r.MARKET_TYPE_NEW || ''),
      apply_date: day(r.APPLY_DATE),
      listing_date: day(r.LISTING_DATE),
      issue_price: price || null,
      issue_pe: num(r.AFTER_ISSUE_PE),
      industry_pe: num(r.INDUSTRY_PE),
      issue_shares_10k: num(r.ISSUE_NUM),
      win_rate_pct: num(r.ONLINE_ISSUE_LWR),
      first_close_chg_pct: num(r.LD_CLOSE_CHANGE),
    };
  });
}

const CB_QUOTES = 'f2~01~CONVERT_STOCK_CODE~CONVERT_STOCK_PRICE,'
  + 'f235~10~SECURITY_CODE~TRANSFER_PRICE,'
  + 'f236~10~SECURITY_CODE~TRANSFER_VALUE,'
  + 'f2~10~SECURITY_CODE~CURRENT_BOND_PRICE,'
  + 'f237~10~SECURITY_CODE~TRANSFER_PREMIUM_RATIO';

export async function convertibleBonds(includeDelisted = false, limit = 500) {
  const rows = await datacenter('RPT_BOND_CB_LIST', {
    sortColumns: 'PUBLIC_START_DATE,SECURITY_CODE', sortTypes: '-1,1',
    pageSize: 500, limit: Math.max(Number(limit) || 500, 500),
    extra: { quoteColumns: CB_QUOTES, quoteType: '0' },
  });
  if (!rows.length) throw new Error('东财可转债列表为空，接口可能改了');
  const today = day(new Date());
  const out = [];
  for (const r of rows) {
    const listing = day(r.LISTING_DATE);
    const delist = day(r.DELIST_DATE);
    const market = String(r.TRADE_MARKET || '');
    let status;
    if ((delist && delist <= today) || market === 'STAS00') status = 'delisted';
    else if (!['CNSESH', 'CNSESZ'].includes(market)) status = 'unknown';
    else if (listing && listing <= today) status = 'listed';
    else if (listing || r.PUBLIC_START_DATE) status = 'upcoming';
    else status = 'unknown';
    if (status === 'delisted' && !includeDelisted) continue;
    out.push({
      code: String(r.SECURITY_CODE || ''),
      name: String(r.SECURITY_NAME_ABBR || ''),
      status,
      stock_code: String(r.CONVERT_STOCK_CODE || ''),
      stock_name: String(r.SECURITY_SHORT_NAME || ''),
      rating: String(r.RATING || ''),
      issue_size_100m: num(r.ACTUAL_ISSUE_SCALE),
      listing_date: listing,
      delist_date: delist,
      expire_date: day(r.EXPIRE_DATE),
      convert_start: day(r.TRANSFER_START_DATE),
      initial_convert_price: num(r.INITIAL_TRANSFER_PRICE),
      convert_price: num(r.TRANSFER_PRICE),
      bond_price: num(r.CURRENT_BOND_PRICE),
      stock_price: num(r.CONVERT_STOCK_PRICE),
      convert_value: num(r.TRANSFER_VALUE),
      premium_pct: num(r.TRANSFER_PREMIUM_RATIO),
    });
  }
  return out;
}


const CNINFO_QUERY = 'http://www.cninfo.com.cn/new/hisAnnouncement/query';
const CNINFO_SEARCH = 'http://www.cninfo.com.cn/new/information/topSearch/query';
const EM_REPORT = 'https://reportapi.eastmoney.com/report/list';
const SINA_FIN = 'https://quotes.sina.cn/cn/api/openapi.php/CompanyFinanceService.getFinanceReport2022';

async function postForm(url, form, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'user-agent': H_DC['user-agent'],
      referer: 'http://www.cninfo.com.cn/',
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: new URLSearchParams(form),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}：${url}`);
  return res.text();
}

export async function cninfoAnnouncements(code, limit = 30, category = '') {
  const hits = await postForm(CNINFO_SEARCH, { keyWord: code, maxNum: '10' });
  let found;
  try { found = JSON.parse(hits) || []; } catch { throw new Error('巨潮代码检索返回的不是 JSON'); }
  const orgId = found.find((it) => it && String(it.code) === code)?.orgId || '';
  if (!orgId) throw new Error(`巨潮没查到 ${code} 的 orgId（代码错或该市场不覆盖）`);
  const form = {
    pageNum: '1', pageSize: String(Math.max(1, Math.min(limit, 50))),
    column: ['0', '3'].includes(code[0]) ? 'szse' : 'sse',
    tabName: 'fulltext', plate: '', stock: `${code},${orgId}`,
    searchkey: '', secid: '', category, trade: '', seDate: '',
    sortName: '', sortType: '', isHLtitle: 'true',
  };
  const text = await postForm(CNINFO_QUERY, form);
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error('巨潮公告查询返回的不是 JSON（可能被反爬拦截）'); }
  const rows = payload?.announcements || [];
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const stamp = r.announcementTime;
    let when = '';
    if (typeof stamp === 'number') {
      const d = new Date(stamp);
      when = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    const title = String(r.announcementTitle || '').replace(/<[^>]+>/g, '').trim();
    if (!title) continue;
    out.push({
      date: when,
      title,
      type: String(r.announcementTypeName || ''),
      url: r.adjunctUrl ? `http://static.cninfo.com.cn/${r.adjunctUrl}` : '',
    });
  }
  return out;
}

export async function eastmoneyReports(code, months = 12, limit = 20) {
  const end = new Date();
  const begin = new Date(end.getTime() - Math.max(30, months * 31) * 86400000);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const query = new URLSearchParams({
    industryCode: '*', pageSize: String(Math.max(1, Math.min(limit, 50))),
    industry: '*', rating: '', ratingChange: '',
    beginTime: iso(begin), endTime: iso(end),
    pageNo: '1', fields: '', qType: '0', orgCode: '',
    code, rcode: '', p: '1', pageNum: '1',
  });
  const payload = await fetchJson(`${EM_REPORT}?${query}`, { headers: H_DC, timeoutMs: 15_000 });
  const rows = payload?.data || [];
  return rows.filter((r) => r && typeof r === 'object').map((r) => ({
    title: String(r.title || ''),
    date: day(r.publishDate),
    org: String(r.orgSName || ''),
    rating: String(r.emRatingName || ''),
    eps_this_year: num(r.predictThisYearEps),
    eps_next_year: num(r.predictNextYearEps),
    pe_this_year: num(r.predictThisYearPe),
    industry: String(r.indvInduName || ''),
  }));
}

export async function sinaFinancialReport(code, venue = 'sh', reportType = 'lrb', num = 8) {
  if (!['fzb', 'lrb', 'llb'].includes(reportType)) {
    throw new Error('report_type 只能是 fzb / lrb / llb');
  }
  const query = new URLSearchParams({
    paperCode: `${venue}${code}`, source: reportType, type: '0',
    page: '1', num: String(Math.max(1, Math.min(num, 20))),
  });
  const payload = await fetchJson(`${SINA_FIN}?${query}`, {
    headers: { 'user-agent': H_DC['user-agent'] }, timeoutMs: 15_000,
  });
  const reportList = payload?.result?.data?.report_list || {};
  if (!reportList || typeof reportList !== 'object') {
    throw new Error('新浪财报返回的 report_list 不是对象，格式可能已变');
  }
  const out = [];
  for (const period of Object.keys(reportList).sort().reverse().slice(0, Math.max(1, Math.min(num, 20)))) {
    const node = reportList[period] || {};
    const items = {};
    const yoy = {};
    for (const it of node.data || []) {
      if (!it || typeof it !== 'object') continue;
      const title = String(it.item_title || '').trim();
      if (!title || it.item_value === null || it.item_value === '') continue;
      items[title] = it.item_value;
      if (it.item_tongbi !== null && it.item_tongbi !== '') yoy[title] = it.item_tongbi;
    }
    out.push({
      period: period.length === 8 ? `${period.slice(0, 4)}-${period.slice(4, 6)}-${period.slice(6, 8)}` : period,
      items, yoy,
    });
  }
  return out;
}


const CHINABOND = 'https://yield.chinabond.com.cn/cbweb-pbc-web/pbc/historyQuery';
const CHINAMONEY = 'https://www.chinamoney.com.cn/r/cms/www/chinamoney/data/currency/{name}-chrt.csv';
const SZSE_CAL = 'https://www.szse.cn/api/report/exchange/onepersistenthour/monthList';
const NBS_INDEX = 'https://www.stats.gov.cn/sj/zxfb/';
const CB_CURVES = { all: 'ycqx', treasury: 'hzsylqx', bank_aaa: 'syyhsylqx', mtn_aaa: 'zdqpjsylqx' };
const CB_NAMES = {
  treasury: '中债国债收益率曲线',
  bank_aaa: '中债商业银行普通债收益率曲线(AAA)',
  mtn_aaa: '中债中短期票据收益率曲线(AAA)',
};
const CB_FIRST_DAY = { treasury: '2006-03-01', mtn_aaa: '2006-12-25', bank_aaa: '2009-12-24' };
const CB_HEADER = ['曲线名称', '日期', '3月', '6月', '1年', '3年', '5年', '7年', '10年', '30年'];
const CB_TENORS = ['3m', '6m', '1y', '3y', '5y', '7y', '10y', '30y'];

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function lprHistory(limit = 36) {
  const rows = await datacenter('RPTA_WEB_RATE', {
    sortColumns: 'TRADE_DATE', sortTypes: '1', columns: 'TRADE_DATE,LPR1Y,LPR5Y',
    pageSize: 500, limit: 2000,
  });
  const out = [];
  for (const r of rows) {
    if (r.LPR1Y === null || r.LPR1Y === undefined) continue;
    const d = day(r.TRADE_DATE);
    if (!d) continue;
    out.push({ date: d, lpr_1y: num(r.LPR1Y), lpr_5y: num(r.LPR5Y) });
  }
  if (!out.length) throw new Error('东财 LPR 报表里没有 LPR 数据');
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out.slice(-Math.max(1, limit));
}

export async function nbsPmi() {
  const ua = { 'user-agent': 'Mozilla/5.0' };
  const indexHtml = await fetchText(NBS_INDEX, { headers: ua, timeoutMs: 20_000 });
  const links = [...indexHtml.matchAll(/<a[^>]+href="([^"]+)"[^>]*>\s*([^<]{6,80}?)\s*<\/a>/g)]
    .map((m) => [m[1], m[2]]);
  const hit = links.find(([, title]) => title.includes('采购经理指数'));
  if (!hit) throw new Error('国家统计局最新发布页未找到「采购经理指数」条目');
  const url = hit[0].startsWith('http') ? hit[0] : NBS_INDEX + hit[0].replace(/^\.?\//, '');
  let html = await fetchText(url, { headers: ua, timeoutMs: 20_000 });
  html = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, '');
  let text = html.replace(/<[^>]+>/g, '').replace(/[\s\u3000\xa0]+/g, '');
  const grab = (pattern) => {
    const m = text.match(pattern);
    return m ? Number(m[1]) : null;
  };
  const ym = hit[1].match(/(\d{4})年(\d{1,2})月/);
  const result = {
    title: hit[1].trim(),
    period: ym ? `${ym[1]}-${String(Number(ym[2])).padStart(2, '0')}` : null,
    manufacturing_pmi: grab(/(?<!非)制造业采购经理指数（PMI）为([\d.]+)%/),
    non_manufacturing_pmi: grab(/非制造业商务活动指数为([\d.]+)%/),
    composite_pmi: grab(/综合PMI产出指数为([\d.]+)%/),
    pmi_large: grab(/大型企业PMI为([\d.]+)%/),
    pmi_medium: grab(/中型企业PMI为([\d.]+)%/),
    pmi_small: grab(/小型企业PMI为([\d.]+)%/),
    source_url: url,
  };
  const combined = text.match(/大、中、小型企业PMI分别为([\d.]+)%、([\d.]+)%和([\d.]+)%/);
  if (combined) {
    result.pmi_large = Number(combined[1]);
    result.pmi_medium = Number(combined[2]);
    result.pmi_small = Number(combined[3]);
  } else {
    const mMs = text.match(/中、小型企业PMI分别为([\d.]+)%和([\d.]+)%/);
    if (mMs) {
      result.pmi_medium = Number(mMs[1]);
      result.pmi_small = Number(mMs[2]);
    }
  }
  if (['manufacturing_pmi', 'non_manufacturing_pmi', 'composite_pmi']
    .some((k) => result[k] === null)) {
    throw new Error(`PMI 正文措辞可能已变更，三个主指标解析不全；请核对页面：${url}`);
  }
  return result;
}

export async function chinabondYield(days = 30, curve = 'treasury') {
  if (!CB_CURVES[curve]) throw new Error(`curve 只能是 ${Object.keys(CB_CURVES).join('/')}`);
  const end = new Date();
  const start = new Date(end.getTime() - Math.max(1, Math.min(days, 360)) * 86400000);
  const wanted = Object.keys(CB_NAMES).filter((k) => curve === 'all' || k === curve);
  const first = wanted.map((k) => CB_FIRST_DAY[k]).sort()[0];
  const begin = new Date(Math.max(Date.parse(`${first}T00:00:00Z`), start.getTime()));
  const query = new URLSearchParams({
    startDate: isoDate(begin), endDate: isoDate(end), gjqx: '0',
    qxId: CB_CURVES[curve], locale: 'cn_ZH',
  });
  const html = await fetchText(`${CHINABOND}?${query}`, {
    headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://yield.chinabond.com.cn/' },
    timeoutMs: 20_000,
  });
  const body = html.replace(/<!--[\s\S]*?-->/g, '');
  const tables = body.split('<table');
  if (tables.length < 3) throw new Error('中债收益率页面里没有数据表，接口口径可能已变');
  const tableRows = [...tables[tables.length - 1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((m) => m[1]);
  const cells = tableRows.map((r) => [...r.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
    .map((m) => m[1].replace(/<[^>]+>|\s+/g, '')));
  if (!cells.length || JSON.stringify(cells[0]) !== JSON.stringify(CB_HEADER)) {
    throw new Error('中债收益率页面表头改变，不能按原列序解析');
  }
  const byName = Object.fromEntries(wanted.map((k) => [CB_NAMES[k], k]));
  const rows = [];
  for (const rec of cells.slice(1)) {
    if (rec.length !== CB_HEADER.length) throw new Error(`中债收益率行列数不对：${rec.join(',')}`);
    const name = rec[0];
    if (!byName[name]) throw new Error(`中债返回了未请求的曲线「${name}」`);
    const row = { date: rec[1], curve: name, curve_key: byName[name] };
    CB_TENORS.forEach((k, i) => { row[k] = num(rec[i + 2]); });
    rows.push(row);
  }
  if (!rows.length) throw new Error(`${isoDate(begin)}~${isoDate(end)} 没有中债收益率（区间内无交易日或接口未发布）`);
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.curve.localeCompare(b.curve));
  return { curve, rows, start: isoDate(begin), end: isoDate(end) };
}

export async function repoFixing(kind = 'FR') {
  const names = { FR: 'frr', FDR: 'fdr' };
  const key = String(kind || 'FR').toUpperCase();
  if (!names[key]) throw new Error('kind 只能是 FR / FDR');
  const text = await fetchText(CHINAMONEY.replace('{name}', names[key]), {
    headers: {
      'user-agent': 'Mozilla/5.0',
      referer: 'https://www.chinamoney.com.cn/chinese/bkfrr/',
    },
    encoding: 'utf-8',
    timeoutMs: 20_000,
  });
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(',');
    if (parts.length !== 9 || parts.slice(1, 6).some((p) => p.trim())) {
      throw new Error(`货币网定盘利率 CSV 格式改变：${line.slice(0, 60)}`);
    }
    const k = key.toLowerCase();
    out.push({
      date: parts[0].trim(),
      [`${k}001`]: num(parts[6]),
      [`${k}007`]: num(parts[7]),
      [`${k}014`]: num(parts[8]),
    });
  }
  if (!out.length) throw new Error(`货币网 ${key} 定盘利率为空`);
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

export async function tradingCalendar(year, month) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error('year/month 必须为整数，month 在 1–12 之间');
  }
  const last = new Date(year, month, 0).getDate();
  const query = new URLSearchParams({ month: `${year}-${month}` });
  const payload = await fetchJson(`${SZSE_CAL}?${query}`, {
    headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.szse.cn/' },
    timeoutMs: 20_000,
  });
  const rows = payload?.data;
  if (!Array.isArray(rows) || !rows.length) throw new Error('深交所尚未返回该月日历；不能推断全月休市');
  const days = [];
  for (const rec of rows) {
    if (!rec || !['0', '1'].includes(String(rec.jybz))) throw new Error('深交所日历字段异常');
    const d = day(rec.jyrq);
    if (!d) throw new Error(`深交所日历日期无法识别：${rec.jyrq}`);
    days.push({ date: d, is_open: String(rec.jybz) === '1' });
  }
  const expected = new Set(Array.from({ length: last }, (_, i) => `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`));
  const got = new Set(days.map((d) => d.date));
  if (expected.size !== got.size || [...expected].some((d) => !got.has(d))) {
    throw new Error('深交所日历月份错位或日期不完整');
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  return { year, month, days, open_count: days.filter((d) => d.is_open).length };
}


const EM_ZT = 'https://push2ex.eastmoney.com';
const ZT_UT = '7eea3edcaed734bea9cbfc24409ed989';
const ZT_ENDPOINT = {
  zt: ['getTopicZTPool', 'fbt:asc'],
  zb: ['getTopicZBPool', 'fbt:asc'],
  dt: ['getTopicDTPool', 'fund:asc'],
  yzt: ['getYesterdayZTPool', 'zs:desc'],
};
const THS_LIMIT_POOL = 'https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool';
const THS_STRONG = 'http://zx.10jqka.com.cn/event/api/getharden/date/{date}/order/num/desc/page/1/limit/200';

function fmtZtTime(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return text;
  const s = text.padStart(6, '0');
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
}

function ymd(date = null) {
  if (date) {
    const t = String(date).replace(/-/g, '');
    return t.slice(0, 8);
  }
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

export async function limitPool(kind = 'zt', date = null) {
  if (!ZT_ENDPOINT[kind]) throw new Error(`kind 只能是 ${Object.keys(ZT_ENDPOINT).join('/')}`);
  const [endpoint, sort] = ZT_ENDPOINT[kind];
  const query = new URLSearchParams({
    ut: ZT_UT, dpt: 'wz.ztzt', Pageindex: '0', pagesize: '10000', sort, date: ymd(date),
  });
  const payload = await fetchJson(`${EM_ZT}/${endpoint}?${query}`, {
    headers: H_QUOTE, timeoutMs: 15_000,
  });
  const node = payload?.data;
  if (!node) return [];
  const out = [];
  for (const p of node.pool || []) {
    if (!p || typeof p !== 'object') continue;
    const stat = p.zttj || {};
    const base = {
      code: String(p.c || ''),
      name: String(p.n || ''),
      price: (num(p.p) || 0) / 1000,
      change_pct: Math.round((num(p.zdp) || 0) * 100) / 100,
      turnover_pct: Math.round((num(p.hs) || 0) * 100) / 100,
      industry: String(p.hybk || ''),
      streak_days: stat.days,
      streak_boards: stat.ct,
    };
    if (kind === 'zt') {
      Object.assign(base, {
        amount_yuan: num(p.amount),
        float_mcap_yuan: num(p.ltsz),
        limit_days: p.lbc,
        first_seal: fmtZtTime(p.fbt),
        last_seal: fmtZtTime(p.lbt),
        seal_fund_yuan: num(p.fund),
        break_times: p.zbc,
      });
    } else if (kind === 'zb') {
      Object.assign(base, {
        limit_price: (num(p.ztp) || 0) / 1000,
        first_seal: fmtZtTime(p.fbt),
        break_times: p.zbc,
        amplitude_pct: num(p.zf),
        speed_pct: num(p.zs),
      });
    } else if (kind === 'dt') {
      Object.assign(base, {
        pe: num(p.pe),
        seal_fund_yuan: num(p.fund),
        last_seal: fmtZtTime(p.lbt),
        dt_days: p.days,
        open_times: p.oc,
      });
    } else {
      Object.assign(base, {
        amplitude_pct: num(p.zf),
        speed_pct: num(p.zs),
        y_first_seal: fmtZtTime(p.yfbt),
        y_limit_days: p.ylbc,
      });
    }
    out.push(base);
  }
  return out;
}

export async function limitSentiment(date = null) {
  const zt = await limitPool('zt', date);
  const zb = await limitPool('zb', date);
  const dtp = await limitPool('dt', date);
  const ladder = {};
  for (const s of zt) {
    const d = s.limit_days;
    if (Number.isInteger(d) && d > 0) ladder[d] = (ladder[d] || 0) + 1;
  }
  const ztN = zt.length;
  const zbN = zb.length;
  const ladderSorted = Object.fromEntries(Object.entries(ladder)
    .sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => [k, v]));
  return {
    date: ymd(date),
    zt_count: ztN,
    zb_count: zbN,
    dt_count: dtp.length,
    break_rate_pct: ztN + zbN ? Math.round((zbN / (ztN + zbN)) * 1000) / 10 : null,
    max_streak: Object.keys(ladder).length ? Math.max(...Object.keys(ladder).map(Number)) : 0,
    ladder: ladderSorted,
    zt_stocks: zt,
    zb_stocks: zb,
    dt_stocks: dtp,
  };
}

export async function thsLimitReason(date = null) {
  const query = new URLSearchParams({
    page: '1', limit: '200',
    field: '199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003,9004',
    filter: 'HS,GEM2STAR', order_field: '330324', order_type: '0', date: ymd(date),
  });
  const payload = await fetchJson(`${THS_LIMIT_POOL}?${query}`, {
    headers: { 'user-agent': 'Mozilla/5.0' }, timeoutMs: 15_000,
  });
  const info = payload?.data?.info || [];
  const out = [];
  for (const it of info) {
    if (!it || typeof it !== 'object') continue;
    let first = '';
    if (it.first_limit_up_time) {
      try {
        const d = new Date(Number(it.first_limit_up_time) * 1000);
        first = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
      } catch { first = ''; }
    }
    out.push({
      code: String(it.code || ''),
      name: String(it.name || ''),
      price: num(it.latest),
      change_pct: num(it.change_rate),
      reason: String(it.reason_type || ''),
      board_type: String(it.limit_up_type || ''),
      seal_rate: num(it.limit_up_suc_rate),
      break_times: it.open_num || 0,
      seal_amount_yuan: num(it.order_amount),
      high_days: String(it.high_days || ''),
      first_seal: first,
      re_sealed: Boolean(it.is_again_limit),
    });
  }
  return out;
}

export async function thsStrong(date = null) {
  const day = date ? (String(date).match(/^\d{8}$/)
    ? `${String(date).slice(0, 4)}-${String(date).slice(4, 6)}-${String(date).slice(6, 8)}`
    : String(date).slice(0, 10)) : isoDate(new Date());
  const payload = await fetchJson(THS_STRONG.replace('{date}', day), {
    headers: { 'user-agent': 'Mozilla/5.0' }, timeoutMs: 15_000,
  });
  if (payload?.errocode) throw new Error(`同花顺热点错误：${payload.errormsg}`);
  const rows = payload?.data || [];
  return rows.filter((r) => r && typeof r === 'object').map((r) => ({
    code: String(r.code || ''),
    name: String(r.name || ''),
    reason: String(r.reason || ''),
    date: String(r.date || ''),
    market: String(r.market || ''),
  }));
}
