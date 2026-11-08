import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Archive, mergedBarsDicts, updateFromProvider } from '../lib/js/archive.js';
import { runArchive } from '../lib/js/archive-tool.js';

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-astock-archive-'));
  return { dir, archive: new Archive(path.join(dir, 'archive.sqlite')) };
}

const BARS = [
  { date: '2026-11-03', open: 10, close: 10.2, high: 10.4, low: 9.9, volume_lot: 1000 },
  { date: '2026-11-04', open: 10.2, close: 10.3, high: 10.5, low: 10.1, volume_lot: 1200 },
  { date: '2026-11-05', open: 10.3, close: 10.1, high: 10.4, low: 10, volume_lot: 900 },
];

test('存档：写入 / 读取 / raw 与 qfq 并存', () => {
  const { dir, archive } = tmp();
  const info = archive.saveBars('600000', BARS, 'raw', 'test');
  assert.equal(info.saved, 3);
  assert.equal(info.first_date, '2026-11-03');
  assert.equal(info.last_date, '2026-11-05');

  const rows = archive.loadBars('600000', { adjust: 'raw' });
  assert.equal(rows.length, 3);
  assert.equal(rows[1].close, 10.3);

  // 同日期 qfq 可以并存，不覆盖 raw
  archive.saveBars('600000', [{ ...BARS[0], close: 9.8 }], 'qfq', 'test');
  assert.equal(archive.loadBars('600000', { adjust: 'raw' }).length, 3);
  assert.equal(archive.loadBars('600000', { adjust: 'qfq' })[0].close, 9.8);

  // 同口径覆盖
  archive.saveBars('600000', [{ ...BARS[0], close: 10.25 }], 'raw', 'test');
  assert.equal(archive.loadBars('600000', { adjust: 'raw' })[0].close, 10.25);

  const st = archive.stats();
  assert.equal(st.codes, 1);
  assert.equal(st.bars, 4);
  assert.equal(st.first_date, '2026-11-03');
  assert.equal(st.last_date, '2026-11-05');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('存档：limit 取最近 N 根 / 合并 / 清理保护', async () => {
  const { dir, archive } = tmp();
  archive.saveBars('600000', BARS, 'raw');
  const recent = archive.loadBars('600000', { limit: 2 });
  assert.deepEqual(recent.map((b) => b.date), ['2026-11-04', '2026-11-05']);

  const merged = mergedBarsDicts(
    [{ date: '2026-11-04', close: 9.9 }, { date: '2026-11-06', close: 10.6 }],
    [{ date: '2026-11-05', close: 10.1 }, { date: '2026-11-06', close: 10.5 }],
  );
  assert.deepEqual(merged.map((b) => b.date), ['2026-11-04', '2026-11-05', '2026-11-06']);
  assert.equal(merged[2].close, 10.6);

  assert.throws(() => archive.prune({}), /必须指定/);
  const pruned = archive.prune({ before: '2026-11-05' });
  assert.equal(pruned.deleted, 2);
  assert.equal(archive.loadBars('600000', { adjust: 'raw' }).length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('存档更新：注入取数 / 失败明细', async () => {
  const { dir, archive } = tmp();
  const res = await updateFromProvider(archive, ['600000', '000001'], async (code) => {
    if (code === '000001') throw new Error('限流');
    return BARS;
  }, 'raw', 640);
  assert.equal(res.updated.length, 1);
  assert.equal(res.failed.length, 1);
  assert.equal(res.total_saved, 3);
  assert.match(res.failed[0].error, /限流/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('astock_archive：status / update / prune 文案', async () => {
  const { dir, archive } = tmp();
  const status = await runArchive({ action: 'status' }, { archive });
  assert.match(status, /本地历史行情存档/);
  assert.match(status, /存档为空/);

  const updated = await runArchive({ action: 'update', codes: ['600000'] }, {
    archive,
    fetchKlines: async () => ({ bars: BARS }),
  });
  assert.match(updated, /存档已更新：成功 1 只、失败 0 只/);
  assert.match(updated, /\| 600000 \| 3 \| 2026-11-03 \| 2026-11-05 \|/);

  const pruned = await runArchive({ action: 'prune', before: '2026-11-05' }, { archive });
  assert.match(pruned, /已清理 2 根 K 线（2026-11-05 之前）/);

  const bad = await runArchive({ action: 'nope' }, { archive });
  assert.match(bad, /未知 action/);

  fs.rmSync(dir, { recursive: true, force: true });
});
