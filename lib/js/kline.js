/**
 * K 线 / 行情快照（腾讯主源）。
 *
 * 腾讯 K 线接口一次能同时拿到 K 线与实时快照（`data[symbol].qt`），
 * 所以 `fetchKlines` 顺手把快照也返回，少打一次请求。
 */

import { fetchJson, fetchText } from './http.js';
import {
  boardOf, limitPrices, normalizeCode, tencentSymbol,
} from './market.js';

/** 腾讯行情字段下标（与上游 astock_data.py 的 `_T` 一致）。 */
const T = {
  name: 1, code: 2, price: 3, prev_close: 4, open: 5,
  volume_lot: 6, time: 30, change: 31, change_pct: 32,
  high: 33, low: 34, amount_wan: 37, turnover: 38, pe: 39,
  amplitude: 43, float_mcap: 44, total_mcap: 45, pb: 46,
  limit_up: 47, limit_down: 48, volume_ratio: 49,
};

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pick(fields, key) {
  const idx = T[key];
  return idx === undefined ? null : num(fields[idx]);
}

function positiveOrNone(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 20261023161458 → 2026-10-23 16:14:58（分钟线 12 位）。 */
export function fmtTencentTime(raw) {
  const text = String(raw ?? '').trim();
  if (/^\d{14}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)} `
      + `${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}`;
  }
  if (/^\d{12}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)} `
      + `${text.slice(8, 10)}:${text.slice(10, 12)}`;
  }
  return text;
}

/**
 * 解析腾讯快照数组（`v_sh600000="1~浦发银行~..."` 或 K 线响应里的 `qt`）。
 * @returns {object|null}
 */
export function parseTencentQuote(fields, venue = '', kind = 'stock') {
  if (!Array.isArray(fields) || fields.length < 50) return null;
  const code = String(fields[T.code] || '').trim();
  if (!code) return null;
  const name = String(fields[T.name] || '').trim();
  const board = kind === 'index' ? 'index' : boardOf(code);
  const prevClose = pick(fields, 'prev_close');
  let price = pick(fields, 'price');
  let limitUp = positiveOrNone(pick(fields, 'limit_up'));
  let limitDown = positiveOrNone(pick(fields, 'limit_down'));
  const extra = {};

  // 停牌/未开盘时 price 可能为 0——用昨收兜底并把状态说清楚，而不是返回 0 元
  if (!price && prevClose) {
    price = prevClose;
    extra.price_is_prev_close = true;
    extra.note = '当前无成交价（停牌/未开盘），已用昨收填充';
  }
  if (price && board && board !== 'index') {
    const lp = limitPrices(prevClose || 0, code, name);
    limitUp = limitUp || lp.up;
    limitDown = limitDown || lp.down;
    extra.limit_pct = lp.pct;
  }

  return {
    code,
    venue,
    name,
    price,
    prev_close: prevClose,
    open: pick(fields, 'open'),
    high: pick(fields, 'high'),
    low: pick(fields, 'low'),
    change: pick(fields, 'change'),
    change_pct: pick(fields, 'change_pct'),
    volume_lot: pick(fields, 'volume_lot'),
    amount: (pick(fields, 'amount_wan') || 0) * 10000 || null,
    turnover: pick(fields, 'turnover'),
    volume_ratio: pick(fields, 'volume_ratio'),
    amplitude: pick(fields, 'amplitude'),
    pe: pick(fields, 'pe'),
    pb: pick(fields, 'pb'),
    total_mcap: (pick(fields, 'total_mcap') || 0) * 1e8 || null,
    float_mcap: (pick(fields, 'float_mcap') || 0) * 1e8 || null,
    limit_up: limitUp,
    limit_down: limitDown,
    trade_time: fmtTencentTime(fields[T.time]),
    board,
    source: 'tencent',
    extra,
  };
}

/** 新浪备源：var hq_str_sh600000="名称,今开,昨收,现价,最高,最低,...,日期,时间"; */
export function parseSinaQuote(payload, code, venue) {
  if (!String(payload).includes('="')) return null;
  const body = String(payload).split('="')[1].replace(/[";\s]+$/g, '');
  const fields = body.split(',');
  if (fields.length < 32) return null;
  const price = num(fields[3]);
  const prev = num(fields[2]);
  const name = String(fields[0] || '').trim();
  const quote = {
    code,
    venue,
    board: boardOf(code),
    name,
    price,
    prev_close: prev,
    open: num(fields[1]),
    high: num(fields[4]),
    low: num(fields[5]),
    change: null,
    change_pct: null,
    volume_lot: (num(fields[8]) || 0) / 100 || null,
    amount: num(fields[9]),
    turnover: null,
    volume_ratio: null,
    amplitude: null,
    pe: null,
    pb: null,
    total_mcap: null,
    float_mcap: null,
    limit_up: null,
    limit_down: null,
    trade_time: fields.length > 31 ? `${fields[30]} ${fields[31]}` : '',
    source: 'sina',
    extra: {},
  };
  if (price && prev) {
    quote.change = Math.round((price - prev) * 100) / 100;
    quote.change_pct = Math.round((price - prev) / prev * 100 * 100) / 100;
  }
  const lp = limitPrices(prev || 0, code, name);
  quote.limit_up = lp.up;
  quote.limit_down = lp.down;
  quote.extra.limit_pct = lp.pct;
  return quote;
}

const SINA_QUOTE = 'https://hq.sinajs.cn/list=';

/**
 * 单只/多只实时快照（腾讯主源，失败换新浪）。
 * @param {string[]} codes
 * @param {'stock'|'index'|'etf'} [kind]
 * @param {{useCache?: boolean}} [options]
 */
export async function fetchQuotes(codes, kind = 'stock', { useCache = true } = {}) {
  const items = [];
  for (const raw of codes || []) {
    const text = String(raw ?? '').trim();
    if (!text) continue;
    const { code, venue } = normalizeCode(text, kind);
    items.push({ code, venue, kind });
  }
  if (!items.length) return [];
  const capped = items.slice(0, 50);
  const symbols = capped.map((item) => tencentSymbol(item.code, item.venue));
  const ttl = useCache ? 3000 : 0;

  try {
    const text = await fetchText(`https://qt.gtimg.cn/q=${symbols.join(',')}`, {
      encoding: 'gbk',
      headers: { referer: 'https://finance.qq.com/' },
      timeoutMs: 10_000,
      cacheTtlMs: ttl,
    });
    const bySymbol = new Map();
    for (const line of text.split(';')) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes('="')) continue;
      const symbol = trimmed.split('=')[0].replace(/^v_/, '').trim();
      const venue = ['sh', 'sz', 'bj'].includes(symbol.slice(0, 2)) ? symbol.slice(0, 2) : '';
      const body = trimmed.split('="')[1].replace(/";?\s*$/, '');
      const item = capped.find((entry) => tencentSymbol(entry.code, entry.venue) === symbol);
      const quote = parseTencentQuote(body.split('~'), venue, item?.kind || 'stock');
      if (quote) bySymbol.set(`${venue}${quote.code}`, quote);
    }
    const out = symbols.map((symbol) => bySymbol.get(symbol)).filter(Boolean);
    if (out.length) return out;
  } catch {
    // 腾讯失败 → 新浪备源
  }

  const text = await fetchText(`${SINA_QUOTE}${symbols.join(',')}`, {
    encoding: 'gbk',
    headers: { referer: 'https://finance.sina.com.cn' },
    timeoutMs: 10_000,
    cacheTtlMs: ttl,
  });
  const bySymbol = new Map();
  for (const line of text.split(';')) {
    const trimmed = line.trim();
    if (!trimmed.includes('="')) continue;
    const symbol = trimmed.split('=')[0].replace(/^var hq_str_/, '').trim();
    const item = capped.find((entry) => tencentSymbol(entry.code, entry.venue) === symbol);
    if (!item) continue;
    const quote = parseSinaQuote(trimmed, item.code, item.venue);
    if (quote) bySymbol.set(symbol, quote);
  }
  const out = symbols.map((symbol) => bySymbol.get(symbol)).filter(Boolean);
  if (!out.length) {
    throw new Error('行情接口没有返回任何有效数据（代码可能不存在或已退市）');
  }
  return out;
}

const PERIOD_KEYS = {
  day: 'day',
  week: 'week',
  month: 'month',
};

const MINUTE_KEYS = {
  '1m': 'm1', '5m': 'm5', '15m': 'm15', '30m': 'm30', '60m': 'm60',
};

const TENCENT_KLINE_HOSTS = [
  'https://ifzq.gtimg.cn/appstock/app/fqkline/get',
  'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get',
  'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get',
];

const TENCENT_MKLINE_HOSTS = [
  'https://ifzq.gtimg.cn/appstock/app/kline/mkline',
  'https://web.ifzq.gtimg.cn/appstock/app/kline/mkline',
  'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/kline/mkline',
];

const EM_KLINE = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
const EM_KLT = {
  '1m': '1', '5m': '5', '15m': '15', '30m': '30', '60m': '60',
  day: '101', week: '102', month: '103',
};
const EM_FQT = { none: '0', qfq: '1', hfq: '2' };

const klineCache = new Map();
const KLINE_TTL_MS = 60_000;

function cacheGetKline(key) {
  const hit = klineCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > KLINE_TTL_MS) {
    klineCache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSetKline(key, value) {
  klineCache.set(key, { at: Date.now(), value });
  if (klineCache.size > 200) klineCache.delete(klineCache.keys().next().value);
}

function parseTencentRows(node, keys) {
  for (const key of keys) {
    const rows = node?.[key];
    if (!Array.isArray(rows) || !rows.length) continue;
    const bars = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 6) continue;
      bars.push({
        date: String(row[0]),
        open: num(row[1]) || 0,
        close: num(row[2]) || 0,
        high: num(row[3]) || 0,
        low: num(row[4]) || 0,
        volume_lot: num(row[5]) || 0,
      });
    }
    if (bars.length) return bars;
  }
  return [];
}

async function fetchTencentKlines(symbol, period, limit, adjust) {
  const minute = Boolean(MINUTE_KEYS[period]);
  let urls;
  if (minute) {
    const mcode = MINUTE_KEYS[period];
    urls = TENCENT_MKLINE_HOSTS.map((host) => `${host}?param=${symbol},${mcode},,${limit}`);
  } else {
    const apiPeriod = PERIOD_KEYS[period] || 'day';
    const adj = adjust === 'none' ? '' : (adjust === 'hfq' ? 'hfq' : 'qfq');
    const param = adj
      ? `${symbol},${apiPeriod},,,${limit},${adj}`
      : `${symbol},${apiPeriod},,,${limit}`;
    urls = TENCENT_KLINE_HOSTS.map((host) => `${host}?param=${param}`);
  }

  let lastError = null;
  for (const url of urls) {
    try {
      const json = await fetchJson(url, {
        headers: { referer: 'https://gu.qq.com/' },
        timeoutMs: 12_000,
        cacheTtlMs: KLINE_TTL_MS,
      });
      if (json?.code !== 0) {
        lastError = new Error(`腾讯 K 线返回错误：${json?.msg || json?.code}`);
        continue;
      }
      const node = json?.data?.[symbol] || {};
      const keys = minute
        ? [MINUTE_KEYS[period]]
        : adjust === 'qfq'
          ? [`qfq${period}`, period, 'day']
          : adjust === 'hfq'
            ? [`hfq${period}`, period, 'day']
            : [period, `qfq${period}`, 'day'];
      const bars = parseTencentRows(node, keys);
      if (bars.length) {
        let quote = null;
        const qt = node.qt?.[symbol];
        if (Array.isArray(qt)) quote = parseTencentQuote(qt, symbol.slice(0, 2));
        return { bars, quote };
      }
      lastError = new Error('腾讯 K 线返回空');
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return { bars: [], quote: null };
}

async function fetchEastmoneyKlines(code, venue, period, limit, adjust) {
  const klt = EM_KLT[period];
  if (!klt) return [];
  const fqt = EM_FQT[String(adjust || 'qfq').toLowerCase()] || '1';
  const secid = `${venue === 'sh' ? '1' : '0'}.${code}`;
  const query = new URLSearchParams({
    secid,
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57',
    klt,
    fqt,
    end: '20500101',
    lmt: String(limit),
  });
  const json = await fetchJson(`${EM_KLINE}?${query}`, {
    headers: { referer: 'https://quote.eastmoney.com/' },
    timeoutMs: 12_000,
    cacheTtlMs: KLINE_TTL_MS,
  });
  const rows = json?.data?.klines || [];
  const bars = [];
  for (const raw of rows) {
    const parts = String(raw).split(',');
    if (parts.length < 6) continue;
    bars.push({
      date: String(parts[0]),
      open: num(parts[1]) || 0,
      close: num(parts[2]) || 0,
      high: num(parts[3]) || 0,
      low: num(parts[4]) || 0,
      volume_lot: num(parts[5]) || 0,
      amount: parts.length > 6 ? num(parts[6]) : null,
    });
  }
  return bars;
}

/**
 * K 线（腾讯主源 + 东财备源，日/周/月/1m/5m/15m/30m/60m）。
 * 返回 { code, venue, bars, quote }；bars 已按日期升序、去重、截断到 limit。
 * @param {string} rawCode
 * @param {{period?: string, limit?: number, adjust?: 'qfq'|'hfq'|'none', useCache?: boolean}} [options]
 */
export async function fetchKlines(rawCode, {
  period = 'day', limit = 120, adjust = 'qfq', useCache = true, kind = 'stock',
} = {}) {
  const { code, venue } = normalizeCode(rawCode, kind);
  const symbol = tencentSymbol(code, venue);
  const p = String(period || 'day').toLowerCase();
  if (!PERIOD_KEYS[p] && !MINUTE_KEYS[p]) {
    throw new Error(`不支持的周期 ${period}（支持 day/week/month/1m/5m/15m/30m/60m）`);
  }
  const n = Math.max(1, Math.min(640, Number(limit) || 120));
  const adj = ['qfq', 'hfq', 'none'].includes(adjust) ? adjust : 'qfq';
  const key = `k:${venue}${code}:${p}:${n}:${adj}`;
  if (useCache) {
    const cached = cacheGetKline(key);
    if (cached) return cached;
  }

  const errors = [];
  let bars = [];
  let quote = null;
  try {
    const result = await fetchTencentKlines(symbol, p, n, adj);
    bars = result.bars;
    quote = result.quote;
  } catch (error) {
    errors.push(`腾讯: ${error?.message ?? error}`);
  }
  if (!bars.length) {
    try {
      bars = await fetchEastmoneyKlines(code, venue, p, n, adj);
      if (!bars.length) errors.push('东财: 返回空');
    } catch (error) {
      errors.push(`东财: ${error?.message ?? error}`);
    }
  }
  if (!bars.length) {
    throw new Error(`${code} ${p} K 线获取失败（已尝试腾讯/东财：${errors.join('；') || '无可用源'}）`);
  }

  bars.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const seen = new Set();
  const deduped = [];
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    const bar = bars[i];
    if (seen.has(bar.date)) continue;
    seen.add(bar.date);
    deduped.push(bar);
  }
  deduped.reverse();
  const trimmed = deduped.length > n ? deduped.slice(-n) : deduped;
  const out = {
    code, venue, bars: trimmed, quote,
  };
  if (useCache) cacheSetKline(key, out);
  return out;
}
