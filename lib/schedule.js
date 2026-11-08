/**
 * 盯盘的 DSH 落地：把 `astock_watch start/stop/status` 接到宿主的 schedule 服务。
 *
 * **为什么要这一层**：上游 astock-plugin 的盯盘是 lite-work 的「盯梢」系统——
 * 一个**探针**每 N 秒取一次数据、指纹变了才唤醒 Agent，所以能做到「非交易时段
 * 零 token」。DSH 没有探针，只有定时任务：到点就把 prompt 投给一个 Agent 会话。
 *
 * 两者的代价完全不同，所以这里不做「假装等价」，而是按 DSH 的真实语义实现，
 * 并把差异写进工具输出：
 *   · 间隔默认 15 分钟而不是上游的 5 分钟 —— 每次运行都要真实调模型；
 *   · 只在**工作日 9:00–14:59** 运行（cron），收盘后与周末完全不动；
 *   · 投递到**独立会话**（new_once），不打断当前对话；
 *   · prompt 里明确「无异常只回一行」，避免把盯盘变成刷屏。
 *
 * 服务端 API（`@deepseek-ai/dsh-schedule`）：
 *   create({title, prompt, timing, target}, actorSessionId?, signal?)
 *   edit({id, action:"update"|"delete", patch, expectedUpdatedAt?})
 *   list({active?, limit?, offset?}), view({id})
 * timing.kind ∈ after | at | every | daily | weekly | cron | rrule
 */

/** 计划的标题前缀（用于在全部任务里认出本插件建的那条）。 */
export const TASK_TITLE = 'A股盯盘';

/** 盘后舆情报告的标题前缀（与盯盘分开认，两条任务互不干扰）。 */
export const REPORT_TITLE = 'A股盘后报告';

/** 盘后报告：工作日 15:05（收盘后行情与资金数据已齐）。 */
export const REPORT_CRON = '5 15 * * 1-5';

/** DSH 下每次运行都要花 token，5 分钟太密；默认 15 分钟。 */
export const DEFAULT_INTERVAL_MINUTES = 15;

/** 允许的最小间隔（分钟）：低于这个值建议直接用行情面板看。 */
export const MIN_INTERVAL_MINUTES = 5;

/**
 * 从配置推导运行间隔（分钟）。
 *
 * 上游的 `watch_interval_seconds` 是**探针**间隔（默认 300 秒），直接搬到
 * Agent 定时任务上会变成每小时 12 次模型调用。所以这里只认**用户显式配过**的
 * 值：没配过就用 15 分钟，配过则按其换算并夹到下限。
 */
export function intervalMinutes(astockConfig = {}) {
  const raw = Number(astockConfig?.watch_interval_seconds);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_INTERVAL_MINUTES;
  return Math.max(MIN_INTERVAL_MINUTES, Math.round(raw / 60));
}

/** 生成 cron 表达式：工作日 9:00–14:59，每 N 分钟一次。 */
export function watchCron(minutes) {
  const step = Math.max(1, Math.min(59, Math.round(minutes)));
  return `*/${step} 9-14 * * 1-5`;
}

/** 投给定时会话的 prompt（自包含：新会话里没有本次对话的上下文）。 */
export function watchPrompt(minutes, plan = null) {
  const extra = [];
  if (plan && Array.isArray(plan.rules) && plan.rules.length) {
    extra.push('', '精确价位规则（本地计划）：');
    for (const r of plan.rules.slice(0, 20)) {
      const op = { lt: '跌破', le: '触及', gt: '站上', ge: '站上' }[r.op] || r.op;
      extra.push(`- ${r.code}${r.name ? ` ${r.name}` : ''} ${op} ${Number(r.price).toFixed(2)}（${r.severity || 'action'}）`);
    }
  }
  const thresholds = ['stop_loss_pct', 'take_profit_pct', 'trailing_pct', 'drop_alert_pct', 'rise_alert_pct', 'volume_ratio_alert']
    .filter((k) => plan && plan[k] !== undefined && plan[k] !== null);
  if (thresholds.length) {
    extra.push('', '计划阈值（优先于设置页）：' + thresholds.map((k) => `${k}=${plan[k]}`).join('、'));
  }
  return [
    `A股盯盘（每 ${minutes} 分钟自动运行，DSH 定时任务）。`,
    '',
    '做法：',
    '1. 调 astock_hint（不传 code）检查全部持仓的止损、止盈、回撤、超仓、T+1 可卖；',
    '2. 调 astock_quote（不传 codes）看持仓与自选股的当日涨跌、量比；',
    '3. 有信号时，逐条写清楚「哪只股、触发了哪条规则、现价与阈值」，并说明这是规则触发而不是预测。',
    '',
    '纪律：',
    '- 没有任何触发时，只回一行「无异常」，不要输出分析、不要复述上一次的结论；',
    '- 不要把历史涨跌讲成未来走势，不要给「买入/卖出/加仓」这类指令式措辞；',
    '- 你只能提示与记账，不能下单——用户自己在券商 App 操作。',
    ...extra,
  ].join('\n');
}

/**
 * 投给「盘后报告」定时会话的 prompt。
 *
 * 与盯盘的区别：盯盘是盘中每 N 分钟一次、无异常只回一行；盘后报告**每天只跑
 * 一次**，目的是把「今天持仓/自选发生了什么」收成一份可读的复盘，所以要求
 * 先给要点、再给明细。
 */
export function reportPrompt() {
  return [
    'A股盘后舆情报告（工作日 15:05 自动运行，DSH 定时任务）。',
    '',
    '做法：',
    '1. 调 astock_sentiment，code=portfolio（持仓+自选全量：公告/研报/新闻/热度/龙虎榜/两融/股东户数，含背离提示）；',
    '2. 调 astock_hint（不传 code）复核今天是否触发止损、止盈、超仓或 T+1 约束；',
    '3. 若台账里没有持仓也没有自选，只回一行「今日无持仓，未生成盘后报告」，不要编内容。',
    '',
    '输出格式：',
    '- 开头 3–5 条要点：谁出现信号背离、谁同向、明天要留意什么；',
    '- 然后按标的分小节给证据摘要（事实/观点/媒体/情绪要分开写）；',
    '- 最后一行固定写「以上为数据整理，不构成投资建议」。',
    '',
    '纪律：',
    '- 不预测涨跌、不给「买入/卖出/加仓」这类指令式措辞；',
    '- 不要把历史涨跌讲成未来走势；',
    '- 你只能提示与记账，不能下单——用户自己在券商 App 操作。',
  ].join('\n');
}

/** 从 list 结果里认出本插件的历史任务（不同版本可能返回数组或 {items}）。 */
function itemsOf(listResult) {
  if (Array.isArray(listResult)) return listResult;
  if (Array.isArray(listResult?.items)) return listResult.items;
  if (Array.isArray(listResult?.tasks)) return listResult.tasks;
  return [];
}

function isOurs(task) {
  return String(task?.title ?? '').trim().startsWith(TASK_TITLE);
}

function isReportTask(task) {
  return String(task?.title ?? '').trim().startsWith(REPORT_TITLE);
}

/**
 * 任务是否在运行。
 *
 * 宿主的 catalog 记录用 `status: 'active' | 'paused' | 'ended'`，而早期版本/测试
 * 替身用的是布尔 `active`。**两种都要认**：只认 `active !== false` 会把
 * `status: 'paused'` 的任务当成运行中，于是 start 不会恢复它、status 还会报
 * 「运行中」——这类误判在界面上完全看不出来。
 */
export function isTaskActive(task) {
  if (!task) return false;
  if (typeof task.active === 'boolean') return task.active;
  if (typeof task.status === 'string') return task.status === 'active';
  return true;
}

/**
 * 盯盘计划的读写控制器。
 *
 * @param {() => object|undefined} getSchedule 取 schedule 服务（可能尚未就绪）
 */
export function createWatchController(getSchedule) {
  const requireService = () => {
    const service = getSchedule();
    if (!service || typeof service.create !== 'function') {
      throw new Error(
        '当前宿主没有可用的定时服务（schedule），无法创建盯盘计划。'
        + '19 个取数/台账工具不受影响，可手动调用 astock_hint 检查。',
      );
    }
    return service;
  };

  const findTask = async () => {
    const service = getSchedule();
    if (!service || typeof service.list !== 'function') return null;
    const tasks = itemsOf(await service.list({ limit: 500 }));
    // 优先启用的那条；没有启用的就返回暂停的那条（供 status 说明）
    return tasks.find((t) => isOurs(t) && isTaskActive(t)) ?? tasks.find(isOurs) ?? null;
  };

  const exists = async () => {
    const task = await findTask();
    return Boolean(task && isTaskActive(task));
  };

  /**
   * 创建（或修正）盯盘计划。已存在且参数一致时不重复建。
   * @returns {Promise<{task: object, created: boolean, cron: string, minutes: number}>}
   */
  const ensure = async ({ minutes, sessionId = '', preset = '', cwd = '', prompt = '' } = {}) => {
    const service = requireService();
    const step = Math.max(MIN_INTERVAL_MINUTES, Math.round(minutes || DEFAULT_INTERVAL_MINUTES));
    const cron = watchCron(step);
    const effectivePrompt = prompt || watchPrompt(step);
    const existing = await findTask();

    if (existing && isTaskActive(existing)) {
      const sameCron = JSON.stringify(existing).includes(cron);
      if (sameCron && existing.prompt !== effectivePrompt) {
        const patched = await service.edit({
          id: existing.id,
          action: 'update',
          patch: { prompt: effectivePrompt },
          ...(existing.updatedAt ? { expectedUpdatedAt: existing.updatedAt } : {}),
        });
        return { task: patched ?? existing, created: false, cron, minutes: step, promptUpdated: true };
      }
      if (sameCron) return { task: existing, created: false, cron, minutes: step };
      // 间隔变了：原地改，保留已提交的下一次与运行历史
      const patched = await service.edit({
        id: existing.id,
        action: 'update',
        patch: { timing: { kind: 'cron', cron: { expression: cron, time_zone: 'Asia/Shanghai' } } },
        ...(existing.updatedAt ? { expectedUpdatedAt: existing.updatedAt } : {}),
      });
      return { task: patched ?? existing, created: false, cron, minutes: step };
    }

    if (existing && !isTaskActive(existing)) {
      // 之前被暂停过：直接恢复，不新建第二条
      const resumed = await service.edit({
        id: existing.id,
        action: 'update',
        patch: { active: true, prompt: effectivePrompt },
        ...(existing.updatedAt ? { expectedUpdatedAt: existing.updatedAt } : {}),
      });
      return { task: resumed ?? existing, created: false, cron, minutes: step };
    }

    const created = await service.create({
      title: TASK_TITLE,
      prompt: effectivePrompt,
      timing: { kind: 'cron', cron: { expression: cron, time_zone: 'Asia/Shanghai' } },
      target: {
        kind: 'new_once',
        // create 里省略的值用 Host 默认；显式带上是让「盯盘会话」落在可预期的位置
        ...(cwd || preset ? { create: { ...(cwd ? { cwd } : {}), ...(preset ? { agentPreset: preset } : {}) } } : {}),
      },
    }, sessionId || undefined);
    // `create` 的返回值字段不全（没有 scheduledAtLocal），回读一次拿完整记录
    return { task: (await findTask()) ?? created, created: true, cron, minutes: step };
  };

  /** 停用盯盘：删掉计划（不留暂停态，避免下次 start 撞上「已有暂停计划」）。 */
  const stop = async () => {
    const service = requireService();
    const task = await findTask();
    if (!task) return { removed: 0 };
    await service.edit({ id: task.id, action: 'delete' });
    return { removed: 1, title: task.title };
  };

  /** 读当前状态（不创建）。 */
  const status = async () => {
    const service = getSchedule();
    if (!service || typeof service.list !== 'function') {
      return { available: false };
    }
    const task = await findTask();
    if (!task) return { available: true, task: null };
    return { available: true, task };
  };

  const updatePrompt = async (prompt) => {
    const service = getSchedule();
    if (!service || typeof service.edit !== 'function') return { updated: false };
    const task = await findTask();
    if (!task) return { updated: false };
    const patched = await service.edit({
      id: task.id,
      action: 'update',
      patch: { prompt },
      ...(task.updatedAt ? { expectedUpdatedAt: task.updatedAt } : {}),
    });
    return { updated: Boolean(patched), task: patched ?? task };
  };

  return { ensure, stop, status, findTask, exists, itemsOf, isOurs, updatePrompt };
}

/**
 * 盘后舆情报告 → DSH 定时计划。
 *
 * **为什么单独一条任务**：盯盘只在 9:00–14:59 运行，收盘后完全静默；而上游
 * 的盘后报告是在「收盘后第一次探针」时触发的（15:05–16:00 窗口）。DSH 没有
 * 探针，所以用一条独立的工作日 15:05 定时任务补上这个缺口——投递到独立会话，
 * 不打断当前对话。
 *
 * @param {() => object|undefined} getSchedule 取 schedule 服务（可能尚未就绪）
 */
export function createReportController(getSchedule) {
  const requireService = () => {
    const service = getSchedule();
    if (!service || typeof service.create !== 'function') {
      throw new Error('当前宿主没有可用的定时服务（schedule），无法创建盘后报告任务。');
    }
    return service;
  };

  const findTask = async () => {
    const service = getSchedule();
    if (!service || typeof service.list !== 'function') return null;
    const tasks = itemsOf(await service.list({ limit: 500 }));
    return tasks.find((t) => isReportTask(t) && isTaskActive(t))
      ?? tasks.find(isReportTask)
      ?? null;
  };

  /** 创建或修正盘后报告计划（幂等：已有运行中的同 cron 任务时直接复用）。 */
  const ensure = async ({ sessionId = '', preset = '', cwd = '' } = {}) => {
    const service = requireService();
    const existing = await findTask();

    if (existing && isTaskActive(existing)) {
      const sameCron = JSON.stringify(existing).includes(REPORT_CRON);
      if (sameCron) return { task: existing, created: false, cron: REPORT_CRON };
      const patched = await service.edit({
        id: existing.id,
        action: 'update',
        patch: { timing: { kind: 'cron', cron: { expression: REPORT_CRON, time_zone: 'Asia/Shanghai' } } },
        ...(existing.updatedAt ? { expectedUpdatedAt: existing.updatedAt } : {}),
      });
      return { task: patched ?? existing, created: false, cron: REPORT_CRON };
    }

    if (existing && !isTaskActive(existing)) {
      const resumed = await service.edit({
        id: existing.id,
        action: 'update',
        patch: { active: true },
        ...(existing.updatedAt ? { expectedUpdatedAt: existing.updatedAt } : {}),
      });
      return { task: resumed ?? existing, created: false, cron: REPORT_CRON };
    }

    const created = await service.create({
      title: REPORT_TITLE,
      prompt: reportPrompt(),
      timing: { kind: 'cron', cron: { expression: REPORT_CRON, time_zone: 'Asia/Shanghai' } },
      target: {
        kind: 'new_once',
        ...(cwd || preset ? { create: { ...(cwd ? { cwd } : {}), ...(preset ? { agentPreset: preset } : {}) } } : {}),
      },
    }, sessionId || undefined);
    return { task: (await findTask()) ?? created, created: true, cron: REPORT_CRON };
  };

  /** 停用盘后报告（删除计划，不留暂停态）。 */
  const stop = async () => {
    const service = requireService();
    const task = await findTask();
    if (!task) return { removed: 0 };
    await service.edit({ id: task.id, action: 'delete' });
    return { removed: 1, title: task.title };
  };

  /** 读当前状态（不创建）。 */
  const status = async () => {
    const service = getSchedule();
    if (!service || typeof service.list !== 'function') return { available: false };
    const task = await findTask();
    if (!task) return { available: true, task: null };
    return { available: true, task, active: isTaskActive(task) };
  };

  return { ensure, stop, status, findTask };
}

/** 把 `create` 的返回值整理成一行可读的时间（没有就返回空串）。 */
export function nextRunText(task) {
  // 优先用宿主给的本地时间；`create` 的返回值常常只带 UTC 的 scheduledAt，
  // 直接截断会显示成「01:00」这种差 8 小时的假时间（实测踩到）。
  const local = task?.scheduledAtLocal || task?.nextRunAtLocal || '';
  if (local) return String(local).replace('T', ' ').replace(/(\+08:00|Z|\.\d+)$/, '').slice(0, 16);

  const utc = task?.scheduledAt || task?.nextRunAt || '';
  if (!utc) return '';
  const when = new Date(String(utc));
  if (Number.isNaN(when.getTime())) return '';
  // 盯盘只在中国市场用，统一按 Asia/Shanghai 显示，不跟随宿主机时区
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(when);
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`;
}
