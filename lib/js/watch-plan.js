/**
 * 盯盘计划（DSH 本地版）：DSH `schedule` 没有 probe_config 字段，
 * 所以价位规则/阈值存本地 JSON，并把摘要写进盯盘任务的 prompt。
 * 上游 `astock_plan.py` 的语义在此按 DSH 能力落地。
 */

import fs from 'node:fs';
import path from 'node:path';

import { normalizeCode } from './market.js';

export const DEFAULT_PLAN = {
  rules: [],
  codes: '',
  kinds: '',
  min_level: 'action',
  once_per_day: true,
};

const THRESHOLD_KEYS = [
  'stop_loss_pct', 'take_profit_pct', 'trailing_pct',
  'drop_alert_pct', 'rise_alert_pct', 'volume_ratio_alert',
];

const THRESHOLD_LABELS = {
  stop_loss_pct: '止损线',
  take_profit_pct: '止盈线',
  trailing_pct: '移动止盈回撤',
  drop_alert_pct: '当日跌幅异动',
  rise_alert_pct: '当日涨幅异动',
  volume_ratio_alert: '放量阈值',
};

const OPS = {
  lt: '跌破',
  le: '触及',
  gt: '站上',
  ge: '站上',
};

const SEVERITIES = ['info', 'action', 'urgent'];

export function defaultPlanPath(ledgerPath) {
  return path.join(path.dirname(String(ledgerPath || '')), 'watch-plan.json');
}

export function loadPlan(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      ...DEFAULT_PLAN,
      ...raw,
      rules: Array.isArray(raw.rules) ? raw.rules : [],
    };
  } catch {
    return { ...DEFAULT_PLAN, rules: [] };
  }
}

export function savePlan(file, plan) {
  fs.mkdirSync(path.dirname(file) || '.', { recursive: true });
  fs.writeFileSync(file, JSON.stringify(plan, null, 2), 'utf8');
}

export function parseRules(raw) {
  const out = [];
  const errors = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') {
      errors.push('规则必须是对象');
      continue;
    }
    let code = '';
    try {
      code = normalizeCode(String(item.code || '')).code;
    } catch {
      errors.push(`代码无效：${item.code}`);
      continue;
    }
    const price = Number(item.price);
    if (!Number.isFinite(price) || price <= 0) {
      errors.push(`${code}：price 必须大于 0`);
      continue;
    }
    const op = String(item.op || 'le').toLowerCase();
    if (!OPS[op]) {
      errors.push(`${code}：op 只能是 lt/le/gt/ge`);
      continue;
    }
    const severity = String(item.severity || 'action').toLowerCase();
    if (!SEVERITIES.includes(severity)) {
      errors.push(`${code}：severity 只能是 info/action/urgent`);
      continue;
    }
    out.push({
      code,
      name: String(item.name || ''),
      kind: String(item.kind || 'price'),
      price: Math.round(price * 100) / 100,
      op,
      label: String(item.label || ''),
      severity,
      ...(item.vol_ratio_gt !== undefined && item.vol_ratio_gt !== null
        ? { vol_ratio_gt: Number(item.vol_ratio_gt) } : {}),
      ...(item.vol_ratio_lt !== undefined && item.vol_ratio_lt !== null
        ? { vol_ratio_lt: Number(item.vol_ratio_lt) } : {}),
    });
  }
  return [out, errors];
}

export function describeRules(plan, limit = 50) {
  const rules = plan.rules || [];
  if (!rules.length) return [];
  const lines = ['| 代码 | 名称 | 方向 | 价位 | 级别 |', '|---|---|---|---|---|'];
  for (const r of rules.slice(0, limit)) {
    lines.push(`| ${r.code} | ${r.name || '-'} | ${OPS[r.op] || r.op} | `
      + `${Number(r.price).toFixed(2)} | ${r.severity} |`);
  }
  return lines;
}

export function summarizePlan(plan) {
  const parts = [];
  if (plan.codes) parts.push(`额外代码 ${plan.codes}`);
  if (plan.kinds) parts.push(`信号 ${plan.kinds}`);
  if (plan.min_level) parts.push(`级别 ${plan.min_level}`);
  if (plan.rules?.length) parts.push(`价位规则 ${plan.rules.length} 条`);
  return parts.join('；');
}

export function planView(plan, { interval = 300 } = {}) {
  const lines = ['## 盯盘规则（当前实际生效）', ''];
  lines.push(`- 计划 id：\`local:watch-plan\``);
  lines.push(`- 探测间隔：${interval} 秒`);
  lines.push(`- 覆盖代码：${plan.codes || '（默认：台账持仓 + 自选股）'}`);
  lines.push(`- 信号类型：${plan.kinds || '（默认：通用 9 类全开）'}`);
  lines.push(`- 报告级别：${plan.min_level || 'action'}`);
  const once = plan.once_per_day === undefined ? true : Boolean(plan.once_per_day);
  lines.push(`- 当天去重：${once ? '开' : '关'}`, '');

  lines.push('### 阈值（计划覆盖 > 设置页 > 默认）', '');
  const thresholds = THRESHOLD_KEYS.filter((k) => plan[k] !== undefined && plan[k] !== null);
  if (!thresholds.length) lines.push('（计划里没有覆盖任何阈值，全部走设置页/默认）');
  else {
    lines.push('| 阈值 | 计划值 |', '|---|---|');
    for (const key of thresholds) {
      lines.push(`| ${THRESHOLD_LABELS[key] || key} | ${plan[key]} |`);
    }
  }
  lines.push('');

  const rules = describeRules(plan);
  if (rules.length) {
    lines.push(`### 价位规则（${plan.rules.length} 条）`, '', ...rules);
  } else {
    lines.push('### 价位规则', '', '（没有配置精确价位规则，只按百分比阈值盯）');
  }
  lines.push('', '### 原始配置', '```json', JSON.stringify(plan, null, 2), '```', '');
  lines.push('改动：`astock_watch action=set_rules`（rules 整体替换 / '
    + 'add_rules 追加 / remove_rules 删除指定代码；同代码 remove + add ＝替换）。');
  return lines.join('\n');
}

/** `action=set_rules` 的写入逻辑。 */
export function applyRules(current, args) {
  const replace = args.rules;
  const add = Array.isArray(args.add_rules) ? args.add_rules : [];
  const remove = (Array.isArray(args.remove_rules) ? args.remove_rules : [])
    .map((c) => String(c).trim()).filter(Boolean);
  const thrExtra = {};
  const thrSet = [];
  for (const key of THRESHOLD_KEYS) {
    if (args[key] === undefined || args[key] === null || args[key] === '') continue;
    const n = Number(args[key]);
    if (Number.isFinite(n)) {
      thrExtra[key] = n;
      thrSet.push(THRESHOLD_LABELS[key] || key);
    }
  }
  const clearing = Array.isArray(replace) && replace.length === 0;
  if (replace === undefined && !add.length && !remove.length
    && !Object.keys(thrExtra).length) {
    return {
      error: '[Error] 需要 rules（整体替换）/ add_rules（追加）/ '
        + 'remove_rules（按代码删除）三者之一，或至少一个阈值键（如 stop_loss_pct）',
    };
  }

  const plan = { ...current, rules: [...(current.rules || [])] };
  const replaced = [];
  if (Array.isArray(replace)) {
    const [newRules, errs] = parseRules(replace);
    if (errs.length) return { error: ruleError(errs) };
    plan.rules = newRules;
  } else {
    const drop = new Set(remove);
    const had = new Set(plan.rules.map((r) => r.code));
    if (drop.size) plan.rules = plan.rules.filter((r) => !drop.has(r.code));
    if (add.length) {
      const [addOk, errs] = parseRules(add);
      if (errs.length) return { error: ruleError(errs) };
      plan.rules.push(...addOk);
      const added = new Set(addOk.map((r) => r.code));
      replaced.push(...[...added].filter((c) => drop.has(c) && had.has(c)).sort());
    }
  }

  for (const key of ['codes', 'kinds', 'min_level', 'once_per_day']) {
    if (args[key] !== undefined && args[key] !== null && args[key] !== '') {
      plan[key] = args[key];
    }
  }
  Object.assign(plan, thrExtra);
  if (!plan.rules.length && !thrSet.length && !clearing
    && !['codes', 'kinds', 'min_level', 'once_per_day'].some(
      (k) => args[k] !== undefined && args[k] !== null && args[k] !== '',
    )) {
    return { error: '[Error] 规则为空且没有其它配置项，未做任何修改' };
  }
  return {
    plan, clearing, replaced, thrSet,
    replaceGiven: Array.isArray(replace),
    addGiven: add.length > 0,
    removeGiven: remove.length > 0,
  };
}

function ruleError(errors) {
  return '[Error] 规则有误，未写入：\n'
    + errors.slice(0, 8).map((e) => `- ${e}`).join('\n')
    + '\n\n每条至少要有 code 与 price；op ∈ lt/le/gt/ge；'
    + 'severity ∈ info/action/urgent';
}

export function renderSetRules(result, { enabled = true, message = '' } = {}) {
  const {
    plan, clearing, replaced, thrSet, replaceGiven, addGiven, removeGiven,
  } = result;
  let head = '✅ 已写入盯盘规则';
  if (clearing) head = '✅ 已清空价位规则（改为只按百分比阈值盯）';
  else if (replaced.length) head = '✅ 已替换盯盘规则';
  const lines = [`${head}（共 ${plan.rules.length} 条）`, ''];
  if (replaced.length && !clearing) {
    lines.push(`🔁 ${replaced.join('、')} 是**替换**：该代码的旧规则已删除，`
      + '现在生效的是本次 add_rules 里的新规则。', '');
    lines.push('> 核对请用 `action=plan` 回读完整规则。', '');
  }
  if (replaceGiven && (addGiven || removeGiven)) {
    const skipped = [addGiven ? 'add_rules' : '', removeGiven ? 'remove_rules' : '']
      .filter(Boolean).join('、');
    lines.push(`⚠️ 本次同时给了 \`rules\`，已按**整体替换**处理，`
      + `${skipped} **未生效**（两者互斥，只能选一种写法）。`, '');
  }
  if (thrSet.length) {
    lines.push(`🔧 阈值已写入计划（计划值优先于设置页）：${thrSet.join('、')}`, '');
  }
  const summary = summarizePlan(plan);
  if (summary) lines.push(`**概览**：${summary}`, '');
  const rules = describeRules(plan);
  if (rules.length) lines.push(...rules, '');
  if (!enabled) {
    lines.push('⚠️ 插件盯盘开关是**关闭**的：规则已保存，但探针不会跑。'
      + '说「启动盯盘」（`action=start`）才会生效。', '');
  }
  if (message) lines.push(`（${message}）`);
  return lines.join('\n');
}
