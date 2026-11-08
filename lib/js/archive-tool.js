/**
 * `astock_archive` 工具——上游 `astock_mixin_quant.py::_tool_archive` 的 Node 移植。
 */

import { updateFromProvider } from './archive.js';
import { fetchKlines } from './kline.js';

function spanYears(first, last) {
  const a = Date.parse(`${String(first).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(last).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, (b - a) / 86400000 / 365.25);
}

/**
 * @param {object} args { action?, codes?, limit?, before? }
 * @param {{ledger: object, archive: object, fetchKlines?: Function}} options
 */
export async function runArchive(args = {}, options = {}) {
  const action = String(args.action || 'status').trim().toLowerCase();
  const archive = options.archive;
  if (!archive) return '[Error] 存档未初始化';

  if (action === 'status') {
    const st = archive.stats();
    const lines = ['**本地历史行情存档**', '', '| 项目 | 数值 |', '|---|---|'];
    lines.push(`| 文件 | \`${st.path}\` |`);
    lines.push(`| 已存标的 | ${st.codes} 只 |`);
    lines.push(`| 总 K 线根数 | ${st.bars.toLocaleString('en-US')} 根 |`);
    lines.push(`| 时间跨度 | ${st.first_date || '-'} ~ ${st.last_date || '-'} |`);
    lines.push(`| 占用空间 | ${st.size_human} |`, '');
    if (st.detail.length) {
      lines.push('### 覆盖最多的标的（前 10）', '');
      lines.push('| 代码 | 口径 | 根数 | 起 | 止 |', '|---|---|---|---|---|');
      for (const d of st.detail.slice(0, 10)) {
        lines.push(`| ${d.code} | ${d.adjust} | ${d.bar_count} | ${d.first_date} | ${d.last_date} |`);
      }
      lines.push('');
    }
    if (st.bars === 0) {
      lines.push('**存档为空**。说一句「更新 K 线存档」开始累积。');
    } else {
      const years = spanYears(st.first_date, st.last_date);
      lines.push(`> 当前覆盖约 ${years.toFixed(1)} 年。回测会自动优先用存档数据`
        + '——**存得越久，回测窗口越长**。建议每天跑一次更新。');
    }
    lines.push('', '_存档只存不复权原始价：前复权会随分红重算整段历史，'
      + '存下来会自相矛盾。_');
    return lines.join('\n');
  }

  if (action === 'prune') {
    const before = String(args.before || '').trim();
    const codes = (args.codes || []).map((c) => String(c).trim()).filter(Boolean);
    if (!before && !codes.length) {
      return '[Error] prune 必须指定 before 日期或 codes，'
        + '否则会清空全部存档。这是刻意的保护——几年数据一次误点就没了。';
    }
    const res = archive.prune({ before, codes: codes.length ? codes : null });
    return `✅ 已清理 ${res.deleted} 根 K 线`
      + (codes.length ? `（${codes.join(', ')}）` : '')
      + (before ? `（${before} 之前）` : '');
  }

  if (action !== 'update') {
    return `[Error] 未知 action ${action}；可选 update/status/prune`;
  }

  let codes = (args.codes || []).map((c) => String(c).trim()).filter(Boolean);
  const ledger = options.ledger;
  if (!codes.length) {
    if (!ledger) return '[Error] 台账未初始化';
    try {
      codes = ledger.listPositions().map((p) => p.code);
      codes.push(...ledger.listWatch().map((w) => w.code));
    } catch (error) {
      return `[Error] 读取台账失败：${error?.message ?? error}`;
    }
  }
  codes = [...new Set(codes.filter(Boolean))];
  if (!codes.length) {
    return '台账里没有持仓或自选股，没东西可存。'
      + '先用 astock_record 录入持仓，或 astock_watch 添加自选，'
      + '或用 codes 参数指定要存档的代码。';
  }

  const limit = Math.max(60, Math.min(Math.trunc(Number(args.limit) || 640), 2000));
  const fetchK = options.fetchKlines || fetchKlines;
  const result = await updateFromProvider(archive, codes, async (code) => {
    const out = await fetchK(code, { period: 'day', limit, adjust: 'none' });
    return out.bars || [];
  }, 'raw', limit);

  const ok = result.updated.length;
  const fail = result.failed.length;
  const lines = [`✅ 存档已更新：成功 ${ok} 只、失败 ${fail} 只、`
    + `新增/刷新 ${result.total_saved.toLocaleString('en-US')} 根`, ''];
  if (result.updated.length) {
    lines.push('| 代码 | 写入 | 起 | 止 |', '|---|---|---|---|');
    for (const u of result.updated.slice(0, 15)) {
      lines.push(`| ${u.code} | ${u.saved} | ${u.first_date} | ${u.last_date} |`);
    }
    lines.push('');
  }
  if (result.failed.length) {
    lines.push('**失败明细**（通常是接口限流，稍后重试即可）：', '');
    for (const f of result.failed.slice(0, 10)) lines.push(`- ${f.code}：${f.error}`);
    lines.push('');
  }
  lines.push('_提示：存档是随时间累积的，今天存的覆盖约 2.6 年，'
    + '**一年后才会多出一年**。建议每天跑一次。_');
  return lines.join('\n');
}
