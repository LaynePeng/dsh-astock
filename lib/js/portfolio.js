/**
 * 台账工具：`astock_record`（录入/预览成交）与 `astock_portfolio`（持仓总览）。
 * 与 上游 `astock_mixin_ledger.py` 的文案、校验口径一致。
 */

import { fetchQuotes } from './kline.js';
import { dataCutoff } from './asof.js';
import {
  renderDetail, renderList, renderRecorded, renderSettled, renderStats,
} from './journal.js';
import {
  boardOf, calcFee, checkOrderSize, feeBreakdownDict, normalizeCode,
  pctChange, roundPrice, tradingStatus,
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

/**
 * 盈亏口径：**账户口径优先，流水口径兜底**。
 *
 *   账户口径  总盈亏 = 总资产 − 净本金（用户记过的出入金）
 *   流水口径  总盈亏 = 浮动盈亏 + 已实现盈亏（交易流水算出来的）
 *
 * 两个口径本应相等，把它们相减得到的 `gap` 就是**账实差异**：
 * 分红/利息这类非交易入账、漏记的成交、早期回填成本与真实成本不一致，
 * 都会让差额不为 0。差异必须显式列出来——以前拿「总资产 − 流水盈亏」
 * 倒推本金，等于把这段差额悄悄算进本金里，用户看到的收益率就永远是错的。
 *
 * 没有登记过本金时（`capital === null`）退回流口径，并把本金倒推出来，
 * 同时在提示里说明这是估算。
 */
export function lifetimePnl({
  floatPnl = 0, realizedPnl = 0, equity = 0, capital = null,
} = {}) {
  const num = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  const r2 = (n) => Math.round(n * 100) / 100;
  const trade = r2(num(floatPnl) + num(realizedPnl));
  const hasCapital = capital !== null && capital !== undefined && Number(capital) > 0;
  const base = hasCapital ? r2(Number(capital)) : r2(num(equity) - trade);
  const total = hasCapital ? r2(num(equity) - base) : trade;
  return {
    total,
    capitalBase: base,
    pct: base > 0 ? Math.round((total / base) * 10000) / 100 : null,
    trade,
    source: hasCapital ? 'capital' : 'derived',
    gap: hasCapital ? r2(total - trade) : null,
  };
}

/** 持仓快照（文本 + 结构化数据）。 */
export async function snapshot(ledger, {
  includeWatch = false, fetchQuotes: fetchQ = fetchQuotes,
} = {}) {
  const positions = ledger.listPositions();
  const cash = ledger.getCash();
  const realized = ledger.realizedPnl();
  const feesTotal = ledger.totalFee();
  // 本金（出入金）：没有登记过就是「未知」，不能当 0
  const capital = ledger.netCapital();
  const capitalTotal = capital.count > 0 ? capital.total : null;

  // -------------------------------------------------- 今日盈亏的口径
  //
  // 「今日盈亏」不能简单用 (现价 - 昨收) × 当前持股数：
  //   · 今天新买的仓位昨天并不持有，套昨收会凭空多出一段收益；
  //   · 今天卖掉的标的已经不在 positions 里，会被完全漏掉；
  //   · 当天的交易费用也没地方体现。
  // 这里按「今天一天账户资产的变化」分三段算：昨仓、今买、今卖。
  const today = todayIso();
  let todayTrades = [];
  try {
    todayTrades = ledger.trades({ start: today, end: today, limit: 500 }) || [];
  } catch {
    todayTrades = [];
  }
  const boughtToday = new Map();
  const soldToday = [];
  for (const t of todayTrades) {
    const code = String(t.code || '');
    const shares = Number(t.shares) || 0;
    if (!code || shares <= 0) continue;
    if (t.side === 'buy') {
      const cur = boughtToday.get(code) || { shares: 0, amount: 0 };
      cur.shares += shares;
      // 含费买入均价：费用摊销进成本，不然今天的盈亏会虚高一个手续费
      cur.amount += (Number(t.amount) || 0) + (Number(t.fee) || 0);
      boughtToday.set(code, cur);
    } else if (t.side === 'sell') {
      soldToday.push({
        code,
        name: t.name || '',
        shares,
        price: Number(t.price) || 0,
        fee: Number(t.fee) || 0,
      });
    }
  }

  const quotes = {};
  // 当日卖出的标的已不在 positions 里，但算今日盈亏要它们的昨收
  const quoteCodes = positions.map((p) => p.code);
  for (const sold of soldToday) {
    if (!quoteCodes.includes(sold.code)) quoteCodes.push(sold.code);
  }
  if (quoteCodes.length) {
    try {
      const list = await fetchQ(quoteCodes, 'stock');
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
    // 昨仓：按昨收算；今买：按含费买入均价算。两者之和才是这只票今天的贡献
    const bought = boughtToday.get(p.code);
    const newShares = bought ? Math.min(bought.shares, p.shares) : 0;
    const prevShares = p.shares - newShares;
    let todayPnl = prevShares > 0 ? (q.change || 0) * prevShares : 0;
    if (newShares > 0 && bought && bought.shares > 0) {
      todayPnl += (price - bought.amount / bought.shares) * newShares;
    }
    totalTodayPnl += todayPnl;
    rows.push([
      `${p.name || '-'}(${p.code})`, p.shares,
      f(p.cost_price, 3), f(price),
      `${f(floatPnl)} (${pct(pctChange(price, p.cost_price))})`,
      f(todayPnl),
      f(p.available_today, 0), money(mv),
    ]);
  }

  // 今日卖出：卖出价相对昨收的差价，再扣掉卖出费用（即使已不在持仓里）
  let soldTodayPnl = 0;
  let soldMissingQuote = 0;
  for (const sold of soldToday) {
    const q2 = quotes[sold.code];
    if (!q2 || typeof q2.change !== 'number') {
      soldMissingQuote += 1;
      continue;
    }
    const prevClose = (Number(q2.price) || 0) - q2.change;
    soldTodayPnl += (sold.price - prevClose) * sold.shares - sold.fee;
  }
  totalTodayPnl += soldTodayPnl;

  const equity = totalMv + Number(cash.balance || 0);
  const lifetime = lifetimePnl({
    floatPnl: totalFloatPnl, realizedPnl: realized.realized_pnl, equity,
    capital: capitalTotal,
  });
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
    ['浮动盈亏（当前持仓）', `${signed(totalFloatPnl)} 元`],
    ['已实现盈亏（卖了结的）', `${signed(realized.realized_pnl)} 元`],
    ['流水盈亏（浮动 + 已实现）', `${signed(lifetime.trade)} 元`],
    // 主指标：账户口径 = 总资产 − 本金，这才是「我投了 2 万现在亏多少」
    [`${lifetime.source === 'capital' ? '账户盈亏（总资产 − 本金）' : '账户盈亏（本金按倒推）'}`,
      `${signed(lifetime.total)} 元`],
    [`${lifetime.source === 'capital' ? '对本金' : '对本金（倒推）'}`,
      lifetime.pct !== null ? pct(lifetime.pct) : '—'],
    [`净本金（${capital.count} 笔出入金）`, capitalTotal !== null ? `${f(capitalTotal)} 元` : '未登记'],
    ['今日盈亏', `${signed(totalTodayPnl)} 元`],
    ['累计交易费用', `${f(feesTotal)} 元`],
    ['持仓数量', `${positions.length} 只`],
  ]));
  // 口径写清楚：不写的话「浮动 +3%、账户 -12%」会被当成自相矛盾
  lines.push('', '> **账户盈亏 = 总资产 − 净本金**（你投进去的钱），这才是「投了 2 万现在赚没赚」。'
    + '流水盈亏 = 浮动 + 已实现（含两侧费用），它只看交易本身，看不见分红、利息、'
    + '漏记的成交；两个口径对不上时，差额单列成「账实差异」，不互相顶替。');
  if (lifetime.source !== 'capital') {
    lines.push('> 还没登记过本金，收益率只能按「总资产 − 流水盈亏」倒推，'
      + '出入金或资金校准之后会失真。用 `astock_portfolio action=capital` 记一笔本金即可。');
  } else if (lifetime.gap !== null && Math.abs(lifetime.gap) >= 0.01) {
    lines.push(`> ⚠️ 账实差异 ${signed(lifetime.gap)} 元：账面资产比交易流水推出来的`
      + '多/少了这一笔。常见原因：分红或利息到账、有成交没记、早期回填的成本与真实成本不一致。'
      + '核对后把非交易入账按「出入金」补记，差额就会归零。');
  }
  if (soldToday.length) {
    const names = soldToday.map((s) => `${s.name || '-'}(${s.code})`).join('、');
    lines.push('', `> 今日盈亏已含当日卖出标的：${names}`);
    if (soldMissingQuote) {
      lines.push(`> ⚠️ 其中 ${soldMissingQuote} 只卖出标的行情缺失，今日盈亏未含其昨日收盘价。`);
    }
  }
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
      realized_sell_count: realized.sell_count,
      total_pnl: lifetime.total,
      total_pnl_pct: lifetime.pct,
      trade_pnl: lifetime.trade,
      pnl_source: lifetime.source,
      reconcile_gap: lifetime.gap,
      capital_total: capitalTotal,
      capital_count: capital.count,
      capital_base: lifetime.capitalBase,
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

  if (action === 'capital') {
    const net = ledger.netCapital();
    const rows = ledger.listCapital(Math.trunc(Number(args.limit) || 30));
    const head = net.count
      ? `**净本金 ${f(net.total)} 元**（${net.count} 笔，起始 ${net.first_date || '—'}）\n`
        + `账户盈亏 = 总资产 − 净本金 = 你真正赚/亏的钱；出入金按「入金正、出金负」记。`
      : '还没有登记过本金。没有本金只能按「总资产 − 流水盈亏」倒推收益率，'
        + '一有出入金或资金校准就会失真——先记一笔：`action=capital amount=20000`';
    if (!rows.length) return head;
    return `${head}\n\n` + table(
      ['id', '日期', '金额', '备注'],
      rows.map((row) => [row.id, row.date, signed(row.amount), row.note || '—']),
    );
  }

  if (action === 'capital_add') {
    const amount = Number(args.amount);
    if (!Number.isFinite(amount) || amount === 0) {
      return '[Error] action=capital_add 需要 amount（入金正数、出金负数，不能为 0）';
    }
    const added = ledger.addCapital(amount, {
      date: String(args.date || ''), note: String(args.note || ''),
    });
    const net = ledger.netCapital();
    return `✅ 已记${added.amount >= 0 ? '入金' : '出金'} ${signed(added.amount)} 元`
      + `（${added.date}${added.note ? `，${added.note}` : ''}）\n`
      + `净本金 ${f(net.total)} 元（${net.count} 笔）。`
      + '账户盈亏会在下一次总览里按「总资产 − 净本金」重算。';
  }

  if (action === 'capital_delete') {
    const id = Number(args.capital_id);
    if (!Number.isFinite(id)) {
      return '[Error] action=capital_delete 需要 capital_id（先用 action=capital 查 id）';
    }
    const removed = ledger.deleteCapital(id);
    const net = ledger.netCapital();
    return `✅ 已删除出入金 ${removed.id}（${removed.date} ${signed(removed.amount)} 元）\n`
      + `净本金 ${f(net.total)} 元（${net.count} 笔）`;
  }

  if (action.startsWith('journal_')) {
    return runJournal(action, args, options);
  }

  // list / summary：看板版式暂未移植，先返回完整文字总览
  const snap = await snapshot(ledger, {
    includeWatch: action === 'list' || action === 'summary',
    fetchQuotes: options.fetchQuotes || fetchQuotes,
  });
  return snap.text;
}

/** 北京时间今天（复核日比较必须用交易日口径，不能用宿主本地时区）。 */
function cnToday() {
  return String(tradingStatus().now || '').slice(0, 10);
}

/** `fetchQuotes` 返回的是**数组**，这里统一转成 code→quote 的映射。 */
function quotesToMap(list) {
  const map = {};
  for (const quote of Array.isArray(list) ? list : []) {
    if (quote && quote.code) map[String(quote.code)] = quote;
  }
  return map;
}

/**
 * 判断留痕的四个动作：记录 / 列表 / 审定 / 统计。
 *
 * 单独抽出来是因为它和「算账」是两件事：这里不猜价格，只把人的判断连同
 * 当时的依据与数据快照存下来，到期用真实价格回看兑现没有。
 */
async function runJournal(action, args = {}, options = {}) {
  const ledger = options.ledger;
  const today = cnToday();

  if (action === 'journal_record') {
    const claim = String(args.claim || '').trim();
    if (!claim) {
      return '[Error] journal_record 需要 claim（判断原文）。'
        + '例：claim=「跌破 38.60 后 20 日内不收回，减半」';
    }
    const rawCode = String(args.code || '').trim();
    // 传了非数字就当没给：NaN 落库后会在回看时变成「记录价 NaN」
    const givenPrice = Number(args.price);
    let priceAt = args.price === null || args.price === undefined
      || !Number.isFinite(givenPrice) ? null : givenPrice;
    let priceNote = '';
    let quote = null;
    if (rawCode) {
      try {
        const list = await (options.fetchQuotes || fetchQuotes)([rawCode], 'stock');
        quote = quotesToMap(list)[normalizeCode(rawCode).code] || null;
      } catch {
        quote = null;
      }
      if (priceAt === null && quote && Number.isFinite(Number(quote.price))) {
        priceAt = Number(quote.price);
        const cutoff = dataCutoff();
        priceNote = `记录价取自${cutoff.price_basis}`
          + `（取数 ${cutoff.date} ${cutoff.time}），不是你的成交价。`;
      } else if (priceAt === null) {
        priceNote = '取不到当前价，记录价留空——以后回看会少一个参照点，能补就补。';
      }
    }
    const snapshot = quote ? {
      现价: quote.price,
      涨跌幅: quote.change_pct,
      量比: quote.volume_ratio,
      换手率: quote.turnover_rate,
      数据时点: tradingStatus().now,
    } : { 数据时点: tradingStatus().now };
    try {
      const thesis = ledger.saveThesis({
        code: rawCode,
        name: args.name || quote?.name || '',
        stance: args.stance || 'watch',
        claim,
        basis: args.basis || '',
        evidence_for: args.evidence_for || '',
        evidence_against: args.evidence_against || '',
        verify_date: args.verify_date || '',
        verify_kind: args.verify_kind || '',
        verify_price: args.verify_price,
        prev_id: args.prev_id || '',
        price_at: priceAt,
        snapshot,
      });
      return renderRecorded(thesis, { priceNote });
    } catch (error) {
      return `[Error] 记判断失败：${error?.message ?? error}`;
    }
  }

  if (action === 'journal_list') {
    const code = String(args.code || '').trim();
    const thesisId = String(args.thesis_id || '').trim();
    if (thesisId) {
      const thesis = ledger.getThesis(thesisId);
      if (!thesis) return `[Error] 没有这条判断：${thesisId}`;
      let quotes = {};
      try {
        quotes = quotesToMap(await (options.fetchQuotes || fetchQuotes)([thesis.code], 'stock'));
      } catch {
        quotes = {};
      }
      return renderDetail(thesis, { quotes });
    }
    // 模型有时把布尔传成字符串，宁可宽松也不要静默忽略「只看该复核的」
    const due = args.due === true || args.due === 'true';
    const rows = ledger.listTheses({
      code,
      outcome: String(args.outcome || '').trim(),
      due,
      today,
      limit: Math.trunc(Number(args.limit) || 30),
    });
    let prices = {};
    if (due && rows.length) {
      try {
        prices = quotesToMap(await (options.fetchQuotes || fetchQuotes)(
          rows.map((row) => row.code).filter(Boolean), 'stock',
        ));
      } catch {
        prices = {};
      }
    }
    const total = ledger.countTheses({
      code, outcome: String(args.outcome || '').trim(), due, today,
    });
    return renderList(rows, {
      due, today, prices, truncated: total > rows.length,
    });
  }

  if (action === 'journal_settle') {
    const thesisId = String(args.thesis_id || '').trim();
    if (!thesisId) {
      return '[Error] journal_settle 需要 thesis_id（用 action=journal_list 查 id）';
    }
    try {
      const thesis = ledger.settleThesis(thesisId, {
        outcome: args.outcome,
        price: args.price,
        note: args.note,
      });
      return renderSettled(thesis);
    } catch (error) {
      return `[Error] 审定失败：${error?.message ?? error}`;
    }
  }

  if (action === 'journal_stats') {
    const code = String(args.code || '').trim();
    return renderStats(ledger.thesisStats({ code }), { code });
  }

  return `[Error] 未知 action=${action}。判断留痕可用：`
    + 'journal_record（记）/ journal_list（看）/ journal_settle（审定）/ journal_stats（兑现率）';
}

export { feeBreakdownDict };
