/**
 * DSH 专属维护能力（JS 版）：台账导出/导入、备份/恢复、每日收盘快照、数据自愈。
 *
 * 上游 `maintenance.py` 的 Node 移植。上游 astock-plugin 的写盘只有台账与存档
 * 两处；这里补的是**用户自己的数据可携带**：换机器、重装插件、误删之后能拿回来。
 * 所有函数只操作 astock-data 目录内的文件，不改取数/记账口径。
 *
 * 几条刻意的设计（与 Python 版一致，别改）：
 *
 * - **导出是快照**（positions + trades + watchlist + cash），导入只回放**成交**。
 *   持仓由成交按移动加权成本重算，避免「导入的持仓与流水对不上」——那种账
 *   在界面上看不出错，但下一次卖出算出的已实现盈亏一定是错的。
 * - **备份走 SQLite 的 `VACUUM INTO`**，不是复制文件：台账开了 WAL，直接复制
 *   主文件可能丢掉最近的事务。
 * - **每日快照单独存 JSONL**，不往上游台账里加表：两边共用同一个 ledger.sqlite，
 *   加表会破坏「与 lite-work 版共用台账」的承诺。
 * - 缺数据一律给 null / 空串，不用 0 冒充。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  BOARD, boardOf, calcFee, checkOrderSize, normalizeCode, nowCn, isTradingDay,
} from './market.js';
import { fetchKlines, fetchQuotes } from './kline.js';
import { snapshot } from './portfolio.js';
import { updateFromProvider } from './archive.js';
import { run as runBacktest, getCached } from './backtest-tool.js';
import { DEFAULT_STRATEGY, STRATEGIES } from './quant.js';

/** 导出 JSON 的格式标记（以后改结构时靠它识别）。 */
export const EXPORT_FORMAT = 'dsh-astock-ledger/1';

/** 单次导入的行数上限：再多的成交应该分批，一次性回放既慢又难核对。 */
export const MAX_IMPORT_ROWS = 2000;

/** 备份保留份数（list 只列最近 N 份，磁盘上的旧备份不自动删）。 */
export const MAX_BACKUPS_LISTED = 12;

// ====================================================================== 工具函数

function pad(n) {
  return String(n).padStart(2, '0');
}

function nowText(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function stamp(now = new Date()) {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-`
    + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function todayIso(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function num(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 2) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** digits;
  // 与 Python 的 round() 一样按「就近取偶」处理 .5 的情况
  const scaled = n * f;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let out;
  if (Math.abs(diff - 0.5) < 1e-9) out = floor % 2 === 0 ? floor : floor + 1;
  else out = Math.round(scaled);
  return out / f;
}

// ====================================================================== 路径

export function dataDir(ledgerPath) {
  return path.dirname(String(ledgerPath || ''));
}

export function equityPath(ledgerPath) {
  return path.join(dataDir(ledgerPath), 'equity.jsonl');
}

export function backupRoot(ledgerPath) {
  return path.join(dataDir(ledgerPath), 'backups');
}

/** 最近一次回测结论的落盘位置（面板下次打开还能看到推荐率）。 */
export function backtestPath(ledgerPath) {
  return path.join(dataDir(ledgerPath), 'backtest.json');
}

// ====================================================================== 导出

function normalizeRows(rows = []) {
  return rows.map((row) => {
    const item = { ...row };
    if (typeof item.fee_detail === 'string') {
      try {
        item.fee_detail = JSON.parse(item.fee_detail);
      } catch {
        // 解析不了就保留原字符串
      }
    }
    return item;
  });
}

/** CSV 字段转义（与 Python csv.writer 的默认规则一致）。 */
function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** 成交流水 CSV：**中文表头 + BOM**，双击就能用 Excel 打开不乱码。 */
export function tradesCsv(rows = []) {
  const header = ['成交日期', '代码', '名称', '方向', '成交价', '数量',
    '成交金额', '费用', '已实现盈亏', '备注'];
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push([
      row.trade_date ?? '',
      row.code ?? '',
      row.name ?? '',
      row.side === 'buy' ? '买入' : '卖出',
      row.price ?? '',
      row.shares ?? '',
      row.amount ?? '',
      row.fee ?? '',
      row.realized === null || row.realized === undefined ? '' : row.realized,
      row.note ?? '',
    ].map(csvCell).join(','));
  }
  // Python csv.writer 的 lineterminator 是 \r\n
  return `\ufeff${lines.join('\r\n')}\r\n`;
}

/** 导出（不写盘，内容直接回给宿主做下载）。 */
export function exportPayload(ledger, kind = 'ledger.json') {
  const rows = ledger.exportRows();
  const key = String(kind || 'ledger.json').trim().toLowerCase();

  if (['trades.csv', 'trades', 'csv'].includes(key)) {
    return {
      ok: true,
      filename: `astock-trades-${stamp()}.csv`,
      contentType: 'text/csv; charset=utf-8',
      content: tradesCsv(rows.trades || []),
      rows: (rows.trades || []).length,
    };
  }

  if (['watchlist.json', 'watchlist', 'watch'].includes(key)) {
    const payload = {
      format: 'dsh-astock-watchlist/1',
      exportedAt: nowText(),
      watchlist: (rows.watchlist || []).map((row) => ({
        code: String(row.code || ''),
        name: String(row.name || ''),
        note: String(row.note || ''),
        added_at: String(row.added_at || ''),
      })),
    };
    return {
      ok: true,
      filename: `astock-watchlist-${stamp()}.json`,
      contentType: 'application/json; charset=utf-8',
      content: JSON.stringify(payload, null, 2),
      rows: payload.watchlist.length,
    };
  }

  const cashRow = (rows.cash || [{}])[0] || {};
  const payload = {
    format: EXPORT_FORMAT,
    exportedAt: nowText(),
    cash: num(cashRow.balance) || 0.0,
    positions: normalizeRows(rows.positions || []),
    trades: normalizeRows(rows.trades || []),
    watchlist: normalizeRows(rows.watchlist || []),
  };
  return {
    ok: true,
    filename: `astock-ledger-${stamp()}.json`,
    contentType: 'application/json; charset=utf-8',
    content: JSON.stringify(payload, null, 2),
    rows: payload.trades.length,
  };
}

// ====================================================================== 导入

/** 表头别名（中英文都认，大小写/空格不敏感）。 */
export const HEADER_ALIASES = {
  trade_date: ['trade_date', 'date', '成交日期', '交易日期', '日期'],
  code: ['code', 'symbol', '代码', '证券代码', '股票代码'],
  side: ['side', 'direction', '方向', '买卖', '买卖方向'],
  price: ['price', '成交价', '成交价格', '价格'],
  shares: ['shares', 'quantity', 'qty', '数量', '成交数量', '股数'],
  fee: ['fee', '费用', '手续费', '佣金'],
  name: ['name', '名称', '股票名称'],
  note: ['note', '备注'],
};

const BUY_WORDS = new Set(['buy', 'b', '买入', '买']);
const SELL_WORDS = new Set(['sell', 's', '卖出', '卖']);

function headerKey(cell) {
  // 去掉 BOM：Excel 打开/另存过的 CSV 常在第一个表头前带 \ufeff
  const text = String(cell ?? '').trim().replace(/^\ufeff/, '').toLowerCase().replace(/\s+/g, '');
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.some((alias) => alias.toLowerCase() === text)) return key;
  }
  return '';
}

function detectDelimiter(sample) {
  const counts = { ',': 0, '\t': 0, ';': 0 };
  let inQuotes = false;
  for (const ch of sample) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch] += 1;
  }
  let best = ',';
  for (const [delimiter, n] of Object.entries(counts)) {
    if (n > counts[best]) best = delimiter;
  }
  return best;
}

/** 极简 RFC 4180 解析（支持引号内的分隔符与换行）。 */
export function parseDelimited(raw, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => String(cell).trim() !== ''));
}

function normDate(raw) {
  let text = String(raw ?? '').trim();
  if (!text) return todayIso();
  text = text.replace(/\//g, '-').replace(/\./g, '-');
  if (/^\d{8}$/.test(text)) text = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new Error(`日期格式无法识别（${JSON.stringify(raw)}，应为 YYYY-MM-DD）`);
  }
  return text;
}

function normSide(raw) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (BUY_WORDS.has(text)) return 'buy';
  if (SELL_WORDS.has(text)) return 'sell';
  return '';
}

/**
 * 把粘贴的 CSV/TSV 解析成成交行。
 *
 * 识别不出的行**明确报错**，不猜——猜错方向或价格会直接污染台账。
 */
export function parseTradeRows(text) {
  const raw = String(text ?? '').trim().replace(/^\ufeff/, '');
  if (!raw) return { rows: [], errors: ['没有内容'] };

  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return { rows: [], errors: ['至少需要一行表头和一行数据'] };

  const delimiter = detectDelimiter(lines.slice(0, 5).join('\n'));
  const table = parseDelimited(raw, delimiter);
  if (!table.length) return { rows: [], errors: ['读不到表头'] };

  const headers = table[0].map((cell) => String(cell ?? '').trim());
  const mapping = headers.map((name) => headerKey(name));
  const known = new Set(mapping.filter(Boolean));
  const missing = ['trade_date', 'code', 'side', 'price', 'shares']
    .filter((key) => !known.has(key));
  if (missing.length) {
    const labels = {
      trade_date: '成交日期', code: '代码', side: '方向', price: '成交价', shares: '数量',
    };
    return { rows: [], errors: [`表头缺少：${missing.map((key) => labels[key]).join('、')}`] };
  }

  const rows = [];
  const errors = [];
  const records = table.slice(1);
  for (let index = 0; index < records.length; index += 1) {
    if (index >= MAX_IMPORT_ROWS) {
      errors.push(`超过 ${MAX_IMPORT_ROWS} 行，只解析前 ${MAX_IMPORT_ROWS} 行`);
      break;
    }
    const record = records[index];
    const item = { _index: index };
    headers.forEach((_header, column) => {
      const key = mapping[column];
      if (key) item[key] = String(record[column] ?? '').trim();
    });
    try {
      item.trade_date = normDate(item.trade_date);
    } catch (error) {
      errors.push(`第 ${index + 2} 行：${error.message}`);
      continue;
    }
    item.side = normSide(item.side);
    if (!item.side) {
      errors.push(`第 ${index + 2} 行：方向只能是 买入/卖出（buy/sell）`);
      continue;
    }
    const price = Number(String(item.price ?? '').replace(/,/g, ''));
    const shares = Number(String(item.shares ?? '').replace(/,/g, ''));
    if (!Number.isFinite(price) || !Number.isFinite(shares)) {
      errors.push(`第 ${index + 2} 行：价格/数量不是数字`);
      continue;
    }
    item.price = round(price, 3);
    item.shares = Math.trunc(shares);
    if (item.price <= 0 || item.shares <= 0) {
      errors.push(`第 ${index + 2} 行：价格与数量都必须大于 0`);
      continue;
    }
    const feeRaw = String(item.fee ?? '').replace(/,/g, '');
    if (feeRaw) {
      const fee = Number(feeRaw);
      item.fee = Number.isFinite(fee) ? round(fee, 2) : null;
    } else {
      item.fee = null;
    }
    rows.push(item);
  }
  return { rows, errors };
}

function existingKeys(ledger) {
  const keys = new Set();
  for (const row of ledger.exportRows().trades || []) {
    keys.add([
      String(row.trade_date ?? ''),
      String(row.code ?? ''),
      String(row.side ?? ''),
      round(num(row.price) || 0, 3),
      Math.trunc(num(row.shares) || 0),
    ].join('|'));
  }
  return keys;
}

function previewRows(ledger, rows) {
  const state = {};
  for (const pos of ledger.listPositions()) {
    state[String(pos.code)] = {
      shares: Math.trunc(num(pos.shares) || 0),
      cost: num(pos.cost_price) || 0.0,
      available: Math.trunc(num(pos.available_today) || num(pos.shares) || 0),
    };
  }
  const existing = existingKeys(ledger);
  const today = todayIso();
  const out = [];

  for (const row of rows) {
    const problems = [];
    let code;
    try {
      ({ code } = normalizeCode(String(row.code ?? '')));
    } catch (error) {
      out.push({
        ...row,
        status: 'error',
        problems: [`代码无法识别：${error?.message ?? error}`],
      });
      continue;
    }

    const price = Number(row.price);
    const shares = Math.trunc(row.shares);
    const side = String(row.side);
    const amount = round(price * shares, 2);
    const board = boardOf(code);
    const feeBreakdown = calcFee(amount, side, ledger.fee, board);
    const fee = row.fee !== null && row.fee !== undefined
      ? Number(row.fee) : round(feeBreakdown.total, 2);

    const current = state[code] || { shares: 0, cost: 0.0, available: 0 };
    const held = Math.trunc(current.shares);
    const cost = Number(current.cost);
    const available = Math.trunc(current.available);

    const err = checkOrderSize(shares, code, side, held);
    if (err) problems.push(err);

    let newShares;
    let newCost;
    let realized = null;
    if (side === 'buy') {
      newShares = held + shares;
      newCost = newShares ? round((cost * held + amount + fee) / newShares, 4) : 0.0;
    } else {
      if (held <= 0) problems.push(`${code} 当前无持仓，无法卖出`);
      else if (shares > available) {
        problems.push(`可卖数量不足：持仓 ${held} 股，可卖 ${available} 股，本次 ${shares} 股`);
      }
      newShares = Math.max(0, held - shares);
      newCost = newShares ? round(cost, 4) : 0.0;
      realized = held > 0 ? round((price - cost) * shares - fee, 2) : null;
    }

    const duplicate = existing.has([
      String(row.trade_date), code, side, round(price, 3), shares,
    ].join('|'));
    const status = problems.length ? 'error' : (duplicate ? 'duplicate' : 'ok');
    // 重复行不参与模拟：导入时会跳过它，预览也必须按「跳过」推演，
    // 否则后面的卖出会按虚增的持仓算，看起来能过、落账却失败。
    if (!problems.length && !duplicate) {
      state[code] = {
        shares: newShares,
        cost: newCost,
        // 历史成交不影响今天的 T+1 可卖；今天买入的会锁住当天
        available: row.trade_date !== today ? newShares : available,
      };
    }

    out.push({
      index: row._index,
      trade_date: row.trade_date,
      code,
      name: String(row.name ?? ''),
      side,
      price,
      shares,
      amount,
      fee: round(fee, 2),
      realized,
      newShares,
      newCost,
      duplicate,
      status,
      problems,
    });
  }

  const summary = { ok: 0, duplicate: 0, error: 0 };
  for (const item of out) summary[item.status] = (summary[item.status] || 0) + 1;
  return {
    ok: true,
    committed: false,
    rows: out,
    summary,
    totalAmount: round(out.reduce((sum, item) => sum + item.amount, 0), 2),
    totalFee: round(out.reduce((sum, item) => sum + item.fee, 0), 2),
  };
}

/** 导入成交：默认只预览；`commit=true` 才按日期顺序回放落账。 */
export function importTrades(ledger, text, commit = false) {
  const { rows, errors } = parseTradeRows(text);
  if (!rows.length) {
    return {
      ok: false, message: '没有可导入的成交行', errors, rows: [], summary: {},
    };
  }

  if (!commit) {
    const result = previewRows(ledger, rows);
    result.errors = errors;
    result.message = `预览：${result.summary.ok || 0} 行可导入，`
      + `${result.summary.duplicate || 0} 行疑似重复，`
      + `${result.summary.error || 0} 行校验不通过`;
    return result;
  }

  const ordered = [...rows].sort((a, b) => {
    if (a.trade_date !== b.trade_date) return a.trade_date < b.trade_date ? -1 : 1;
    return a._index - b._index;
  });
  const existing = existingKeys(ledger);
  const applied = [];
  const failed = [];
  const skipped = [];
  for (const row of ordered) {
    let code;
    try {
      ({ code } = normalizeCode(row.code));
    } catch {
      code = String(row.code);
    }
    const key = [
      row.trade_date, code, row.side, round(Number(row.price), 3), Math.trunc(row.shares),
    ].join('|');
    if (existing.has(key)) {
      skipped.push({
        trade_date: row.trade_date,
        code,
        side: row.side,
        price: row.price,
        shares: row.shares,
        reason: '台账里已有同一笔（日期/代码/方向/价格/数量一致）',
      });
      continue;
    }
    try {
      const saved = ledger.recordTrade(code, row.side, row.price, row.shares, {
        tradeDate: row.trade_date,
        name: String(row.name ?? ''),
        note: String(row.note ?? ''),
        feeOverride: row.fee ?? null,
      });
      existing.add(key);
      applied.push({
        trade_date: saved.trade_date,
        code: saved.code,
        side: saved.side,
        price: saved.price,
        shares: saved.shares,
        fee: saved.fee,
        costAfter: saved.cost_price_after,
        sharesAfter: saved.shares_after,
      });
    } catch (error) {
      failed.push({
        trade_date: row.trade_date,
        code,
        side: row.side,
        price: row.price,
        shares: row.shares,
        error: String(error?.message ?? error),
      });
    }
  }

  return {
    ok: true,
    committed: true,
    applied,
    skipped,
    failed,
    errors,
    summary: { applied: applied.length, skipped: skipped.length, failed: failed.length },
    message: `已导入 ${applied.length} 笔成交`
      + (skipped.length ? `，跳过 ${skipped.length} 笔重复` : '')
      + (failed.length ? `，${failed.length} 笔失败（见明细）` : ''),
  };
}

// ====================================================================== 全量 JSON 导入

/**
 * 解析导出的台账 JSON（`astock-ledger-*.json`）。
 *
 * 与成交 CSV 导入的区别：这份文件带**持仓、资金、自选**，所以能完整恢复一个账户。
 * 但持仓仍然以**成交回放**为准（导入的持仓只在「没有对应流水」时按手工持仓写入），
 * 否则「持仓与流水对不上」的账在界面上看不出错，下次卖出算的已实现盈亏一定是错的。
 */
export function parseLedgerJson(text) {
  let payload;
  try {
    payload = JSON.parse(String(text ?? '').trim());
  } catch (error) {
    return { ok: false, errors: [`不是合法 JSON：${error?.message ?? error}`] };
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, errors: ['内容必须是一个 JSON 对象'] };
  }
  const errors = [];
  if (payload.format && payload.format !== EXPORT_FORMAT) {
    errors.push(`格式标记是 ${payload.format}，本插件期望 ${EXPORT_FORMAT}（仍会尽力导入）`);
  }
  const positions = Array.isArray(payload.positions) ? payload.positions : [];
  const trades = Array.isArray(payload.trades) ? payload.trades : [];
  const watchlist = Array.isArray(payload.watchlist) ? payload.watchlist : [];
  const cash = num(payload.cash);
  if (!positions.length && !trades.length && !watchlist.length && cash === null) {
    return { ok: false, errors: [...errors, '文件里没有持仓 / 成交 / 自选 / 资金，无法导入'] };
  }
  return {
    ok: true,
    errors,
    payload: {
      format: String(payload.format || ''),
      exportedAt: String(payload.exportedAt || ''),
      cash,
      positions,
      trades,
      watchlist,
    },
  };
}

/**
 * 预览全量导入：把「会发生什么」算清楚，**不落账**。
 *
 * @param {object} ledger
 * @param {string} text 导出的 JSON 原文
 * @param {{scope?: 'all'|'watch_cash'|'trades'}} options
 */
export function previewLedgerImport(ledger, text, { scope = 'all' } = {}) {
  const parsed = parseLedgerJson(text);
  if (!parsed.ok) return { ok: false, errors: parsed.errors, message: parsed.errors[0] };
  const { payload } = parsed;
  const mode = ['all', 'watch_cash', 'trades'].includes(scope) ? scope : 'all';

  const currentPositions = {};
  for (const pos of ledger.listPositions()) currentPositions[pos.code] = pos;
  const currentWatch = new Set(ledger.listWatch().map((w) => w.code));
  const cashBefore = num(ledger.getCash().balance) || 0;

  const incoming = {};
  for (const pos of payload.positions) {
    const code = String(pos.code || '');
    if (code) incoming[code] = pos;
  }
  const tradesInFile = payload.trades.filter((t) => t && t.code);
  const tradedCodes = new Set(tradesInFile.map((t) => String(t.code)));

  const add = [];
  const update = [];
  const remove = [];
  if (mode !== 'watch_cash') {
    for (const [code, pos] of Object.entries(incoming)) {
      const before = currentPositions[code];
      if (!before) add.push({ code, shares: Math.trunc(num(pos.shares) || 0) });
      else if (Math.trunc(num(before.shares) || 0) !== Math.trunc(num(pos.shares) || 0)) {
        update.push({
          code,
          sharesBefore: Math.trunc(num(before.shares) || 0),
          sharesAfter: Math.trunc(num(pos.shares) || 0),
        });
      }
    }
    for (const code of Object.keys(currentPositions)) {
      if (!incoming[code] && !tradedCodes.has(code)) remove.push(code);
    }
  }

  const existing = existingKeys(ledger);
  let duplicate = 0;
  const newTrades = [];
  if (mode !== 'watch_cash') {
    for (const trade of tradesInFile) {
      let code;
      try {
        ({ code } = normalizeCode(String(trade.code)));
      } catch {
        continue;
      }
      const key = [
        String(trade.trade_date || ''), code, String(trade.side || ''),
        round(num(trade.price) || 0, 3), Math.trunc(num(trade.shares) || 0),
      ].join('|');
      if (existing.has(key)) duplicate += 1;
      else newTrades.push({ code, trade });
    }
  }

  const watchAdd = payload.watchlist
    .map((w) => String(w.code || ''))
    .filter((code) => code && !currentWatch.has(code));

  return {
    ok: true,
    scope: mode,
    exportedAt: payload.exportedAt,
    errors: parsed.errors,
    positions: { add, update, remove },
    trades: { inFile: tradesInFile.length, new: newTrades.length, duplicate },
    watchlist: { inFile: payload.watchlist.length, add: watchAdd },
    cash: {
      before: cashBefore,
      after: mode === 'trades' ? cashBefore : payload.cash,
    },
    message: `预览（${mode === 'all' ? '全量' : mode === 'watch_cash' ? '仅资金+自选' : '仅成交'}）：`
      + `持仓 +${add.length} / 改 ${update.length} / 清 ${remove.length}，`
      + `成交新增 ${newTrades.length}（重复 ${duplicate}），`
      + `自选 +${watchAdd.length}，`
      + (mode === 'trades' ? '资金不变' : `资金 ${cashBefore} → ${payload.cash ?? '不变'}`),
  };
}

/**
 * 执行全量导入。`scope` 决定恢复哪些部分：
 *
 *   · all        —— 成交 + 资金 + 自选（持仓由成交回放得出）
 *   · watch_cash —— 只恢复资金与自选（不碰流水与持仓）
 *   · trades     —— 只回放成交（资金不动，方便「流水补录」）
 */
export function importLedger(ledger, text, { scope = 'all' } = {}) {
  const parsed = parseLedgerJson(text);
  if (!parsed.ok) return { ok: false, message: parsed.errors[0], errors: parsed.errors };
  const { payload } = parsed;
  const mode = ['all', 'watch_cash', 'trades'].includes(scope) ? scope : 'all';
  const applied = { trades: 0, skipped: 0, failed: [], watch: 0, cash: null, positions: 0 };

  if (mode !== 'watch_cash') {
    const existing = existingKeys(ledger);
    const rows = payload.trades
      .filter((t) => t && t.code)
      .sort((a, b) => String(a.trade_date || '').localeCompare(String(b.trade_date || '')));
    for (const trade of rows) {
      let code;
      try {
        ({ code } = normalizeCode(String(trade.code)));
      } catch {
        applied.failed.push({ code: String(trade.code || ''), error: '代码无法识别' });
        continue;
      }
      const key = [
        String(trade.trade_date || ''), code, String(trade.side || ''),
        round(num(trade.price) || 0, 3), Math.trunc(num(trade.shares) || 0),
      ].join('|');
      if (existing.has(key)) {
        applied.skipped += 1;
        continue;
      }
      try {
        ledger.recordTrade(code, String(trade.side || ''), num(trade.price), num(trade.shares), {
          tradeDate: String(trade.trade_date || ''),
          name: String(trade.name || ''),
          note: String(trade.note || ''),
          feeOverride: trade.fee === null || trade.fee === undefined ? null : num(trade.fee),
        });
        existing.add(key);
        applied.trades += 1;
      } catch (error) {
        applied.failed.push({ code, error: String(error?.message ?? error) });
      }
    }

    // 没有流水的持仓（手工维护的那种）按文件原样写入；有流水的以回放为准
    const tradedCodes = new Set(rows.map((t) => {
      try {
        return normalizeCode(String(t.code)).code;
      } catch {
        return String(t.code || '');
      }
    }));
    for (const pos of payload.positions) {
      const code = String(pos.code || '');
      if (!code || tradedCodes.has(code)) continue;
      const shares = Math.trunc(num(pos.shares) || 0);
      if (shares <= 0) continue;
      ledger._db((db) => {
        db.prepare(
          'INSERT INTO positions(code, name, shares, cost_price, opened_at, updated_at)'
          + ' VALUES (?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name,'
          + ' shares=excluded.shares, cost_price=excluded.cost_price, updated_at=excluded.updated_at',
        ).run(code, String(pos.name || ''), shares, num(pos.cost_price) || 0,
          String(pos.opened_at || todayIso()), nowText());
      });
      applied.positions += 1;
    }

    if (mode === 'all' && payload.cash !== null && payload.cash !== undefined) {
      ledger.setCash(Number(payload.cash));
      applied.cash = Number(payload.cash);
    }
  }

  if (mode !== 'trades') {
    for (const item of payload.watchlist) {
      const code = String(item.code || '');
      if (!code) continue;
      try {
        ledger.addWatch(code, String(item.name || ''), String(item.note || ''));
        applied.watch += 1;
      } catch {
        // 代码不合法就跳过，不让整批失败
      }
    }
    if (payload.cash !== null && payload.cash !== undefined) {
      ledger.setCash(Number(payload.cash));
      applied.cash = Number(payload.cash);
    }
  }

  return {
    ok: true,
    scope: mode,
    applied,
    errors: parsed.errors,
    message: `导入完成（${mode === 'all' ? '全量' : mode === 'watch_cash' ? '资金+自选' : '仅成交'}）：`
      + `成交 +${applied.trades}（重复跳过 ${applied.skipped}`
      + (applied.failed.length ? `，失败 ${applied.failed.length}` : '') + '），'
      + `手工持仓 +${applied.positions}，自选 +${applied.watch}`
      + (applied.cash !== null ? `，资金 ${applied.cash}` : ''),
  };
}

// ====================================================================== 自选导入

/** 解析自选股 JSON（`astock-watchlist-*.json`，也接受纯数组）。 */
export function parseWatchlistJson(text) {
  let payload;
  try {
    payload = JSON.parse(String(text ?? '').trim());
  } catch (error) {
    return { ok: false, items: [], errors: [`不是合法 JSON：${error?.message ?? error}`] };
  }
  const list = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.watchlist) ? payload.watchlist : null);
  if (!list) return { ok: false, items: [], errors: ['内容里没有 watchlist 数组'] };

  const items = [];
  const errors = [];
  for (const raw of list) {
    const codeRaw = typeof raw === 'string' ? raw : String(raw?.code || '');
    if (!codeRaw.trim()) continue;
    try {
      const { code } = normalizeCode(codeRaw);
      items.push({
        code,
        name: typeof raw === 'string' ? '' : String(raw.name || ''),
        note: typeof raw === 'string' ? '' : String(raw.note || ''),
      });
    } catch (error) {
      errors.push(`${codeRaw}：${error?.message ?? error}`);
    }
  }
  return { ok: true, items, errors };
}

/** 导入自选（默认只预览；`commit=true` 才写入，重复的按「更新名称/备注」处理）。 */
export function importWatchlist(ledger, text, { commit = false } = {}) {
  const parsed = parseWatchlistJson(text);
  if (!parsed.ok) return { ok: false, message: parsed.errors[0], errors: parsed.errors };
  const current = new Set(ledger.listWatch().map((w) => w.code));
  const added = [];
  const updated = [];
  for (const item of parsed.items) {
    if (current.has(item.code)) updated.push(item);
    else added.push(item);
  }
  if (!commit) {
    return {
      ok: true,
      committed: false,
      added,
      updated,
      errors: parsed.errors,
      message: `预览：新增 ${added.length} 只、已存在 ${updated.length} 只（会更新名称/备注）`,
    };
  }
  let saved = 0;
  const failed = [];
  for (const item of parsed.items) {
    try {
      ledger.addWatch(item.code, item.name, item.note);
      saved += 1;
    } catch (error) {
      failed.push(`${item.code}：${error?.message ?? error}`);
    }
  }
  return {
    ok: true,
    committed: true,
    added,
    updated,
    failed,
    errors: parsed.errors,
    message: `已导入 ${saved} 只自选` + (failed.length ? `，${failed.length} 只失败` : ''),
  };
}

// ====================================================================== 备份

/** 用 SQLite 的 `VACUUM INTO` 做一致快照（WAL 下也能拿到完整数据）。 */
export function sqliteBackup(source, target) {
  fs.mkdirSync(path.dirname(target) || '.', { recursive: true });
  try {
    fs.rmSync(target, { force: true });
  } catch {
    // 目标不存在是常态
  }
  const db = new DatabaseSync(source);
  try {
    db.exec(`VACUUM INTO '${String(target).replace(/'/g, "''")}'`);
  } finally {
    try { db.close(); } catch { /* 忽略 */ }
  }
}

function copyPlain(source, target) {
  fs.mkdirSync(path.dirname(target) || '.', { recursive: true });
  fs.copyFileSync(source, target);
}

/** 同一分钟内重复备份的判定窗口（毫秒）。 */
export const BACKUP_MIN_INTERVAL_MS = 60_000;

export function createBackup({ ledger, archive, minIntervalMs = BACKUP_MIN_INTERVAL_MS }) {
  const ledgerPath = ledger?.path || '';
  // 一分钟内连点：不生成新快照，只回一条提示（minIntervalMs=0 可关掉，测试用）
  if (minIntervalMs > 0) {
    try {
      const [latest] = listBackups(ledgerPath, 1);
      if (latest && latest.createdAt) {
        const age = Date.now() - new Date(String(latest.createdAt).replace(' ', 'T')).getTime();
        if (Number.isFinite(age) && age >= 0 && age < minIntervalMs) {
          return {
            ok: true,
            skipped: true,
            name: latest.name,
            sizeBytes: latest.sizeBytes,
            message: `刚备份过（${String(latest.createdAt).slice(11, 19)}），未重复创建`,
          };
        }
      }
    } catch {
      // 列不出来就照常备份，不能因为节流检查失败而阻止用户
    }
  }
  const archivePath = archive?.path || '';
  const root = backupRoot(ledgerPath);
  let folder = path.join(root, stamp());
  if (fs.existsSync(folder)) {
    // 同一秒内连点两次：加进程号后缀，别把上一份 meta 覆盖掉
    folder = `${folder}-${process.pid}`;
  }
  fs.mkdirSync(folder, { recursive: true });

  const files = [];
  const sources = [
    ['ledger', ledgerPath],
    ['archive', archivePath],
    // 净值曲线与最近回测也一起备份：换机器后不用重跑才有历史
    ['equity', equityPath(ledgerPath)],
    ['backtest', backtestPath(ledgerPath)],
  ];
  for (const [label, source] of sources) {
    if (!source || !fs.existsSync(source)) continue;
    const target = path.join(folder, path.basename(source));
    try {
      if (source.endsWith('.sqlite')) sqliteBackup(source, target);
      else copyPlain(source, target);
      files.push({ label, name: path.basename(source), bytes: fs.statSync(target).size });
    } catch (error) {
      files.push({
        label, name: path.basename(source), error: String(error?.message ?? error),
      });
    }
  }

  const meta = {
    createdAt: nowText(),
    ledgerPath,
    archivePath,
    files,
  };
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  return {
    ok: files.length > 0 && files.every((item) => !item.error),
    name: path.basename(folder),
    path: folder,
    files,
    message: files.length
      ? `已备份 ${files.length} 个文件到 ${path.basename(folder)}`
      : '没有可备份的台账/存档文件',
  };
}

export function listBackups(ledgerPath, limit = MAX_BACKUPS_LISTED) {
  const root = backupRoot(ledgerPath);
  if (!fs.existsSync(root)) return [];
  const items = [];
  for (const name of fs.readdirSync(root)) {
    const folder = path.join(root, name);
    let stat;
    try {
      stat = fs.statSync(folder);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(folder, 'meta.json'), 'utf8')) || {};
    } catch {
      meta = {};
    }
    let size = 0;
    try {
      for (const entry of fs.readdirSync(folder)) {
        if (entry === 'meta.json') continue;
        try {
          const st = fs.statSync(path.join(folder, entry));
          if (st.isFile()) size += st.size;
        } catch {
          // 单个文件读不到不影响列表
        }
      }
    } catch {
      size = 0;
    }
    items.push({
      name,
      createdAt: String(meta.createdAt || ''),
      files: meta.files || [],
      sizeBytes: size,
    });
  }
  items.sort((a, b) => (a.name < b.name ? 1 : (a.name > b.name ? -1 : 0)));
  const n = Math.max(1, Math.trunc(Number(limit) || MAX_BACKUPS_LISTED));
  return items.slice(0, n);
}

/**
 * 删除一份备份。
 *
 * 当天最新的一份不允许删：恢复是破坏性操作，留一份兜底比"删干净"重要。
 * 更早的备份可以删，避免目录无限增长。
 */
export function deleteBackup(ledgerPath, name) {
  const clean = String(name || '').trim();
  if (!clean || clean === '.' || clean === '..' || clean.includes('/') || clean.includes('\\')) {
    return { ok: false, message: '备份名称不合法' };
  }
  const root = backupRoot(String(ledgerPath || ''));
  const folder = path.join(root, clean);
  if (path.dirname(folder) !== root) return { ok: false, message: '备份名称不合法' };
  if (!fs.existsSync(folder)) return { ok: false, message: `备份 ${clean} 不存在` };

  const items = listBackups(ledgerPath, 500);
  const newest = items[0];
  const today = nowText().slice(0, 10);
  if (newest && newest.name === clean && String(newest.createdAt).startsWith(today)) {
    return { ok: false, message: '当天最新的备份不能删（留一份兜底），请先创建新备份' };
  }
  try {
    fs.rmSync(folder, { recursive: true, force: true });
  } catch (error) {
    return { ok: false, message: `删除失败：${error?.message ?? error}` };
  }
  return { ok: true, name: clean, message: `已删除备份 ${clean}` };
}

/** 从备份恢复台账与存档；恢复前**自动再备份一次**当前状态。 */
export function restoreBackup({ ledger, archive }, name) {
  const clean = path.basename(String(name || '').trim());
  if (clean === '' || clean === '.' || clean === '..') {
    return { ok: false, message: '没有指定要恢复的备份' };
  }
  const folder = path.join(backupRoot(ledger?.path || ''), clean);
  if (!fs.existsSync(folder)) return { ok: false, message: `备份 ${clean} 不存在` };

  // 恢复前的兜底备份不能被节流：哪怕一分钟内刚手动备份过，也要先保当前状态
  const safety = createBackup({ ledger, archive, minIntervalMs: 0 });
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(folder, 'meta.json'), 'utf8')) || {};
  } catch {
    return { ok: false, message: '备份缺少 meta.json，无法确定恢复目标' };
  }

  const targets = {
    ledger: ledger?.path || '',
    archive: archive?.path || '',
    equity: equityPath(ledger?.path || ''),
    backtest: backtestPath(ledger?.path || ''),
  };
  const restored = [];
  const failed = [];
  for (const item of meta.files || []) {
    const label = String(item.label || '');
    const source = path.join(folder, String(item.name || ''));
    const target = targets[label];
    if (!target || !fs.existsSync(source)) continue;
    try {
      if (source.endsWith('.sqlite')) {
        // 覆盖前必须清掉 -wal/-shm，否则旧 WAL 会被回放到新文件上
        for (const suffix of ['', '-wal', '-shm']) {
          try { fs.rmSync(`${target}${suffix}`, { force: true }); } catch { /* 忽略 */ }
        }
        copyPlain(source, target);
      } else {
        copyPlain(source, target);
      }
      restored.push(label);
    } catch (error) {
      failed.push(`${label}: ${error?.message ?? error}`);
    }
  }

  if (!restored.length) {
    return { ok: false, message: '备份里没有可恢复的文件', failed };
  }
  return {
    ok: true,
    restored,
    failed,
    safetyBackup: safety.name,
    message: `已恢复 ${restored.join('、')}`
      + (failed.length ? `；失败 ${failed.join('；')}` : '')
      + (safety.name ? `（恢复前已自动备份为 ${safety.name}）` : ''),
  };
}

// ====================================================================== 数据自愈

/**
 * 按**全部**流水重放，重建持仓与移动加权成本。
 *
 * 为什么不直接用 `ledger.rebuildPosition()`：它内部只取最近 500 笔流水，
 * 单只标的超过 500 笔时成本会算错且看不出来。这里从 `exportRows()` 取全量，
 * 口径与上游一致（买入金额+费用摊到股数，卖出不改成本价）。
 */
function replayPositions(ledger) {
  const rows = ledger.exportRows().trades || [];
  const grouped = new Map();
  for (const row of rows) {
    const code = String(row.code || '');
    if (!code) continue;
    if (!grouped.has(code)) grouped.set(code, []);
    grouped.get(code).push(row);
  }

  const results = [];
  ledger._db((db) => {
    for (const [code, trades] of grouped.entries()) {
      trades.sort((a, b) => {
        const da = String(a.trade_date || '');
        const dbb = String(b.trade_date || '');
        if (da !== dbb) return da < dbb ? -1 : 1;
        return Math.trunc(num(a.id) || 0) - Math.trunc(num(b.id) || 0);
      });
      let shares = 0;
      let cost = 0.0;
      let name = '';
      let opened = '';
      for (const trade of trades) {
        if (trade.name) name = String(trade.name);
        if (trade.side === 'buy') {
          if (!opened) opened = String(trade.trade_date || '');
          const total = cost * shares + (num(trade.amount) || 0) + (num(trade.fee) || 0);
          shares += Math.trunc(num(trade.shares) || 0);
          cost = shares ? round(total / shares, 4) : 0.0;
        } else {
          shares -= Math.trunc(num(trade.shares) || 0);
          if (shares <= 0) {
            shares = 0;
            cost = 0.0;
            opened = '';
          }
        }
      }
      if (shares > 0) {
        db.prepare(
          'INSERT INTO positions(code, name, shares, cost_price, opened_at,'
          + ' updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET'
          + ' name=excluded.name, shares=excluded.shares,'
          + ' cost_price=excluded.cost_price, updated_at=excluded.updated_at',
        ).run(code, name, shares, cost, opened, nowText());
      } else {
        db.prepare('DELETE FROM positions WHERE code=?').run(code);
      }
      results.push({
        code, name, shares, cost_price: round(cost, 4),
      });
    }
  });
  return results;
}

/** 按全部成交流水重放，重建持仓与移动加权成本（数据自愈）。 */
export function rebuildPositions(ledger) {
  const before = {};
  for (const p of ledger.listPositions()) {
    before[p.code] = {
      shares: Math.trunc(num(p.shares) || 0),
      cost: num(p.cost_price) || 0.0,
    };
  }
  let rebuilt;
  try {
    rebuilt = replayPositions(ledger);
  } catch (error) {
    return { ok: false, message: `重算失败：${error?.name ?? 'Error'}: ${error?.message ?? error}` };
  }

  const traded = new Set(rebuilt.map((item) => item.code));
  const untouched = Object.keys(before).filter((code) => !traded.has(code)).sort();
  for (const item of rebuilt) {
    const previous = before[item.code] || { shares: 0, cost: 0.0 };
    item.sharesBefore = Math.trunc(previous.shares);
    item.costBefore = round(previous.cost, 4);
  }
  const changed = rebuilt.filter((item) => (
    Math.trunc(num(item.shares) || 0) !== item.sharesBefore
    || Math.abs((num(item.cost_price) || 0) - item.costBefore) > 0.0001
  ));
  return {
    ok: true,
    rebuilt,
    changed,
    untouched,
    message: `已按流水重算 ${rebuilt.length} 只标的的持仓与成本`
      + (changed.length ? `，其中 ${changed.length} 只股数有变化` : '')
      + (untouched.length ? `；${untouched.length} 只有持仓但没有流水，已原样保留` : ''),
  };
}

// ====================================================================== 每日快照

async function indexQuote() {
  try {
    const quotes = await fetchQuotes(['000001'], 'index', { useCache: true });
    return quotes.length ? quotes[0] : null;
  } catch {
    // 指数取不到不影响持仓快照
    return null;
  }
}

function appendEquity(ledgerPath, record) {
  const file = equityPath(ledgerPath);
  const lines = [];
  if (fs.existsSync(file)) {
    try {
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const text = line.trim();
        if (!text) continue;
        let item;
        try {
          item = JSON.parse(text);
        } catch {
          continue;
        }
        if (String(item.date || '') !== record.date) lines.push(JSON.stringify(item));
      }
    } catch {
      lines.length = 0;
    }
  }
  lines.push(JSON.stringify(record));
  fs.mkdirSync(path.dirname(file) || '.', { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${lines.join('\n')}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function cnDateText(now = new Date()) {
  const d = nowCn(now);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function cnTimeText(now = new Date()) {
  const d = nowCn(now);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * 记一条收盘净值快照（同一天重复执行会覆盖当天那条）。
 *
 * 行情取不到时**不记**：`snapshot()` 在拿不到行情时会用成本价代替，那种
 * 净值点会把曲线拉出一条假的水平线，比少一个点更误导。
 */
export async function recordSnapshot(ledger, { now = new Date() } = {}) {
  const date = cnDateText(now);
  const snap = await snapshot(ledger, { includeWatch: false });
  const data = snap?.data || {};
  if ((data.positions || []).length && !Object.keys(data.quotes || {}).length) {
    return { date, skipped: '行情未取到，跳过净值快照' };
  }
  const equity = round(num(data.equity) || 0.0, 2);
  if (equity <= 0) return { date, skipped: '总资产为 0，跳过净值快照' };

  const index = await indexQuote();
  const record = {
    date,
    at: cnTimeText(now),
    equity,
    cash: round(num(data.cash) || 0.0, 2),
    marketValue: round(num(data.total_market_value) || 0.0, 2),
    floatPnl: round(num(data.float_pnl) || 0.0, 2),
    todayPnl: round(num(data.today_pnl) || 0.0, 2),
    positions: (data.positions || []).length,
    indexClose: round(num(index?.price), 2),
    indexChangePct: round(num(index?.change_pct), 2),
  };
  appendEquity(ledger.path, record);
  return record;
}

/** 读最近 N 条收盘快照（按日期升序，供画图）。 */
export function readEquityCurve(ledgerPath, limit = 60) {
  const file = equityPath(ledgerPath);
  if (!fs.existsSync(file)) return [];
  const items = [];
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;
      let item;
      try {
        item = JSON.parse(text);
      } catch {
        continue;
      }
      if (item && typeof item === 'object' && item.date) items.push(item);
    }
  } catch {
    return [];
  }
  items.sort((a, b) => (String(a.date) < String(b.date) ? -1 : 1));
  const n = Math.max(1, Math.trunc(Number(limit) || 60));
  return items.slice(-n);
}

// ====================================================================== 维护动作

/** 设置页「立即更新存档」：把持仓+自选的日 K 落库（同步，每只 1 次请求）。 */
export async function archiveRun(ledger, archive) {
  let codes;
  try {
    codes = ledger.listPositions().map((p) => p.code);
    codes = codes.concat(ledger.listWatch().map((w) => w.code));
  } catch (error) {
    return { ok: false, message: `读取台账/存档失败：${error?.message ?? error}` };
  }
  codes = [...new Set(codes.filter(Boolean))];
  if (!codes.length) {
    return { ok: false, message: '台账里没有持仓或自选股，先录入标的再更新存档' };
  }

  const fetchFn = async (code) => {
    const result = await fetchKlines(code, {
      period: 'day', limit: 640, adjust: 'none',
    });
    return result.bars || [];
  };

  let result;
  try {
    result = await updateFromProvider(archive, codes, fetchFn, 'raw', 640);
  } catch (error) {
    return { ok: false, message: `更新失败：${error?.message ?? error}` };
  }
  return {
    ok: true,
    message: `存档已更新：${result.updated.length} 只成功、`
      + `${result.failed.length} 只失败，写入 ${Number(result.total_saved).toLocaleString('zh-CN')} 根 K 线`,
  };
}

/** 回测结论 → 面板字段。 */
export function backtestPayload(hit) {
  if (!hit) return null;
  const result = hit.result;
  const rec = hit.recommendation;
  if (!result || !rec) return null;
  return {
    strategy: result.strategy || '',
    label: result.strategy_label || '',
    winRate: rec.win_rate ?? null,
    grade: rec.grade || '',
    gradeLabel: rec.label || '',
    sample: rec.sample ?? 0,
    avgExcessPct: rec.avg_excess_pct ?? null,
    maxDrawdownPct: rec.max_drawdown_pct ?? null,
    confidence: rec.confidence || '',
    reason: rec.reason || '',
    cached: Boolean(hit.cached),
    cacheAgeSec: hit.cache_age_sec ?? null,
    at: nowText(),
  };
}

/** 把本进程刚跑出的回测结论落盘（面板下次打开还能看到）。 */
export function persistBacktest(ledgerPath, payload) {
  if (!payload) return null;
  const file = backtestPath(ledgerPath);
  try {
    fs.mkdirSync(path.dirname(file) || '.', { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // 落盘失败不影响动作结果
  }
  return payload;
}

/** 读上一次落盘的回测结论（没有/坏了都返回 null）。 */
export function readBacktestResult(ledgerPath) {
  try {
    const payload = JSON.parse(fs.readFileSync(backtestPath(ledgerPath), 'utf8'));
    return payload && typeof payload === 'object' && payload.strategy ? payload : null;
  } catch {
    return null;
  }
}

/** 设置页「立即回测（出推荐率）」。 */
export async function backtestRun(ledger, archive, config = {}) {
  let key = String(config.pick_strategy || DEFAULT_STRATEGY).trim().toLowerCase();
  if (!STRATEGIES[key]) key = DEFAULT_STRATEGY;
  let out;
  try {
    out = await runBacktest(key, {
      useCache: false, ledger, archive,
    });
  } catch (error) {
    return {
      ok: false,
      message: `回测失败：${error?.name ?? 'Error'}: ${error?.message ?? error}。`
        + '若是接口限流，等 10-30 秒再点一次',
    };
  }
  const payload = backtestPayload(out);
  if (!payload) return { ok: false, message: '回测未产生结论' };
  persistBacktest(ledger.path, payload);
  if (payload.winRate === null || payload.winRate === undefined) {
    return { ok: false, message: `${payload.label}：${payload.reason}` };
  }
  const sign = (v) => (Number(v) >= 0 ? '+' : '');
  return {
    ok: true,
    message: `${payload.label} 推荐率 ${Math.round(payload.winRate)}%`
      + `（${payload.grade} 档·${payload.gradeLabel}；${payload.sample} 期样本，`
      + `可信度 ${payload.confidence}；平均超额 ${sign(payload.avgExcessPct)}`
      + `${Number(payload.avgExcessPct ?? 0).toFixed(2)}%，`
      + `最大回撤 ${Number(payload.maxDrawdownPct ?? 0).toFixed(1)}%）`,
  };
}

/** 存档状态（面板用；失败也给可读原因而不是白屏）。 */
export function archivePayload(archive) {
  let stats;
  try {
    stats = archive.stats();
  } catch (error) {
    return { ok: false, error: `存档读取失败：${error?.message ?? error}` };
  }
  stats.detail = (stats.detail || []).slice(0, 8);
  stats.ok = true;
  return stats;
}

/** 工作日 15:05：更新本地存档 + 记一条收盘净值。 */
export async function dailyMaintenance(ledger, archive) {
  const now = new Date();
  const today = cnDateText(now);
  if (!isTradingDay(now)) {
    return { ok: true, date: today, skipped: `${today} 非交易日` };
  }

  let hasCodes;
  try {
    hasCodes = ledger.listPositions().length > 0 || ledger.listWatch().length > 0;
  } catch {
    // 台账读不到也先把净值记下来
    hasCodes = true;
  }
  let archiveResult;
  if (!hasCodes) {
    archiveResult = { ok: true, message: '台账里没有持仓或自选股，跳过存档' };
  } else {
    try {
      archiveResult = await archiveRun(ledger, archive);
    } catch (error) {
      archiveResult = { ok: false, message: `存档更新失败：${error?.message ?? error}` };
    }
  }

  let snap;
  try {
    snap = await recordSnapshot(ledger, { now });
  } catch (error) {
    snap = { error: `净值快照失败：${error?.message ?? error}` };
  }

  return {
    ok: Boolean(archiveResult.ok) && !snap.error,
    date: today,
    archive: archiveResult,
    snapshot: snap,
  };
}

/** 「维护」面板数据（**不联网**：回测只读缓存）。 */
export function maintPayload({ ledger, archive, config = {} }) {
  const strategy = String(config.pick_strategy || DEFAULT_STRATEGY || '');

  let backtest = readBacktestResult(ledger.path);
  if (backtest === null && strategy) {
    try {
      backtest = backtestPayload(getCached(strategy));
    } catch {
      backtest = null;
    }
  }

  const curve = readEquityCurve(ledger.path, 30);
  let ledgerInfo;
  try {
    const rows = ledger.exportRows();
    ledgerInfo = {
      positions: (rows.positions || []).length,
      trades: (rows.trades || []).length,
      watchlist: (rows.watchlist || []).length,
      cash: round(num(((rows.cash || [{}])[0] || {}).balance), 2),
    };
  } catch (error) {
    ledgerInfo = { error: `台账读取失败：${error?.message ?? error}` };
  }

  return {
    view: 'maint',
    ok: true,
    renderedAt: nowText(),
    strategy,
    archive: archivePayload(archive),
    backtest,
    equity: { curve, latest: curve.length ? curve[curve.length - 1] : null },
    backups: listBackups(ledger.path, 6),
    ledger: ledgerInfo,
    paths: {
      dataDir: dataDir(ledger.path),
      ledger: ledger.path,
      archive: archive.path,
    },
    disclaimer: '存档只存不复权原始价；回测推荐率是历史统计，不是单只股票上涨的概率。',
  };
}

export { BOARD };
