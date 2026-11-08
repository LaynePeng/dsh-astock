/**
 * 主营构成（分部收入占比）+ 选股方法论门槛②判定。
 * 上游 `astock_business.py` 的 Node 移植。
 */

import { fetchJson } from './http.js';
import { fetchQuotes } from './kline.js';
import { normalizeCode } from './market.js';

const URL_TMPL = 'https://emweb.securities.eastmoney.com/PC_HSF10/BusinessAnalysis/'
  + 'PageAjax?code={prefix}{code}';

export const THRESHOLD_PCT = 5.0;
export const PASS = 'pass';
export const BELOW = 'below';
export const ABSENT = 'absent';
export const NA = 'na';
export const UNKNOWN = 'unknown';

const CAPITAL_EVENT_WORDS = [
  '回购', '增持', '分红', '派息', '红利', '股权激励', '注销', '质押',
  '股东会', '股东大会', '章程', '注册资本',
  '重组', '划转', '权益变动', '要约收购', '实际控制人', '控股股东变更',
  '间接持有', '股权转让', '资产注入', '借壳', '合并', '分立',
  '定增', '向特定对象发行', '保荐', '上市辅导', '可转债', '可转换公司债',
  '配股', '非公开发行', '招股说明书', 'IPO',
];

const SYNONYMS = {
  机器人: ['机器人', '减速器', '谐波', 'RV', '精密传动', '智能装备'],
  人形机器人: ['机器人', '减速器', '谐波', '精密传动'],
  算力: ['算力', 'IDC', '数据中心', '服务器', '云计算'],
  人工智能: ['人工智能', '算力', 'AI'],
  光伏: ['光伏', '硅片', '电池片', '组件', '逆变器'],
  储能: ['储能', '电池'],
  锂电: ['锂离子电池', '动力电池', '电池', '正极', '负极', '隔膜'],
  半导体: ['半导体', '芯片', '集成电路', '晶圆', '封装'],
  军工: ['军工', '国防', '航空航天', '兵器'],
  汽车: ['汽车', '整车', '零部件', '汽零'],
  医药: ['医药', '药品', '制剂', '原料药', '医疗器械'],
  白酒: ['白酒', '酒类', '酒'],
  黄金: ['黄金', '贵金属', '矿产金'],
  稀土: ['稀土', '永磁', '磁材'],
  电池: ['电池', '锂离子', '动力电池', '储能电池'],
  锡: ['锡锭', '锡材', '锡产品', '锡'],
  铜: ['铜产品', '铜', '阴极铜'],
  铝: ['铝', '电解铝', '铝锭', '铝材'],
  锌: ['锌产品', '锌', '锌锭'],
  镍: ['镍', '镍产品'],
  钴: ['钴', '钴产品'],
  光学: ['光学', '镜片', '镜头', '光学元件'],
  激光: ['激光', '光子'],
  显示: ['显示', '面板', '液晶', 'OLED'],
  消费电子: ['消费电子', '智能终端', '精密组件'],
  连接器: ['连接器', '线缆', '互连'],
  创新药: ['创新药', '药品', '制剂', '生物药'],
  医疗器械: ['医疗器械', '器械', '耗材'],
  原料药: ['原料药', '中间体', 'api'],
};

const NOISE_ITEMS = ['其他', '其它', '合计', '抵销', '分部间'];

export class Segment {
  constructor(data = {}) {
    Object.assign(this, {
      item: '', ratio_pct: 0, income: null, gross_pct: null, rank: null,
    }, data);
  }

  toDict() {
    return {
      item: this.item,
      ratio_pct: this.ratio_pct,
      income: this.income,
      gross_pct: this.gross_pct,
      rank: this.rank,
    };
  }
}

export class BusinessMix {
  constructor(data = {}) {
    Object.assign(this, {
      code: '', name: '', report_date: '', by_product: [], by_industry: [], scope: '',
    }, data);
  }

  get items() {
    return this.by_product.length ? this.by_product : this.by_industry;
  }

  top(n = 5) {
    return [...this.items].sort((a, b) => b.ratio_pct - a.ratio_pct).slice(0, n);
  }
}

export class Threshold2Result {
  constructor(data = {}) {
    Object.assign(this, {
      code: '',
      result: UNKNOWN,
      ratio_pct: null,
      matched: '',
      keywords: [],
      report_date: '',
      reason: '',
      candidates: [],
    }, data);
  }

  get passed() {
    if (this.result === PASS) return true;
    if (this.result === BELOW || this.result === ABSENT) return false;
    return null;
  }

  get verdict() {
    return {
      [PASS]: 'PASS 过',
      [BELOW]: 'FAIL 不过（占比不足）',
      [ABSENT]: 'FAIL 不过（无此业务）',
      [NA]: 'NA 不适用',
      [UNKNOWN]: 'WARN 未核实',
    }[this.result] || 'WARN 未核实';
  }
}

function prefix(venue) {
  return { sh: 'SH', sz: 'SZ', bj: 'BJ' }[String(venue).toLowerCase()] || 'SZ';
}

function numOrNull(raw) {
  if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function segments(rows, mainopType) {
  const out = [];
  for (const row of rows || []) {
    if (String(row?.MAINOP_TYPE || '') !== mainopType) continue;
    const item = String(row?.ITEM_NAME || '').trim();
    const ratio = numOrNull(row?.MBI_RATIO);
    if (!item || ratio === null) continue;
    const gross = numOrNull(row?.GROSS_RPOFIT_RATIO);
    const rank = numOrNull(row?.RANK);
    out.push(new Segment({
      item,
      ratio_pct: Math.round(ratio * 100 * 1e4) / 1e4,
      income: numOrNull(row?.MAIN_BUSINESS_INCOME),
      gross_pct: gross === null ? null : Math.round(gross * 100 * 100) / 100,
      rank: rank === null ? null : Math.trunc(rank),
    }));
  }
  return out;
}

/** 取一家公司最新报告期的主营构成。取不到抛错（不能当成"通过"）。 */
export async function fetchMix(rawCode, name = '') {
  const { code, venue } = normalizeCode(rawCode);
  const url = URL_TMPL.replace('{prefix}', prefix(venue)).replace('{code}', code);
  const raw = await fetchJson(url, {
    headers: {
      referer: 'https://emweb.securities.eastmoney.com/',
      connection: 'close',
      accept: '*/*',
    },
    timeoutMs: 15_000,
  });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('主营构成接口返回结构异常（非对象）');
  }
  if (raw.status === -1) {
    throw new Error(`主营构成接口不支持 ${code}（${raw.message || '代码不合法'}）`
      + '——北交所与 ETF 无分部披露，门槛② 无法据此核实');
  }
  const rows = raw.zygcfx || [];
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error('主营构成为空（该公司可能未披露分部数据）');
  }
  const dates = rows.map((row) => String(row?.REPORT_DATE || '').slice(0, 10));
  const latest = dates.filter(Boolean).sort().pop() || '';
  const rowsAt = rows.filter((row) => String(row?.REPORT_DATE || '').slice(0, 10) === latest);
  let scope = '';
  for (const item of raw.zyfw || []) {
    if (item && typeof item === 'object' && item.BUSINESS_SCOPE) {
      scope = String(item.BUSINESS_SCOPE);
      break;
    }
  }
  return new BusinessMix({
    code,
    name,
    report_date: latest,
    by_product: segments(rowsAt, '2'),
    by_industry: segments(rowsAt, '1'),
    scope,
  });
}

/** 从事件文本里提取业务关键词（只做显式同义词桥接）。 */
export function keywordsFrom(text) {
  const hits = [];
  for (const [key, alts] of Object.entries(SYNONYMS)) {
    if (String(text || '').includes(key)) {
      for (const alt of alts) if (!hits.includes(alt)) hits.push(alt);
    }
  }
  return hits;
}

function isNoise(item) {
  return NOISE_ITEMS.some((noise) => item.includes(noise));
}

/** 判定门槛②。 */
export function judge(mix, eventText = '', keywords = []) {
  const res = new Threshold2Result({
    code: mix.code,
    report_date: mix.report_date,
    candidates: mix.top(8),
  });
  const text = String(eventText || '');
  let clean = text;
  if (mix.name && mix.name.length >= 2) clean = clean.split(mix.name).join(' ');
  let kws = keywords.length ? [...keywords] : keywordsFrom(clean);
  if (keywords.length) kws = [...keywords];
  res.keywords = kws;

  const capitalHit = CAPITAL_EVENT_WORDS.filter((word) => text.includes(word));
  if (!kws.length && capitalHit.length) {
    res.result = NA;
    res.reason = `事件属资本运作（${capitalHit.slice(0, 3).join('/')}），`
      + '不涉及某块业务收入占比——门槛② 不适用，'
      + '应以资金（门槛③）与止损（门槛④）为准';
    return res;
  }
  if (!kws.length) {
    res.result = UNKNOWN;
    res.reason = '未能从事件文本中提取出业务关键词，无法定位对应分部。'
      + '请补充关键词（如 event_text 写明「机器人业务」）或人工核对';
    return res;
  }
  const items = mix.items;
  if (!items.length) {
    res.result = UNKNOWN;
    res.reason = '该公司未披露分部构成，门槛② 无法核实';
    return res;
  }

  let hits = [];
  for (const kw of kws) {
    if (!kw) continue;
    const cand = items.filter((seg) => !isNoise(seg.item)
      && !seg.item.startsWith('其中') && seg.item.includes(kw));
    if (cand.length) {
      hits = cand;
      break;
    }
  }

  if (!hits.length) {
    const inScope = kws.filter((kw) => kw && mix.scope.includes(kw));
    res.result = ABSENT;
    const top = mix.top(3).map((seg) => `${seg.item} ${seg.ratio_pct.toFixed(1)}%`).join('、');
    if (inScope.length) {
      res.reason = `分部表中无「${inScope.join('/')}」相关项，但经营范围含该业务——`
        + `说明其收入低于分部披露门槛（远<${THRESHOLD_PCT.toFixed(0)}%）。`
        + `现有分部：${top}`;
    } else {
      res.reason = `分部表与经营范围中均无「${kws.slice(0, 3).join('/')}」相关业务。`
        + `现有分部：${top}`;
    }
    return res;
  }

  const best = hits.reduce((a, b) => (b.ratio_pct > a.ratio_pct ? b : a));
  res.ratio_pct = best.ratio_pct;
  res.matched = best.item;
  if (best.ratio_pct >= THRESHOLD_PCT) {
    res.result = PASS;
    res.reason = `「${best.item}」占营收 ${best.ratio_pct.toFixed(2)}% >= ${THRESHOLD_PCT.toFixed(0)}%，`
      + `该业务变好会进报表（报告期 ${mix.report_date}）`;
  } else {
    res.result = BELOW;
    res.reason = `「${best.item}」占营收仅 ${best.ratio_pct.toFixed(2)}% < ${THRESHOLD_PCT.toFixed(0)}%，`
      + `即使翻倍对报表影响也在四舍五入范围（报告期 ${mix.report_date}）`;
  }
  return res;
}

/** 一站式：取分部构成 + 判定；取数失败收敛成 unknown。 */
export async function check(code, eventText = '', name = '', keywords = [], options = {}) {
  try {
    const mix = await (options.fetchMix || fetchMix)(code, name);
    return judge(mix, eventText, keywords);
  } catch (error) {
    return new Threshold2Result({
      code,
      result: UNKNOWN,
      reason: `主营构成取数失败：${error?.name || 'Error'}: ${error?.message ?? error}`,
    });
  }
}

const NOTES = {
  [PASS]: '占比达标，该业务变好会进报表。',
  [BELOW]: '有这块业务但占比不足 5%，即使翻倍对报表影响也在四舍五入范围。',
  [ABSENT]: '**分部表里没有这块业务**——分部披露有重要性门槛，'
    + '进不了表意味着占比远低于 5%。这是**否定证据**，不是数据缺失。',
  [NA]: '事件属资本运作（回购/增持/分红），不涉及某块业务收入占比。'
    + '**门槛② 不适用**，不能据此否决——应以门槛③资金、门槛④止损为准。',
  [UNKNOWN]: '数据取不到（北交所/ETF/接口异常）。'
    + '**这不等于通过**，只是一条未核实的门槛。',
};

async function resolveName(code, fetchQ) {
  try {
    const quotes = await (fetchQ || fetchQuotes)([code], 'stock');
    return quotes[0]?.name || '';
  } catch {
    return '';
  }
}

/** `astock_business` 工具输出。 */
export async function runBusiness(args = {}, options = {}) {
  const eventText = String(args.event || '').trim();
  let keywords = args.keywords || [];
  if (typeof keywords === 'string') {
    keywords = keywords.replace(/，/g, ',').split(',').map((s) => s.trim()).filter(Boolean);
  }
  let codesRaw = args.codes || [];
  if (typeof codesRaw === 'string') {
    codesRaw = codesRaw.replace(/，/g, ',').split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (codesRaw.length) {
    return businessBatch(codesRaw, eventText, keywords, options);
  }
  const codeRaw = String(args.code || '').trim();
  if (!codeRaw) {
    return '[Error] 需要 code（如 002273）或 codes 数组。这是按标的查分部收入构成的工具，'
      + '用于判定选股方法论第②道门槛「相关业务收入占营收 ≥5%」。'
      + '单只传 code，批量核持仓/候选池传 codes。';
  }
  const { code } = normalizeCode(codeRaw);
  const name = await resolveName(code, options.fetchQuotes);
  const res = await check(code, eventText, name, keywords, options);
  const lines = [`## 主营构成 · 门槛②判定：${name || code}（${code}）`, ''];
  lines.push(`**结论：${res.verdict}**`, '');
  if (res.reason) lines.push(`> ${res.reason}`, '');
  if (res.report_date) {
    lines.push(`报告期：**${res.report_date}**（分部数据按中报/年报披露，不是实时）`, '');
  }
  if (res.candidates.length) {
    lines.push('| 分部 | 收入占比 | 毛利率 |', '|---|---|---|');
    for (const seg of res.candidates.slice(0, 8)) {
      const gross = seg.gross_pct === null ? '-' : `${seg.gross_pct.toFixed(1)}%`;
      lines.push(`| ${seg.item} | **${seg.ratio_pct.toFixed(2)}%** | ${gross} |`);
    }
    lines.push('');
  }
  const note = NOTES[res.result];
  if (note) lines.push(`**怎么读这个结论**：${note}`, '');
  if (res.keywords.length) lines.push(`匹配关键词：${res.keywords.join('、')}`, '');
  lines.push('> 数据源：东财 F10 主营构成。只做数据归集与门槛判定，不构成买入建议。');
  return lines.join('\n');
}

async function businessBatch(codesRaw, eventText, keywords, options) {
  const rows = [];
  const stats = {
    [PASS]: 0, [BELOW]: 0, [ABSENT]: 0, [NA]: 0, [UNKNOWN]: 0,
  };
  let noEvent = 0;
  for (const raw of codesRaw.slice(0, 20)) {
    let code;
    try {
      ({ code } = normalizeCode(raw));
    } catch {
      continue;
    }
    const name = await resolveName(code, options.fetchQuotes);
    const res = await check(code, eventText, name, keywords, options);
    if (res.result === UNKNOWN && !eventText && !keywords.length) {
      const top = res.candidates.slice(0, 3)
        .map((seg) => `${seg.item} ${seg.ratio_pct.toFixed(1)}%`).join('、');
      rows.push(`| ${name || code}（${code}）| ➖ 未指定业务 | ${top || '—'} |`);
      noEvent += 1;
      continue;
    }
    stats[res.result] = (stats[res.result] || 0) + 1;
    const detail = res.ratio_pct !== null
      ? `${res.matched} ${res.ratio_pct.toFixed(1)}%`
      : `${res.reason.slice(0, 34)}${res.reason.length > 34 ? '…' : ''}`;
    rows.push(`| ${name || code}（${code}）| ${res.verdict} | ${detail} |`);
  }
  const total = Object.values(stats).reduce((a, b) => a + b, 0) + noEvent;
  const lines = [`## 门槛②批量体检（${total} 只）`, ''];
  const judged = Object.values(stats).reduce((a, b) => a + b, 0);
  if (judged) {
    lines.push(`**过 ${stats[PASS]} 只 · 不过 ${stats[BELOW] + stats[ABSENT]} 只`
      + ` · 不适用 ${stats[NA]} 只 · 未核实 ${stats[UNKNOWN]} 只**`);
  }
  if (noEvent) {
    lines.push(`**${noEvent} 只未指定业务，只列主营构成**（传 event 或 keywords 才判门槛②）`);
  }
  lines.push('', '| 标的 | 结论 | 命中分部/原因 |', '|---|---|---|', ...rows, '');
  lines.push('> 「不适用」= 事件属回购/增持等资本运作，门槛② 本就不涉及业务占比；'
    + '「未核实」= 数据取不到（北交所/ETF），**不等于通过**。');
  return lines.join('\n');
}
