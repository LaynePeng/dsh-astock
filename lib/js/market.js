/**
 * A 股市场规则：代码规范化 / 板块 / 涨跌停 / 费用 / 交易时段 / 数量单位。
 *
 * 与 上游 `astock_market.py` 逐项对齐（口径必须一致，否则 JS 与 Python
 * 两条路径会给出不同的涨跌停价、费用和「可买股数」）。
 */

export const BOARD = {
  MAIN: 'main',
  GEM: 'gem',
  STAR: 'star',
  BJ: 'bj',
  ETF: 'etf',
  INDEX: 'index',
  UNKNOWN: 'unknown',
};

export const BOARD_LABELS = {
  main: '沪深主板',
  gem: '创业板',
  star: '科创板',
  bj: '北交所',
  etf: '场内基金',
  index: '指数',
  unknown: '未知',
};

const BOARD_LIMIT = {
  main: 10.0,
  gem: 20.0,
  star: 20.0,
  bj: 30.0,
  etf: 10.0,
  index: 0.0,
  unknown: 10.0,
};

const VENUE_PREFIX = new Set(['sh', 'sz', 'bj']);

/** 6 位代码 → 板块。识别失败返回 unknown（不抛错）。 */
export function boardOf(code) {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) return BOARD.UNKNOWN;
  if (/^(600|601|603|605|000|001|002|003)/.test(c)) return BOARD.MAIN;
  if (/^(300|301)/.test(c)) return BOARD.GEM;
  if (/^(688|689)/.test(c)) return BOARD.STAR;
  if (/^(430|83|87|88|889|920)/.test(c)) return BOARD.BJ;
  if (/^(510|511|512|513|515|518|588|159|161|162)/.test(c)) return BOARD.ETF;
  if (/^(000|001|399|899|999)/.test(c)) return BOARD.MAIN;
  if (/^(5|15|16)/.test(c)) return BOARD.ETF;
  return BOARD.UNKNOWN;
}

export function boardLabel(board) {
  return BOARD_LABELS[board] || BOARD_LABELS.unknown;
}

/** 6 位代码 → 交易所前缀（指数与个股同码段，靠 kind 区分）。 */
export function guessVenue(code, kind = 'stock') {
  const c = String(code || '').trim();
  if (kind === 'index') {
    if (/^(000|880|999|5)/.test(c)) return 'sh';
    if (c.startsWith('399')) return 'sz';
    if (c.startsWith('899')) return 'bj';
  }
  if (boardOf(c) === BOARD.BJ) return 'bj';
  if (/^(6|5|9)/.test(c)) return 'sh';
  return 'sz';
}

/**
 * 任意输入 → { code, venue }。
 * 接受 600000 / sh600000 / 600000.SH / sz.000001；无法识别时抛错。
 */
export function normalizeCode(raw, kind = 'stock') {
  let text = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!text) throw new Error('代码为空');
  if (text.includes('.')) {
    const at = text.lastIndexOf('.');
    const left = text.slice(0, at);
    const right = text.slice(at + 1);
    if (VENUE_PREFIX.has(right)) text = right + left;
    else if (VENUE_PREFIX.has(left)) text = left + right;
    else text = left;
  }
  let prefix = '';
  for (const p of VENUE_PREFIX) {
    if (text.startsWith(p)) {
      prefix = p;
      text = text.slice(p.length);
      break;
    }
  }
  const match = text.match(/(\d{6})/);
  if (!match) {
    throw new Error(`无法识别代码 ${JSON.stringify(raw)}，请用 6 位代码（如 600000）`
      + '或带交易所前缀（如 sh600000 / 000001.sz）');
  }
  const code = match[1];
  const venue = prefix || guessVenue(code, kind);
  const expect = guessVenue(code, kind);
  if (prefix && prefix !== expect && boardOf(code) !== BOARD.INDEX) {
    throw new Error(`代码 ${code} 与交易所前缀 ${prefix} 不匹配（应为 ${expect}）`);
  }
  return { code, venue };
}

export function tencentSymbol(code, venue) {
  return `${venue}${code}`;
}

/** 涨跌幅限制（百分比）：板块 + ST 双重判断。 */
export function limitPct(code, name = '', kind = 'stock') {
  if (kind === 'index') return 0.0;
  const board = boardOf(code);
  if (kind === 'etf' || board === BOARD.ETF) return 10.0;
  const up = String(name || '').toUpperCase().replace(/\s+/g, '');
  if (up.includes('ST')) return 5.0;
  return BOARD_LIMIT[board] ?? 10.0;
}

/** (涨停价, 跌停价, 限制比例)，四舍五入到分。 */
export function limitPrices(prevClose, code, name = '', kind = 'stock') {
  const pct = limitPct(code, name, kind);
  const prev = Number(prevClose) || 0;
  if (pct <= 0 || !prev || prev <= 0) return { up: null, down: null, pct };
  return {
    up: roundPrice(prev * (1 + pct / 100.0)),
    down: roundPrice(prev * (1 - pct / 100.0)),
    pct,
  };
}

export function roundPrice(p) {
  return Math.round((Number(p) + 1e-9) * 100) / 100;
}

export function pctChange(newPrice, oldPrice) {
  const n = Number(newPrice);
  const o = Number(oldPrice);
  if (!o) return null;
  return Math.round(((n - o) / o * 100.0) * 100) / 100;
}

/** 宽容的数值转换（接口常返回 "" / "-" / "0.00" 占位）。 */
export function toFloat(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const text = String(value).trim().replace(/,/g, '');
  if (!text || ['-', '--', 'None', 'null', 'N/A'].includes(text)) return fallback;
  const n = Number(text);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------- 费用

export const DEFAULT_FEE = {
  commission_rate: 0.00025,
  min_commission: 5.0,
  stamp_tax_rate: 0.0005,
  transfer_fee_rate: 0.00001,
  other_rate: 0.0,
};

/**
 * 费用配置（用户设置页可覆盖）。
 * @param {object} [raw]
 */
export function feeConfig(raw = {}) {
  const pick = (key) => {
    const value = Number(raw?.[key]);
    return Number.isFinite(value) ? value : DEFAULT_FEE[key];
  };
  return {
    commission_rate: pick('commission_rate'),
    min_commission: pick('min_commission'),
    stamp_tax_rate: pick('stamp_tax_rate'),
    transfer_fee_rate: pick('transfer_fee_rate'),
    other_rate: pick('other_rate'),
  };
}

/** 按成交金额算费用。ETF 免印花税/过户费，指数不算费。 */
export function calcFee(amount, side, cfg = DEFAULT_FEE, board = BOARD.MAIN) {
  const zero = {
    commission: 0, stamp_tax: 0, transfer_fee: 0, other: 0, total: 0,
  };
  if (!(Number(amount) > 0)) return zero;
  if (board === BOARD.INDEX) return zero;
  const commission = Math.max(amount * cfg.commission_rate, cfg.min_commission);
  let stamp = 0;
  let transfer = 0;
  if (board !== BOARD.ETF) {
    if (side === 'sell') stamp = amount * cfg.stamp_tax_rate;
    transfer = amount * cfg.transfer_fee_rate;
  }
  const other = amount * cfg.other_rate;
  return {
    commission,
    stamp_tax: stamp,
    transfer_fee: transfer,
    other,
    total: round4(commission + stamp + transfer + other),
  };
}

export function feeBreakdownDict(fee) {
  return {
    commission: round4(fee.commission),
    stamp_tax: round4(fee.stamp_tax),
    transfer_fee: round4(fee.transfer_fee),
    other: round4(fee.other),
    total: round4(fee.total),
  };
}

function round4(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1e4) / 1e4;
}

// ---------------------------------------------------------------- 数量单位

export function lotSize(code) {
  return boardOf(code) === BOARD.STAR ? 200 : 100;
}

export function roundLot(shares, code) {
  const step = lotSize(code);
  const n = Number(shares);
  if (!(n > 0)) return 0;
  return Math.floor(n / step) * step;
}

/** 校验申报数量；合法返回 null，不合法返回中文原因。 */
export function checkOrderSize(shares, code, side, holding = 0) {
  const n = Number(shares) || 0;
  if (n <= 0) return '数量必须大于 0';
  if (side === 'buy') {
    const step = lotSize(code);
    if (n % step !== 0) return `买入数量必须是 ${step} 股的整数倍（本次 ${n} 股）`;
    if (n < step) return `买入数量不足最小单位 ${step} 股`;
    return null;
  }
  if (holding && n > holding) return `卖出数量 ${n} 股超过持仓 ${holding} 股`;
  if (n % 100 !== 0 && n !== holding) {
    return `卖出零股（${n % 100} 股部分）只能在一次性卖出全部剩余持仓时申报`;
  }
  return null;
}

// ---------------------------------------------------------------- 交易时段

export const SESSIONS = [
  ['09:15', '09:25', '开盘集合竞价'],
  ['09:25', '09:30', '集合竞价撮合'],
  ['09:30', '11:30', '上午连续竞价'],
  ['13:00', '14:57', '下午连续竞价'],
  ['14:57', '15:00', '收盘集合竞价'],
];

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 北京时间（UTC+8，不依赖 tzdata）。 */
export function nowCn(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600 * 1000);
}

function cnParts(now = new Date()) {
  const d = nowCn(now);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
    hhmm: `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`,
    seconds: d.getUTCSeconds(),
  };
}

export function isTradingDay(now = new Date()) {
  const { weekday } = cnParts(now);
  // JS: 周日=0 … 周六=6（Python weekday() 是周一=0，别照抄）
  return weekday >= 1 && weekday <= 5;
}

export function tradingStatus(now = new Date()) {
  const p = cnParts(now);
  let phase = '休市';
  let isOpen = false;
  if (p.weekday >= 1 && p.weekday <= 5) {
    for (const [start, end, label] of SESSIONS) {
      if (p.hhmm >= start && p.hhmm < end) {
        phase = label;
        isOpen = true;
        break;
      }
    }
    if (!isOpen) {
      if (p.hhmm < '09:15') phase = '开盘前';
      else if (p.hhmm >= '15:00') phase = '已收盘';
      else if (p.hhmm >= '11:30' && p.hhmm < '13:00') phase = '午间休市';
    }
  } else {
    phase = '非交易日（周末）';
  }
  const stamp = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
    + ` ${p.hhmm}:${String(p.seconds).padStart(2, '0')}`;
  return {
    open: isOpen,
    phase,
    now: stamp,
    is_trading_day: p.weekday >= 1 && p.weekday <= 5,
  };
}

/** 把交易时段状态包成给 Agent 的一段说明（避免把收盘价当实时价）。 */
export function marketContext(now = new Date()) {
  const st = tradingStatus(now);
  let text;
  if (st.open) text = `当前处于${st.phase}，价格为实时行情。`;
  else if (st.phase === '已收盘') {
    text = '当前已收盘，显示的为当日收盘价（不会再变动）；如需操作请规划到下一交易日。';
  } else if (st.phase === '午间休市') text = '当前午间休市，价格为上午收盘价。';
  else if (st.phase === '开盘前') text = '当前开盘前，价格为上一交易日收盘价。';
  else text = `当前${st.phase}，价格为上一交易日收盘价。`;
  return { ...st, text };
}

/** 兼容旧名：交易时段说明（面板/工具里的短句）。 */
export function marketClock(now = new Date()) {
  const st = tradingStatus(now);
  return { open: st.open, text: st.phase };
}

/** 解析"开始盯盘"时刻，非法值退回 09:15 - lead。 */
export function resolveWatchStart(startHhmm = '', leadMinutes = 5) {
  if (typeof startHhmm === 'string' && HHMM_RE.test(startHhmm.trim())) {
    return startHhmm.trim();
  }
  return `09:${String(Math.max(0, 15 - Math.max(0, leadMinutes))).padStart(2, '0')}`;
}

export function shouldWatchNow(now = new Date(), {
  leadMinutes = 5, startHhmm = '',
} = {}) {
  const p = cnParts(now);
  if (p.weekday === 0 || p.weekday === 6) return { watch: false, reason: '周末休市，无需盯盘' };
  const start = resolveWatchStart(startHhmm, leadMinutes);
  if (p.hhmm < start) return { watch: false, reason: `开盘前（早于 ${start}）` };
  if (p.hhmm >= '15:00') return { watch: false, reason: '已收盘（15:00 后价格不再变动）' };
  if (p.hhmm >= '11:30' && p.hhmm < '13:00') return { watch: false, reason: '午间休市' };
  return { watch: true, reason: tradingStatus(now).phase };
}
