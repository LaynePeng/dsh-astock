/**
 * 投资舆情数据层：公告 / 研报 / 新闻 / 热度榜 / 龙虎榜 / 两融 / 股东户数 / 快讯。
 * 上游 `astock_sentiment_data.py` 的 Node 移植。只取证据，不做情绪打分。
 */

import { fetchJson, fetchText } from './http.js';
import { normalizeCode, toFloat } from './market.js';

export const RELIABILITY_ORDER = ['hard_fact', 'official_view', 'media', 'crowd'];

export const RELIABILITY_LABELS = {
  hard_fact: '法定披露/客观数据',
  official_view: '卖方观点',
  media: '媒体报道',
  crowd: '散户情绪',
};

export const DIRECTION_LABELS = {
  positive: '偏正面',
  negative: '偏负面',
  neutral: '中性',
  unknown: '未判定',
};

const EM_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  referer: 'https://data.eastmoney.com/',
  accept: '*/*',
  connection: 'close',
};

const ANNOUNCE_URL = 'https://np-anotice-stock.eastmoney.com/api/security/ann';
const REPORT_URL = 'https://reportapi.eastmoney.com/report/list';
const NEWS_URL = 'https://search-api-web.eastmoney.com/search/jsonp';
const HOT_URL = 'https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock';
const LHB_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const SINA_FEED_URL = 'https://zhibo.sina.com.cn/api/zhibo/feed';

export class Evidence {
  constructor(data = {}) {
    Object.assign(this, {
      category: '',
      title: '',
      reliability: 'media',
      direction: 'unknown',
      as_of: '',
      source: '',
      url: '',
      summary: '',
      meta: {},
    }, data);
  }

  asDict() {
    const out = {
      category: this.category,
      title: this.title,
      reliability: this.reliability,
      reliability_label: RELIABILITY_LABELS[this.reliability] || this.reliability,
      direction: this.direction,
      direction_label: DIRECTION_LABELS[this.direction] || this.direction,
      as_of: this.as_of,
      source: this.source,
    };
    if (this.summary) out.summary = this.summary;
    if (this.url) out.url = this.url;
    if (this.meta && Object.keys(this.meta).length) out.meta = this.meta;
    return out;
  }
}

const POS_WORDS = [
  '增持', '回购', '中标', '签约', '预增', '扭亏', '超预期', '上调', '买入', '推荐',
  '涨价', '突破', '获批', '获批上市', '利好', '同比增长', '创新高', '订单', '扩产',
  '分红', '股权激励', '净利增长', '业绩增长', '龙头', '研报首次覆盖',
];
const NEG_WORDS = [
  '减持', '质押', '诉讼', '仲裁', '立案', '处罚', '警示', '问询', '预亏', '下调',
  '亏损', '违约', '退市', '冻结', '查封', '风险提示', '被调查', '解禁', '商誉减值',
  '终止', '失败', '召回', '停产', '同比下降', '净利下滑', '跌停', '卖出', '谨慎',
];

/** 从标题/摘要判方向（保守：同时出现正负词 → neutral）。 */
export function judgeDirection(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return 'unknown';
  const pos = POS_WORDS.filter((w) => t.includes(w.toLowerCase())).length;
  const neg = NEG_WORDS.filter((w) => t.includes(w.toLowerCase())).length;
  if (pos && neg) return 'neutral';
  if (pos) return 'positive';
  if (neg) return 'negative';
  return 'unknown';
}

export function clean(text) {
  return String(text || '').replace(/<[^>]+>/g, '').trim();
}

export function dateOnly(raw) {
  const t = String(raw || '').trim();
  return t ? t.split(' ')[0] : '';
}

function num(raw) {
  return toFloat(raw, null);
}

async function getJson(url, headers = EM_HEADERS) {
  return fetchJson(url, { headers, timeoutMs: 15_000 });
}

/** 公司公告（法定披露）。 */
export async function fetchAnnouncements(code, pageSize = 10) {
  const query = new URLSearchParams({
    page_size: String(Math.max(1, Math.min(Number(pageSize) || 10, 50))),
    page_index: '1',
    ann_type: 'A',
    client_source: 'web',
    stock_list: code,
  });
  let data;
  try {
    data = await getJson(`${ANNOUNCE_URL}?${query}`);
  } catch {
    return [];
  }
  const rows = data?.data?.list || [];
  const out = [];
  for (const row of rows) {
    const title = clean(row?.title);
    if (!title) continue;
    const art = String(row?.art_code || '');
    const columns = row?.columns || [];
    const colName = columns.filter((c) => c && typeof c === 'object')
      .map((c) => clean(c.column_name)).join(', ');
    out.push(new Evidence({
      category: 'announce',
      title,
      reliability: 'hard_fact',
      direction: judgeDirection(title),
      as_of: dateOnly(row?.notice_date || row?.display_time),
      source: '东方财富·公告',
      url: art ? `https://data.eastmoney.com/notices/detail/${code}/${art}.html` : '',
      meta: colName ? { type: colName } : {},
    }));
  }
  return out;
}

/** 机构研报（卖方观点）。 */
export async function fetchReports(code, months = 6, limit = 8) {
  const end = new Date();
  const begin = new Date(end.getTime() - Math.max(30, Number(months) * 30) * 86400000);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    + `-${String(d.getDate()).padStart(2, '0')}`;
  const query = new URLSearchParams({
    industryCode: '*',
    pageSize: String(Math.max(1, Math.min(Number(limit) || 8, 50))),
    industry: '*',
    beginTime: iso(begin),
    endTime: iso(end),
    pageNo: '1',
    qType: '0',
    code,
    pageNum: '1',
  });
  let data;
  try {
    data = await getJson(`${REPORT_URL}?${query}`);
  } catch {
    return [];
  }
  const rows = data?.data || [];
  const out = [];
  for (const row of rows) {
    const title = clean(row?.title);
    if (!title) continue;
    const rating = clean(row?.emRatingName || row?.sRatingName || '');
    const org = clean(row?.orgSName || row?.orgName || '');
    const eps = num(row?.predictThisYearEps);
    const pe = num(row?.predictThisYearPe);
    const meta = { org };
    if (rating) meta.rating = rating;
    if (eps !== null) meta.eps_forecast = eps;
    if (pe !== null) meta.pe_forecast = pe;
    let direction = judgeDirection(title + rating);
    if (rating) {
      const low = rating.toLowerCase();
      if (['买入', '增持', '推荐', '强烈'].some((k) => rating.includes(k))) direction = 'positive';
      else if (['减持', '卖出', '回避'].some((k) => rating.includes(k))) direction = 'negative';
      else if (rating.includes('中性') || rating.includes('持有')
        || ['neutral', 'hold'].includes(low)) direction = 'neutral';
    }
    out.push(new Evidence({
      category: 'report',
      title,
      reliability: 'official_view',
      direction,
      as_of: dateOnly(row?.publishDate),
      source: org ? `卖方研报·${org}` : '卖方研报',
      url: row?.infoCode
        ? `https://data.eastmoney.com/report/zw_stock.jshtml?infocode=${row.infoCode}` : '',
      meta,
    }));
  }
  return out;
}

/** 个股相关新闻（媒体）。 */
export async function fetchNews(keyword, limit = 10, code = '') {
  const payload = {
    uid: '',
    keyword,
    type: ['cmsArticleWebOld'],
    client: 'web',
    clientType: 'web',
    clientVersion: 'curr',
    param: {
      cmsArticleWebOld: {
        searchScope: 'default',
        sort: 'time',
        pageIndex: 1,
        pageSize: Math.max(1, Math.min(Number(limit) || 10, 30)),
        preTag: '',
        postTag: '',
      },
    },
  };
  const query = new URLSearchParams({ cb: '', param: JSON.stringify(payload) });
  let data = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let text;
    try {
      text = await fetchText(`${NEWS_URL}?${query}`, { headers: EM_HEADERS, timeoutMs: 15_000 });
    } catch {
      return [];
    }
    let body = text.trim();
    const wrapped = body.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
    if (wrapped) body = wrapped[1];
    try {
      data = JSON.parse(body);
    } catch {
      return [];
    }
    if (data?.result?.cmsArticleWebOld) break;
  }
  const rows = data?.result?.cmsArticleWebOld || [];
  const out = [];
  for (const row of rows) {
    const title = clean(row?.title);
    if (!title) continue;
    const summary = clean(row?.content).slice(0, 160);
    out.push(new Evidence({
      category: 'news',
      title,
      reliability: 'media',
      direction: judgeDirection(title + summary),
      as_of: String(row?.date || '').slice(0, 16),
      source: clean(row?.mediaName || '媒体'),
      url: String(row?.url || ''),
      summary,
      meta: { relevance: newsRelevance(title, summary, keyword, code) },
    }));
  }
  return out;
}

const INDUSTRY_HINTS = ['行业', '板块', '全线', '集体', '多股', '等股', '概念股', '赛道',
  '各大', '多家', '周报', '汇总', '盘点', '要闻'];
const SUBJECT_HINTS = ['公告', '被罚', '遭', '拟', '控股', '股东', '持股', '董事长',
  '总经理', '任职', '回购', '增持', '减持', '中标', '签约', '业绩',
  '净利', '营收', '评级', '目标价', '涨停', '封板'];

/** 新闻与标的的相关度：direct / industry / weak。 */
export function newsRelevance(title, summary, keyword, code = '') {
  const kw = String(keyword || '').trim();
  const t = title || '';
  const body = `${t} ${summary}`;
  const inTitle = Boolean(kw) && (t.includes(kw) || (code && t.includes(code)));
  const summaryLike = INDUSTRY_HINTS.some((h) => t.includes(h));
  if (inTitle) {
    if (summaryLike && !SUBJECT_HINTS.some((h) => t.includes(h))) return 'industry';
    return 'direct';
  }
  if (summaryLike) return 'industry';
  if (kw && body.includes(kw)) return 'industry';
  return 'weak';
}

/** 同花顺人气榜。 */
export async function fetchHotRank(code = null, kind = 'hour', limit = 10) {
  const period = String(kind).toLowerCase() === 'day' ? 'day' : 'hour';
  const query = new URLSearchParams({ stock_type: 'a', type: period, list_type: 'normal' });
  let data;
  try {
    data = await fetchJson(`${HOT_URL}?${query}`, {
      headers: {
        'user-agent': EM_HEADERS['user-agent'],
        referer: 'https://www.10jqka.com.cn/',
      },
      timeoutMs: 15_000,
    });
  } catch (error) {
    return {
      available: false, error: error?.message ?? String(error), rank: null, top: [],
    };
  }
  const rows = data?.data?.stock_list || [];
  const normalized = rows.map((row) => {
    const tags = row?.tag || {};
    const concept = tags.concept_tag || [];
    return {
      rank: Math.trunc(num(row?.order) || 0),
      code: String(row?.code || ''),
      name: clean(row?.name),
      heat: num(row?.rate),
      change_pct: num(row?.rise_and_fall),
      rank_change: num(row?.hot_rank_chg),
      concepts: Array.isArray(concept) ? concept.slice(0, 5).map(String) : [],
      popularity: clean(tags.popularity_tag),
      reason: clean(row?.analyse).slice(0, 200),
      reason_title: clean(row?.analyse_title),
    };
  });
  const found = code ? normalized.find((item) => item.code === code) || null : null;
  return {
    available: true,
    rank: found,
    top: normalized.slice(0, Math.max(1, Math.min(Number(limit) || 10, 30))),
    period: period === 'day' ? '日榜' : '小时榜',
  };
}

/** 龙虎榜。 */
export async function fetchLhb(code, limit = 5) {
  const query = new URLSearchParams({
    reportName: 'RPT_DAILYBILLBOARD_DETAILSNEW',
    columns: 'ALL',
    pageSize: '1',
    pageNumber: '1',
    sortColumns: 'TRADE_DATE',
    sortTypes: '-1',
    filter: `(SECURITY_CODE="${code}")`,
  });
  let data;
  try {
    data = await getJson(`${LHB_URL}?${query}`);
  } catch {
    return [];
  }
  const rows = data?.result?.data || [];
  const out = [];
  for (const row of rows.slice(0, Math.max(1, Math.min(Number(limit) || 5, 20)))) {
    const date = dateOnly(row?.TRADE_DATE);
    const net = num(row?.BILLBOARD_NET_AMT);
    const buy = num(row?.BILLBOARD_BUY_AMT);
    const sell = num(row?.BILLBOARD_SELL_AMT);
    const chg = num(row?.CHANGE_RATE);
    const reason = clean(row?.EXPLANATION || row?.EXPLAIN || '');
    let direction = 'unknown';
    if (net !== null) direction = net > 0 ? 'positive' : net < 0 ? 'negative' : 'neutral';
    out.push(new Evidence({
      category: 'lhb',
      title: `${date} 上榜${reason ? `（${reason}）` : ''}`,
      reliability: 'hard_fact',
      direction,
      as_of: date,
      source: '东方财富·龙虎榜',
      meta: {
        net_amount: net, buy_amount: buy, sell_amount: sell, change_pct: chg,
      },
    }));
  }
  return out;
}

/** 融资融券余额趋势。 */
export async function fetchMargin(code, limit = 10) {
  const query = new URLSearchParams({
    reportName: 'RPTA_WEB_RZRQ_GGMX',
    columns: 'ALL',
    pageSize: String(Math.max(2, Math.min(Number(limit) || 10, 60))),
    pageNumber: '1',
    sortColumns: 'DATE',
    sortTypes: '-1',
    filter: `(scode="${code}")`,
  });
  let data;
  try {
    data = await getJson(`${LHB_URL}?${query}`);
  } catch (error) {
    return {
      available: false, error: error?.message ?? String(error), rows: [], trend: null,
    };
  }
  const rows = data?.result?.data || [];
  const series = rows.map((row) => ({
    date: dateOnly(row?.DATE),
    fin_balance: num(row?.RZYE),
    fin_buy: num(row?.RZMRE),
    fin_repay: num(row?.RZCHE),
    sec_balance: num(row?.RQYE),
    total_balance: num(row?.RZRQYE),
  }));
  series.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  let trend = null;
  if (series.length >= 2) {
    const last = series[series.length - 1];
    const prev = series.length >= 5 ? series[series.length - 5] : series[0];
    if (last.fin_balance && prev.fin_balance) {
      const delta = last.fin_balance - prev.fin_balance;
      trend = {
        window: `${prev.date} → ${last.date}`,
        delta: Math.round(delta * 100) / 100,
        delta_pct: Math.round((delta / prev.fin_balance) * 100 * 100) / 100,
        direction: delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'neutral',
      };
    }
  }
  return { available: true, rows: series, trend };
}

/** 股东户数变化。 */
export async function fetchHolderCount(code, limit = 6) {
  const query = new URLSearchParams({
    reportName: 'RPT_HOLDERNUMLATEST',
    columns: 'ALL',
    pageSize: String(Math.max(1, Math.min(Number(limit) || 6, 20))),
    pageNumber: '1',
    filter: `(SECURITY_CODE="${code}")`,
  });
  let data;
  try {
    data = await getJson(`${LHB_URL}?${query}`);
  } catch (error) {
    return {
      available: false, error: error?.message ?? String(error), rows: [], trend: null,
    };
  }
  const rows = data?.result?.data || [];
  const series = rows.map((row) => ({
    end_date: dateOnly(row?.END_DATE),
    holders: num(row?.HOLDER_NUM),
    change_pct: num(row?.HOLDER_NUM_RATIO),
    avg_market_value: num(row?.AVG_MARKET_CAP),
  }));
  series.sort((a, b) => String(a.end_date).localeCompare(String(b.end_date)));
  let trend = null;
  if (series.length) {
    const latest = series[series.length - 1];
    const chg = latest.change_pct;
    if (chg !== null && chg !== undefined) {
      trend = {
        end_date: latest.end_date,
        holders: latest.holders,
        change_pct: chg,
        direction: chg < 0 ? 'positive' : chg > 0 ? 'negative' : 'neutral',
        note: chg < 0 ? '户数下降＝筹码趋于集中'
          : chg > 0 ? '户数上升＝筹码分散（散户增多）' : '持平',
      };
    }
  }
  return { available: true, rows: series, trend };
}

/** 新浪财经 7×24 快讯。 */
export async function fetchFeed(limit = 15, keyword = '') {
  const query = new URLSearchParams({
    page: '1',
    page_size: String(Math.max(1, Math.min(Number(limit) || 15, 50))),
    zhibo_id: '152',
    tag_id: '0',
    dire: 'f',
    dpc: '1',
  });
  let data;
  try {
    data = await fetchJson(`${SINA_FEED_URL}?${query}`, {
      headers: {
        'user-agent': EM_HEADERS['user-agent'],
        referer: 'https://finance.sina.com.cn/7x24/',
      },
      timeoutMs: 15_000,
    });
  } catch {
    return [];
  }
  const rows = data?.result?.data?.feed?.list || [];
  const kw = String(keyword || '').trim();
  const out = [];
  for (const row of rows) {
    const text = clean(row?.rich_text || row?.text || '');
    if (!text) continue;
    if (kw && !text.includes(kw)) continue;
    out.push(new Evidence({
      category: 'feed',
      title: text.split('。')[0].slice(0, 80),
      reliability: 'media',
      direction: judgeDirection(text),
      as_of: String(row?.create_time || '').slice(0, 16),
      source: '新浪财经·7×24',
      summary: text.slice(0, 200),
      meta: {
        tags: (row?.tag || []).filter((t) => t && typeof t === 'object' && t.name)
          .map((t) => t.name),
      },
    }));
  }
  return out;
}

function localDateTime() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 按范围抓取全部舆情证据。 */
export async function collect(rawCode, name = '', scope = [], days = 7, options = {}) {
  const { code } = normalizeCode(rawCode);
  const wanted = new Set((scope || []).map((s) => String(s).trim()).filter(Boolean));
  if (!wanted.size) {
    ['announce', 'report', 'news', 'hot', 'lhb', 'margin', 'holder'].forEach((s) => wanted.add(s));
  }
  const items = [];
  const errors = {};
  const extras = {};
  const api = {
    fetchAnnouncements,
    fetchReports,
    fetchNews,
    fetchHotRank,
    fetchLhb,
    fetchMargin,
    fetchHolderCount,
    fetchFeed,
    ...options,
  };

  if (wanted.has('announce')) {
    const got = await api.fetchAnnouncements(code, 10);
    items.push(...got);
    if (!got.length) errors.announce = '暂无公告或接口不可用';
  }
  if (wanted.has('report')) {
    const got = await api.fetchReports(code, Math.max(6, Math.trunc(days / 7)), 8);
    items.push(...got);
    if (!got.length) errors.report = '近期无机构研报或接口不可用';
  }
  if (wanted.has('news')) {
    const got = await api.fetchNews(name || code, 20, code);
    const direct = got.filter((e) => (e.meta || {}).relevance === 'direct');
    const loose = got.filter((e) => (e.meta || {}).relevance !== 'direct');
    items.push(...direct.slice(0, 10));
    if (loose.length) {
      extras.news_background = loose.slice(0, 6).map((e) => ({
        title: e.title,
        as_of: e.as_of,
        source: e.source,
        relevance: (e.meta || {}).relevance,
      }));
    }
    if (!direct.length) {
      errors.news = '无直接相关新闻（仅有行业/弱相关报道，已单独列为背景，不计入舆情方向）';
    }
  }
  if (wanted.has('hot')) {
    const hot = await api.fetchHotRank(code, 'hour', 10);
    extras.hot = hot;
    if (!hot.available) errors.hot = hot.error || '热度榜不可用';
    else if (!hot.rank) {
      extras.hot_miss = '未进入同花顺人气榜前 100（关注度低，本身就是一个中性偏淡的信号）';
    } else {
      const r = hot.rank;
      const direction = (r.change_pct || 0) > 0 ? 'positive'
        : (r.change_pct || 0) < 0 ? 'negative' : 'neutral';
      items.push(new Evidence({
        category: 'hot',
        title: `同花顺${hot.period || '人气榜'}第 ${r.rank} 名`,
        reliability: 'crowd',
        direction,
        as_of: localDateTime(),
        source: '同花顺·人气榜',
        summary: (r.reason || '').slice(0, 160),
        meta: {
          heat: r.heat,
          rank: r.rank,
          rank_change: r.rank_change,
          concepts: r.concepts || [],
          popularity: r.popularity || '',
        },
      }));
    }
  }
  if (wanted.has('lhb')) {
    const got = await api.fetchLhb(code, 5);
    items.push(...got);
    if (!got.length) errors.lhb = '近期未上龙虎榜（不是异常）';
  }
  if (wanted.has('margin')) {
    const mg = await api.fetchMargin(code, 10);
    extras.margin = mg;
    if (!mg.available) errors.margin = mg.error || '两融数据不可用';
    else if (mg.trend) {
      const t = mg.trend;
      items.push(new Evidence({
        category: 'margin',
        title: `融资余额 ${t.window} 变化 ${t.delta_pct >= 0 ? '+' : ''}${t.delta_pct.toFixed(2)}%`,
        reliability: 'hard_fact',
        direction: t.direction,
        as_of: t.window.split('→').pop().trim(),
        source: '东方财富·两融',
        meta: { delta: t.delta, delta_pct: t.delta_pct },
      }));
    }
  }
  if (wanted.has('holder')) {
    const hd = await api.fetchHolderCount(code, 6);
    extras.holder = hd;
    if (!hd.available) errors.holder = hd.error || '股东户数不可用';
    else if (hd.trend) {
      const t = hd.trend;
      items.push(new Evidence({
        category: 'holder',
        title: `股东户数 ${t.end_date}：${Math.round(t.holders).toLocaleString('en-US')} 户`
          + `（${t.change_pct >= 0 ? '+' : ''}${t.change_pct.toFixed(2)}%）`,
        reliability: 'hard_fact',
        direction: t.direction,
        as_of: t.end_date,
        source: '东方财富·股东户数',
        summary: t.note || '',
        meta: { holders: t.holders, change_pct: t.change_pct },
      }));
    }
  }
  if (wanted.has('feed')) {
    items.push(...await api.fetchFeed(30, name));
  }

  items.sort((a, b) => {
    const da = a.as_of || '';
    const db = b.as_of || '';
    if (da !== db) return da < db ? 1 : -1;
    const ia = RELIABILITY_ORDER.indexOf(a.reliability);
    const ib = RELIABILITY_ORDER.indexOf(b.reliability);
    return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib);
  });
  return {
    code, name, items, extras, errors,
  };
}
