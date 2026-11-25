/**
 * 判断留痕（研究档案）——记录、复核、统计。
 *
 * 解决的问题：插件原来只有**成交流水**，没有「我当时怎么判断的」。
 * 于是半年后回看，只剩一个结果（赚了/亏了），却说不清当时凭什么下这个判断、
 * 有没有按计划复核。这一层把「判断」也变成可追溯的资产：
 *
 *   · 记：判断原文 + 依据 + 支持/反对证据 + 当时价格与数据快照；
 *   · 复核：到期用**真实价格**判定兑现与否，判不了就留 pending，不硬凑；
 *   · 统计：过去 N 条判断兑现了几成（按单一标的或全库）。
 *
 * 边界（与项目原则一致）：
 *   · 不存「目标价」「上涨概率」——这些数字没有数学基础；
 *   · 兑现率是**历史判断的命中情况**，不是未来上涨概率，也不构成择时建议；
 *   · 判定用真实收盘/现价，取不到就留空并说明，绝不按「接近」算兑现。
 */

import { f, ratio, table } from './format.js';

export const STANCE_LABEL = {
  bull: '看多', bear: '看空', watch: '只观察',
};

export const OUTCOME_LABEL = {
  pending: '待复核', hit: '兑现', miss: '未兑现', void: '已作废',
};

export const VERIFY_KIND_LABEL = {
  price_below: '跌破',
  price_above: '站上',
};

/**
 * 把「价格」归一成数字：调用方可能传数字（到期价）、也可能传一整个 quote 对象
 * （列表页批量取到的行情）。混着传是这里最容易出的 bug——传对象时 Number()
 * 得到 NaN，判定会静默变成「取不到当前价」。
 */
function toPrice(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return toPrice(value.price);
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 复核条件的文字描述（没有可复算条件时返回空串，不编）。 */
export function verifyRuleText(thesis = {}) {
  const kind = String(thesis.verify_kind || '');
  const price = Number(thesis.verify_price);
  if (!kind || !Number.isFinite(price)) return '';
  return `到期时收盘价${VERIFY_KIND_LABEL[kind] || kind} ${price.toFixed(2)}`;
}

/**
 * 用真实价格判定复核条件是否已满足。
 *
 * @returns {{state: 'met'|'not_met'|null, text: string}}
 *          null 表示没有可复算条件或拿不到价格——交给人工判定，不猜。
 */
export function judgeVerify(thesis = {}, price = null) {
  const kind = String(thesis.verify_kind || '');
  const target = Number(thesis.verify_price);
  const now = toPrice(price);
  if (!kind || !Number.isFinite(target)) {
    return { state: null, text: '没有可复算条件，到期需人工判定' };
  }
  if (now === null) {
    return { state: null, text: '取不到当前价，无法自动判定' };
  }
  const met = kind === 'price_below' ? now < target : now > target;
  return {
    state: met ? 'met' : 'not_met',
    text: `现价 ${now.toFixed(2)} ${met ? '已' : '未'}${VERIFY_KIND_LABEL[kind] || kind} `
      + `${target.toFixed(2)}`,
  };
}

/** 记完一条判断后的确认（把复核日、复核条件、怎么复盘都写清楚）。 */
export function renderRecorded(thesis = {}, { priceNote = '' } = {}) {
  const lines = [
    `## 已记下判断 ${thesis.thesis_id}`,
    '',
    table(['项目', '值'], [
      ['标的', `${thesis.code || '-'} ${thesis.name || ''}`.trim()],
      ['方向', STANCE_LABEL[thesis.stance] || thesis.stance || '-'],
      ['判断', thesis.claim],
      ['依据', thesis.basis || '-'],
      ['记录价', thesis.price_at === null || thesis.price_at === undefined
        ? '-' : f(thesis.price_at)],
      ['复核日', thesis.verify_date || '未设（不提醒复核）'],
      ['复核条件', verifyRuleText(thesis) || '人工判定'],
      ...(thesis.version > 1 ? [['版本', `第 ${thesis.version} 版（上一版 ${thesis.prev_id}）`]] : []),
    ]),
  ];
  if (priceNote) lines.push('', `_${priceNote}_`);
  lines.push(
    '',
    '到期后：`astock_portfolio action=journal_list due=true` 看该复核哪些，'
    + '再用 `action=journal_settle` 写结果。',
    '这条记录没有目标价、没有概率——它只回答「我当时怎么想、后来对了没有」。',
  );
  return lines.join('\n');
}

/** 判断列表（due=true 时补上现价与条件的实时判定）。 */
export function renderList(rows = [], {
  due = false, today = '', prices = {}, truncated = false,
} = {}) {
  if (!rows.length) {
    return due
      ? '没有到期该复核的判断。'
      : '还没有记录过判断。用 `astock_portfolio action=journal_record` 记第一条——'
        + '写清判断、依据和复核日期，到期用真实价格回看。';
  }
  const header = due ? `## 该复核的判断（${rows.length} 条）` : `## 判断档案（${rows.length} 条）`;
  const lines = [header, ''];
  const body = rows.map((row) => {
    const price = prices[String(row.code || '')];
    const verdict = judgeVerify(row, price);
    const cells = [
      row.thesis_id,
      row.code,
      row.name || '',
      STANCE_LABEL[row.stance] || row.stance || '-',
      String(row.claim || '').slice(0, 40),
      row.verify_date || '-',
      verifyRuleText(row) || '-',
      OUTCOME_LABEL[row.outcome] || row.outcome || '-',
    ];
    if (due) cells.push(verdict.text);
    return cells;
  });
  lines.push(table(
    ['id', '代码', '名称', '方向', '判断', '复核日', '复核条件', '结果']
      .concat(due ? ['当前判定'] : []),
    body,
  ));
  if (truncated) lines.push('', '_结果较多，只显示最近若干条；用 code 过滤可看得更细。_');
  if (due && today) lines.push('', `_复核日 ≤ ${today} 且尚未判定的判断。_`);
  lines.push('', '审定：`astock_portfolio action=journal_settle thesis_id=<id> '
    + 'outcome=<hit|miss|void> [price=<到期价>] [note=<说明>]`');
  return lines.join('\n');
}

/** 单条判断的完整档案（含版本演进）。 */
export function renderDetail(thesis = {}, { quotes = {} } = {}) {
  if (!thesis) return '[Error] 没有这条判断';
  const price = quotes[String(thesis.code || '')];
  const verdict = judgeVerify(thesis, price);
  const lines = [
    `## ${thesis.code} ${thesis.name || ''} · 判断 ${thesis.thesis_id}（第 ${thesis.version} 版）`,
    '',
    `**判断**：${thesis.claim}`,
    `**方向**：${STANCE_LABEL[thesis.stance] || thesis.stance || '-'}`,
    `**依据**：${thesis.basis || '-'}`,
    '',
    `**记录价**：${thesis.price_at === null || thesis.price_at === undefined ? '-' : f(thesis.price_at)}`
      + `　**记录时间**：${thesis.created_at || '-'}`,
    `**复核日**：${thesis.verify_date || '未设'}　**复核条件**：${verifyRuleText(thesis) || '人工判定'}`,
  ];
  if (thesis.evidence_for) {
    lines.push('', '**支持证据**', ...String(thesis.evidence_for).split('\n').map((s) => `- ${s}`));
  }
  if (thesis.evidence_against) {
    lines.push('', '**反对证据**', ...String(thesis.evidence_against).split('\n').map((s) => `- ${s}`));
  }
  lines.push('', `**当前判定**：${verdict.text}`);
  lines.push(`**审定结果**：${OUTCOME_LABEL[thesis.outcome] || thesis.outcome || '-'}`
    + `${thesis.outcome_price ? `（到期价 ${f(thesis.outcome_price)}）` : ''}`
    + `${thesis.outcome_note ? ` · ${thesis.outcome_note}` : ''}`);
  if (thesis.snapshot) {
    let snap = null;
    try {
      snap = JSON.parse(thesis.snapshot);
    } catch {
      snap = null;
    }
    if (snap && typeof snap === 'object' && Object.keys(snap).length) {
      lines.push('', '**记录时的数据快照**', ...Object.entries(snap)
        .map(([key, value]) => `- ${key}: ${value === null || value === undefined ? '-' : value}`));
    }
  }
  return lines.join('\n');
}

/** 审定后的回执（把「兑现/未兑现」和对应的价格、说明固定下来）。 */
export function renderSettled(thesis = {}) {
  const label = OUTCOME_LABEL[thesis.outcome] || thesis.outcome;
  const lines = [
    `## 已审定 ${thesis.thesis_id} → ${label}`,
    '',
    `标的 ${thesis.code} ${thesis.name || ''}　判断：${thesis.claim}`,
    `复核条件：${verifyRuleText(thesis) || '人工判定'}`,
    `到期价：${thesis.outcome_price === null || thesis.outcome_price === undefined
      ? '-' : f(thesis.outcome_price)}`
      + `${thesis.outcome_note ? `　说明：${thesis.outcome_note}` : ''}`,
  ];
  if (thesis.outcome === 'void') {
    lines.push('', '作废不计入兑现率——条件变了（比如换了逻辑、标的除权）就不该算对错。');
  }
  lines.push('', '用 `astock_portfolio action=journal_stats` 看累计兑现情况。');
  return lines.join('\n');
}

/** 兑现统计。 */
export function renderStats(stats = {}, { code = '' } = {}) {
  const scope = code ? `${code} 的判断` : '全部判断';
  const lines = [
    `## ${scope}兑现情况`,
    '',
    table(['项目', '数值'], [
      ['已判定', `${stats.settled || 0} 条`],
      ['兑现', `${stats.hit || 0} 条`],
      ['未兑现', `${stats.miss || 0} 条`],
      ['已作废', `${stats.void || 0} 条（不计入）`],
      ['待复核', `${stats.pending || 0} 条`],
      // 兑现率是比例而不是涨跌幅，别用带 + 号的 pct（+0.00% 会被读成「涨了」）
      ['兑现率', stats.hit_rate === null || stats.hit_rate === undefined
        ? '-' : ratio(stats.hit_rate)],
    ]),
  ];
  if (!stats.settled) {
    lines.push('', '还没有已判定的判断——兑现率要等复核之后才有，不预设。');
  } else {
    lines.push(
      '',
      '**这个数字是什么**：过去你记下的判断里，到期条件真的满足的比例。',
      '**这个数字不是什么**：不是未来上涨概率，不是胜率，也不能外推成收益预期。'
      + `样本只有 ${stats.settled} 条，样本越小越说明不了问题。`,
    );
  }
  return lines.join('\n');
}
