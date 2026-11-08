/**
 * 投资舆情分析：七类证据归集 + 背离提示。上游 `astock_sentiment.py` 的 Node 移植。
 * 不产生 0-100 情绪分。
 */

import { money } from './format.js';
import { RELIABILITY_LABELS, RELIABILITY_ORDER } from './sentiment-data.js';

export const CATEGORY_ORDER = ['announce', 'report', 'news', 'hot', 'lhb', 'margin', 'holder', 'feed'];

export const CATEGORY_LABELS = {
  announce: '公司公告',
  report: '机构研报',
  news: '相关新闻',
  hot: '市场热度',
  lhb: '龙虎榜',
  margin: '融资融券',
  holder: '股东户数',
  feed: '行业快讯',
};

const CATEGORY_WEIGHT = {
  announce: 3, lhb: 3, margin: 3, holder: 2,
  report: 2, news: 1, hot: 1, feed: 1,
};

const ANCHOR_CATEGORIES = ['lhb', 'margin', 'holder'];
export const STALE_DAYS = 30;
export const THIN_EVIDENCE_MIN = 2;

export class CategorySignal {
  constructor(data = {}) {
    Object.assign(this, {
      category: '',
      count: 0,
      positive: 0,
      negative: 0,
      neutral: 0,
      unknown: 0,
      latest_as_of: '',
      reliability: 'media',
      headlines: [],
      meta: {},
    }, data);
  }

  get net() {
    return this.positive - this.negative;
  }

  get direction() {
    const judged = this.positive + this.negative + this.neutral;
    if (judged === 0) return 'unknown';
    if (this.unknown > judged) return 'unknown';
    if (this.net > 0) return 'positive';
    if (this.net < 0) return 'negative';
    return 'neutral';
  }

  asDict() {
    const out = {
      category: this.category,
      label: CATEGORY_LABELS[this.category] || this.category,
      count: this.count,
      positive: this.positive,
      negative: this.negative,
      neutral: this.neutral,
      unknown_direction: this.unknown,
      net_direction: this.direction,
      reliability: this.reliability,
      reliability_label: RELIABILITY_LABELS[this.reliability] || this.reliability,
    };
    if (this.latest_as_of) out.latest_as_of = this.latest_as_of;
    if (this.headlines.length) out.headlines = this.headlines.slice(0, 3);
    if (Object.keys(this.meta).length) out.meta = this.meta;
    return out;
  }
}

export class Conflict {
  constructor(data = {}) {
    Object.assign(this, {
      kind: '', severity: 'low', title: '', detail: '', involved: [], advice: '',
    }, data);
  }

  asDict() {
    const out = {
      kind: this.kind,
      severity: this.severity,
      title: this.title,
      detail: this.detail,
      involved: this.involved,
    };
    if (this.advice) out.advice = this.advice;
    return out;
  }
}

export class SentimentReport {
  constructor(data = {}) {
    Object.assign(this, {
      code: '',
      name: '',
      as_of: '',
      tone: 'thin',
      tone_text: '',
      categories: [],
      conflicts: [],
      stale_items: [],
      errors: {},
      evidence_count: 0,
      weight_score: 0,
    }, data);
  }

  asDict() {
    return {
      code: this.code,
      name: this.name,
      as_of: this.as_of,
      tone: this.tone,
      tone_text: this.tone_text,
      evidence_count: this.evidence_count,
      categories: this.categories.map((c) => c.asDict()),
      conflicts: this.conflicts.map((c) => c.asDict()),
      stale_items: this.stale_items,
      data_issues: this.errors,
      weight_score: this.weight_score,
      note: 'weight_score 是证据强度（方向×类别权重之和），'
        + '只用于同类标的横向排序，不是涨跌预测，也不是情绪评分',
    };
  }
}

function parseDate(text) {
  const t = String(text || '').trim().slice(0, 10);
  if (t.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  const d = new Date(`${t}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function todayIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 证据 → 归类信号 + 背离提示 + 数据质量说明。 */
export function summarize(items, code, name = '', errors = {}, extras = {}) {
  const today = new Date(`${todayIso()}T00:00:00Z`);
  const byCat = {};
  const stale = [];
  for (const evidence of items) {
    const d = parseDate(evidence.as_of);
    const expired = Boolean(d) && ['news', 'feed', 'hot', 'lhb'].includes(evidence.category)
      && (today - d) / 86400000 > STALE_DAYS;
    if (expired) {
      stale.push(`${CATEGORY_LABELS[evidence.category] || evidence.category}：`
        + `${evidence.title.slice(0, 30)}（${evidence.as_of}）`);
      evidence.meta = { ...(evidence.meta || {}), expired: true };
      continue;
    }
    if (!byCat[evidence.category]) byCat[evidence.category] = [];
    byCat[evidence.category].push(evidence);
  }

  const categories = [];
  for (const cat of CATEGORY_ORDER) {
    const group = byCat[cat] || [];
    if (!group.length) continue;
    const sig = new CategorySignal({
      category: cat, count: group.length, reliability: group[0].reliability,
    });
    for (const evidence of group) {
      if (evidence.direction === 'positive') sig.positive += 1;
      else if (evidence.direction === 'negative') sig.negative += 1;
      else if (evidence.direction === 'neutral') sig.neutral += 1;
      else sig.unknown += 1;
    }
    const dates = group.map((e) => e.as_of).filter(Boolean).sort().reverse();
    sig.latest_as_of = dates[0] || '';
    sig.headlines = group.filter((e) => e.title).map((e) => e.title);
    if (cat === 'margin' && extras.margin?.trend) sig.meta.trend = extras.margin.trend;
    if (cat === 'holder' && extras.holder?.trend) sig.meta.trend = extras.holder.trend;
    if (cat === 'hot') {
      const hot = extras.hot || {};
      if (hot.rank) {
        sig.meta.rank = hot.rank.rank;
        sig.meta.heat = hot.rank.heat;
        sig.meta.concepts = hot.rank.concepts || [];
        sig.meta.popularity = hot.rank.popularity || '';
        sig.meta.rank_change = hot.rank.rank_change;
        if (hot.rank.reason) sig.meta.platform_reason = hot.rank.reason;
      } else {
        for (const evidence of group) {
          const em = evidence.meta || {};
          if (em.rank) {
            for (const key of ['rank', 'heat', 'rank_change', 'concepts', 'popularity']) {
              if (em[key] !== undefined && em[key] !== null) sig.meta[key] = em[key];
            }
            break;
          }
        }
      }
    }
    categories.push(sig);
  }

  let weight = 0;
  for (const sig of categories) {
    const w = CATEGORY_WEIGHT[sig.category] || 1;
    if (sig.direction === 'positive') weight += w;
    else if (sig.direction === 'negative') weight -= w;
  }
  const effective = categories.reduce(
    (sum, sig) => sum + sig.positive + sig.negative + sig.neutral, 0,
  );

  const report = new SentimentReport({
    code,
    name,
    as_of: todayIso(),
    categories,
    stale_items: stale.slice(0, 8),
    errors,
    evidence_count: effective,
    weight_score: weight,
  });
  report.conflicts = detectConflicts(categories, extras);
  const [tone, toneText] = judgeTone(categories, report.conflicts, effective, report.stale_items);
  report.tone = tone;
  report.tone_text = toneText;
  return report;
}

function sig(categories, cat) {
  return categories.find((s) => s.category === cat) || null;
}

export function negativeAnchor(categories) {
  for (const cat of ANCHOR_CATEGORIES) {
    const s = sig(categories, cat);
    if (s && s.direction === 'negative') return cat;
  }
  return '';
}

export function detectConflicts(categories, extras = {}) {
  const out = [];
  const report = sig(categories, 'report');
  const margin = sig(categories, 'margin');
  const holder = sig(categories, 'holder');
  const hot = sig(categories, 'hot');
  const lhb = sig(categories, 'lhb');
  const announce = sig(categories, 'announce');
  const news = sig(categories, 'news');

  if (report && margin && report.direction === 'positive' && margin.direction === 'negative') {
    const deltaPct = Math.abs((margin.meta.trend || {}).delta_pct || 0);
    out.push(new Conflict({
      kind: 'report_vs_margin',
      severity: 'high',
      title: '研报偏多，但融资余额在下降',
      detail: `${report.count} 篇研报整体偏正面（${report.headlines.length ? report.headlines[0].slice(0, 40) : ''}…），`
        + `但同期融资余额减少 ${deltaPct.toFixed(2)}%。`
        + '杠杆资金往往比研报更贴近真实交易意愿。',
      involved: ['report', 'margin'],
      advice: '把研报观点当参考、把两融当验证：在融资余额止跌回升前，不宜据研报加仓。',
    }));
  }

  if (hot && hot.meta.rank && hot.meta.rank <= 10 && negativeAnchor(categories)) {
    const anchor = negativeAnchor(categories);
    out.push(new Conflict({
      kind: 'hot_vs_flow',
      severity: 'high',
      title: '人气榜排名靠前，但资金数据偏空',
      detail: `同花顺人气榜第 ${hot.meta.rank} 名（散户关注度极高），`
        + `而${CATEGORY_LABELS[anchor] || anchor}显示偏空。`
        + '高关注度 + 资金流出通常意味着情绪先行、承接不足。',
      involved: ['hot', anchor],
      advice: '热度不等于买盘。若已持有，可考虑在情绪高点减仓而非加仓。',
    }));
  }

  if (announce && announce.direction === 'positive' && news && news.direction === 'negative') {
    out.push(new Conflict({
      kind: 'announce_vs_news',
      severity: 'medium',
      title: '公告事件偏正面，但媒体报道偏负面',
      detail: '公告本身含正面事件词（如增持/中标/预增），但同期媒体标题偏负面——'
        + '常见于利好兑现、或市场对事件有不同解读。',
      involved: ['announce', 'news'],
      advice: '以公告原文为准，别只看标题：确认事件是否已在此前预期之内（利好兑现）。',
    }));
  }

  if (holder && holder.direction === 'negative' && report && report.direction === 'positive') {
    out.push(new Conflict({
      kind: 'holder_vs_report',
      severity: 'medium',
      title: '股东户数上升（筹码分散），但研报看多',
      detail: '散户户数增加通常意味着筹码从集中转向分散，与机构看多观点形成反差。',
      involved: ['holder', 'report'],
      advice: '分散过程中股价更容易震荡；研报观点需要更长周期验证，不适合短线依据。',
    }));
  }

  const lhbDir = lhb ? lhb.direction : null;
  const marginDir = margin ? margin.direction : null;
  if (lhbDir === 'positive' && marginDir === 'negative') {
    out.push(new Conflict({
      kind: 'lhb_vs_margin',
      severity: 'medium',
      title: '龙虎榜净买入，但融资余额下降',
      detail: '短线席位在买、杠杆资金在撤，属于典型的资金结构分歧。',
      involved: ['lhb', 'margin'],
      advice: '这类行情持续性差，参与需更严的止损。',
    }));
  }
  return out;
}

export function judgeTone(categories, conflicts, effective, stale) {
  if (effective < THIN_EVIDENCE_MIN) {
    return ['thin', `有效证据仅 ${effective} 条，不足以形成舆情判断——`
      + '不要据此操作，先看公告原文与行情本身。'];
  }
  if (conflicts.length) {
    const high = conflicts.filter((c) => c.severity === 'high');
    if (high.length) {
      return ['conflicted', `证据背离（${conflicts.length} 处，其中 ${high.length} 处为高优先级）：`
        + '不同来源指向不一致，按「以客观数据为准」处理。'];
    }
    return ['conflicted', `存在 ${conflicts.length} 处证据背离，需分别核实。`];
  }
  const pos = categories.reduce((sum, s) => sum + s.positive, 0);
  const neg = categories.reduce((sum, s) => sum + s.negative, 0);
  if (pos > neg * 2 && pos >= 3) {
    return ['aligned_positive', `各类证据同向偏正面（正面 ${pos} 条 / 负面 ${neg} 条），`
      + '但舆情不改变基本面，仍需结合估值与仓位纪律。'];
  }
  if (neg > pos * 2 && neg >= 3) {
    return ['aligned_negative', `各类证据同向偏负面（负面 ${neg} 条 / 正面 ${pos} 条），`
      + '建议核对是否有公告/新闻解释了下跌原因。'];
  }
  return ['thin', `证据方向不一致或不明显（正面 ${pos} / 负面 ${neg}），暂无一致结论。`];
}

const REL_TAG = {
  hard_fact: '【事实】',
  official_view: '【观点】',
  media: '【媒体】',
  crowd: '【情绪】',
};

const TONE_STYLE = {
  aligned_positive: '🟢 证据同向偏正面',
  aligned_negative: '🔴 证据同向偏负面',
  conflicted: '🟡 证据背离（关键）',
  thin: '⚪ 证据不足',
};

function fnum(value, digits = 2, dash = '-') {
  if (value === null || value === undefined || value === '') return dash;
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const negative = n < 0;
  const fixed = Math.abs(n).toFixed(digits);
  const [ip, dec] = fixed.split('.');
  const withSep = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${withSep}${dec === undefined ? '' : `.${dec}`}`;
}

/** 舆情报告 Markdown。 */
export function render(report, items, extras = {}, maxPerCategory = 3) {
  const out = [];
  out.push(`## 舆情分析：${report.name || report.code}（${report.code}）`, '');
  out.push(`**${TONE_STYLE[report.tone] || report.tone}** — ${report.tone_text}`, '');
  out.push(`> 证据 ${report.evidence_count} 条 · 覆盖 ${report.categories.length} 类 · `
    + `数据基准日 ${report.as_of}。本模块只归集证据与背离，**不预测涨跌、不给评级**。`, '');

  if (report.conflicts.length) {
    out.push('### ⚠️ 信号背离（优先看这里）', '');
    for (const c of report.conflicts) {
      const mark = { high: '🔴', medium: '🟠', low: '🟡' }[c.severity] || '•';
      out.push(`${mark} **${c.title}**`);
      out.push(`   ${c.detail}`);
      if (c.advice) out.push(`   → ${c.advice}`);
      out.push('');
    }
  }

  out.push('### 证据清单（按类别）', '');
  if (!report.categories.length) out.push('未取到任何分类证据。', '');
  for (const cat of CATEGORY_ORDER) {
    const s = report.categories.find((c) => c.category === cat);
    if (!s) continue;
    const label = CATEGORY_LABELS[cat] || cat;
    const rel = RELIABILITY_LABELS[s.reliability] || s.reliability;
    const dirCn = { positive: '偏正面', negative: '偏负面', neutral: '中性', unknown: '方向未判定' }[s.direction] || '未判定';
    const unjudged = s.unknown ? `，${s.unknown} 条未判出方向` : '';
    let head = `**${label}**（${s.count} 条，可靠度：${rel}，整体${dirCn}${unjudged}`;
    if (s.latest_as_of) head += `，最新 ${s.latest_as_of}`;
    out.push(`${head}）`);

    const trend = s.meta.trend;
    if (cat === 'margin' && trend) {
      out.push(`   · 融资余额变化 ${trend.delta_pct >= 0 ? '+' : ''}${trend.delta_pct.toFixed(2)}%`
        + `（${trend.window}）`);
    }
    if (cat === 'holder' && trend) {
      out.push(`   · ${trend.note || ''}，共 ${fnum(trend.holders, 0)} 户`);
    }
    if (cat === 'hot') {
      const m = s.meta;
      if (m.rank) {
        const extra = [];
        if (m.heat) extra.push(`热度 ${fnum(m.heat, 0)}`);
        if (m.rank_change !== null && m.rank_change !== undefined && m.rank_change !== 0) {
          extra.push(`较上次 ${m.rank_change > 0 ? '+' : ''}${Number(m.rank_change)} 名`);
        }
        if (m.popularity) extra.push(String(m.popularity));
        if (m.concepts?.length) extra.push(`概念：${m.concepts.slice(0, 3).join('/')}`);
        out.push(`   · 排名第 ${m.rank}${extra.length ? `（${extra.join('，')}）` : ''}`);
      }
      if (m.platform_reason) out.push(`   · 平台归因：${String(m.platform_reason).slice(0, 100)}…`);
    }

    const picked = items.filter((e) => e.category === cat).slice(0, maxPerCategory);
    for (const e of picked) {
      out.push(`   - ${REL_TAG[e.reliability] || ''}${e.as_of} ${e.title.slice(0, 70)}`);
      const meta = e.meta || {};
      const bits = [];
      if (meta.rating) bits.push(`评级 ${meta.rating}`);
      if (meta.org) bits.push(String(meta.org));
      if (meta.eps_forecast !== null && meta.eps_forecast !== undefined) {
        bits.push(`预测EPS ${fnum(meta.eps_forecast)}`);
      }
      if (meta.pe_forecast !== null && meta.pe_forecast !== undefined) {
        bits.push(`预测PE ${fnum(meta.pe_forecast)}`);
      }
      if (meta.net_amount !== null && meta.net_amount !== undefined) {
        bits.push(`净额 ${money(meta.net_amount)}`);
      }
      if (meta.type) bits.push(String(meta.type));
      if (bits.length) out.push(`     _（${bits.join(' · ')}）_`);
    }
    out.push('');
  }

  if (extras.hot_miss) {
    out.push(`**市场热度**：${extras.hot_miss}`, '');
  }
  const background = extras.news_background || [];
  if (background.length) {
    out.push(`**行业/弱相关背景**（${background.length} 条，未计入舆情方向）`);
    for (const b of background.slice(0, 4)) {
      out.push(`   - ${b.as_of || ''} ${String(b.title || '').slice(0, 60)}`);
    }
    out.push('');
  }

  if (Object.keys(report.errors).length || report.stale_items.length) {
    out.push('### 数据质量说明', '');
    for (const [cat, reason] of Object.entries(report.errors)) {
      out.push(`- \`${CATEGORY_LABELS[cat] || cat}\`：${reason}`);
    }
    if (report.stale_items.length) {
      out.push(`- 超过 30 天的旧闻 ${report.stale_items.length} 条`
        + `（已保留但不作为近期证据）：${report.stale_items[0].slice(0, 50)}…`);
    }
    out.push('');
  }

  out.push('---');
  out.push('**怎么用这份报告**：公告/龙虎榜/两融/股东户数是**客观数据**，'
    + '研报是**卖方观点**，人气温榜是**散户注意力**——权重依次递减。'
    + '出现背离时以客观数据为准。以上仅供参考，不构成投资建议。');
  return out.join('\n');
}

/** 一句话摘要（给面板/盯梢用）。 */
export function renderBrief(report) {
  if (report.tone === 'thin') {
    return `${report.name || report.code}：证据不足（${report.evidence_count} 条），暂无法判断`;
  }
  const parts = report.conflicts.slice(0, 2).map((c) => c.title);
  const head = TONE_STYLE[report.tone] || report.tone;
  if (parts.length) {
    return `${report.name || report.code}：${head} — ${parts.join('；')}`;
  }
  return `${report.name || report.code}：${head}`;
}

export function renderConflictLines(report) {
  return report.conflicts.map((c) => `${c.title}（${c.severity}）`);
}
