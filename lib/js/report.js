/**
 * 盘后复盘邮件（**零 token**）：本地拼装 + 现有 SMTP 直接发。
 *
 * 为什么单独做：盘后报告原来只有「调模型生成」的定时任务（每轮花 token），
 * 而大多数人收盘后只想知道三件事——今天赚了多少、有没有该处理的信号、
 * 持仓的舆情有没有变化。这三件事都能用**已有数据**拼出来，不需要模型。
 *
 * 数据来源全部复用现成实现（不另算一套口径）：
 *   · 账户与持仓 → `portfolio.snapshot()`（与面板/工具同一份）
 *   · 风险信号   → `hints.buildPositionHints()`（与 astock_hint 同一引擎）
 *   · 舆情       → `sentiment-data.collect()` + `sentiment.summarize()`
 *
 * 发信走 `alerts.deliver()`：basic 用密码、OAuth2 自动换 access_token，
 * 与「高风险提醒」是同一条通道，配一次就都能用。
 */

import { snapshot } from './portfolio.js';
import { hintsConfig, buildPositionHints } from './hints.js';
import { fetchQuotes } from './kline.js';
import { collect } from './sentiment-data.js';
import { summarize, renderBrief } from './sentiment.js';
import { nowCn } from './market.js';
import { deliver, mailConfig, mailReady } from './alerts.js';

function pad(n) {
  return String(n).padStart(2, '0');
}

function cnDate(now) {
  const d = nowCn(now);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function cnWeekday(now) {
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return names[nowCn(now).getUTCDay()] || '';
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function signed(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${money(n)}`;
}

function pct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

/** 上证指数（取不到返回 null，不编数字）。 */
async function indexSnapshot() {
  try {
    const quotes = await fetchQuotes(['000001'], 'index', { useCache: true });
    if (!quotes.length) return null;
    const quote = quotes[0];
    return { name: quote.name || '上证指数', price: quote.price, changePct: quote.change_pct };
  } catch {
    return null;
  }
}

/**
 * 拼一份复盘。
 *
 * @param {object} ledger
 * @param {object} config 运行期配置
 * @param {{now?: Date, sentimentLimit?: number, collectSentiment?: Function}} options
 * @returns {Promise<{ok: boolean, subject: string, text: string, html: string, summary: object}>}
 */
export async function buildReport(ledger, config = {}, {
  now = new Date(),
  sentimentLimit = null,
  collectSentiment = collect,
  snapshot: snapshotFn = snapshot,
  indexQuote: indexFn = indexSnapshot,
} = {}) {
  const snap = await snapshotFn(ledger, { includeWatch: false });
  const data = snap?.data || {};
  const positions = data.positions || [];
  const quotes = data.quotes || {};
  const cfg = hintsConfig(config);
  const totalMv = Number(data.total_market_value || 0);
  const equity = Number(data.equity || 0);

  const signals = [];
  for (const pos of positions) {
    const quote = quotes[String(pos.code || '')] || {};
    try {
      for (const hint of buildPositionHints(pos, quote, cfg, {
        totalMarketValue: totalMv, totalEquity: equity,
      })) {
        if (hint.severity === 'action' || hint.severity === 'urgent') {
          signals.push({ code: hint.code, name: hint.name, title: hint.title, severity: hint.severity });
        }
      }
    } catch {
      // 单票算挂了不影响整份报告
    }
  }

  const index = await indexFn();
  const limit = Math.max(0, Math.trunc(
    sentimentLimit === null ? (Number(config.report_email_top) || 3) : sentimentLimit,
  ));
  // 舆情只挑「有信号」或「市值最大」的前 N 只，避免每只都打几次接口
  const ranked = [...positions].sort((a, b) => (
    (Number(b.cost_price || 0) * Number(b.shares || 0))
    - (Number(a.cost_price || 0) * Number(a.shares || 0))
  ));
  const signalCodes = new Set(signals.map((s) => s.code));
  const targets = [];
  for (const pos of ranked) {
    if (targets.length >= limit) break;
    targets.push(pos);
  }
  for (const pos of ranked) {
    if (targets.length >= limit) break;
    if (signalCodes.has(pos.code) && !targets.includes(pos)) targets.push(pos);
  }

  const briefs = [];
  for (const pos of targets) {
    try {
      const got = await collectSentiment(String(pos.code), String(pos.name || ''), ['announce', 'report', 'news'], 7);
      const report = summarize(got.items || [], got.code || pos.code, got.name || pos.name,
        got.errors || {}, got.extras || {});
      briefs.push(renderBrief(report));
    } catch (error) {
      briefs.push(`${pos.name || pos.code}：舆情取数失败（${String(error?.message ?? error).slice(0, 40)}）`);
    }
  }

  const todayPnl = Number(data.today_pnl || 0);
  const floatPnl = Number(data.float_pnl || 0);
  const todayPct = equity > 0 ? (todayPnl / equity) * 100 : null;
  const dateText = cnDate(now);
  const subject = `[A股助手] 盘后复盘 ${dateText}${signals.length ? `（${signals.length} 条信号）` : ''}`;

  const lines = [
    `A股助手 · 盘后复盘 ${dateText}（${cnWeekday(now)}）`,
    '',
    `总资产 ${money(equity)} 元（今日 ${signed(todayPnl)} / ${pct(todayPct)}）`,
    `持仓市值 ${money(totalMv)} 元 · 可用资金 ${money(data.cash)} 元 · `
      + `浮动盈亏 ${signed(floatPnl)}（${pct(positions.length ? floatPnl / Math.max(1, positions.reduce((s, p) => s + Number(p.cost_price || 0) * Number(p.shares || 0), 0)) * 100 : null)}）`,
    index
      ? `${index.name} ${money(index.price)}（${pct(index.changePct)}）`
      : '沪指数据未取到',
    '',
    `持仓（${positions.length} 只）`,
  ];
  if (!positions.length) {
    lines.push('  （空仓）');
  }
  for (const pos of positions) {
    const quote = quotes[String(pos.code || '')] || {};
    const price = Number(quote.price || pos.cost_price || 0);
    const cost = Number(pos.cost_price || 0);
    const shares = Math.trunc(Number(pos.shares) || 0);
    const pnlPct = cost ? ((price - cost) / cost) * 100 : null;
    const weight = equity > 0 ? (price * shares / equity) * 100 : null;
    lines.push(`  ${pos.code} ${pos.name || ''}  ${shares} 股  现价 ${money(price)}  `
      + `成本 ${money(cost)}  浮盈 ${pct(pnlPct)}  占比 ${weight === null ? '—' : `${weight.toFixed(1)}%`}`);
  }
  lines.push('', `信号（${signals.length} 条）`);
  if (!signals.length) {
    lines.push('  今天没有触发阈值的变化。');
  }
  for (const signal of signals) {
    lines.push(`  ${signal.severity === 'urgent' ? '🔴' : '🟠'} ${signal.code} ${signal.name}：${signal.title}`);
  }
  if (briefs.length) {
    lines.push('', '舆情');
    for (const brief of briefs) lines.push(`  ${brief}`);
  }
  lines.push('', '—— 以上为按既定规则算出的复盘，仅供参考，不构成投资建议。');

  const text = lines.join('\n');
  const rows = positions.map((pos) => {
    const quote = quotes[String(pos.code || '')] || {};
    const price = Number(quote.price || pos.cost_price || 0);
    const cost = Number(pos.cost_price || 0);
    const shares = Math.trunc(Number(pos.shares) || 0);
    const pnlPct = cost ? ((price - cost) / cost) * 100 : null;
    const color = pnlPct !== null && pnlPct < 0 ? '#d93025' : '#0a9e6a';
    return `<tr><td>${pos.code}</td><td>${pos.name || ''}</td><td align="right">${shares}</td>`
      + `<td align="right">${money(price)}</td><td align="right">${money(cost)}</td>`
      + `<td align="right" style="color:${color}">${pct(pnlPct)}</td></tr>`;
  }).join('');

  const html = '<div style="font:14px/1.7 -apple-system,Segoe UI,Roboto,sans-serif;color:#202124;max-width:720px">'
    + `<h3 style="margin:0 0 4px">盘后复盘 ${dateText}</h3>`
    + `<div style="color:#5f6368;font-size:13px;margin-bottom:10px">总资产 ${money(equity)} 元`
    + `（今日 ${signed(todayPnl)} / ${pct(todayPct)}）`
    + (index ? ` · ${index.name} ${money(index.price)}（${pct(index.changePct)}）` : '')
    + '</div>'
    + (positions.length
      ? `<table style="border-collapse:collapse;width:100%;font-size:13px">`
        + '<tr style="color:#5f6368"><th align="left">代码</th><th align="left">名称</th>'
        + '<th align="right">股数</th><th align="right">现价</th><th align="right">成本</th>'
        + `<th align="right">浮盈</th></tr>${rows}</table>`
      : '<div style="color:#5f6368">（空仓）</div>')
    + (signals.length
      ? '<h4 style="margin:16px 0 6px">信号</h4><ul style="margin:0;padding-left:18px">'
        + signals.map((s) => `<li>${s.code} ${s.name}：${s.title}</li>`).join('')
        + '</ul>'
      : '<div style="margin-top:12px;color:#5f6368">今天没有触发阈值的变化。</div>')
    + (briefs.length
      ? '<h4 style="margin:16px 0 6px">舆情</h4><ul style="margin:0;padding-left:18px">'
        + briefs.map((b) => `<li>${b}</li>`).join('') + '</ul>'
      : '')
    + '<div style="margin-top:16px;color:#80868b;font-size:12px">'
    + '以上为按既定规则算出的复盘，仅供参考，不构成投资建议。</div></div>';

  return {
    ok: true,
    subject,
    text,
    html,
    summary: {
      date: dateText,
      equity,
      positions: positions.length,
      signals: signals.length,
      briefs: briefs.length,
    },
  };
}

/**
 * 生成并发送盘后复盘邮件。
 *
 * @returns {Promise<{ok: boolean, message: string, subject?: string, summary?: object}>}
 */
export async function sendReport(ledger, config = {}, options = {}) {
  const cfg = mailConfig(config);
  const ready = mailReady(cfg);
  if (!ready.ready) return { ok: false, message: `邮件未就绪：${ready.reason}` };
  let report;
  try {
    report = await buildReport(ledger, config, options);
  } catch (error) {
    return { ok: false, message: `生成复盘失败：${error?.message ?? error}` };
  }
  const sent = await deliver(cfg, {
    subject: report.subject, text: report.text, html: report.html,
  }, options.send ? { send: options.send } : {});
  return {
    ok: sent.ok,
    message: sent.message,
    subject: report.subject,
    summary: report.summary,
  };
}
