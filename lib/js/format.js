/**
 * 输出格式化（与上游 `astock_common` 的 `_f/_pct/_ratio/_table` 对齐）。
 *
 * 口径：
 *   · 缺数据一律 `-`，绝不用 0 冒充；
 *   · `pct` 带符号（涨跌幅/动量），`ratio` 不带符号（换手/占比/波动率）；
 *   · 表格转义 `|`，避免把 Markdown 表撑坏。
 */

export function f(value, digits = 2, dash = '-') {
  if (value === null || value === undefined || value === '') return dash;
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  // 用 toFixed 而不是 toLocaleString/先乘再舍：toFixed 按 double 的精确值
  // 舍入，9.8035（实际 9.8034999…）会得到 9.803，与 Python 的 .3f 一致。
  const negative = n < 0;
  const fixed = Math.abs(n).toFixed(digits);
  const [intPart, decPart] = fixed.split('.');
  const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const text = decPart === undefined ? withSep : `${withSep}.${decPart}`;
  return negative ? `-${text}` : text;
}

export function pct(value) {
  if (value === null || value === undefined) return '-';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

export function ratio(value) {
  if (value === null || value === undefined) return '-';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return `${n.toFixed(2)}%`;
}

export function money(value) {
  if (value === null || value === undefined) return '-';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(2)}万`;
  return n.toFixed(2);
}

export function table(headers, rows) {
  const cell = (value) => String(value === null || value === undefined ? '-' : value)
    .replace(/\|/g, '\\|');
  const out = [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
  ];
  for (const row of rows) out.push(`| ${row.map(cell).join(' | ')} |`);
  return out.join('\n');
}
