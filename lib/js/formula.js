/**
 * 技术公式库（纯函数 · 零网络）——上游 `astock_formula.py` 的 JS 移植。
 *
 * 口径与上游逐条对齐（改之前先读本文件顶部的口径说明）：
 *   1. 缺数据返回 null，绝不用 0 代替；
 *   2. 价格 round 2，均线/比率 round 4；
 *   3. 序列按日期升序，最后一个是"最新"；
 *   4. 均线看复权（qfq），成交价看原始（raw），两者不可混用；
 *   5. 只做统计，不预测。
 */

export const TRADING_DAYS_PER_YEAR = 244;
export const MA_DRIFT_THRESHOLD_PCT = 1.0;

/**
 * Python 的 round 是"银行家舍入"（.5 取偶），JS 的 Math.round 是 .5 向上。
 * 财务数字差一位就会误导人，所以这里显式模拟 Python 的舍入。
 *
 * **不能只看 `n*10^d` 的小数部分**：9.8035 在 double 里其实是
 * 9.8034999999999996…，Python `round(9.8035, 3)` = 9.803，而先乘再判
 * 会把它当成精确的 .5 抬成 9.804（K 线 MA20 就踩过这个坑）。
 * 这里用 `toFixed` 拿到二进制值的十进制展开，再按"是否真的恰好 .5"
 * 决定银行家舍入还是普通四舍五入。
 */
export function pyRound(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (digits < 0 || digits > 20) return Math.round(n * 10 ** digits) / 10 ** digits;
  const negative = n < 0;
  const abs = Math.abs(n);
  // toFixed 上限 100；多取 25 位足以判断目标位之后是否全 0（真 .5）
  const fixed = abs.toFixed(Math.min(100, digits + 25));
  const [intPart, fracPart = ''] = fixed.split('.');
  const kept = fracPart.slice(0, digits).padEnd(digits, '0');
  const rest = fracPart.slice(digits);
  const first = rest[0] || '0';
  const isTie = first === '5' && /^0*$/.test(rest.slice(1));
  let scaled = BigInt(intPart + kept);
  if (isTie) {
    if (scaled % 2n === 1n) scaled += 1n;
  } else if (Number(first) >= 5) {
    scaled += 1n;
  }
  const result = Number(scaled) / 10 ** digits;
  return negative ? -result : result;
}

/** Neumaier 补偿求和：Python 3.12 的 `sum()` 对浮点用这个，naive reduce 会差 1e-15。 */
export function compensatedSum(values) {
  let sum = 0;
  let compensation = 0;
  for (const value of values) {
    const v = Number(value);
    const t = sum + v;
    if (Math.abs(sum) >= Math.abs(v)) compensation += (sum - t) + v;
    else compensation += (v - t) + sum;
    sum = t;
  }
  return sum + compensation;
}

export function mean(values) {
  const vals = (values || []).filter((v) => v !== null && v !== undefined).map(Number);
  if (!vals.length) return null;
  return compensatedSum(vals) / vals.length;
}

export function stdev(values, sample = true) {
  const vals = (values || []).filter((v) => v !== null && v !== undefined).map(Number);
  const n = vals.length;
  if (n < (sample ? 2 : 1)) return null;
  const m = compensatedSum(vals) / n;
  const denom = sample ? n - 1 : n;
  return Math.sqrt(compensatedSum(vals.map((v) => (v - m) ** 2)) / denom);
}

export function safeDiv(a, b, fallback = null) {
  if (a === null || a === undefined || b === null || b === undefined) return fallback;
  const denom = Number(b);
  if (!denom) return fallback;
  return Number(a) / denom;
}

/** A 股报价最小变动 0.01（+1e-9 抵消浮点尾差）。 */
export function roundPrice(p) {
  return pyRound(Number(p) + 1e-9, 2);
}

export function sma(closes, n, digits = 4) {
  if (!n || n <= 0) return null;
  const vals = (closes || []).filter((c) => c).map(Number);
  if (vals.length < n) return null;
  const slice = vals.slice(-n);
  return pyRound(compensatedSum(slice) / n, digits);
}

export function maSet(closes, periods = [5, 10, 20, 60]) {
  const out = {};
  for (const n of periods) out[`ma${n}`] = sma(closes, n);
  return out;
}

export function deviationPct(price, baseline, digits = 2) {
  if (baseline === null || baseline === undefined || !baseline) return null;
  return pyRound((Number(price) - Number(baseline)) / Number(baseline) * 100.0, digits);
}

export function maPosition(price, mas) {
  const above = [];
  const below = [];
  for (const key of ['ma5', 'ma10', 'ma20', 'ma60']) {
    const v = mas?.[key];
    if (v === null || v === undefined) continue;
    const label = key.toUpperCase();
    (Number(price) > Number(v) ? above : below).push(label);
  }
  if (!above.length && !below.length) return '均线数据不足';
  if (!below.length) return `在 ${above.join('/')} 全部上方（强势）`;
  if (!above.length) return `在 ${below.join('/')} 全部下方（弱势）`;
  return `上方 ${above.join('/')}；下方 ${below.join('/')}`;
}

export function alignmentScore(price, mas) {
  const m5 = mas?.ma5;
  const m10 = mas?.ma10;
  const m20 = mas?.ma20;
  if (m5 === null || m5 === undefined || m10 === null || m10 === undefined
    || m20 === null || m20 === undefined) return null;
  let score = 0;
  if (Number(price) > Number(m5)) score += 1;
  if (Number(m5) > Number(m10)) score += 1;
  if (Number(m10) > Number(m20)) score += 1;
  return score;
}

export function dividendAdjustFactor(prevClose, dividendPerShare, digits = 6) {
  if (!prevClose || Number(prevClose) <= 0) return 1.0;
  if (dividendPerShare === null || dividendPerShare === undefined
    || Number(dividendPerShare) < 0) return 1.0;
  return pyRound((Number(prevClose) - Number(dividendPerShare)) / Number(prevClose), digits);
}

export function maDistortionEstimate(prevClose, dividendPerShare, n, digits = 3) {
  const factor = dividendAdjustFactor(prevClose, dividendPerShare);
  if (factor >= 1.0) return null;
  return pyRound(-(1.0 - factor) * 100.0, digits);
}

export function momentumPct(closes, n, digits = 2) {
  const vals = (closes || []).filter((c) => c).map(Number);
  if (vals.length <= n) return null;
  const base = vals[vals.length - (n + 1)];
  if (!base) return null;
  return pyRound((vals[vals.length - 1] - base) / base * 100.0, digits);
}

export function rsi(closes, period = 14) {
  const vals = (closes || []).filter((c) => c).map(Number);
  if (vals.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = vals.length - period; i < vals.length; i += 1) {
    const diff = vals[i] - vals[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (gains + losses === 0) return 50.0;
  if (losses === 0) return 100.0;
  const rs = (gains / period) / (losses / period);
  return pyRound(100.0 - 100.0 / (1.0 + rs), 2);
}

export function volatilityAnnualPct(closes, window = 20, digits = 2) {
  const vals = (closes || []).filter((c) => c).map(Number);
  if (vals.length < 2) return null;
  const rets = [];
  const start = Math.max(1, vals.length - window);
  for (let i = start; i < vals.length; i += 1) {
    const prev = vals[i - 1];
    if (prev) rets.push((vals[i] - prev) / prev);
  }
  const sd = stdev(rets);
  if (sd === null) return null;
  return pyRound(sd * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100.0, digits);
}

export function annualizePct(totalReturnPct, days, digits = 2) {
  if (!days || days <= 0) return null;
  return pyRound(Number(totalReturnPct) * (TRADING_DAYS_PER_YEAR / days), digits);
}

export function maxDrawdown(values) {
  const vals = (values || []).filter((v) => v !== null && v !== undefined).map(Number);
  if (vals.length < 2) return null;
  let peak = vals[0];
  let peakI = 0;
  let worst = 0.0;
  let wi = 0;
  let wj = 0;
  for (let i = 0; i < vals.length; i += 1) {
    const v = vals[i];
    if (v > peak) {
      peak = v;
      peakI = i;
    }
    if (peak > 0) {
      const dd = (v - peak) / peak * 100.0;
      if (dd < worst) {
        worst = dd;
        wi = peakI;
        wj = i;
      }
    }
  }
  return {
    pct: pyRound(worst, 2),
    peak_idx: wi,
    trough_idx: wj,
    peak: pyRound(vals[wi], 4),
    trough: pyRound(vals[wj], 4),
  };
}

export function posInRangePct(price, low, high, digits = 2) {
  if (!high || Number(high) <= Number(low)) return null;
  return pyRound((Number(price) - Number(low)) / (Number(high) - Number(low)) * 100.0, digits);
}

export function drawdownFromHighPct(price, high, digits = 2) {
  if (!high) return null;
  return pyRound((Number(price) - Number(high)) / Number(high) * 100.0, digits);
}

export function riskAdjustedRatio(totalReturnPct, maxDdPct, digits = 2) {
  if (totalReturnPct === null || totalReturnPct === undefined
    || maxDdPct === null || maxDdPct === undefined) return null;
  const dd = Math.abs(Number(maxDdPct));
  if (dd <= 0) return null;
  return pyRound(Number(totalReturnPct) / dd, digits);
}

export function weightedAvgCost(oldShares, oldCost, addShares, addPrice, fee = 0.0, digits = 4) {
  if (addShares <= 0) return null;
  const oldTotal = Math.max(0, Number(oldShares)) * Number(oldCost);
  const newTotal = Number(addShares) * Number(addPrice) + Number(fee || 0);
  const totalShares = Math.max(0, Number(oldShares)) + Number(addShares);
  if (totalShares <= 0) return null;
  return pyRound((oldTotal + newTotal) / totalShares, digits);
}

export function breakevenPrice(buyPrice, shares, buyFee = 0.0, sellFeeRate = 0.0, digits = 4) {
  if (shares <= 0 || !buyPrice) return null;
  const costTotal = Number(buyPrice) * Number(shares) + Number(buyFee || 0);
  const rate = Number(sellFeeRate || 0);
  if (rate >= 1) return null;
  return pyRound(costTotal / (Number(shares) * (1 - rate)), digits);
}

export function stopTakePrices(cost, stopPct, takePct) {
  if (!cost) return { stop: null, take: null };
  return {
    stop: roundPrice(Number(cost) * (1 - Math.abs(Number(stopPct)) / 100.0)),
    take: roundPrice(Number(cost) * (1 + Math.abs(Number(takePct)) / 100.0)),
  };
}

export function riskRewardRatio(entry, stop, target, digits = 2) {
  const risk = Number(entry) - Number(stop);
  if (risk <= 0) return null;
  return pyRound((Number(target) - Number(entry)) / risk, digits);
}

export function positionShares(cash, price, {
  equity = null, maxPositionPct = null, lot = 100, cashUsagePct = 100.0,
} = {}) {
  if (price === null || price === undefined || Number(price) <= 0) {
    return { shares: 0, amount: 0.0, binding: '价格非法', cash_left: pyRound(Number(cash || 0), 2) };
  }
  const p = Number(price);
  const budget = Math.max(0, Number(cash || 0))
    * Math.min(100, Math.max(0, Number(cashUsagePct))) / 100.0;
  let binding = '可用现金';
  let capBudget = budget;
  if (equity && maxPositionPct) {
    const cap = Number(equity) * Number(maxPositionPct) / 100.0;
    if (cap < capBudget) {
      capBudget = cap;
      binding = '单票上限';
    }
  }
  const unit = lot > 0 ? Number(lot) : 100;
  const shares = Math.floor(capBudget / (p * unit)) * unit;
  const amount = pyRound(shares * p, 2);
  return {
    shares,
    amount,
    binding: shares > 0 ? binding : `${binding}不足一手`,
    cash_left: pyRound(Number(cash || 0) - amount, 2),
  };
}

const OP_SIDE = {
  lt: ['跌破', 'above'],
  le: ['跌破或触及', 'above'],
  gt: ['站上', 'below'],
  ge: ['站上或触及', 'below'],
};

export function checkRuleDirection(price, rulePrice, op) {
  if (price === null || price === undefined || rulePrice === null || rulePrice === undefined) {
    return { ok: false, side: 'unknown', distance_pct: null, reason: '价格或规则价缺失' };
  }
  const opKey = String(op || 'lt').toLowerCase();
  if (!OP_SIDE[opKey]) {
    return { ok: false, side: 'unknown', distance_pct: null,
      reason: `未知操作符 ${JSON.stringify(opKey)}（只支持 lt/le/gt/ge）` };
  }
  const p = Number(price);
  const r = Number(rulePrice);
  const side = Math.abs(p - r) < 1e-9 ? 'flat' : (p > r ? 'above' : 'below');
  const want = OP_SIDE[opKey][1];
  const distance = r ? pyRound((p - r) / r * 100.0, 2) : null;
  if (side === 'flat') {
    return { ok: false, side, distance_pct: 0.0,
      reason: `现价与规则价相同（${r}），方向已到位，规则随时触发一次` };
  }
  if (side === want) {
    return { ok: true, side, distance_pct: distance,
      reason: `有效：现价 ${p} 在规则价 ${r} ${side === 'above' ? '上方' : '下方'}，`
        + `距触发 ${Math.abs(distance).toFixed(2)}%` };
  }
  return { ok: false, side, distance_pct: distance,
    reason: `⚠️ 方向已失效：${OP_SIDE[opKey][0]} ${r} 需要现价在`
      + `${want === 'above' ? '上方' : '下方'}，实际 ${p} 已在`
      + `${side === 'below' ? '下方' : '上方'}——这条规则不会按预期生效，应改 op 或改价` };
}

function pickMa(entry, maKey) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'object') {
    if (entry[maKey] !== undefined && entry[maKey] !== null) return entry[maKey];
    const norm = String(maKey).toLowerCase().replace(/_/g, '');
    for (const [key, value] of Object.entries(entry)) {
      if (String(key).toLowerCase().replace(/_/g, '') === norm) return value;
    }
    return null;
  }
  const n = Number(entry);
  return Number.isFinite(n) ? n : null;
}

export function checkMaDrift(rulePrice, maValue, thresholdPct = MA_DRIFT_THRESHOLD_PCT) {
  if (maValue === null || maValue === undefined || !maValue) {
    return { drift_pct: null, need_update: false, suggest: null, reason: '均线数据不足，无法校验' };
  }
  const r = Number(rulePrice);
  const m = Number(maValue);
  const drift = pyRound((r - m) / m * 100.0, 2);
  const need = Math.abs(drift) > Math.abs(Number(thresholdPct));
  const suggest = need ? roundPrice(m) : null;
  const thresholdText = Number.isInteger(Number(thresholdPct))
    ? `${Number(thresholdPct)}.0` : String(thresholdPct);
  const reason = need
    ? `⚠️ 需更新：规则价 ${r} vs 均线 ${m}，偏差 ${drift >= 0 ? '+' : ''}${drift.toFixed(2)}%`
      + `（阈值 ±${thresholdText}%）→ 建议改为 ${suggest}`
    : `可保留：规则价 ${r} vs 均线 ${m}，偏差 ${drift >= 0 ? '+' : ''}${drift.toFixed(2)}%`
      + `（阈值 ±${thresholdText}%）`;
  return { drift_pct: drift, need_update: need, suggest, reason };
}

export function checkRuleSet(rules, quotes, maMap = null) {
  const out = [];
  for (const rule of rules || []) {
    const code = String(rule.code || '');
    const price = quotes?.[code] ?? null;
    const direction = checkRuleDirection(price, rule.price, rule.op);
    const row = {
      code,
      label: rule.label || '',
      rule_price: rule.price,
      op: rule.op,
      price,
      direction_ok: direction.ok,
      distance_pct: direction.distance_pct,
      problems: [],
    };
    if (!direction.ok) row.problems.push(direction.reason);
    const maKey = String(rule.ma_key || '').trim();
    if (maMap && maKey) {
      row.ma_key = maKey;
      const drift = checkMaDrift(rule.price, pickMa(maMap[code], maKey));
      row.drift_pct = drift.drift_pct;
      row.suggest_price = drift.suggest;
      if (drift.need_update) row.problems.push(drift.reason);
    }
    row.ok = row.problems.length === 0;
    out.push(row);
  }
  return out;
}

export function summary(closes, price = null) {
  const vals = (closes || []).filter((c) => c).map(Number);
  if (!vals.length) return { bars: 0 };
  const last = price !== null && price !== undefined ? Number(price) : vals[vals.length - 1];
  const mas = maSet(vals);
  const out = {
    bars: vals.length,
    close: roundPrice(last),
    ...mas,
    dev_ma5_pct: deviationPct(last, mas.ma5),
    dev_ma10_pct: deviationPct(last, mas.ma10),
    dev_ma20_pct: deviationPct(last, mas.ma20),
    dev_ma60_pct: deviationPct(last, mas.ma60),
    ma_position: maPosition(last, mas),
    alignment: alignmentScore(last, mas),
    rsi14: rsi(vals),
    volatility_20d: volatilityAnnualPct(vals),
    mom5: momentumPct(vals, 5),
    mom20: momentumPct(vals, 20),
    mom60: momentumPct(vals, 60),
    max_drawdown: maxDrawdown(vals),
  };
  const window = Math.min(60, vals.length);
  const seg = vals.slice(-window);
  const segHigh = Math.max(...seg);
  const segLow = Math.min(...seg);
  out.high_window = roundPrice(segHigh);
  out.low_window = roundPrice(segLow);
  out.pos_in_range = posInRangePct(last, segLow, segHigh);
  out.drawdown_from_high = drawdownFromHighPct(last, segHigh);
  return out;
}
