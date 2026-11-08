/**
 * 每日收盘维护（**零 token，纯子进程**）。
 *
 * 为什么由宿主自己定时、而不是建一条 DSH 定时任务：
 *   · 定时任务到点会**真的调一次模型**，而「更新本地日 K 存档 + 记一条收盘
 *     净值」是纯规则/取数动作，不需要模型参与；
 *   · 存档的价值是「今天开始存，一年后多一年」，忘了跑就是**永久损失**，
 *     不能依赖用户记得每天点一次按钮。
 *
 * 触发策略：每 5 分钟检查一次，工作日 15:05 之后、当天还没跑过就跑一次。
 * 这样应用在 15:20 才打开也能补跑；状态落盘，重启不会重复跑。
 *
 * 失败**不重试**（当天只记一次尝试）：行情接口限流时反复重试只会更糟；而
 * 存档是增量的（每次取最近 640 根按主键覆盖），漏一天会在下一次自动补齐。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** 默认执行时刻（收盘后行情与资金数据已齐）。 */
export const MAINTENANCE_TIME = '15:05';

/** 检查间隔：5 分钟（一次 tick 只是读一个本地 JSON，成本可忽略）。 */
export const MAINTENANCE_TICK_MS = 5 * 60 * 1000;

/** 插件加载后先补一次检查（应用 15:06 启动时不必再等 5 分钟）。 */
export const MAINTENANCE_START_DELAY_MS = 20 * 1000;

/** 中国市场的固定时区（不跟随宿主机时区，避免机器设成 UTC 时算错日子）。 */
const TIME_ZONE = 'Asia/Shanghai';

/**
 * 把任意时刻换算成中国市场时钟。
 *
 * @returns {{date: string, hhmm: string, weekday: number}} weekday 1=周一 … 7=周日
 */
export function chinaClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? '';
  const year = Number(pick('year'));
  const month = Number(pick('month'));
  const day = Number(pick('day'));
  const hour = Number(pick('hour')) % 24;
  const minute = Number(pick('minute'));
  const sunday = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=周日
  return {
    date: `${pick('year')}-${pick('month')}-${pick('day')}`,
    hhmm: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    weekday: sunday === 0 ? 7 : sunday,
  };
}

/**
 * 今天该不该跑。
 *
 * 只在工作日、且已过设定时刻、且当天还没跑过时返回 true。
 * 23:59 之后到次日 00:00 之间不跑：日期已变，时间又早于 15:05。
 */
export function shouldRunDaily({ now = new Date(), lastRunDate = '', time = MAINTENANCE_TIME } = {}) {
  const clock = chinaClock(now);
  if (clock.weekday > 5) return false;
  if (clock.hhmm < time) return false;
  return clock.date !== String(lastRunDate || '');
}

/** 维护状态文件的位置：与台账同目录（台账路径可配，状态跟着走）。 */
export function maintenanceStatePath(ledgerPath = '') {
  const raw = String(ledgerPath || '').trim();
  const dir = raw
    ? dirname(resolve(raw))
    : join(homedir(), '.dsh', 'astock-data');
  return join(dir, 'dsh-maintenance.json');
}

/** 读状态（文件不存在/坏了都返回空对象，绝不抛）。 */
export function readState(file) {
  if (!file) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 写状态（原子替换；写不了也不影响主流程）。 */
export function writeState(file, state) {
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state ?? {}, null, 2), 'utf8');
    renameSync(tmp, file);
  } catch {
    /* 状态文件只是去重用的，写失败不该影响存档 */
  }
}

/** 把一次维护结果压成状态文件里能存的一小段（别把整份报告塞进去）。 */
export function summarizeResult(result) {
  if (!result || typeof result !== 'object') return null;
  const archive = result.archive && typeof result.archive === 'object' ? result.archive : {};
  const snapshot = result.snapshot && typeof result.snapshot === 'object' ? result.snapshot : {};
  return {
    ok: result.ok !== false,
    date: result.date || '',
    skipped: result.skipped || '',
    archive: archive.message || '',
    equity: snapshot.equity ?? null,
    cash: snapshot.cash ?? null,
  };
}

/**
 * 安装每日维护定时器。
 *
 * @param {object} host 能调 `interval(fn, ms)` 的 ctx（Cordis timer 服务）
 * @param {object} options
 * @param {() => Promise<any>} options.run 跑一次维护（返回结构化结果）
 * @param {(message: string, level?: string) => void} [options.log]
 * @param {string} [options.time] 执行时刻（HH:MM）
 * @param {string} [options.statePath] 状态文件路径
 * @param {() => Date} [options.now] 取当前时间（测试注入）
 * @returns {() => void} 停止函数
 */
export function installDailyTimer(host, {
  run, log = () => {}, time = MAINTENANCE_TIME, statePath = '', now = () => new Date(),
} = {}) {
  if (!host || typeof host.interval !== 'function') {
    log('宿主没有 timer 服务，每日收盘维护不会自动运行');
    return () => {};
  }

  let running = false;
  const tick = async () => {
    if (running) return;
    const current = now();
    const state = readState(statePath);
    if (!shouldRunDaily({ now: current, lastRunDate: state.lastRunDate, time })) return;

    const clock = chinaClock(current);
    running = true;
    // 先记账再干活：失败也留痕，不在当天反复重试
    writeState(statePath, {
      ...state,
      lastRunDate: clock.date,
      lastAttemptAt: current.toISOString(),
    });
    try {
      const result = await run();
      writeState(statePath, {
        lastRunDate: clock.date,
        lastAttemptAt: current.toISOString(),
        lastRunAt: new Date().toISOString(),
        lastResult: summarizeResult(result),
      });
      const summary = summarizeResult(result) || {};
      if (summary.skipped) {
        log(`每日维护跳过：${summary.skipped}`, 'debug');
      } else if (summary.ok === false) {
        log(`每日维护部分失败：${summary.archive || '存档未更新'}`);
      } else {
        log(`每日维护完成：${summary.archive || '存档已处理'}`);
      }
    } catch (error) {
      writeState(statePath, {
        lastRunDate: clock.date,
        lastAttemptAt: current.toISOString(),
        lastError: String(error?.message ?? error),
      });
      log(`每日维护失败：${error?.message ?? error}`);
    } finally {
      running = false;
    }
  };

  const disposers = [];
  const stopInterval = host.interval(tick, MAINTENANCE_TICK_MS);
  if (typeof stopInterval === 'function') disposers.push(stopInterval);
  if (typeof host.timeout === 'function') {
    const stopStartup = host.timeout(tick, MAINTENANCE_START_DELAY_MS);
    if (typeof stopStartup === 'function') disposers.push(stopStartup);
  }
  return () => {
    for (const dispose of disposers) {
      try { dispose(); } catch { /* 已经停了 */ }
    }
  };
}
