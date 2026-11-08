/**
 * 标的检索（东财 suggest）——上游 `astock_data.py::search` 的 JS 移植。
 */

import { fetchText } from './http.js';
import { BOARD_LABELS, boardOf, guessVenue } from './market.js';
import { table } from './format.js';

const EM_SUGGEST = 'https://searchapi.eastmoney.com/api/suggest/get';
const A_STOCK_TYPES = new Set(['沪A', '深A', '京A', '科创板', '创业板', '北证A股', 'A股']);

async function fetchSuggest(query) {
  const text = await fetchText(`${EM_SUGGEST}?${query}`, {
    headers: {
      referer: 'https://www.eastmoney.com/',
      // 东财 CDN 对 keep-alive 连接会返回 JSONP/用户搜索（实测），
      // 关掉长连接才稳定返回 QuotationCodeTable。
      connection: 'close',
      accept: '*/*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    timeoutMs: 10_000,
  });
  // 东财 suggest 有时返回 JSONP（jQuery...({...})），剥掉外层再解析。
  let body = text.trim();
  const wrapped = body.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
  if (wrapped) body = wrapped[1];
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`检索接口返回的不是 JSON：${body.slice(0, 160)}`);
  }
}

/**
 * 按代码/名称/拼音检索。
 * @returns {Promise<Array<{code,name,symbol,venue,kind,board,market}>>}
 */
export async function searchSymbols(keyword, limit = 10) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  const query = new URLSearchParams({
    input: kw,
    type: '14',
    token: 'D43BF722C8E33BDC906FB84D85E326E8',
    count: String(Math.max(1, Math.min(Number(limit) || 10, 30))),
  });

  // 首次请求偶发被 CDN 路由到"用户搜索"后端（没有 QuotationCodeTable），
  // 重试一次即可拿到正确结果——不重试会把「浦发」误报成"没找到"。
  let data = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    data = await fetchSuggest(query);
    if (data?.QuotationCodeTable) break;
  }

  const rows = data?.QuotationCodeTable?.Data || [];
  const out = [];
  for (const row of rows) {
    const code = String(row?.Code || '').trim();
    const name = String(row?.Name || '').trim();
    if (!code || !name) continue;
    const classify = String(row?.Classify || '');
    const secType = String(row?.SecurityTypeName || '');
    const mkt = String(row?.MktNum || '');
    let kind;
    let venue;
    if (classify === 'Index' || secType === '指数') {
      kind = 'index';
      venue = mkt === '1' ? 'sh' : 'sz';
    } else if (['Fund', 'ETF'].includes(classify) || secType.startsWith('基金')) {
      kind = 'etf';
      venue = mkt === '1' ? 'sh' : 'sz';
    } else if (classify === 'AStock' || A_STOCK_TYPES.has(secType)) {
      kind = 'stock';
      venue = guessVenue(code);
      if (/^(43|83|87|88|920)/.test(code)) venue = 'bj';
    } else {
      kind = 'other';
      venue = mkt === '1' ? 'sh' : 'sz';
    }
    out.push({
      code,
      name,
      symbol: `${venue}${code}`,
      venue,
      kind,
      board: BOARD_LABELS[boardOf(code)] || '',
      market: secType || classify,
    });
  }
  return out;
}

/** `astock_search` 工具输出。 */
export async function runSearch(args = {}, options = {}) {
  const kw = String(args.keyword || '').trim();
  if (!kw) return '[Error] 需要 keyword';
  const search = options.search || searchSymbols;
  const rows = (await search(kw, Math.trunc(Number(args.limit) || 10)))
    .filter((row) => ['stock', 'index', 'etf'].includes(row.kind));
  if (!rows.length) {
    return `没找到与「${kw}」匹配的股票/ETF/指数（债券、基金净值等已过滤）。`;
  }
  return table(
    ['代码', '名称', '类型', '板块', 'symbol'],
    rows.map((row) => [row.code, row.name, row.market, row.board, row.symbol]),
  );
}
