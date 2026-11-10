/**
 * 备份的节流、列表元数据与删除保护。
 *
 * 维护页把「导出」和「备份/恢复」混在一起时，用户一分钟内连点三次备份，
 * 列表只显示到分钟，看上去"没生效"；这里锁住三件事：
 *   · 60 秒内重复备份不新增快照，返回 skipped；
 *   · 列表带秒级 createdAt 与 sizeBytes；
 *   · 当天最新一份不能删，更早的可以。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Ledger } from '../lib/js/ledger.js';
import {
  createBackup, deleteBackup, listBackups, restoreBackup,
} from '../lib/js/maintenance.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-astock-backup-'));
  const ledger = new Ledger(join(dir, 'ledger.sqlite'));
  ledger.setCash(1000);
  return { dir, ledger, archive: {} };
}

test('备份节流：60 秒内第二次只提示，不新增快照', () => {
  const { ledger, archive } = setup();
  const first = createBackup({ ledger, archive });
  assert.equal(first.ok, true);
  assert.ok(!first.skipped);
  assert.match(first.message, /已备份/);

  const second = createBackup({ ledger, archive });
  assert.equal(second.ok, true);
  assert.equal(second.skipped, true);
  assert.match(second.message, /刚备份过/);
  assert.equal(listBackups(ledger.path).length, 1);

  // 显式关掉节流（恢复前的兜底备份就这么用）
  const forced = createBackup({ ledger, archive, minIntervalMs: 0 });
  assert.ok(!forced.skipped);
  assert.equal(listBackups(ledger.path).length, 2);
});

test('备份列表：createdAt 到秒、sizeBytes 有值', () => {
  const { ledger, archive } = setup();
  createBackup({ ledger, archive });
  const [item] = listBackups(ledger.path);
  assert.match(item.createdAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.ok(item.sizeBytes > 0);
  assert.match(item.name, /^\d{8}-\d{6}/);
});

test('删除保护：当天最新一份不能删，更早的可以', () => {
  const { ledger, archive } = setup();
  createBackup({ ledger, archive });
  createBackup({ ledger, archive, minIntervalMs: 0 });
  const items = listBackups(ledger.path);
  assert.equal(items.length, 2);

  const refused = deleteBackup(ledger.path, items[0].name);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /当天最新/);

  const removed = deleteBackup(ledger.path, items[1].name);
  assert.equal(removed.ok, true);
  assert.equal(listBackups(ledger.path).length, 1);

  // 路径穿越必须拒绝
  assert.equal(deleteBackup(ledger.path, '../ledger.sqlite').ok, false);
  assert.equal(deleteBackup(ledger.path, '').ok, false);
});

test('恢复前的兜底备份不受 60 秒节流影响', () => {
  const { ledger, archive } = setup();
  createBackup({ ledger, archive });
  const before = listBackups(ledger.path).length;
  const restored = restoreBackup({ ledger, archive }, listBackups(ledger.path)[0].name);
  assert.equal(restored.ok, true);
  // 恢复本身会再写一份"恢复前"的备份
  assert.ok(listBackups(ledger.path).length >= before + 1);
});
