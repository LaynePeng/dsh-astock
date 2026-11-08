/**
 * `astock_events` 事件驱动筛股——上游 `plugin.py::_tool_events` 的 JS 移植。
 * 快讯流 → 个股硬事件 → 5 日主力资金印证；不预测、不给概率。
 */

import { fetchMoneyFlow } from './flow.js';
import { compensatedSum } from './formula.js';
import { searchSymbols } from './search.js';
import { fetchFeed } from './sentiment-data.js';

export const EVENT_KINDS = {
  回购: ['回购'],
  增持: ['增持'],
  中标: ['中标', '签约', '订单', '合同'],
  预增: ['预增', '扭亏', '超预期', '净利增长', '业绩增长'],
  重组: ['重组', '并购', '收购', '借壳'],
  获批: ['获批', '批准', '注册证'],
  分红: ['分红', '派息', '特别分红'],
  利空: ['减持', '预亏', '立案', '处罚', '退市', '商誉减值', '解禁'],
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 快讯文本 → 上市公司（搜索接口定位代码）。 */
export async function companyInText(text, options = {}) {
  const search = options.search || searchSymbols;
  let cand = '';
  const m = String(text || '').match(/【([\u4e00-\u9fa5A-Za-z0-9]{2,10})：/);
  if (m) cand = m[1];
  else {
    const m2 = String(text || '').match(
      /^([\u4e00-\u9fa5A-Za-z]{2,8}?(?:股份|集团|科技|生物|制药|电子|光电|能源|银行|证券|控股|电力|健康|环保|新材|咨询))/,
    );
    cand = m2 ? m2[1] : '';
  }
  if (!cand) return null;
  let rows;
  try {
    rows = await search(cand, 3);
  } catch {
    return null;
  }
  for (const row of rows || []) {
    const code = String(row?.code || '');
    if (code.length === 6 && ['0', '3', '6'].includes(code[0])) {
      return { code, name: row?.name || code };
    }
  }
  return null;
}

/**
 * @param {object} args { kind?, limit? }
 * @param {{fetchFeed?: Function, fetchMoneyFlow?: Function, search?: Function,
 *          sleep?: Function}} [options]
 */
export async function runEvents(args = {}, options = {}) {
  const kind = String(args.kind || '').trim();
  const maxN = Math.trunc(Number(args.limit) || 8);
  let feed;
  try {
    feed = await (options.fetchFeed || fetchFeed)(50, '');
  } catch (error) {
    return `[Error] 快讯获取失败：${error?.message ?? error}`;
  }

  const hits = [];
  for (const ev of feed) {
    const text = ev.summary || ev.title || '';
    for (const [kName, kWords] of Object.entries(EVENT_KINDS)) {
      if (kind && kName !== kind) continue;
      if (!kWords.some((word) => text.includes(word))) continue;
      if (kName === '利空' && !kind) continue;
      const company = await companyInText(text, options);
      if (!company) break;
      hits.push({
        kind: kName,
        code: company.code,
        name: company.name,
        text: ev.title || text.slice(0, 80),
        as_of: ev.as_of,
        source: ev.source,
      });
      break;
    }
    if (hits.length >= maxN * 2) break;
  }

  if (!hits.length) {
    const kinds = Object.keys(EVENT_KINDS).join('/');
    return `快讯流里没有匹配的个股硬事件（类型=${kind || '利好类全部'}）。`
      + `宏观/行业消息不关联个股，按设计跳过。可换类型重试：${kinds}`;
  }

  const out = [`**事件驱动候选**（${kind || '利好类'}，快讯流实时）`, '',
    '只列事实与资金印证，不预测涨跌、无概率评分。', ''];
  let shown = 0;
  const flowApi = options.fetchMoneyFlow || fetchMoneyFlow;
  const wait = options.sleep || sleep;
  for (const hit of hits) {
    if (shown >= maxN) break;
    let net5 = null;
    if (shown < 5) {
      try {
        const flows = await flowApi(hit.code, 5);
        net5 = flows?.length
          ? compensatedSum(flows.map((item) => Number(item.main_net || 0)))
          : null;
        await wait(400);
      } catch {
        net5 = null;
      }
    }
    const mark = (net5 || 0) > 0 ? '✅' : (net5 || 0) < 0 ? '⚠️' : '—';
    const flowText = net5 !== null
      ? `5日主力净流入 ${net5 / 1e8 >= 0 ? '+' : ''}${(net5 / 1e8).toFixed(2)} 亿`
      : '资金数据缺失';
    out.push(`- ${mark} **${hit.name}（${hit.code}）**｜${hit.kind}：${hit.text}`);
    out.push(`  ${hit.as_of} · ${hit.source} · ${flowText}`);
    if ((net5 || 0) < 0) out.push('  ⚠️ 消息利好但资金在撤——背离，追高需谨慎');
    shown += 1;
  }
  out.push('', '——事件为媒体报道，资金为结果数据；不构成投资建议。');
  return out.join('\n');
}
