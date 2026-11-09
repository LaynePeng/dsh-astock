/**
 * dsh-astock —— A 股助手（DeepSeek Harness 插件，宿主侧）。
 *
 * 上游事实源：lite-work-plugins/plugins/astock-plugin（v2.9.1）。本插件把它的
 * **19 个工具原样搬进 DSH**：工具名、参数 schema、输出文案都不改写，schema 直接
 * 用上游导出的 `lib/tools.json` 而不是手抄；实现已从 Python 全量重写为 Node
 * （`lib/js/`），口径逐条对齐原实现，这样两边不会演化出「同名不同口径」的两套
 * 行情逻辑。
 *
 * 与上游的差异（都是宿主能力差异，不是行为差异）：
 *   · 上游的右栏面板依赖 lite-work 的通用插件 UI 协议（markdown + lite-tree），
 *     DSH 没有那套协议 —— 这里改为**自建右栏面板**：宿主注册
 *     `GET /api/dsh-astock/panel`，客户端插件（lib/client.js）用 React 画
 *     KPI 卡 / 持仓卡 / 三策略对比（数据整形见 lib/js/panel.js）；
 *   · 上游会自动创建/维护宿主「盯盘」计划；DSH 的定时任务由 schedule 系统
 *     负责（见 lib/schedule.js），`astock_watch` 保留自选与规则读写。
 *
 * 安全边界（继承上游）：**不接触任何委托通道**——没有下单、撤单、券商登录，
 * 也不生成委托文件。用户自己在券商 App 执行，插件只负责取数、记账、算账与提示。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = JSON.parse(readFileSync(join(HERE, 'tools.json'), 'utf8'));

// 静态依赖也要带着 boot 的缓存键加载：否则「改了子模块、启停插件」跑的还是
// 旧模块（Node 按 URL 缓存），只能重启进程——这正是排查时最容易误判的坑。
const KEY = globalThis.__DSH_ASTOCK_BOOT_KEY__ || String(Date.now());
const withKey = (spec) => new URL(`${spec}?${KEY}`, import.meta.url).href;

const configMod = await import(withKey('./config.js'));
const { hostOptions, toAstockConfig, applyDefaultPaths } = configMod;
const scheduleMod = await import(withKey('./schedule.js'));
const {
  createWatchController, createReportController, intervalMinutes, watchCron,
  nextRunText, MIN_INTERVAL_MINUTES, isTaskActive, watchPrompt,
  REPORT_CRON, REPORT_TITLE,
} = scheduleMod;
const alertsMod = await import(withKey('./alerts.js'));
const { installAlertTimer, probeSeconds } = alertsMod;
const maintenanceMod = await import(withKey('./maintenance.js'));
const { installDailyTimer, maintenanceStatePath } = maintenanceMod;
// 19 个工具重写的第 1 个：astock_calc（纯公式 + 腾讯 K 线）。
const calcMod = await import(withKey('./js/calc.js'));
// 第 2 个：astock_quote（腾讯/新浪快照 + 台账自选兜底）。
const ledgerMod = await import(withKey('./js/ledger.js'));
const quoteMod = await import(withKey('./js/quote-tool.js'));
const klineToolMod = await import(withKey('./js/kline-tool.js'));
const searchMod = await import(withKey('./js/search.js'));
const screenMod = await import(withKey('./js/screen.js'));
const flowMod = await import(withKey('./js/flow.js'));
const portfolioMod = await import(withKey('./js/portfolio.js'));
const hintMod = await import(withKey('./js/hint-tool.js'));
const syncMod = await import(withKey('./js/sync.js'));
const businessMod = await import(withKey('./js/business.js'));
const sentimentMod = await import(withKey('./js/sentiment-tool.js'));
const eventsMod = await import(withKey('./js/events.js'));
const pickMod = await import(withKey('./js/pick-tool.js'));
const backtestMod = await import(withKey('./js/backtest-tool.js'));
const archiveMod = await import(withKey('./js/archive.js'));
const archiveToolMod = await import(withKey('./js/archive-tool.js'));
const actMod = await import(withKey('./js/act-tool.js'));
const watchToolMod = await import(withKey('./js/watch-tool.js'));
const watchPlanMod = await import(withKey('./js/watch-plan.js'));
const extraMod = await import(withKey('./js/extra-tool.js'));
// 宿主侧能力（面板 / 维护动作 / 邮件判定）：原来走 python 子进程，现已全部 JS 化。
const jsPanel = await import(withKey('./js/panel.js'));
const jsMaintenance = await import(withKey('./js/maintenance.js'));
const jsAlerts = await import(withKey('./js/alerts.js'));
const jsSettings = await import(withKey('./js/settings.js'));
const jsOAuth = await import(withKey('./js/oauth.js'));
const jsReport = await import(withKey('./js/report.js'));
const configSchemaMod = await import(withKey('./config-schema.js'));

/** 插件版本（读 package.json；读不到返回空串）。 */
function packageVersion() {
  try {
    return JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version ?? '';
  } catch {
    return '';
  }
}

/** 邮件配置摘要（**绝不回显密码**，只说明填没填）。 */
function mailConfigSummary(astockConfig = {}) {
  return {
    enabled: Boolean(astockConfig.mail_enabled),
    host: astockConfig.mail_host || '',
    port: Number(astockConfig.mail_port || 465),
    hasPassword: Boolean(astockConfig.mail_password),
    recipients: String(astockConfig.mail_to || '').trim() !== '',
    minLevel: astockConfig.mail_min_level || 'urgent',
  };
}

/** 右栏面板数据端点（客户端 lib/client.js 也引用这个路径）。 */
export const PANEL_ENDPOINT = '/api/dsh-astock/panel';

/** 下载台账/流水的查询参数（`?download=ledger.json` / `?download=trades.csv`）。 */
export const DOWNLOAD_QUERY = 'download';

/** 自检端点：确认插件装配到了什么（面板/设置页/邮件是否就绪）。
 *
 * 必须挂在 `/api/` 下：DSH 0.2.2 的 web 服务器只把 `/api/*` 路由到插件注册的
 * 处理器，其它路径（例如早期用的 `/dsh-astock/info`）会被宿主当成未知请求
 * 直接回 400/404——面板端点 `/api/dsh-astock/panel` 一直可用就是证据。
 */
export const INFO_ENDPOINT = '/api/dsh-astock/info';

/** Cordis 插件名（与 package.json 的 name 一致）。 */
export const name = 'dsh-astock';

/** 依赖的工具注册表与系统提示服务。 */
export const inject = ['tools', 'systemPrompt'];

/** 注入模型的用法说明（工具描述本身已经很长，这里只讲「什么时候用、边界在哪」）。 */
export const USAGE_GUIDANCE = [
  '本会话装有 A 股助手工具（astock_* 系列，共 19 个）：行情快照 astock_quote、K 线 astock_kline、'
    + '代码检索 astock_search、条件选股 astock_screen、资金流 astock_flow、'
    + '技术公式 astock_calc、建仓/持仓/账户 astock_record/astock_portfolio/astock_hint、'
    + '舆情与事件 astock_sentiment/astock_events/astock_business、'
    + '量化选股与回测 astock_pick/astock_backtest、本地存档 astock_archive、'
    + '操作指示 astock_act、自选与盯盘规则 astock_watch、扩展数据面 astock_extra。',
  '凡是涉及 A 股行情、个股研究、持仓盈亏、买卖股数估算、历史回测的问题，先用这些工具取真实数据再回答，'
    + '不要凭印象编价格、涨跌幅或财报数字；取不到就直说取不到（工具会返回 [Error] 原因）。',
  '边界：这些工具**只读取数、只写本地台账**（默认 ~/.dsh/astock-data/ledger.sqlite），'
    + '没有任何下单/撤单/券商对接能力。用户自己在券商 App 执行交易，'
    + '插件只把「买哪几只、各多少股、止损止盈价」算清楚并记账。',
  '口径提醒：历史胜率/推荐率不是上涨概率，别把回测结论讲成预测；'
    + '所有输出都不构成投资建议，需要时明确提示风险。',
  '右栏「A股 → 维护」页可以直接更新存档、跑回测、启用盘后报告、导出/备份/导入台账——'
    + '这些是按钮动作，不需要模型代劳；用户问「怎么导出/备份/更新存档」时指向那里。',
].join('\n');

/**
 * 装进 DSH。
 *
 * @param {object} ctx    Cordis 上下文（已注入 tools / systemPrompt）
 * @param {object} [config] 插件配置（见 lib/config.js 的键映射）
 *
 * 注意：**不要返回任何值**。Cordis 把 apply 的返回值当作 disposer/effect，
 * 返回普通对象会直接让插件激活失败（实测 `TypeError: Invalid effect`）。
 */
export function apply(ctx, config = {}) {
  const options = hostOptions(config);
  const astockConfig = applyDefaultPaths(toAstockConfig(config));

  // JS 台账/存档实例：惰性创建，整个插件生命周期复用。声明必须在
  // mergeLocalSettings 之前——那里要刷新费率，而 `let` 在声明前访问会抛 TDZ。
  let ledgerInstance = null;
  let archiveInstance = null;

  /**
   * 本地设置（右栏「配置」页写入的 `settings.json`）合并进运行期配置。
   *
   * DSH 0.2.2 的「插件」页对第三方 bundle 常常不渲染配置表单（用户看到的就是
   * 「根本没有配置」），所以邮件/OAuth/交易/风控这些必须在右栏能改。合并顺序：
   * **本地设置 > 宿主配置 > 内置默认**；保存后调一次这个函数即生效，不用重启。
   */
  const settingsFile = () => jsSettings.settingsPath(astockConfig.ledger_path);
  const mergeLocalSettings = () => {
    const saved = jsSettings.loadSettings(astockConfig.ledger_path);
    Object.assign(astockConfig, jsSettings.settingsToAstock(saved));
    const oauthState = jsSettings.loadOAuthState(astockConfig.ledger_path);
    astockConfig.oauth_refresh_token = oauthState.refresh_token || '';
    // 费率改了要刷新已建好的台账实例，否则仍是启动时那套费率
    if (ledgerInstance) {
      ledgerInstance.refreshFee({
        commission_rate: astockConfig.commission_rate,
        min_commission: astockConfig.min_commission,
        stamp_tax_rate: astockConfig.stamp_tax_rate,
        transfer_fee_rate: astockConfig.transfer_fee_rate,
      });
    }
    return oauthState;
  };
  let oauthState = mergeLocalSettings();
  // 设备码授权的中间态（只在内存里，重启即失效——重新点一次「开始授权」即可）
  let pendingDevice = null;

  const jsLedger = () => {
    if (!ledgerInstance) {
      ledgerInstance = new ledgerMod.Ledger(astockConfig.ledger_path, {
        commission_rate: astockConfig.commission_rate,
        min_commission: astockConfig.min_commission,
        stamp_tax_rate: astockConfig.stamp_tax_rate,
        transfer_fee_rate: astockConfig.transfer_fee_rate,
      });
    }
    return ledgerInstance;
  };

  const jsArchive = () => {
    if (!archiveInstance) {
      archiveInstance = new archiveMod.Archive(astockConfig.archive_path);
    }
    return archiveInstance;
  };

  /**
   * 可选服务的装配统一走这里：`ctx.inject` 本身也可能因为宿主版本不同而抛
   * （比如旧版没有 schedule / timer 服务名）。装配失败只降级这一个能力，
   * 绝不能把整个 apply 抛出去——那会让 19 个工具和面板一起消失。
   */
  const safeInject = (services, callback) => {
    try {
      ctx.inject?.(services, callback);
    } catch (error) {
      try {
        console.warn(`[dsh-astock] 可选服务 ${services.join('/')} 装配失败：${error?.message ?? error}`);
      } catch { /* 宿主没有 console */ }
    }
  };

  const watchPlanPath = join(dirname(astockConfig.ledger_path), 'watch-plan.json');

  const workspaceOf = (exec) => options.workspace
    || exec?.agent?.session?.header?.cwd
    || '';

  /**
   * `astock_watch` 的 start/stop/status 三个动作由宿主侧接管（落到真实定时任务），
   * 其余动作交给 `js/watch-tool.js`。
   *
   * @returns {Promise<string|null>} null 表示「不接管，交给 watch-tool」
   */
  async function handleWatchAction(args, exec) {
    const action = String(args?.action ?? '').trim().toLowerCase();
    if (action !== 'start' && action !== 'stop' && action !== 'status') return null;

    const minutes = intervalMinutes(astockConfig);
    const cron = watchCron(minutes);

    if (action === 'start') {
      try {
        const plan = watchPlanMod.loadPlan(watchPlanPath);
        const result = await watch.ensure({
          minutes,
          sessionId: exec?.agent?.session?.header?.id ?? exec?.agent?.session?.id ?? '',
          cwd: workspaceOf(exec),
          prompt: watchPrompt(minutes, plan),
        });
        const task = result.task ?? {};
        return [
          '## 已启动盯盘（DSH 定时任务）',
          '',
          '| 项目 | 值 |',
          '|---|---|',
          `| 计划 | ${result.created ? '新建' : '已存在，沿用'} |`,
          `| 计划 id | \`${task.id ?? '-'}\` |`,
          `| 频率 | 工作日 9:00–14:59，每 ${result.minutes} 分钟（cron \`${result.cron}\`） |`,
          `| 下次运行 | ${nextRunText(task) || '-'} |`,
          '| 投递位置 | 独立会话（不打断当前对话） |',
          '',
          '**每次运行都要真实调用模型**，所以间隔比 lite-work 的探针版宽松（默认 15 分钟）。',
          `要调频率就改配置里的 \`watchIntervalSeconds\`（最小 ${MIN_INTERVAL_MINUTES} 分钟）再执行一次 start。`,
          '',
          '阈值（止损/止盈/超仓/量比）仍由配置与计划规则决定，用 `astock_watch action=plan` 查看。',
        ].join('\n');
      } catch (error) {
        return `[Error] 启动盯盘失败：${error?.message ?? error}`;
      }
    }

    if (action === 'stop') {
      try {
        const result = await watch.stop();
        if (!result.removed) return '## 盯盘已停止\n\n当前没有正在运行的盯盘计划。';
        return [
          '## 盯盘已停止',
          '',
          `已删除定时任务${result.title ? `「${result.title}」` : ''}。`,
          '',
          '台账、自选股与阈值配置都没有改动；需要时再说一次「启动盯盘」。',
        ].join('\n');
      } catch (error) {
        return `[Error] 停止盯盘失败：${error?.message ?? error}`;
      }
    }

    // status
    let state;
    try {
      state = await watch.status();
    } catch (error) {
      return `[Error] 读取盯盘状态失败：${error?.message ?? error}`;
    }
    const task = state.task;
    const running = Boolean(task && isTaskActive(task));

    // 盘后报告是另一条任务；顺手读一下，免得用户以为「盯盘关了报告也没了」
    let reportState = null;
    try {
      reportState = await report.status();
    } catch {
      reportState = null;
    }
    const reportTask = reportState?.task ?? null;
    const reportRunning = Boolean(reportTask && isTaskActive(reportTask));

    return [
      '## 盯盘状态',
      '',
      '| 项目 | 状态 |',
      '|---|---|',
      `| 定时计划 | ${running ? '✅ 运行中' : (task ? '⏸ 已暂停' : '❌ 未创建')} |`,
      state.available ? null : '| 定时服务 | ❌ 当前宿主没有 schedule 服务 |',
      task ? `| 计划 id | \`${task.id}\` |` : null,
      running ? `| 下次运行 | ${nextRunText(task) || '-'} |` : null,
      running ? `| 频率 | 工作日 9:00–14:59，每 ${intervalMinutes(astockConfig)} 分钟 |` : null,
      running ? '| 投递位置 | 独立会话 |' : null,
      reportState?.available
        ? `| 盘后报告 | ${reportRunning ? `✅ 工作日 15:05（下次 ${nextRunText(reportTask) || '-'}）` : '❌ 未创建（右栏「维护」页可一键启用）'} |`
        : null,
      '',
      running
        ? '触发信号后才提醒；没有信号时只回一行「无异常」。'
        : '说「启动盯盘」即可创建；阈值与规则用 `astock_watch action=plan` 查看。',
      '',
      '> 与 lite-work 版本的差别：那边是「探针每 5 分钟取数、指纹变了才唤醒 Agent」（非交易时段零 token）；'
      + 'DSH 没有探针，只有定时任务，所以这里是「到点运行一次」。',
    ].filter((line) => line !== null).join('\n');
  }

  // 盯盘开关由 JS 接管：上游那三个动作改的是 lite-work 的「盯梢计划」，
  // DSH 里没有那套探针；这里换成真实的宿主定时任务（见 lib/schedule.js）。
  let scheduleService;
  // `timer` 是可选依赖：不能直接读 `ctx.interval`（Cordis 会报
  // `cannot get property "timer" without inject`，整个请求变成 400）。
  // 只能在自己的 inject 回调里判断，再把结果记下来给自检端点用。
  let timerAvailable = false;
  const watch = createWatchController(() => scheduleService);
  // 盘后报告是**另一条**任务（工作日 15:05）：盯盘只在 9:00–14:59 跑，
  // 收盘后完全静默，不能指望它顺手把盘后报告带出来。
  const report = createReportController(() => scheduleService);

  // 每日 15:05 的存档/净值是纯子进程（零 token），由宿主 timer 驱动；
  // 盘后报告要调模型，由 DSH 定时任务驱动。两个开关分开。
  const archiveAuto = astockConfig.daily_archive !== false;
  const reportAuto = astockConfig.post_close_report === true;

  safeInject(['schedule'], (host) => {
    if (host?.schedule && typeof host.schedule.create === 'function') {
      scheduleService = host.schedule;
      // 配置里声明要盘后报告时，插件加载就把它补齐（幂等，不会重复建）
      if (reportAuto) {
        report.ensure({ cwd: options.workspace }).then((result) => {
          try {
            console.info(`[dsh-astock] 盘后报告任务已就绪：${result.task?.id ?? '-'}`
              + `（下次 ${nextRunText(result.task) || '-'}）`);
          } catch { /* 宿主没有 console */ }
        }).catch((error) => {
          try {
            console.warn(`[dsh-astock] 盘后报告任务装配失败：${error?.message ?? error}`);
          } catch { /* 宿主没有 console */ }
        });
      }
    }
  });

  // 逐个注册：一个工具的 schema 在宿主那一版被拒，不能把另外 18 个一起拖死。
  // （Cordis 会把 apply 抛出的异常记成「插件激活失败」，19 个工具全都没了。
  // 实测最容易被旧版宿主拒绝的是 parameters 里的 oneOf/anyOf——这里降级成
  // 「少一个工具 + 一行日志」，其余照常注册。）
  const toolRegistrations = [];
  for (const tool of TOOLS) {
    try {
      ctx.tools.register({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
        },
        async execute(args, exec) {
          if (tool.name === 'astock_watch') {
            const handled = await handleWatchAction(args, exec);
            if (handled !== null) return handled;
            const basic = await watchToolMod.runWatch(args ?? {}, {
              ledger: jsLedger(),
              planPath: watchPlanPath,
              interval: Number(astockConfig.watch_interval_seconds || 300),
              enabled: astockConfig.watch_enabled !== false,
              syncPrompt: async (plan) => watch.updatePrompt(
                watchPrompt(intervalMinutes(astockConfig), plan),
              ),
            });
            if (basic !== null) return basic;
          }
          // 19 个工具全部走 JS 实现；异常只记日志并返回可读错误，不再回退子进程。
          if (tool.name === 'astock_quote') {
            try {
              return await quoteMod.runQuote(args ?? {}, { ledger: jsLedger() });
            } catch (error) {
              try {
                console.warn(`[dsh-astock] JS astock_quote 失败：${error?.message ?? error}`);
              } catch { /* 宿主没有 console */ }
            }
          }
          if (tool.name === 'astock_kline') {
            try {
              return await klineToolMod.runKline(args ?? {});
            } catch (error) {
              try {
                console.warn(`[dsh-astock] JS astock_kline 失败：${error?.message ?? error}`);
              } catch { /* 宿主没有 console */ }
            }
          }
          if (tool.name === 'astock_search') {
            try {
              return await searchMod.runSearch(args ?? {});
            } catch (error) {
              try {
                console.warn(`[dsh-astock] JS astock_search 失败：${error?.message ?? error}`);
              } catch { /* 宿主没有 console */ }
            }
          }
          if (tool.name === 'astock_screen') {
            try {
              return await screenMod.runScreen(args ?? {});
            } catch (error) {
              try {
                console.warn(`[dsh-astock] JS astock_screen 失败：${error?.message ?? error}`);
              } catch { /* 宿主没有 console */ }
            }
          }
          if (tool.name === 'astock_flow') {
            try {
              return await flowMod.runFlow(args ?? {});
            } catch (error) {
              try {
                console.warn(`[dsh-astock] JS astock_flow 失败：${error?.message ?? error}`);
              } catch { /* 宿主没有 console */ }
            }
          }
          if (tool.name === 'astock_record') {
            try {
              return await portfolioMod.runRecord(args ?? {}, { ledger: jsLedger() });
            } catch (error) {
              try {
                console.warn(`[dsh-astock] JS astock_record 失败：${error?.message ?? error}`);
              } catch { /* 宿主没有 console */ }
            }
          }
          if (tool.name === 'astock_portfolio') {
            try {
              return await portfolioMod.runPortfolio(args ?? {}, { ledger: jsLedger() });
            } catch (error) {
              try {
                console.warn(`[dsh-astock] JS astock_portfolio 失败：${error?.message ?? error}`);
              } catch { /* 宿主没有 console */ }
            }
          }
          if (tool.name === 'astock_hint') {
            try {
              return await hintMod.runHint(args ?? {}, {
                ledger: jsLedger(), config: astockConfig,
              });
            } catch (error) {
              try {
                console.warn(`[dsh-astock] JS astock_hint 失败：${error?.message ?? error}`);
              } catch { /* 宿主没有 console */ }
            }
          }
          if (tool.name === 'astock_sync') {
            try {
              return await syncMod.runSync(args ?? {}, {
                ledger: jsLedger(), config: astockConfig,
              });
            } catch (error) {
              try {
                console.warn(`[dsh-astock] JS astock_sync 失败：${error?.message ?? error}`);
              } catch { /* 宿主没有 console */ }
            }
          }
          if (tool.name === 'astock_business') {
            try {
              return await businessMod.runBusiness(args ?? {});
            } catch (error) {
              try {
                console.warn(`[dsh-astock] JS astock_business 失败：${error?.message ?? error}`);
              } catch { /* 宿主没有 console */ }
            }
          }
          if (tool.name === 'astock_sentiment') {
            try {
              return await sentimentMod.runSentiment(args ?? {}, { ledger: jsLedger() });
            } catch (error) {
              try {
                console.warn(`[dsh-astock] JS astock_sentiment 失败：${error?.message ?? error}`);
              } catch { /* 宿主没有 console */ }
            }
          }
          if (tool.name === 'astock_events') {
            try {
              return await eventsMod.runEvents(args ?? {});
            } catch (error) {
              try {
                console.warn(`[dsh-astock] JS astock_events 失败：${error?.message ?? error}`);
              } catch { /* 宿主没有 console */ }
            }
          }
          if (tool.name === 'astock_pick') {
            try {
              return await pickMod.runPick(args ?? {}, {
                ledger: jsLedger(), config: astockConfig,
              });
            } catch (error) {
              try {
                console.warn(`[dsh-astock] JS astock_pick 失败：${error?.message ?? error}`);
              } catch { /* 宿主没有 console */ }
            }
          }
          if (tool.name === 'astock_backtest') {
            try {
              return await backtestMod.runBacktestTool(args ?? {}, {
                ledger: jsLedger(), config: astockConfig, archive: jsArchive(),
              });
            } catch (error) {
              try {
                console.warn(`[dsh-astock] JS astock_backtest 失败：${error?.message ?? error}`);
              } catch { /* 宿主没有 console */ }
            }
          }
          if (tool.name === 'astock_archive') {
            try {
              return await archiveToolMod.runArchive(args ?? {}, {
                ledger: jsLedger(), archive: jsArchive(),
              });
            } catch (error) {
              try {
                console.warn(`[dsh-astock] JS astock_archive 失败：${error?.message ?? error}`);
              } catch { /* 宿主没有 console */ }
            }
          }
          if (tool.name === 'astock_act') {
            try {
              return await actMod.runAct(args ?? {}, {
                ledger: jsLedger(), config: astockConfig, archive: jsArchive(),
              });
            } catch (error) {
              try {
                console.warn(`[dsh-astock] JS astock_act 失败：${error?.message ?? error}`);
              } catch { /* 宿主没有 console */ }
            }
          }
          if (tool.name === 'astock_extra') {
            try {
              const handled = await extraMod.runExtra(args ?? {});
              if (handled !== null) return handled;
            } catch (error) {
              try {
                console.warn(`[dsh-astock] JS astock_extra 失败：${error?.message ?? error}`);
              } catch { /* 宿主没有 console */ }
            }
          }
          if (tool.name === 'astock_calc') {
            try {
              return await calcMod.runCalc(args ?? {}, { config: astockConfig });
            } catch (error) {
              try {
                console.warn(`[dsh-astock] JS astock_calc 失败：${error?.message ?? error}`);
              } catch { /* 宿主没有 console */ }
            }
          }
          return `[Error] 工具 ${tool.name} 执行失败：JS 实现抛出了异常（详见宿主日志）。`;
        },
      });
      toolRegistrations.push(tool.name);
    } catch (error) {
      try {
        console.warn(`[dsh-astock] 工具 ${tool.name} 注册失败（其余工具继续注册）：${error?.message ?? error}`);
      } catch { /* 宿主没有 console */ }
    }
  }
  if (toolRegistrations.length !== TOOLS.length) {
    try {
      console.warn(`[dsh-astock] 已注册 ${toolRegistrations.length}/${TOOLS.length} 个工具；`
        + '失败项见上一行日志（通常是宿主版本不接受该工具的 parameters schema）');
    } catch { /* 宿主没有 console */ }
  }

  try {
    ctx.systemPrompt?.context?.({
      name: 'dsh-astock:usage',
      order: 120,
      text: USAGE_GUIDANCE,
    });
  } catch (error) {
    try {
      console.warn(`[dsh-astock] 系统提示注入失败（工具照常可用）：${error?.message ?? error}`);
    } catch { /* 宿主没有 console */ }
  }

  // ── 右栏面板数据端点 ────────────────────────────────────────────────
  // 用 webServer 而不是新开服务：客户端与宿主同源，`fetch('/api/...')` 直接可用，
  // 也不引入第二个端口/鉴权体系（genui 的 prompt 端点同样挂在 /api 下）。
  //
  // `webServer` 是**可选**依赖，所以不能写进顶层 inject（那是硬依赖，缺失会让
  // 整个插件激活失败），也不能直接 `ctx.webServer`（Cordis 会报
  // `cannot get property "webServer" without inject`）。正确写法是 ctx.inject +
  // 回调内判断：服务没起来时面板端点不注册，19 个工具照常工作。
  safeInject(['webServer'], (host) => {
    const server = host?.webServer;
    if (!server || typeof server.register !== 'function') return;

    // 每条路由各自隔离：一条注册失败（比如路径被别的插件占了）不能连累另一条，
    // 更不能把后面「定时探测」的装配一并抛掉——那是本插件最容易静默失效的部分。
    const mount = (register, label) => {
      try {
        host.effect(register, label);
      } catch (error) {
        console.warn(`[dsh-astock] ${label} 注册失败：${error?.message ?? error}`);
      }
    };

    mount(() => server.register({
      kind: 'exact',
      path: PANEL_ENDPOINT,
      handler: async (req, res) => {
        const send = (payload) => {
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end(req.method === 'HEAD' ? undefined : JSON.stringify(payload));
        };

        // POST：维护动作。全部必须显式触发，不做隐式副作用。
        // 动作实现都在 `lib/js/` 里，与工具调用同一套函数——避免面板与工具
        // 各自算一套口径（面板说没事、工具喊卖那种矛盾）。
        if (req.method === 'POST') {
          try {
            const raw = await readBody(req, 2 * 1024 * 1024);
            const body = raw ? JSON.parse(raw) : {};
            const op = String(body?.op ?? '').trim();

            if (op === 'mail_test') {
              send(await jsAlerts.testSend(astockConfig));
              return;
            }
            if (op === 'settings_save') {
              const values = body?.values && typeof body.values === 'object' ? body.values : {};
              const result = jsSettings.saveSettings(astockConfig.ledger_path, values);
              // 立刻生效：合并进运行期配置（不用重启 DSH）
              oauthState = mergeLocalSettings();
              jsOAuth.resetTokenCache();
              send({
                ok: true,
                saved: result.saved,
                message: `已保存 ${result.saved.length} 项设置`,
                values: jsSettings.maskedValues(result.settings),
                mail: jsAlerts.status(astockConfig, { oauth: oauthState }),
              });
              return;
            }
            if (op === 'oauth_start') {
              const started = await jsOAuth.startDeviceCode(astockConfig);
              if (!started.ok) {
                send({ ok: false, message: started.message });
                return;
              }
              pendingDevice = {
                deviceCode: started.deviceCode,
                userCode: started.userCode,
                verificationUri: started.verificationUri,
                message: started.message,
                hint: started.hint || '',
                interval: started.interval || 5,
                expiresAt: Date.now() + (started.expiresIn || 900) * 1000,
              };
              send({
                ok: true,
                userCode: started.userCode,
                verificationUri: started.verificationUri,
                expiresIn: started.expiresIn,
                interval: started.interval,
                hint: started.hint || '',
                message: `请打开 ${started.verificationUri} 输入代码 ${started.userCode}，完成后点「我已完成授权」`,
              });
              return;
            }
            if (op === 'oauth_poll') {
              if (!pendingDevice) {
                send({ ok: false, status: 'error', message: '没有进行中的授权，请先点「开始授权」' });
                return;
              }
              if (Date.now() > pendingDevice.expiresAt) {
                pendingDevice = null;
                send({ ok: false, status: 'expired', message: '设备码已过期，请重新点「开始授权」' });
                return;
              }
              const polled = await jsOAuth.pollDeviceCode(astockConfig, pendingDevice.deviceCode);
              if (polled.status === 'pending') {
                send({ ok: true, status: 'pending', message: polled.message || '等待授权…' });
                return;
              }
              if (polled.status !== 'done') {
                pendingDevice = null;
                send({ ok: false, status: 'error', message: polled.message });
                return;
              }
              jsSettings.saveOAuthState(astockConfig.ledger_path, {
                refresh_token: polled.refreshToken,
                account: String(astockConfig.mail_username || ''),
                scope: polled.scope || '',
                obtained_at: new Date().toISOString(),
              });
              pendingDevice = null;
              oauthState = mergeLocalSettings();
              jsOAuth.resetTokenCache();
              send({
                ok: true,
                status: 'done',
                account: oauthState.account,
                message: '授权完成：refresh_token 已保存，之后会自动续期',
              });
              return;
            }
            if (op === 'oauth_logout') {
              jsSettings.clearOAuthState(astockConfig.ledger_path);
              pendingDevice = null;
              oauthState = mergeLocalSettings();
              jsOAuth.resetTokenCache();
              send({ ok: true, message: '已清除授权（refresh_token 已删除）' });
              return;
            }
            if (op === 'archive_update') {
              send(await jsMaintenance.archiveRun(jsLedger(), jsArchive()));
              return;
            }
            if (op === 'backtest_run') {
              const strategy = String(body?.strategy ?? '').trim().toLowerCase();
              const config = strategy ? { ...astockConfig, pick_strategy: strategy } : astockConfig;
              send(await jsMaintenance.backtestRun(jsLedger(), jsArchive(), config));
              return;
            }
            if (op === 'report_on') {
              const result = await report.ensure({ cwd: options.workspace });
              const task = result.task ?? {};
              send({
                ok: true,
                created: result.created,
                message: '盘后报告已启用：工作日 15:05，投递到独立会话',
                // 不回传完整 prompt（很长，且前端用不到）
                task: {
                  id: task.id ?? '',
                  title: task.title ?? '',
                  scheduledAt: task.scheduledAt ?? '',
                  scheduledAtLocal: task.scheduledAtLocal ?? '',
                  status: task.status ?? '',
                  active: task.active,
                },
                next: nextRunText(task),
              });
              return;
            }
            if (op === 'report_off') {
              const result = await report.stop();
              send({
                ok: true,
                removed: result.removed,
                message: result.removed ? '盘后报告已停用' : '当前没有盘后报告任务',
              });
              return;
            }
            if (op === 'watch_start') {
              const minutes = intervalMinutes(astockConfig);
              const plan = watchPlanMod.loadPlan(watchPlanPath);
              const result = await watch.ensure({
                minutes,
                cwd: options.workspace,
                prompt: watchPrompt(minutes, plan),
              });
              send({
                ok: true,
                created: result.created,
                message: `盯盘已${result.created ? '启动' : '就绪'}：工作日 9:00–14:59，每 ${result.minutes} 分钟`,
                task: {
                  id: result.task?.id ?? '',
                  title: result.task?.title ?? '',
                  status: result.task?.status ?? '',
                },
                next: nextRunText(result.task),
              });
              return;
            }
            if (op === 'watch_stop') {
              const result = await watch.stop();
              send({
                ok: true,
                removed: result.removed,
                message: result.removed ? '盯盘已停止（定时任务已删除）' : '当前没有盯盘任务',
              });
              return;
            }
            if (op === 'backup_create') {
              send(jsMaintenance.createBackup({ ledger: jsLedger(), archive: jsArchive() }));
              return;
            }
            if (op === 'backup_list') {
              send({ ok: true, backups: jsMaintenance.listBackups(jsLedger().path) });
              return;
            }
            if (op === 'backup_restore') {
              send(jsMaintenance.restoreBackup(
                { ledger: jsLedger(), archive: jsArchive() },
                String(body?.name ?? ''),
              ));
              return;
            }
            if (op === 'import_trades') {
              send(jsMaintenance.importTrades(
                jsLedger(),
                String(body?.text ?? ''),
                body?.commit === true,
              ));
              return;
            }
            if (op === 'ledger_rebuild') {
              send(jsMaintenance.rebuildPositions(jsLedger()));
              return;
            }
            if (op === 'ledger_import_preview') {
              send(jsMaintenance.previewLedgerImport(
                jsLedger(), String(body?.text ?? ''), { scope: String(body?.scope ?? 'all') },
              ));
              return;
            }
            if (op === 'ledger_import_commit') {
              send(jsMaintenance.importLedger(
                jsLedger(), String(body?.text ?? ''), { scope: String(body?.scope ?? 'all') },
              ));
              return;
            }
            if (op === 'watchlist_import') {
              send(jsMaintenance.importWatchlist(
                jsLedger(), String(body?.text ?? ''), { commit: body?.commit === true },
              ));
              return;
            }
            if (op === 'plan_import') {
              let incoming;
              try {
                incoming = JSON.parse(String(body?.text ?? '').trim());
              } catch (error) {
                send({ ok: false, message: `不是合法 JSON：${error?.message ?? error}` });
                return;
              }
              const current = watchPlanMod.loadPlan(watchPlanPath);
              const source = incoming && incoming.plan && typeof incoming.plan === 'object'
                ? incoming.plan : incoming;
              if (!source || typeof source !== 'object') {
                send({ ok: false, message: '文件里没有盯盘规则对象' });
                return;
              }
              const [rules, ruleErrors] = watchPlanMod.parseRules(source.rules || []);
              const next = {
                ...current,
                ...source,
                rules,
              };
              watchPlanMod.savePlan(watchPlanPath, next);
              // 规则改了要同步进盯盘任务的 prompt，否则定时任务还是按旧规则跑
              try {
                await watch.updatePrompt(watchPrompt(intervalMinutes(astockConfig), next));
              } catch {
                // 没有 schedule 服务时忽略
              }
              send({
                ok: true,
                rules: rules.length,
                errors: ruleErrors,
                message: `已导入 ${rules.length} 条价位规则`
                  + (ruleErrors.length ? `，${ruleErrors.length} 条无效被跳过` : '')
                  + (next.codes ? `；额外盯 ${next.codes}` : ''),
              });
              return;
            }
            if (op === 'plan_export') {
              const plan = watchPlanMod.loadPlan(watchPlanPath);
              send({
                ok: true,
                filename: 'astock-watch-plan.json',
                content: JSON.stringify(plan, null, 2),
              });
              return;
            }
            if (op === 'trade_save') {
              // 录入/修改一笔已成交的买卖。校验全部在台账里做（价格、整手、
              // T+1 可卖），面板只负责把参数原样递进来，避免两边口径不一致。
              const side = String(body?.side || '').trim().toLowerCase();
              const code = String(body?.code || '').trim();
              const price = Number(body?.price);
              const shares = Math.trunc(Number(body?.shares));
              if (!['buy', 'sell'].includes(side)) {
                send({ ok: false, message: '方向只能是 buy（买入）或 sell（卖出）' });
                return;
              }
              if (!code) {
                send({ ok: false, message: '请填股票代码' });
                return;
              }
              if (!Number.isFinite(price) || price <= 0) {
                send({ ok: false, message: '成交价必须大于 0' });
                return;
              }
              if (!Number.isFinite(shares) || shares <= 0) {
                send({ ok: false, message: '成交数量必须是正整数' });
                return;
              }
              const feeText = String(body?.fee ?? '').trim();
              const feeOverride = feeText === '' ? null : Number(feeText);
              if (feeOverride !== null && !Number.isFinite(feeOverride)) {
                send({ ok: false, message: '费用必须是数字，留空则按费率自动算' });
                return;
              }
              const saved = jsLedger().recordTrade(code, side, price, shares, {
                tradeDate: String(body?.trade_date || '').trim(),
                name: String(body?.name || '').trim(),
                note: String(body?.note || '').trim(),
                feeOverride,
              });
              send({
                ok: true,
                message: `已录入${saved.side === 'buy' ? '买入' : '卖出'} `
                  + `${saved.code} ${saved.shares} 股 @ ${saved.price.toFixed(2)}`,
                trade: saved,
              });
              return;
            }
            if (op === 'trade_delete') {
              const tradeId = Math.trunc(Number(body?.trade_id));
              if (!Number.isFinite(tradeId) || tradeId <= 0) {
                send({ ok: false, message: '缺少要删除的流水 id' });
                return;
              }
              const result = jsLedger().deleteTrade(tradeId);
              send({
                ok: true,
                message: `已删除流水 #${tradeId}，${result.code} 持仓已按剩余流水重算`,
                result,
              });
              return;
            }
            if (op === 'event_order_save') {
              // 手动事件单＝券商条件单的参数，落成 plans 里的一条（kind=event_order）。
              // 校验在面板层做，台账只负责存；成交后 astock_sync 仍能按代码/方向/价格匹配。
              const code = String(body?.code || '').trim();
              const side = String(body?.side || '').trim().toLowerCase();
              const triggerKind = String(body?.trigger_kind || '').trim();
              const triggerPrice = Number(body?.trigger_price);
              const shares = Math.trunc(Number(body?.shares));
              const orderType = String(body?.order_type || 'limit').trim().toLowerCase();
              const orderPriceRaw = String(body?.price ?? '').trim();
              const orderPrice = orderPriceRaw === '' ? triggerPrice : Number(orderPriceRaw);
              const validUntil = String(body?.valid_until || '').trim();
              if (!code) { send({ ok: false, message: '请填股票代码' }); return; }
              if (!['buy', 'sell'].includes(side)) {
                send({ ok: false, message: '方向只能是 buy / sell' });
                return;
              }
              if (!['price_below', 'price_above'].includes(triggerKind)) {
                send({ ok: false, message: '触发条件只能是「价格 ≤」或「价格 ≥」' });
                return;
              }
              if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) {
                send({ ok: false, message: '触发价必须大于 0' });
                return;
              }
              if (!Number.isFinite(shares) || shares <= 0) {
                send({ ok: false, message: '数量必须是正整数' });
                return;
              }
              if (!Number.isFinite(orderPrice) || orderPrice <= 0) {
                send({ ok: false, message: '委托价必须大于 0（留空则用触发价）' });
                return;
              }
              if (validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) {
                send({ ok: false, message: '有效期格式应为 YYYY-MM-DD，或留空' });
                return;
              }
              const plan = jsLedger().savePlan({
                code,
                name: String(body?.name || '').trim(),
                side,
                price: orderPrice,
                shares,
                reason: String(body?.note || '').trim() || '手动事件单（券商条件单）',
                kind: 'event_order',
                status: 'pending',
                note: String(body?.note || '').trim(),
                trigger_kind: triggerKind,
                trigger_price: triggerPrice,
                order_type: orderType === 'market' ? 'market' : 'limit',
                valid_until: validUntil,
                source: 'manual',
              });
              send({
                ok: true,
                message: `已创建事件单 ${plan.plan_id}：${code} `
                  + `${triggerKind === 'price_below' ? '≤' : '≥'} ${triggerPrice.toFixed(2)} `
                  + `${side === 'buy' ? '买入' : '卖出'} ${shares} 股`,
                plan: {
                  plan_id: plan.plan_id,
                  code: plan.code,
                  side: plan.side,
                  trigger: triggerKind,
                  trigger_price: plan.trigger_price,
                  price: plan.price,
                  shares: plan.shares,
                  valid_until: plan.valid_until,
                },
              });
              return;
            }
            if (op === 'plan_cancel') {
              const planId = String(body?.plan_id || '').trim();
              if (!planId) {
                send({ ok: false, message: '缺少 plan_id' });
                return;
              }
              const plan = jsLedger().markPlan(planId, 'cancelled', '面板手动撤销');
              send({ ok: true, message: `已撤销事件单 ${planId}`, plan });
              return;
            }
            if (op === 'report_send') {
              send(await jsReport.sendReport(jsLedger(), astockConfig));
              return;
            }
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: `未知操作 ${op || '(空)'}` }));
          } catch (error) {
            send({ ok: false, message: `${error?.name ?? 'Error'}: ${error?.message ?? error}` });
          }
          return;
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'method-not-allowed' }));
          return;
        }

        let url;
        try {
          url = new URL(req.url ?? '/', 'http://localhost');
        } catch {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'bad-url' }));
          return;
        }

        // 下载：导出台账 JSON / 成交 CSV / 自选 / 盯盘规则。用附件头直接落到
        // 浏览器下载目录，不把整份台账塞进面板 JSON（几千笔流水会让面板变慢）。
        const download = url.searchParams.get(DOWNLOAD_QUERY);
        if (download) {
          try {
            const kind = String(download).toLowerCase();
            let payload;
            if (kind === 'watch-plan.json' || kind === 'plan.json' || kind === 'plan') {
              // 盯盘规则是本地 JSON，不经台账
              let content = '';
              try {
                content = readFileSync(watchPlanPath, 'utf8');
              } catch {
                content = JSON.stringify(watchPlanMod.DEFAULT_PLAN, null, 2);
              }
              payload = {
                ok: true,
                filename: `astock-watch-plan-${Date.now()}.json`,
                contentType: 'application/json; charset=utf-8',
                content,
              };
            } else {
              payload = jsMaintenance.exportPayload(jsLedger(), kind);
            }
            if (!payload?.ok) {
              send(payload);
              return;
            }
            const filename = String(payload.filename || 'astock-export');
            // 头部只能放 ASCII；中文文件名走 RFC 5987 的 filename*
            const ascii = filename.replace(/[^\x20-\x7e]/g, '_');
            res.writeHead(200, {
              'content-type': payload.contentType || 'application/octet-stream',
              'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
              'cache-control': 'no-store',
            });
            res.end(req.method === 'HEAD'
              ? undefined
              : Buffer.from(String(payload.content ?? ''), 'utf8'));
          } catch (error) {
            send({ ok: false, message: `${error?.name ?? 'Error'}: ${error?.message ?? error}` });
          }
          return;
        }

        let payload;
        try {
          const asked = url.searchParams.get('panel');
          const panel = asked === 'pick' ? 'pick'
            : asked === 'mail' ? 'mail'
              : asked === 'maint' ? 'maint'
                : asked === 'trade' ? 'trade'
                  : asked === 'auto' ? 'auto'
                    : asked === 'settings' ? 'settings'
                      : 'portfolio';
          const strategy = url.searchParams.get('strategy') ?? '';
          // fresh=1：选股页的「重新扫描」按钮——跳过落盘缓存，真扫一次
          const fresh = url.searchParams.get('fresh') === '1';
          if (panel === 'auto') {
            // 「计划」页：把两类定时放在一张表里说清楚——
            //   · 插件自己的内部 timer（每日 15:05 存档、邮件探测）：不在 DSH 任务列表里；
            //   · 通过 DSH 定时服务建的（盯盘、盘后报告）：左栏「自动化任务」也能看到。
            let watchState = { available: false };
            let reportState = { available: false };
            try {
              watchState = await watch.status();
            } catch { /* 没有 schedule 服务时按不可用显示 */ }
            try {
              reportState = await report.status();
            } catch { /* 同上 */ }
            const saved = maintenanceMod.readState(
              maintenanceStatePath(astockConfig.ledger_path || ''),
            );
            const minutes = intervalMinutes(astockConfig);
            payload = {
              view: 'auto',
              ok: true,
              renderedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
              scheduleAvailable: Boolean(scheduleService),
              watch: {
                available: watchState.available !== false,
                running: Boolean(watchState.task && isTaskActive(watchState.task)),
                taskId: watchState.task?.id ?? '',
                title: watchState.task?.title ?? '',
                status: watchState.task?.status ?? '',
                next: nextRunText(watchState.task),
                minutes,
                cron: watchCron(minutes),
              },
              report: {
                available: reportState.available !== false,
                running: Boolean(reportState.task && isTaskActive(reportState.task)),
                taskId: reportState.task?.id ?? '',
                title: reportState.task?.title ?? REPORT_TITLE,
                status: reportState.task?.status ?? '',
                next: nextRunText(reportState.task),
                cron: REPORT_CRON,
              },
              archive: {
                enabled: archiveAuto,
                time: '15:05',
                lastRunDate: saved.lastRunDate || '',
                lastRunAt: saved.lastRunAt || '',
                lastAttemptAt: saved.lastAttemptAt || '',
                lastError: saved.lastError || '',
                lastResult: saved.lastResult || null,
              },
              mail: {
                ...jsAlerts.status(astockConfig, { oauth: oauthState }),
                intervalSeconds: probeSeconds(astockConfig),
              },
            };
          } else if (panel === 'settings') {
            // 「设置」视图：邮件 / OAuth 全部在这里改（宿主配置页对第三方 bundle
            // 不一定存在，这条路径必须自给自足）
            oauthState = jsSettings.loadOAuthState(astockConfig.ledger_path);
            const fields = jsSettings.fieldSpecs();
            // 没保存过的字段回落到表单默认值，避免下拉框显示空白/与真实默认不一致
            const defaults = Object.fromEntries(fields.map((field) => [field.key, field.default]));
            payload = {
              view: 'settings',
              ok: true,
              renderedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
              fields,
              presets: jsSettings.presetSpecs(),
              version: packageVersion(),
              values: {
                ...defaults,
                ...jsSettings.maskedValues(jsSettings.loadSettings(astockConfig.ledger_path)),
              },
              mail: jsAlerts.status(astockConfig, { oauth: oauthState }),
              oauth: {
                provider: astockConfig.mail_provider || 'outlook',
                authorized: Boolean(oauthState.refresh_token),
                account: oauthState.account || '',
                obtainedAt: oauthState.obtained_at || '',
                clientId: jsOAuth.oauthConfig(astockConfig).clientId,
                tenant: jsOAuth.oauthConfig(astockConfig).tenant,
                pending: pendingDevice
                  ? {
                    userCode: pendingDevice.userCode,
                    verificationUri: pendingDevice.verificationUri,
                    expiresAt: pendingDevice.expiresAt,
                    message: pendingDevice.message,
                    hint: pendingDevice.hint || '',
                  }
                  : null,
              },
              paths: {
                settings: settingsFile(),
                oauth: jsSettings.oauthPath(astockConfig.ledger_path),
              },
            };
          } else if (panel === 'mail') {
            // 「通知」视图只是配置体检，不碰行情、不发信
            payload = {
              view: 'mail',
              ...jsAlerts.status(astockConfig, { oauth: oauthState }),
              // 设置表单没注册时，通知页也要能说清楚「为什么填不了」
              settings: {
                configSchema: Boolean(configSchemaMod.Config),
                error: configSchemaMod.schemaError || '',
              },
            };
          } else {
            payload = await jsPanel.build({
              ledger: jsLedger(),
              archive: jsArchive(),
              config: astockConfig,
              panel,
              strategy,
              fresh,
              tradePage: Number(url.searchParams.get('trade_page')) || 1,
              planPage: Number(url.searchParams.get('plan_page')) || 1,
            });
          }
          // 「维护」视图要带上宿主侧的自动化状态（定时任务/上次执行），
          // 这些信息只有宿主侧有（schedule 服务）。
          if (panel === 'maint') {
            let reportState = null;
            try {
              reportState = await report.status();
            } catch {
              reportState = null;
            }
            const saved = maintenanceMod.readState(
              maintenanceStatePath(astockConfig.ledger_path || ''),
            );
            payload = {
              ...payload,
              settings: {
                configSchema: Boolean(configSchemaMod.Config),
                fields: configSchemaMod.SETTINGS_KEYS.length,
                failed: configSchemaMod.builtFields
                  .filter((item) => !item.ok)
                  .map((item) => item.key),
                error: configSchemaMod.schemaError || '',
              },
              automation: {
                archiveAuto,
                lastRunAt: saved.lastRunAt || '',
                lastRunDate: saved.lastRunDate || '',
                lastError: saved.lastError || '',
                report: reportState && reportState.available
                  ? {
                    available: true,
                    active: Boolean(reportState.task && isTaskActive(reportState.task)),
                    next: nextRunText(reportState.task),
                    taskId: reportState.task?.id ?? '',
                  }
                  : { available: false, active: false, next: '' },
              },
            };
          }
        } catch (error) {
          // 面板失败也要给出可读原因：空白面板比一句报错更让人困惑。
          payload = {
            ok: false,
            renderedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
            error: `${error?.name ?? 'Error'}: ${error?.message ?? error}`,
          };
        }
        send(payload);
      },
    }), 'dsh-astock: panel endpoint');

    // 自检端点：排查「设置页没表单 / 面板打不开 / 邮件不发」时先看这里，
    // 免得每次都靠猜（`configSchema` 为 false 就是 schemastery 没取到）。
    mount(() => server.register({
      kind: 'exact',
      path: INFO_ENDPOINT,
      handler: async (req, res) => {
        let payload;
        try {
          payload = {
            ok: true,
            plugin: name,
            version: packageVersion(),
            tools: TOOLS.length,
            panelEndpoint: PANEL_ENDPOINT,
            configSchema: Boolean(configSchemaMod.Config),
            settingsFields: configSchemaMod.SETTINGS_KEYS.length,
            settingsError: configSchemaMod.schemaError || '',
            // 哪些字段没建起来（schemastery API 差异时看得见，而不是整个表单悄悄没了）
            settingsFailed: configSchemaMod.builtFields
              .filter((item) => !item.ok)
              .map((item) => item.key),
            webServer: Boolean(server),
            schedule: Boolean(scheduleService),
            alertsTimer: timerAvailable,
            alertIntervalSeconds: probeSeconds(astockConfig),
            // 每日 15:05 的存档/净值（零 token）；盘后报告是定时任务
            archiveAuto,
            archiveMaintenanceState: maintenanceStatePath(astockConfig.ledger_path || ''),
            reportAuto,
            mail: mailConfigSummary(astockConfig),
          };
        } catch (error) {
          console.warn(`[dsh-astock] 自检端点取值失败：${error?.message ?? error}`);
          payload = { ok: false, error: String(error?.message ?? error) };
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(payload));
      },
    }), 'dsh-astock: info endpoint');
  });

  // ── 高风险邮件：宿主侧定时探测（零 token） ─────────────────────────
  // 与盯盘 Agent 分开：那个每轮都要调模型，这个只跑一次规则判定 + 发信。
  // 未启用时 `runOnce` 会立刻返回「未启用」，代价只是一次本地判断。
  safeInject(['timer'], (host) => {
    timerAvailable = typeof host?.interval === 'function';
    if (!timerAvailable) return;
    const seconds = probeSeconds(astockConfig);
    try {
      host.effect(() => installAlertTimer(host, {
        seconds,
        log: (message, level) => {
          // debug 级别的"跳过"不该刷屏
          if (level === 'debug') return;
          try { console.info(`[dsh-astock] ${message}`); } catch { /* 宿主没有 console */ }
        },
        probe: async () => jsAlerts.runOnce(jsLedger(), astockConfig),
      }), 'dsh-astock: alert timer');
    } catch (error) {
      console.warn(`[dsh-astock] 邮件定时探测装配失败：${error?.message ?? error}`);
    }

    // 每日收盘维护：更新存档 + 记收盘净值（零 token，纯本地任务）。
    // 这是本插件里唯一「今天不做就永久损失」的功能：存档只增不减，今天开始存，
    // 一年后才多一年历史。所以它由宿主自己定时，不依赖用户记得点按钮。
    if (archiveAuto) {
      try {
        host.effect(() => installDailyTimer(host, {
          statePath: maintenanceStatePath(astockConfig.ledger_path || ''),
          log: (message, level) => {
            if (level === 'debug') return;
            try { console.info(`[dsh-astock] ${message}`); } catch { /* 宿主没有 console */ }
          },
          run: async () => {
            const result = await jsMaintenance.dailyMaintenance(jsLedger(), jsArchive());
            // 盘后复盘邮件：零 token（本地拼装 + 现有 SMTP），失败只降级不抛
            if (!result.skipped && astockConfig.report_email) {
              try {
                result.report = await jsReport.sendReport(jsLedger(), astockConfig);
              } catch (error) {
                result.report = { ok: false, message: String(error?.message ?? error) };
              }
            }
            return result;
          },
        }), 'dsh-astock: daily maintenance');
      } catch (error) {
        console.warn(`[dsh-astock] 每日维护装配失败：${error?.message ?? error}`);
      }
    }
  });
}

/** 读取请求体（POST 用）。上限 2MB：导入成交 CSV 可能有一两千行。 */
async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 本插件注册的工具名（给测试与文档用；不要从 apply 返回它）。 */
export function toolNames() {
  return TOOLS.map((tool) => tool.name);
}

/**
 * 自检（不经过 Cordis：宿主/脚本都能直接调）。
 *
 * `node scripts/selftest.mjs` 走的就是这条路径。刻意**不挂到 ctx 上**——
 * Cordis 里给 ctx 赋属性属于「声明服务」的语义，未 `provide` 就赋值会让整个
 * 插件激活失败（实测报错：cannot set property ... without provide）。
 */
export async function selftest(config = {}) {
  const astockConfig = applyDefaultPaths(toAstockConfig(config));
  // 本地设置（右栏「设置」写入的）也要算进来，否则自检看到的邮件状态会与面板不一致
  Object.assign(astockConfig, jsSettings.settingsToAstock(jsSettings.loadSettings(astockConfig.ledger_path)));
  const oauthState = jsSettings.loadOAuthState(astockConfig.ledger_path);
  astockConfig.oauth_refresh_token = oauthState.refresh_token || '';
  // 台账打不开（目录只读、被文件沙箱挡住、磁盘满）不该让自检直接抛栈：
  // 这时候用户最需要的就是「19 个工具在不在、路径算对没」这几行。
  let ledgerPath = astockConfig.ledger_path;
  let ledgerError = '';
  try {
    const ledger = new ledgerMod.Ledger(ledgerPath, {
      commission_rate: astockConfig.commission_rate,
      min_commission: astockConfig.min_commission,
      stamp_tax_rate: astockConfig.stamp_tax_rate,
      transfer_fee_rate: astockConfig.transfer_fee_rate,
    });
    ledgerPath = ledger.path;
  } catch (error) {
    ledgerError = `${error?.name ?? 'Error'}: ${error?.message ?? error}`;
  }
  return {
    patchVersion: packageVersion(),
    toolCount: TOOLS.length,
    tools: TOOLS.map((tool) => tool.name),
    ledgerPath,
    ledgerError,
    archivePath: astockConfig.archive_path,
    watchPlanPath: join(dirname(astockConfig.ledger_path), 'watch-plan.json'),
    settingsPath: jsSettings.settingsPath(astockConfig.ledger_path),
    oauthPath: jsSettings.oauthPath(astockConfig.ledger_path),
    runtime: `node ${process.versions.node}`,
    sqlite: 'node:sqlite',
    // 邮件只看「配齐了没有」，不发信也不回显密码
    mail: jsAlerts.status(astockConfig, { oauth: oauthState }),
  };
}

export { TOOLS };
