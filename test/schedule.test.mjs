/**
 * 盯盘 → DSH 定时计划 的离线测试。
 *
 * 用假 schedule 服务验证「创建/复用/改间隔/删除」的行为，不触碰真实调度器：
 * 真调度一旦乱建计划，用户会收到莫名其妙的定时消息，这种副作用绝不能在测试里发生。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES, REPORT_CRON, REPORT_TITLE,
  TASK_TITLE, createReportController, createWatchController, intervalMinutes,
  nextRunText, reportPrompt, watchCron, watchPrompt,
} from '../lib/schedule.js';

/** 造一个最小 schedule 服务：记录调用，行为贴近真实 API。 */
function fakeSchedule() {
  const tasks = new Map();
  const calls = [];
  let seq = 0;
  const api = {
    calls,
    tasks,
    async create(input) {
      calls.push({ op: 'create', input });
      const id = `schedule-test-${++seq}`;
      const task = {
        id,
        title: input.title,
        prompt: input.prompt,
        timing: input.timing,
        target: input.target,
        active: true,
        scheduledAtLocal: '2026-11-09T09:15:00+08:00',
        updatedAt: `2026-11-07T10:00:${String(seq).padStart(2, '0')}.000Z`,
      };
      tasks.set(id, task);
      return task;
    },
    async edit(request) {
      calls.push({ op: 'edit', request });
      const task = tasks.get(request.id);
      if (!task) throw new Error('no such task');
      if (request.action === 'delete') {
        tasks.delete(request.id);
        return { id: request.id, deleted: true };
      }
      Object.assign(task, request.patch ?? {});
      return task;
    },
    async list() {
      return [...tasks.values()];
    },
  };
  return api;
}

test('间隔换算：没配过 15 分钟，配过按秒换算并夹下限', () => {
  assert.equal(intervalMinutes({}), DEFAULT_INTERVAL_MINUTES);
  assert.equal(intervalMinutes({ watch_interval_seconds: 300 }), 5);
  assert.equal(intervalMinutes({ watch_interval_seconds: 1800 }), 30);
  // 60 秒 = 1 分钟，低于下限 → 夹到 5
  assert.equal(intervalMinutes({ watch_interval_seconds: 60 }), MIN_INTERVAL_MINUTES);
  // 脏值不能算出 NaN 进 cron 表达式
  assert.equal(intervalMinutes({ watch_interval_seconds: 'abc' }), DEFAULT_INTERVAL_MINUTES);
});

test('cron 只覆盖工作日 9–14 点，且分钟步长合法', () => {
  assert.equal(watchCron(15), '*/15 9-14 * * 1-5');
  assert.equal(watchCron(5), '*/5 9-14 * * 1-5');
  // 步长必须夹到 1–59，否则 Cron 解析失败 → 计划永远不会触发
  assert.equal(watchCron(0), '*/1 9-14 * * 1-5');
  assert.equal(watchCron(120), '*/59 9-14 * * 1-5');
});

test('prompt 自带纪律：无异常只回一行、不许指令式措辞', () => {
  const text = watchPrompt(15);
  assert.match(text, /每 15 分钟/);
  assert.match(text, /无异常/);
  assert.match(text, /不能下单/);
  assert.match(text, /astock_hint/);
});

test('控制器：先建后复用，不重复创建', async () => {
  const service = fakeSchedule();
  const watch = createWatchController(() => service);

  const first = await watch.ensure({ minutes: 15 });
  assert.equal(first.created, true);
  assert.equal(first.cron, '*/15 9-14 * * 1-5');
  assert.equal(service.tasks.size, 1);
  assert.equal([...service.tasks.values()][0].title, TASK_TITLE);
  assert.equal([...service.tasks.values()][0].target.kind, 'new_once');

  const second = await watch.ensure({ minutes: 15 });
  assert.equal(second.created, false, '同间隔再调 start 必须复用，不能建第二条');
  assert.equal(service.tasks.size, 1);
});

test('控制器：改间隔走 edit 而不是新建', async () => {
  const service = fakeSchedule();
  const watch = createWatchController(() => service);
  await watch.ensure({ minutes: 15 });
  const changed = await watch.ensure({ minutes: 30 });

  assert.equal(changed.created, false);
  assert.equal(service.tasks.size, 1, '改间隔不能新增计划');
  const patch = service.calls.find((c) => c.op === 'edit' && c.request.action === 'update');
  assert.match(patch.request.patch.timing.cron.expression, /\*\/30 9-14/);
});

test('控制器：上一轮被暂停时恢复，而不是新建', async () => {
  const service = fakeSchedule();
  const watch = createWatchController(() => service);
  await watch.ensure({ minutes: 15 });
  const [task] = [...service.tasks.values()];
  task.active = false;

  const resumed = await watch.ensure({ minutes: 15 });
  assert.equal(resumed.created, false);
  assert.equal(service.tasks.size, 1);
  assert.equal([...service.tasks.values()][0].active, true);
});

test('控制器：stop 删除计划；没有计划时不报错', async () => {
  const service = fakeSchedule();
  const watch = createWatchController(() => service);
  await watch.ensure({ minutes: 15 });

  const stopped = await watch.stop();
  assert.equal(stopped.removed, 1);
  assert.equal(service.tasks.size, 0);

  assert.deepEqual(await watch.stop(), { removed: 0 });
});

test('控制器：没有 schedule 服务时给出可读错误，而不是抛栈', async () => {
  const watch = createWatchController(() => undefined);
  await assert.rejects(
    () => watch.ensure({ minutes: 15 }),
    /没有可用的定时服务/,
  );
  assert.deepEqual(await watch.status(), { available: false });
});

test('下次运行时间：本地优先，UTC 兜底按 Asia/Shanghai 换算', () => {
  assert.equal(nextRunText({ scheduledAtLocal: '2026-11-09T09:15:00+08:00' }), '2026-11-09 09:15');
  // create 只回 UTC 时必须换算，不能直接截断成 01:15
  assert.equal(nextRunText({ scheduledAt: '2026-11-09T01:15:00.000Z' }), '2026-11-09 09:15');
  assert.equal(nextRunText({}), '');
  assert.equal(nextRunText({ scheduledAt: 'not-a-date' }), '');
});

test('盘后报告 prompt：自带工具指引、口径与边界', () => {
  const text = reportPrompt();
  assert.match(text, /astock_sentiment/);
  assert.match(text, /portfolio/);
  assert.match(text, /不构成投资建议/);
  assert.match(text, /不能下单/);
  assert.equal(REPORT_CRON, '5 15 * * 1-5');
  assert.equal(REPORT_TITLE, 'A股盘后报告');
});

test('盘后报告控制器：创建一次、复用、删除，与盯盘任务互不干扰', async () => {
  const service = fakeSchedule();
  const report = createReportController(() => service);

  const first = await report.ensure({});
  assert.equal(first.created, true);
  assert.equal(service.tasks.size, 1);
  const task = [...service.tasks.values()][0];
  assert.equal(task.title, REPORT_TITLE);
  assert.equal(task.timing.cron.expression, REPORT_CRON);
  assert.equal(task.target.kind, 'new_once');

  const second = await report.ensure({});
  assert.equal(second.created, false, '同 cron 再调 ensure 必须复用');
  assert.equal(service.tasks.size, 1);

  const status = await report.status();
  assert.equal(status.active, true);

  const stopped = await report.stop();
  assert.equal(stopped.removed, 1);
  assert.equal(service.tasks.size, 0);
});

test('任务状态：宿主 catalog 用 status=paused 时也要能识别并恢复', async () => {
  const tasks = new Map();
  const service = {
    async create(input) {
      const task = {
        id: 'schedule-paused-1',
        title: input.title,
        prompt: input.prompt,
        timing: input.timing,
        target: input.target,
        status: 'paused',
        updatedAt: '2026-11-07T10:00:00.000Z',
      };
      tasks.set(task.id, task);
      return task;
    },
    async edit(request) {
      const task = tasks.get(request.id);
      if (request.action === 'delete') {
        tasks.delete(request.id);
        return { id: request.id, deleted: true };
      }
      Object.assign(task, request.patch ?? {});
      return task;
    },
    async list() {
      return [...tasks.values()];
    },
  };

  const report = createReportController(() => service);
  await report.ensure({});
  const [task] = [...tasks.values()];
  task.status = 'paused';

  // 暂停态不能当成「运行中」：ensure 必须恢复它而不是再建一条
  const resumed = await report.ensure({});
  assert.equal(resumed.created, false);
  assert.equal(tasks.size, 1);
  assert.equal([...tasks.values()][0].active, true);
});
