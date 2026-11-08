/**
 * 台账工具：`astock_record`（录入/预览成交）与 `astock_portfolio`（持仓总览）。
 * 与 上游 `astock_mixin_ledger.py` 的文案、校验口径一致。
 */

import { fetchQuotes } from './kline.js';
import {
  boardOf, calcFee, checkOrderSize, feeBreakdownDict, normalizeCode,
  pctChange, roundPrice,
} from './market.js';
import {
  f, money, pct, table,
} from './format.js';

function signed(value, digits = 2) {
  const n = Number(value) || 0;
  const body = f(Math.abs(n), digits);
  return `${n >= 0 ? '+' : '-'}${body}`;
}

function plain(value, digits = 2) {
  return (Number(value) || 0).toFixed(digits);
}

function todayIso() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 录成交后的「可用资金未自动扣减」提示（带可执行的具体金额）。 */
export function cashHintText(ledger, cashDelta) {
  let cur;
  try {
    cur = ledger.getCash();
  } catch {
    return '提示：台账里的可用资金不会自动扣减（出入金不可见），'
      + '请用 astock_portfolio action=set_cash 按券商实际余额校准。';
  }
  const balance = Number(cur.balance || 0);
  const updated = String(cur.updated_at || '');
  const ref = Math.round((balance + Number(cashDelta || 0)) * 100) / 100;
  const when = updated ? `上次校准于 ${updated}` : '尚未校准过';
  return [
    `⚠️ 可用资金未自动扣减 —— 本次资金变动 ${signed(cashDelta)} 元。`,
    `   账面可用资金 ${f(balance)} 元（${when}），`
      + `若此后再无出入金，真实可用应为 ${f(ref)} 元。`,
    '   请核对券商 App 后校准：`astock_portfolio action=set_cash cash=<真实余额>`',
    '   （插件看不到你的银行转账/出入金，所以不会自动改余额。）',
  ].join('\n');
}

function previewTrade(ledger, code, name, side, price, shares, tradeDate, feeOverride) {
  const pos = ledger.listPositions().find((item) => item.code === code);
  const held = pos ? Number(pos.shares) : 0;
  const cost = pos ? Number(pos.cost_price) : 0;
  const available = pos ? Number(pos.available_today) : 0;
  const amount = Math.round(price * shares * 100) / 100;
  const board = boardOf(code);
  const feeBd = calcFee(amount, side, ledger.fee, board);
  const fee = (feeOverride === null || feeOverride === undefined || feeOverride === '')
    ? feeBd.total : Number(feeOverride);

  const problems = [];
  const err = checkOrderSize(shares, code, side, held);
  if (err) problems.push(err);
  if (side === 'sell') {
    if (held <= 0) problems.push(`${code} 当前无持仓，无法录入卖出`);
    else if (shares > available) {
      problems.push(`今日可卖仅 ${available} 股（T+1），本次想卖 ${shares} 股`);
    }
  }
  if (price <= 0) problems.push('成交价必须大于 0');
  if (tradeDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate) || Number.isNaN(Date.parse(`${tradeDate}T00:00:00Z`))) {
      problems.push(`成交日期格式应为 YYYY-MM-DD（收到 ${JSON.stringify(tradeDate)}）`);
    } else if (tradeDate > todayIso()) {
      problems.push('成交日期不能晚于今天');
    }
  }

  let newShares;
  let newCost;
  let cashDelta;
  let realized = null;
  if (side === 'buy') {
    newShares = held + shares;
    newCost = newShares ? Math.round(((cost * held + amount + fee) / newShares) * 1e4) / 1e4 : 0;
    cashDelta = -(amount + fee);
  } else {
    newShares = Math.max(0, held - shares);
    newCost = newShares ? Math.round(cost * 1e4) / 1e4 : 0;
    cashDelta = amount - fee;
    realized = Math.round(((price - cost) * shares - fee) * 100) / 100;
  }

  const lines = [
    `**预览（未落账）**：${side === 'buy' ? '买入' : '卖出'} `
    + `${name || code}(${code}) ${shares} 股 @ ${plain(price)}`,
    '',
    table(['项目', '数值'], [
      ['成交金额', `${f(amount)} 元`],
      ['费用明细', `佣金 ${plain(feeBd.commission)} / 印花税 `
        + `${plain(feeBd.stamp_tax)} / 过户费 ${plain(feeBd.transfer_fee)}`],
      ['费用合计', `${plain(fee)} 元`],
      ['资金变动', `${signed(cashDelta)} 元`],
      ['持仓变化', `${held} → ${newShares} 股`],
      ['成本价变化', held ? `${plain(cost, 4)} → ${plain(newCost, 4)}` : `— → ${plain(newCost, 4)}`],
      ['已实现盈亏', realized !== null ? `${signed(realized)} 元` : '—'],
      ['今日可卖', `${available} 股`],
    ]),
  ];
  if (problems.length) {
    lines.push('', '⚠️ **校验未通过，落账会被拒绝**：', ...problems.map((p) => `- ${p}`));
  } else {
    lines.push('', '✅ 校验通过。确认无误后用 dry_run=false 重新调用即可落账。');
  }
  return { text: lines.join('\n'), problems };
}

function formatRecordResult(result, ledger) {
  const sideCn = result.side === 'buy' ? '买入' : '卖出';
  const lines = [
    `✅ 已录入${sideCn}：${result.name || result.code}(${result.code}) `
    + `${result.shares} 股 @ ${plain(result.price)}（${result.trade_date}）`,
    '',
    table(['项目', '数值'], [
      ['成交金额', `${f(result.amount)} 元`],
      ['费用', `${plain(result.fee)} 元`],
      ['资金变动', `${signed(result.cash_delta)} 元`],
      ['持仓', `${result.shares_after} 股`],
      ['成本价', result.cost_price_before
        ? `${result.cost_price_before} → ${result.cost_price_after}`
        : `${result.cost_price_after}`],
      ['已实现盈亏', result.realized_pnl !== null && result.realized_pnl !== undefined
        ? `${signed(result.realized_pnl)} 元` : '—'],
    ]),
    '',
    cashHintText(ledger, result.cash_delta || 0),
  ];
  return lines.join('\n');
}

/** `astock_record` 工具输出。 */
export async function runRecord(args = {}, options = {}) {
  const side = String(args.side || '').trim().toLowerCase();
  const rawCode = String(args.code || '').trim();
  const priceRaw = args.price;
  const sharesRaw = args.shares;
  if (!['buy', 'sell'].includes(side)) return '[Error] side 只能是 buy 或 sell';
  if (!rawCode) return '[Error] 需要 code';
  const price = Number(priceRaw);
  const shares = Math.trunc(Number(sharesRaw));
  if (!Number.isFinite(price) || !Number.isFinite(shares)) {
    return '[Error] price / shares 必须是数字';
  }
  const dry = Boolean(args.dry_run);
  const ledger = options.ledger;
  if (!ledger) return '[Error] 台账未初始化';
  const { code } = normalizeCode(rawCode);
  let name = String(args.name || '').trim();
  if (!name) {
    try {
      const fetchQ = options.fetchQuotes || fetchQuotes;
      const quotes = await fetchQ([code], 'stock');
      if (quotes.length) name = quotes[0].name || '';
    } catch {
      name = '';
    }
  }

  if (dry) {
    const preview = previewTrade(
      ledger, code, name, side, roundPrice(price), shares,
      String(args.trade_date || ''), args.fee,
    );
    return preview.text;
  }

  const feeOverride = (args.fee === null || args.fee === undefined || args.fee === '')
    ? null : Number(args.fee);
  const result = ledger.recordTrade(code, side, price, shares, {
    tradeDate: String(args.trade_date || ''),
    name,
    note: String(args.note || ''),
    feeOverride,
  });
  return formatRecordResult(result, ledger);
}

/** 持仓快照（文本 + 结构化数据）。 */
export async function snapshot(ledger, {
  includeWatch = false, fetchQuotes: fetchQ = fetchQuotes,
} = {}) {
  const positions = ledger.listPositions();
  const cash = ledger.getCash();
  const realized = ledger.realizedPnl();
  const feesTotal = ledger.totalFee();

  const quotes = {};
  if (positions.length) {
    try {
      const list = await fetchQ(positions.map((p) => p.code), 'stock');
      for (const quote of list) quotes[quote.code] = quote;
    } catch {
      // 行情失败时用成本价兜底，下面会显式提示
    }
  }

  const watchQuotes = {};
  let watchCount = 0;
  if (includeWatch) {
    const held = new Set(positions.map((p) => p.code));
    const items = ledger.listWatch()
      .map((w) => String(w.code || ''))
      .filter((code) => code && !held.has(code));
    watchCount = items.length;
    if (items.length) {
      try {
        const list = await fetchQ(items, 'stock');
        for (const quote of list) watchQuotes[quote.code] = quote;
      } catch {
        // 自选行情失败不阻断持仓总览
      }
    }
  }

  const rows = [];
  let totalMv = 0;
  let totalFloatPnl = 0;
  let totalTodayPnl = 0;
  for (const p of positions) {
    const q = quotes[p.code] || {};
    const price = q.price || p.cost_price;
    const mv = price * p.shares;
    totalMv += mv;
    const floatPnl = (price - p.cost_price) * p.shares;
    totalFloatPnl += floatPnl;
    const todayPnl = (q.change || 0) * p.shares;
    totalTodayPnl += todayPnl;
    rows.push([
      `${p.name || '-'}(${p.code})`, p.shares,
      f(p.cost_price, 3), f(price),
      `${f(floatPnl)} (${pct(pctChange(price, p.cost_price))})`,
      f(todayPnl),
      f(p.available_today, 0), money(mv),
    ]);
  }

  const equity = totalMv + Number(cash.balance || 0);
  const lines = ['**持仓总览**' + (rows.length ? '' : '（当前空仓）'), ''];
  if (rows.length) {
    lines.push(table(
      ['名称(代码)', '股数', '成本价', '现价', '浮动盈亏', '今日盈亏', '今日可卖', '市值'],
      rows,
    ), '');
  }
  lines.push(table(['合计', '数值'], [
    ['持仓市值', `${f(totalMv)} 元`],
    ['可用资金', `${f(cash.balance || 0)} 元`],
    ['账户总市值', `${f(equity)} 元`],
    ['浮动盈亏', `${signed(totalFloatPnl)} 元`],
    ['今日盈亏', `${signed(totalTodayPnl)} 元`],
    ['已实现盈亏（累计）', `${signed(realized.realized_pnl)} 元`],
    ['累计交易费用', `${f(feesTotal)} 元`],
    ['持仓数量', `${positions.length} 只`],
  ]));
  if (!Object.keys(quotes).length && positions.length) {
    lines.push('', '⚠️ 行情获取失败，上表现价用成本价代替，盈亏仅供参考。');
  }
  return {
    text: lines.join('\n'),
    data: {
      positions,
      quotes,
      watch_quotes: watchQuotes,
      watch_count: watchCount,
      total_market_value: totalMv,
      equity,
      cash: Number(cash.balance || 0),
      float_pnl: Math.round(totalFloatPnl * 100) / 100,
      today_pnl: Math.round(totalTodayPnl * 100) / 100,
      realized_pnl: realized.realized_pnl,
    },
  };
}

/** `astock_portfolio` 工具输出。 */
export async function runPortfolio(args = {}, options = {}) {
  const action = String(args.action || 'list');
  const ledger = options.ledger;
  if (!ledger) return '[Error] 台账未初始化';

  if (action === 'set_cash') {
    if (args.cash === null || args.cash === undefined) {
      return '[Error] action=set_cash 需要 cash 参数';
    }
    const res = ledger.setCash(Number(args.cash));
    return `✅ 可用资金已设为 ${f(res.balance)} 元（${res.updated_at}）`;
  }

  if (action === 'trades') {
    const rows = ledger.trades({
      code: String(args.code || ''),
      limit: Math.trunc(Number(args.limit) || 30),
    });
    if (!rows.length) return '暂无成交记录。用 astock_record 录入你在券商的实际成交。';
    return table(
      ['id', '日期', '代码', '名称', '方向', '价格', '数量', '费用', '已实现'],
      rows.map((row) => [
        row.id, row.trade_date, row.code, row.name,
        row.side === 'buy' ? '买入' : '卖出',
        f(row.price), row.shares, f(row.fee),
        row.realized !== null && row.realized !== undefined ? f(row.realized) : '—',
      ]),
    );
  }

  if (action === 'delete_trade') {
    if (args.trade_id === null || args.trade_id === undefined) {
      return '[Error] action=delete_trade 需要 trade_id（先用 action=trades 查 id）';
    }
    const res = ledger.deleteTrade(Math.trunc(Number(args.trade_id)));
    return `✅ 已删除流水 ${res.deleted}（${res.code}），`
      + `并按剩余流水重算：持仓 ${res.shares} 股，`
      + `成本价 ${plain(res.cost_price, 4)}`;
  }

  // list / summary：看板版式暂未移植，先返回完整文字总览
  const snap = await snapshot(ledger, {
    includeWatch: action === 'list' || action === 'summary',
    fetchQuotes: options.fetchQuotes || fetchQuotes,
  });
  return snap.text;
}

export { feeBreakdownDict };
