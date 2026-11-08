/**
 * 高风险邮件通知的**宿主侧定时器**。
 *
 * 为什么由插件自己定时、而不是让模型调工具发：
 *   · 发信如果交给模型，就会出现「该提醒时模型选择不调工具」→ 静默漏发；
 *   · 盯盘 Agent 每次运行都要花 token，而"有没有触发阈值"是纯规则判断，
 *     一次本地调用就能算完，不必经过模型。
 *
 * 所以这里和上游 lite-work 的探针是同一种东西：宿主侧定时跑一次
 * `lib/js/alerts.js::runOnce`（零 token），由它判定并直接发 SMTP。
 * 交易时段判断也在 JS 侧（`market.shouldWatchNow`），非交易时段连取数
 * 都不会真的发生，只是快速返回「不在盯盘时段」。
 */

/** 邮件探测间隔下限（秒）：比这更密只会打爆公共行情接口。 */
export const MIN_PROBE_SECONDS = 60;

/** 默认探测间隔（秒）。 */
export const DEFAULT_PROBE_SECONDS = 300;

/**
 * 从配置推导探测间隔（秒）。
 *
 * 注意与**盯盘 Agent** 的间隔不同：那个每次运行都要调模型，所以默认 15 分钟；
 * 这个只跑一次本地判定，5 分钟是合理的（与上游探针一致）。
 */
export function probeSeconds(config = {}) {
  const raw = Number(config?.mail_probe_seconds ?? config?.mailProbeSeconds);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PROBE_SECONDS;
  return Math.max(MIN_PROBE_SECONDS, Math.round(raw));
}

/**
 * 安装定时探测。
 *
 * @param {object} host 能调 `interval(fn, ms)` 的 ctx（Cordis timer 服务）
 * @param {object} options
 * @param {() => Promise<any>} options.probe 跑一轮判定，返回结果对象
 * @param {(message: string) => void} [options.log]
 * @param {number} [options.seconds] 间隔秒数
 * @returns {() => void} 停止函数；宿主没有 timer 服务时返回空操作
 */
export function installAlertTimer(host, { probe, log = () => {}, seconds }) {
  const interval = Math.max(MIN_PROBE_SECONDS, Math.round(seconds || DEFAULT_PROBE_SECONDS));
  if (!host || typeof host.interval !== 'function') {
    log('宿主没有 timer 服务，邮件通知不会自动运行（可手动 refresh）');
    return () => {};
  }

  // 串行化：一轮还没跑完就跳过下一轮——选股/取数本来就可能慢，
  // 叠加起来会打爆接口限流，也会让邮件重复发。
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await probe();
      reportResult(result, log);
    } catch (error) {
      // 定时器里抛异常会被静默吞掉，必须自己记下来
      log(`邮件探测失败：${error?.message ?? error}`);
    } finally {
      running = false;
    }
  };

  // 不立刻跑一次：插件加载（可能一天几十次）不该顺手发一封邮件
  const dispose = host.interval(tick, interval * 1000);
  return typeof dispose === 'function' ? dispose : () => {};
}

/** 把一轮探测结果转成一行日志（只在值得说的时候开口）。 */
export function reportResult(result, log = () => {}) {
  if (!result) return;
  if (result.sent) {
    log(`已发送高风险邮件：${result.subject ?? ''}（${result.fresh} 条信号）`);
    return;
  }
  if (result.ok === false) {
    log(`邮件发送失败：${result.detail || '未知原因'}`);
    return;
  }
/** 跳过属于常态（未启用/非交易时段/去重窗口），只在调试级别可见 */
  if (result.skipped) log(`本轮未发送：${result.skipped}`, 'debug');
}
