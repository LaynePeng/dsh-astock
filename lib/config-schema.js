/**
 * 设置页表单的 schema（DSH 设置 → 插件 → A股助手）。
 *
 * DSH 的设置页由插件声明的 **Config schema** 自动生成：标了
 * `.extra('volatile', true)` 的字段才出现在表单里，写入落到当前 profile 的
 * `cordis.patch.yml`（即本插件的 `config`），随后由 `lib/config.js` 映射成上游
 * astock 认识的 snake_case 键。
 *
 * 所以字段名必须与 `config.js` 的 `KEY_MAP` 一一对应——写错一个就是
 * 「设置页能改、实际不生效」这种最难查的静默失败（`test/settings.test.mjs`
 * 逐字段校验）。
 *
 * 加载失败时 `Config` 为 undefined：插件照常工作，只是设置页没有表单。
 * 不用静态 import 就是为了这个——`@deepseek-ai/schemastery` 由宿主提供，
 * 拿不到也不该让 19 个工具一起挂掉。
 */

let z;
/** schemastery 取不到/形状不对时的原因（自检端点与维护页会显示）。 */
export let schemaError = '';

try {
  const mod = await import('@deepseek-ai/schemastery');
  // 兼容三种导出形状：ESM default / 命名导出 Schema / 直接命名空间
  z = mod?.default ?? mod?.Schema ?? mod;
  if (!z || typeof z.object !== 'function') {
    schemaError = `@deepseek-ai/schemastery 的导出形状不符合预期（keys: ${Object.keys(mod || {}).join(', ') || '空'}）`;
    z = undefined;
  }
} catch (error) {
  // 最常见原因：插件没有在 package.json 里把 schemastery 声明为 peerDependency，
  // DSH 的 linked-plugin 解析器就不会把 @deepseek-ai/* 路由到宿主安装包。
  schemaError = `${error?.name ?? 'Error'}: ${error?.message ?? error}`;
  z = undefined;
}

/**
 * 字段说明表（**唯一事实源**）。
 *
 * `make(api)` 返回该字段的 schema；`default` 省略表示不设默认值（沿用上游）。
 * 表里同时导出字段名列表，避免「schema 里有一个键、映射表里没有」这种漂移。
 */
export const FIELD_SPECS = [
  // ── 台账 ────────────────────────────────────────────────
  ['ledgerPath', (a) => a.string(), '台账文件路径。留空＝~/.dsh/astock-data/ledger.sqlite（首次启动会自动把旧的 ~/.lite-work/astock-data 搬过来）', ''],
  ['archivePath', (a) => a.string(), '本地日 K 存档文件。留空＝与台账同目录的 archive.sqlite（累积历史，突破行情接口约 2.6 年上限）', ''],
  ['archiveAutoUpdate', (a) => a.boolean(),
    '回测取数时顺手把 K 线写进存档（默认开）。关掉不会影响下面的每日自动存档', true],
  ['dailyArchive', (a) => a.boolean(),
    '每日 15:05 自动更新存档 + 记收盘净值（零 token，纯子进程；应用 15:20 才开也能补跑）。存档只增不减，今天开始存、一年后才多一年', true],
  ['commissionRate', (a) => a.number().min(0), '佣金率：万 2.5 填 0.00025，按券商实际费率改', 0.00025],
  ['minCommission', (a) => a.number().min(0), '最低佣金（元），多数券商单笔 5 元', 5],
  ['stampTaxRate', (a) => a.number().min(0), '印花税（仅卖出，现行 0.05%）', 0.0005],
  ['transferFeeRate', (a) => a.number().min(0), '过户费（沪深双向 0.001%，ETF 不计）', 0.00001],

  // ── 风控阈值 ────────────────────────────────────────────
  ['stopLossPct', (a) => a.number().min(0).max(50), '止损线（%）：浮亏达到该比例提示止损', 8],
  ['takeProfitPct', (a) => a.number().min(0).max(500), '止盈线（%）：浮盈达到该比例提示止盈', 15],
  ['trailingPct', (a) => a.number().min(0).max(90), '移动止盈回撤（%）：自持仓期最高价回撤该比例且仍浮盈时提示', 10],
  ['positionCapPct', (a) => a.number().min(1).max(100), '单票占比上限（%）：超过则买入数量估算受此约束并提示减仓', 25],
  ['addStepPct', (a) => a.number().min(0), '加仓档位间隔（%），需同时开启「加仓提示」', 5],
  ['reduceStepPct', (a) => a.number().min(0), '减仓档位间隔（%）', 10],
  ['enableAdd', (a) => a.boolean(), '加仓提示：默认关（摊平提示容易被误当成「喊单」）', false],
  ['enableReduce', (a) => a.boolean(), '减仓提示：浮盈每达到一个减仓档位就提示一次，默认关', false],

  // ── 异动提醒 ────────────────────────────────────────────
  ['volumeRatioAlert', (a) => a.number().min(0), '放量阈值（倍）：量比超过该值视为放量提示', 2],
  ['dropAlertPct', (a) => a.number().min(0), '下跌异动阈值（%）：当日跌幅超过则提示', 5],
  ['riseAlertPct', (a) => a.number().min(0), '上涨异动阈值（%）：当日涨幅超过则提示', 7],
  ['syncPriceTolerancePct', (a) => a.number().min(0).max(20),
    '回单校价容差（%）：成交价与建议计划价偏差超过该比例时标黄提醒（只提示，不阻断落账）', 2],

  // ── 取数 ────────────────────────────────────────────────
  ['rateLimitPerSec', (a) => a.number().min(0.5).max(50), '行情请求速率上限（次/秒）：公共免费接口，调太快会被掐连接', 5],
  ['httpTimeout', (a) => a.number().min(1).max(120), '请求超时（秒）', 10],
  ['quoteCacheTtl', (a) => a.number().min(0), '行情缓存（秒）：同一轮对话里反复问同一只股时不必重复打接口', 3],
  ['klineCacheTtl', (a) => a.number().min(0), 'K 线缓存（秒）', 60],

  // ── 选股 ────────────────────────────────────────────────
  ['pickStrategy', (a) => a.union([a.const('momentum'), a.const('reversal'), a.const('quality')]),
    '默认选股策略：momentum 趋势动量（趋势市）/ reversal 均值回归（震荡市）/ quality 质量价值（长期）', 'momentum'],
  ['pickMaxPositions', (a) => a.number().min(1).max(20), '一轮最多买几只', 5],
  ['pickUniverse', (a) => a.union([a.const('main'), a.const('all'), a.const('gem'), a.const('star')]),
    '选股范围：main 主板+创业板 / all 全部 / gem 创业板 / star 科创板', 'main'],
  ['pickCashUsagePct', (a) => a.number().min(1).max(100),
    '本轮最多动用可用现金的比例（%）。留 20% 给 T+1 补仓与手续费缓冲', 80],
  ['pickCashReserveYuan', (a) => a.number().min(0),
    '保留现金下限（元）：与使用比例取更严格者，想强制留 5000 元就填 5000', 0],
  ['pickCandidates', (a) => a.number().min(5).max(80),
    '技术面分析只数：从成交额靠前的股票里取多少只拉日 K 算因子（每只 1 次请求，30 只约 6 秒）', 30],
  ['pickMinAmountYuan', (a) => a.number().min(0),
    '最低成交额门槛（元）：流动性太差的标的买得进卖不出，默认 1 亿', 100000000],
  ['backtestAutoGrade', (a) => a.boolean(),
    '选股时自动附推荐率：点「立即跑一轮选股」时顺手跑回测（约 10 秒）；关掉更快', true],

  // ── 盯盘（DSH 定时任务） ────────────────────────────────
  ['watchIntervalSeconds', (a) => a.number().min(300).max(86400),
    '盯盘间隔（秒）。DSH 每次运行都要调用模型，所以下限 5 分钟、默认 15 分钟；只在工作日 9:00–14:59 运行', 900],
  ['postCloseReport', (a) => a.boolean(),
    '工作日 15:05 生成盘后舆情报告（独立会话；每天一次模型调用）。关闭后不创建该定时任务', false],

  // ── 高风险邮件通知 ──────────────────────────────────────
  ['mailEnabled', (a) => a.boolean(), '启用高风险邮件通知（插件自己定时探测并直接发 SMTP，不消耗模型额度）', false],
  ['mailHost', (a) => a.string(), 'SMTP 服务器，如 smtp.qq.com / smtp.163.com / smtp.gmail.com', ''],
  ['mailPort', (a) => a.number().min(1).max(65535), 'SMTP 端口：465（隐式 TLS）或 587（STARTTLS）', 465],
  ['mailSecure', (a) => a.boolean(), '使用隐式 TLS（465 端口选此项；587 请关闭，走 STARTTLS）', true],
  ['mailUsername', (a) => a.string(), '邮箱账号（完整地址，如 me@qq.com），发信时用它登录 SMTP', ''],
  ['mailPassword', (a) => a.string(), 'SMTP 密码 / 授权码（多数服务商要求「授权码」而不是登录密码）', undefined, true],
  ['mailFrom', (a) => a.string(), '发件人地址，留空＝邮箱账号', ''],
  ['mailTo', (a) => a.string(), '收件人，多个用逗号分隔；留空＝发给自己', ''],
  ['mailMinLevel', (a) => a.union([a.const('urgent'), a.const('action'), a.const('info')]),
    '通知阈值：urgent 只发紧急（止损/止盈等）/ action 含需关注 / info 全部', 'urgent'],
  ['mailProbeSeconds', (a) => a.number().min(60).max(3600), '邮件探测间隔（秒），最小 60', 300],

  // ── 宿主侧参数 ──────────────────────────────────────────
  // 解释器路径与单次调用超时已随「去 Python 化」一起移除：19 个工具都在
  // 宿主进程内跑，取数超时由各接口自己的上限决定。

  // ── 逃生口 ──────────────────────────────────────────────
  ['astock', (a) => a.dict(a.string(), a.any()), '高级：直接写上游 snake_case 原始键（如 {"pick_candidates": 40}），优先级最高', {}],
];

/** 设置页里出现过的字段名（测试据此校验与 `config.js` 的映射对齐）。 */
export const SETTINGS_KEYS = FIELD_SPECS.map(([key]) => key);

function buildConfig(api) {
  const shape = {};
  for (const [key, make, description, defaultValue, isSecret] of FIELD_SPECS) {
    // 逐字段兜底：某个 API（比如 `.dict` / `.role`）在宿主那一版 schemastery 里
    // 不存在时，只丢这一个字段，不能让整个设置页消失——更不能让异常冒到
    // 模块顶层，那会连 19 个工具一起加载失败。
    try {
      let schema = make(api);
      if (isSecret && typeof schema.role === 'function') schema = schema.role('secret');
      schema = schema.description(description);
      if (defaultValue !== undefined) schema = schema.default(defaultValue);
      // `.extra('volatile', true)` 是「进设置表单」的开关，缺了就不显示
      shape[key] = schema.extra('volatile', true);
    } catch (error) {
      builtFields.push({ key, ok: false, reason: String(error?.message ?? error) });
    }
  }
  return api.object(shape);
}

/** 每个字段的构建结果（自检端点会带上失败原因，方便定位是哪一条 API 不支持）。 */
export const builtFields = [];

let resolvedConfig;
try {
  resolvedConfig = z ? buildConfig(z) : undefined;
} catch (error) {
  // 连 object() 都建不起来（例如 schemastery 版本差异太大）：放弃表单，
  // 插件其余能力照常——设置页没有，好过插件整个起不来。
  resolvedConfig = undefined;
  schemaError = schemaError || `构建设置 schema 失败：${error?.message ?? error}`;
  builtFields.push({ key: '(object)', ok: false, reason: String(error?.message ?? error) });
}

export const Config = resolvedConfig;
