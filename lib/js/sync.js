/**
 * `astock_sync` 成交回单同步——上游 `astock_mixin_sync.py` 的 Node 移植。
 */

import { compensatedSum } from './formula.js';
import {
  f, table,
} from './format.js';
import { parseReceipt } from './receipt.js';

function todayIso() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function signed(value, digits = 2) {
  const n = Number(value) || 0;
  return `${n >= 0 ? '+' : '-'}${f(Math.abs(n), digits)}`;
}

function g(value) {
  return String(Number(value));
}

/**
 * @param {object} args { text|receipt, dry_run? }
 * @param {{ledger: object, config?: object}} options
 */
export async function runSync(args = {}, options = {}) {
  const text = String(args.text || args.receipt || '').trim();
  if (!text) {
    return '[Error] 需要 text（券商成交回单）。可直接粘贴 App 里的成交明细，'
      + '或传导出的 CSV/TSV 内容。一行一笔也可以。';
  }
  const parsed = parseReceipt(text);
  if (!parsed.trades.length) {
    return '[Error] 没能从这段内容里识别出成交记录。\n'
      + '支持的格式：\n'
      + '· 带表头的 CSV/TSV（粘贴券商导出文件内容）\n'
      + '· 每行一笔：`600000 买入 9.53 2000 2026-10-24`\n'
      + '也可以只用 astock_record 手工录单笔。';
  }
  const dry = args.dry_run === undefined ? true : Boolean(args.dry_run);
  const entries = parsed.usable;
  const ledger = options.ledger;
  if (!ledger) return '[Error] 台账未初始化';
  if (!entries.length) {
    return renderSyncPreview(parsed, [], dry, {
      reason: '所有行都缺少关键字段', ledger,
    });
  }

  const tolerance = Number(options.config?.sync_price_tolerance_pct ?? 2.0);
  const results = [];
  for (const trade of entries) {
    const date = trade.trade_date || todayIso();
    const match = ledger.matchPlan(trade.code, trade.side);
    const item = {
      trade, plan: match, status: 'ok', message: '',
    };
    if (match && match.price) {
      const planPrice = Number(match.price);
      if (planPrice > 0 && trade.price) {
        const dev = ((trade.price - planPrice) / planPrice) * 100;
        item.deviation_pct = Math.round(dev * 100) / 100;
        if (Math.abs(dev) > tolerance) {
          item.status = 'warn';
          item.message = `成交价 ${trade.price.toFixed(2)} 与计划价 `
            + `${planPrice.toFixed(2)} 偏差 ${signed(dev)}%`
            + `（阈值 ±${g(tolerance)}%）`;
        }
        const planShares = Math.trunc(Number(match.shares) || 0);
        if (planShares && trade.shares && trade.shares !== planShares) {
          item.status = 'warn';
          item.message = (item.message ? `${item.message}；` : '')
            + `数量与计划不符（计划 ${planShares} 股，成交 ${trade.shares} 股）`;
        }
      }
    }
    if (!dry) {
      try {
        const rec = ledger.recordTrade(trade.code, trade.side, Number(trade.price || 0),
          Math.trunc(Number(trade.shares || 0)), {
            tradeDate: date,
            name: trade.name || '',
            note: `回单同步(${trade.confidence})`,
            feeOverride: trade.fee,
          });
        item.recorded = rec;
        if (match) {
          ledger.markPlan(match.plan_id, 'filled',
            `回单同步：成交 ${trade.shares} 股 @ ${trade.price}`);
        }
      } catch (error) {
        item.status = 'error';
        item.message = error?.message ?? String(error);
      }
    }
    results.push(item);
  }
  return renderSyncPreview(parsed, results, dry, { ledger });
}

export function renderSyncPreview(parsed, results, dry, { reason = '', ledger = null } = {}) {
  const trades = parsed.trades || [];
  const okN = results.filter((r) => r.status === 'ok').length;
  const warnN = results.filter((r) => r.status === 'warn').length;
  const errN = results.filter((r) => r.status === 'error').length;
  const head = dry ? '**成交回单预览**（未落账）' : '**成交已同步**';
  const lines = [head, ''];
  lines.push(`识别 ${trades.length} 笔`
    + (parsed.method ? `（格式：${parsed.method}）` : '')
    + (parsed.duplicates_removed ? `｜重复去掉 ${parsed.duplicates_removed} 笔` : ''));
  if (reason) lines.push('', `⚠️ ${reason}`);
  lines.push('');

  const rows = results.map((r) => {
    const t = r.trade;
    const plan = r.plan || {};
    const dev = r.deviation_pct;
    return [
      t.code, (t.name || '-').slice(0, 8),
      t.side === 'buy' ? '买入' : '卖出',
      f(t.price), t.shares || '-',
      t.fee ? f(t.fee) : '自动算',
      t.trade_date || '今天',
      plan.plan_id || '无对应计划',
      dev !== undefined && dev !== null ? `${signed(dev)}%` : '-',
      { ok: '✅', warn: '⚠️', error: '❌' }[r.status] || '?',
    ];
  });
  if (rows.length) {
    lines.push(table(
      ['代码', '名称', '方向', '成交价', '数量', '费用', '日期',
        '匹配计划', '校价', '状态'],
      rows,
    ), '');
  }

  const warns = results.filter((r) => r.message);
  if (warns.length) {
    lines.push('**需要你确认**：');
    for (const r of warns) {
      const mark = r.status === 'warn' ? '⚠️' : '❌';
      lines.push(`- ${mark} ${r.trade.code} ${r.trade.name || ''}：${r.message}`);
    }
    lines.push('');
  }

  if (parsed.unparsed?.length) {
    lines.push(`**未能识别（${parsed.unparsed.length} 笔，未计入）**：`);
    for (const raw of parsed.unparsed.slice(0, 8)) {
      lines.push(`- \`${String(raw).slice(0, 80)}\``);
    }
    lines.push('');
  }

  if (dry) {
    if (errN) {
      lines.push('❌ 有解析/校验错误，修正后重试（或改用 astock_record 手工录）。');
    } else {
      lines.push('确认无误后用 `dry_run=false` 重新调用即落账'
        + `（✅${okN} / ⚠️${warnN}）。`);
    }
  } else {
    lines.push(`落账结果：成功 ${okN} 笔`
      + (warnN ? `，警告 ${warnN} 笔` : '')
      + (errN ? `，失败 ${errN} 笔` : '') + '。');
    lines.push('对应计划已标记为已执行；台账成本价与 T+1 可卖已同步更新。');
    const cash = syncCashHint(results, ledger);
    if (cash) lines.push('', cash);
  }
  return lines.join('\n');
}

function syncCashHint(results, ledger) {
  const deltas = [];
  for (const r of results) {
    if (!r.recorded || r.status === 'error') continue;
    const d = r.recorded.cash_delta;
    if (d !== undefined && d !== null) deltas.push(Number(d));
  }
  if (!deltas.length) return '';
  const total = Math.round(compensatedSum(deltas) * 100) / 100;
  let cur;
  try {
    cur = ledger?.getCash();
  } catch {
    return '';
  }
  if (!cur) return '';
  const balance = Number(cur.balance || 0);
  const updated = String(cur.updated_at || '');
  const ref = Math.round((balance + total) * 100) / 100;
  const when = updated ? `上次校准于 ${updated}` : '尚未校准过';
  const tail = deltas.length > 1 ? `（${deltas.length} 笔合计）` : '';
  return [
    `⚠️ 可用资金未自动扣减 —— 本次净资金变动 ${signed(total)} 元${tail}。`,
    `   账面可用资金 ${f(balance)} 元（${when}），`
      + `若此后再无出入金，真实可用应为 ${f(ref)} 元。`,
    '   请核对券商 App 后校准：`astock_portfolio action=set_cash cash=<真实余额>`',
    '   （插件看不到你的银行转账/出入金，所以不会自动改余额。）',
  ].join('\n');
}
