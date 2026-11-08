/**
 * 成交回单解析——上游 `astock_receipt.py` 的 Node 移植。
 *
 * 宽容解析 + 保守落账：识别不出的行进 `unparsed`，绝不猜。
 */

import { roundPrice, toFloat } from './market.js';
import { compensatedSum } from './formula.js';

const COLUMN_ALIASES = {
  code: ['证券代码', '股票代码', '代码', '证券编码', 'code', 'stock_code', 'symbol'],
  name: ['证券名称', '股票名称', '名称', 'name', 'stock_name'],
  side: ['买卖标志', '买卖方向', '操作', '委托类别', '业务名称', 'side',
    'direction', '买卖', '交易类别'],
  price: ['成交价格', '成交均价', '价格', '成交价', 'price', 'avg_price', 'deal_price'],
  shares: ['成交数量', '成交股数', '数量', '股数', 'shares', 'volume',
    'qty', 'quantity', '成交笔数'],
  amount: ['成交金额', '金额', 'amount', 'turnover', '发生金额'],
  fee: ['手续费', '佣金', '费用', '交易费用', 'fee', 'commission', '总费用'],
  date: ['成交日期', '发生日期', '日期', 'date', '委托日期', 'trade_date'],
  time: ['成交时间', '时间', 'time'],
  stamp: ['印花税'],
  transfer: ['过户费'],
};

const BUY_WORDS = ['买入', '买', '证券买入', 'buy', 'b', '担保品买入'];
const SELL_WORDS = ['卖出', '卖', '证券卖出', 'sell', 's', '担保品卖出'];

export class ParsedTrade {
  constructor(data = {}) {
    Object.assign(this, {
      code: '',
      name: '',
      side: '',
      price: null,
      shares: null,
      amount: null,
      fee: null,
      trade_date: '',
      raw: '',
      confidence: 'high',
      evidence: [],
      problems: [],
    }, data);
  }

  get ok() {
    return this.problems.length === 0;
  }

  asDict() {
    return {
      code: this.code,
      name: this.name,
      side: this.side,
      price: this.price,
      shares: this.shares,
      amount: this.amount,
      fee: this.fee,
      trade_date: this.trade_date,
      confidence: this.confidence,
      problems: [...this.problems],
    };
  }
}

/** 全角→半角、去千分位、统一符号。 */
export function norm(text) {
  if (!text) return '';
  const out = [];
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code === 0x3000) out.push(' ');
    else if (code >= 0xFF01 && code <= 0xFF5E) out.push(String.fromCharCode(code - 0xFEE0));
    else if (ch === '，' || ch === '、') out.push(',');
    else if (ch === '：') out.push(':');
    else out.push(ch);
  }
  return out.join('').replace(/−/g, '-').replace(/—/g, '-').replace(/＋/g, '+').trim();
}

const NUM_RE = /-?\d+(?:\.\d+)?/;

/** 从任意文本取第一个数（支持 "+1,234.50"、"1.23万"）。 */
export function num(text) {
  if (text === null || text === undefined) return null;
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  const s = norm(String(text)).replace(/,/g, '');
  if (!s) return null;
  const m = s.match(NUM_RE);
  if (!m) return null;
  let value = Number(m[0]);
  if (!Number.isFinite(value)) return null;
  if (s.includes('万')) value *= 10000;
  return value;
}

export function sideOf(text) {
  const t = norm(text).toLowerCase();
  if (!t) return '';
  for (const word of SELL_WORDS) if (t.includes(word)) return 'sell';
  for (const word of BUY_WORDS) if (t.includes(word)) return 'buy';
  return '';
}

const DATE_PATTERNS = [
  /(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/,
  /(20\d{2})(\d{2})(\d{2})/,
];

export function dateOf(text) {
  const s = norm(text || '');
  for (const pattern of DATE_PATTERNS) {
    const m = s.match(pattern);
    if (m) {
      const y = m[1];
      const mo = Number(m[2]);
      const d = Number(m[3]);
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      }
    }
  }
  return '';
}

function splitCsvLine(line, delim) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      cells.push(cell);
      cell = '';
    } else cell += ch;
  }
  cells.push(cell);
  return cells;
}

/** 识别分隔符并切表；返回 [表头, 数据行]。 */
export function splitTable(text) {
  const raw = norm(text);
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [[], []];
  const sample = lines[0];
  for (const delim of ['\t', ',', '|']) {
    if (sample.split(delim).length - 1 >= 2) {
      const rows = lines.map((line) => splitCsvLine(line, delim));
      const header = (rows[0] || []).map((c) => c.trim());
      return [header, rows.slice(1)
        .map((r) => r.map((c) => c.trim()))
        .filter((r) => r.some((c) => c.trim()))];
    }
  }
  const header = sample.trim().split(/\s{2,}|\s+/);
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = line.trim().split(/\s{2,}|\s+/);
    if (cells.length >= Math.max(3, header.length - 2)) rows.push(cells);
  }
  return [header, rows];
}

/** 表头 → { 语义: 列号 }，按别名最长匹配。 */
export function mapColumns(header) {
  const idx = {};
  const used = new Set();
  const normHeader = header.map((h) => norm(h).toLowerCase());
  const pairs = [];
  for (const [semantic, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      normHeader.forEach((h, i) => {
        if (h && h.includes(alias.toLowerCase())) {
          pairs.push({ len: alias.length, semantic, index: i });
        }
      });
    }
  }
  pairs.sort((a, b) => {
    if (b.len !== a.len) return b.len - a.len;
    if (a.semantic !== b.semantic) return a.semantic < b.semantic ? 1 : -1;
    return Number(b.index) - Number(a.index);
  });
  for (const pair of pairs) {
    if (idx[pair.semantic] !== undefined) continue;
    if (used.has(pair.index)) continue;
    idx[pair.semantic] = pair.index;
    used.add(pair.index);
  }
  return idx;
}

function cleanCode(raw) {
  const m = norm(raw || '').match(/\d{6}/);
  return m ? m[0] : '';
}

function toInt(raw) {
  const v = num(raw);
  if (v === null) return null;
  return Math.trunc(Math.abs(v));
}

/** 从带表头的表格文本解析。 */
export function parseCsv(text) {
  const [header, rows] = splitTable(text);
  if (!header.length || !rows.length) return [];
  const col = mapColumns(header);
  if (col.code === undefined) return [];
  const out = [];
  for (const row of rows) {
    const cell = (key) => {
      const i = col[key];
      return i !== undefined && i < row.length ? String(row[i] || '').trim() : '';
    };
    const code = cleanCode(cell('code'));
    if (!code) continue;
    const trade = new ParsedTrade({
      code,
      name: cell('name'),
      side: sideOf(cell('side')),
      price: num(cell('price')),
      shares: toInt(cell('shares')),
      amount: num(cell('amount')),
      trade_date: dateOf(cell('date')),
      raw: row.join(','),
      confidence: 'high',
      evidence: [`csv:${Object.keys(col).sort().join(',')}`],
    });
    const feeBits = [];
    for (const key of ['fee', 'stamp', 'transfer']) {
      const v = num(cell(key));
      if (v) feeBits.push(v);
    }
    if (feeBits.length) trade.fee = Math.round(compensatedSum(feeBits) * 100) / 100;
    finalize(trade);
    out.push(trade);
  }
  return out;
}

/** 按行解析（无表头场景）。 */
export function parseLines(text) {
  const out = [];
  for (const line of norm(text).split(/\r?\n/)) {
    const ln = line.trim();
    if (!ln || ln.length < 6) continue;
    if (/证券代码|成交|买卖/.test(ln) && !/\d{6}/.test(ln)) continue;
    const m = ln.match(/(?<!\d)(\d{6})(?!\d)/);
    if (!m) continue;
    const trade = new ParsedTrade({
      code: m[1], raw: ln, confidence: 'medium', evidence: ['line'],
    });
    trade.side = sideOf(ln);
    trade.trade_date = dateOf(ln);
    let rest = ln.replace(m[1], ' ');
    if (trade.trade_date) {
      rest = rest.replace(trade.trade_date, ' ')
        .replace(trade.trade_date.replace(/-/g, ''), ' ');
    }
    const tokens = rest.split(/[\s,]+/).filter(Boolean);
    const nums = [];
    tokens.forEach((token, i) => {
      const v = num(token);
      if (v !== null) nums.push([i, v]);
    });
    const picked = pickPriceShares(nums);
    trade.price = picked.price;
    trade.shares = picked.shares;
    finalize(trade);
    out.push(trade);
  }
  return out;
}

/** 从一行数字里挑出「价格」和「股数」。 */
export function pickPriceShares(nums) {
  if (!nums.length) return { price: null, shares: null };
  let priceIdx = null;
  let price = null;
  for (const [i, v] of nums) {
    if (v !== null && Math.abs(v - Math.round(v)) > 1e-9 && v > 0) {
      priceIdx = i;
      price = v;
      break;
    }
  }
  if (price === null) {
    priceIdx = nums[0][0];
    price = nums[0][1];
  }
  const after = nums.filter(([i, v]) => priceIdx !== null && i > priceIdx
    && v !== null && v > 0);
  const lots = after
    .filter(([, v]) => v === Math.trunc(v) && v >= 100 && Math.trunc(v) % 100 === 0)
    .map(([i, v]) => [i, Math.trunc(v)]);
  let shares = null;
  if (lots.length) {
    shares = Math.min(...lots.map(([, v]) => v));
  } else if (after.length) {
    shares = Math.trunc(after[0][1]);
  }
  return { price, shares };
}

/** 补齐/校验单笔成交。问题写进 problems（不抛错）。 */
export function finalize(trade) {
  if (!trade.side) trade.problems.push('识别不出买卖方向');
  if (trade.shares === null || trade.shares <= 0) trade.problems.push('识别不出成交数量');
  if (trade.price === null || trade.price <= 0) trade.problems.push('识别不出成交价格');
  if (trade.shares && trade.price && trade.amount) {
    const calc = Math.round(trade.shares * trade.price * 100) / 100;
    if (calc > 0 && Math.abs(calc - trade.amount) / Math.max(calc, 1) > 0.02) {
      trade.problems.push(
        `金额校验不符：${trade.shares}×${trade.price}=${calc.toFixed(2)} 但回单金额 ${trade.amount.toFixed(2)}`,
      );
      trade.confidence = 'low';
    }
  }
  if (trade.price) trade.price = roundPrice(trade.price);
}

/** 统一入口：自动判断表格 / 逐行。 */
export function parseReceipt(text) {
  const raw = String(text || '').trim();
  if (!raw) return {
    trades: [], unparsed: [], method: 'empty', duplicates_removed: 0, usable: [],
  };

  let trades = [];
  let method = '';
  if (raw.includes('\n')) {
    const csvTrades = parseCsv(raw);
    if (csvTrades.length) {
      trades = csvTrades;
      method = 'csv';
    }
  }
  if (!trades.length) {
    const lineTrades = parseLines(raw);
    if (lineTrades.length) {
      trades = lineTrades;
      method = 'lines';
    }
  }

  const seen = new Set();
  const deduped = [];
  let dups = 0;
  for (const trade of trades) {
    const key = `${trade.code}|${trade.side}|${trade.price || 0}|${trade.shares || 0}`;
    if (seen.has(key)) {
      dups += 1;
      continue;
    }
    seen.add(key);
    deduped.push(trade);
  }

  const bad = deduped.filter((trade) => !trade.ok);
  return {
    trades: deduped,
    unparsed: bad.map((trade) => trade.raw),
    method: method || 'none',
    duplicates_removed: dups,
    usable: deduped.filter((trade) => trade.ok),
  };
}

export { toFloat };
