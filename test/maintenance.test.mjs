/**
 * 每日收盘维护（lib/maintenance.js）的离线测试。
 *
 * 重点不是"定时器会不会响"，而是**该不该响**：
 *   · 周末/非交易日不跑；
 *   · 15:05 之前不跑；
 *   · 当天跑过就不再跑（应用重启、插件重载都不能重复触发）；
 *   · 失败也记一天，不在当天反复重试（行情接口限流时越重试越糟）。
 *
 * 全部用注入的时钟与临时状态文件，不碰真实调度器、不联网。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  MAINTENANCE_TIME,
  chinaClock,
  installDailyTimer,
  maintenanceStatePath,
  readState,
  shouldRunDaily,
} from '../lib/maintenance.js';

/** 2026-11-09 是周一；UTC 07:06 = 北京时间 15:06。 */
const MONDAY_1506 = new Date('2026-11-09T07:06:00Z');
const MONDAY_1500 = new Date('2026-11-09T07:00:00Z');
const SUNDAY_1506 = new Date('2026-11-08T07:06:00Z');

function fakeHost() {
  const ticks = [];
  return {
    ticks,
    interval(fn) {
      ticks.push(fn);
      return () => {};
    },
    timeout() {
      return () => {};
    },
  };
}

test('中国市场时钟：按 Asia/Shanghai 换算，不跟随宿主机时区', () => {
  const clock = chinaClock(MONDAY_1506);
  assert.equal(clock.date, '2026-11-09');
  assert.equal(clock.hhmm, '15:06');
  assert.equal(clock.weekday, 1);
  assert.equal(chinaClock(SUNDAY_1506).weekday, 7);
});

test('shouldRunDaily：工作日过点才跑，周末/未到点/当天已跑都不跑', () => {
  assert.equal(MAINTENANCE_TIME, '15:05');
  assert.equal(shouldRunDaily({ now: MONDAY_1506 }), true);
  assert.equal(shouldRunDaily({ now: MONDAY_1500 }), false);
  assert.equal(shouldRunDaily({ now: SUNDAY_1506 }), false);
  assert.equal(shouldRunDaily({ now: MONDAY_1506, lastRunDate: '2026-11-09' }), false);
  assert.equal(shouldRunDaily({ now: MONDAY_1506, lastRunDate: '2026-11-08' }), true);
});

test('状态文件默认落在 ~/.dsh/astock-data，配置了台账则跟着台账目录', () => {
  assert.match(maintenanceStatePath(''), /\.dsh[\\/]astock-data[\\/]dsh-maintenance\.json$/);

  // 「跟着台账目录」用真实绝对路径验证：`join('C:', ...)` 在 POSIX 上是相对路径，
  // 会被 resolve 拼到 cwd 后面，测出来的是错的（在 Windows 上它也是盘符相对路径）。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-astock-state-'));
  assert.equal(maintenanceStatePath(join(dir, 'ledger.sqlite')), join(dir, 'dsh-maintenance.json'));

  // 真在 Windows 上时，再确认一次原生盘符绝对路径不会被改写
  if (process.platform === 'win32') {
    const win = join('C:\\', 'tmp', 'astock', 'ledger.sqlite');
    assert.equal(maintenanceStatePath(win), join('C:\\', 'tmp', 'astock', 'dsh-maintenance.json'));
  }
});

test('定时器：15:05 之前不跑，过点跑一次，当天不重复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-astock-maint-'));
  const statePath = join(dir, 'state.json');
  const host = fakeHost();
  const runs = [];
  let current = MONDAY_1500;

  const dispose = installDailyTimer(host, {
    statePath,
    now: () => current,
    run: async () => {
      runs.push(Date.now());
      return { ok: true, date: '2026-11-09', archive: { message: '存档已更新' }, snapshot: { equity: 123 } };
    },
  });
  assert.equal(host.ticks.length, 1);

  await host.ticks[0]();
  assert.equal(runs.length, 0, '15:00 不应触发');

  current = MONDAY_1506;
  await host.ticks[0]();
  assert.equal(runs.length, 1, '15:06 应触发一次');

  await host.ticks[0]();
  assert.equal(runs.length, 1, '同一天不能重复触发');

  const saved = readState(statePath);
  assert.equal(saved.lastRunDate, '2026-11-09');
  assert.equal(saved.lastResult.equity, 123);
  assert.match(readFileSync(statePath, 'utf8'), /lastRunAt/);

  dispose();
});

test('定时器：跑失败也记一天，不在当天反复重试', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-astock-maint-'));
  const statePath = join(dir, 'state.json');
  const host = fakeHost();
  let attempts = 0;

  installDailyTimer(host, {
    statePath,
    now: () => MONDAY_1506,
    run: async () => {
      attempts += 1;
      throw new Error('接口限流');
    },
  });

  await host.ticks[0]();
  await host.ticks[0]();
  assert.equal(attempts, 1, '失败后当天不再重试');

  const saved = readState(statePath);
  assert.equal(saved.lastRunDate, '2026-11-09');
  assert.match(saved.lastError, /接口限流/);
});

test('定时器：宿主没有 timer 服务时安静跳过（返回空 disposer）', () => {
  const messages = [];
  const dispose = installDailyTimer(undefined, {
    log: (message) => messages.push(message),
    run: async () => ({}),
  });
  assert.equal(typeof dispose, 'function');
  assert.match(messages.join(''), /没有 timer 服务/);
});
