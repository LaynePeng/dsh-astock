# 去 Python 化：JS 重写记录

> **状态：已完成（v0.5.0）**。`python/` 与 `lib/bridge.js` 已删除，19 个工具与面板/维护/邮件全部由 Node.js 实现，用户机器不再需要 Python。
>
> 目标：**用户机器不需要装 Python**。最终删除 `python/` 与 `lib/bridge.js` 的子进程桥接，19 个工具全部由 Node.js 实现。

## 为什么不能一把梭

改造前 `python/` 是上游 `astock-plugin` v2.9.1 的**原样 vendored 实现**：40 个模块、约 2.3 MB，包含行情源解析、涨跌停/费率/T+1、防未来函数回测、三套策略打分、舆情七类证据等。一次性重写并保证口径一致，工作量是「周」级，不是「一次补丁」级。

所以按**可交付的垂直切片**推进：每个阶段结束后插件都能正常用，只是「已重写的工具走 JS，未重写的暂时走 Python 兜底」；最后一个阶段删掉 Python（已完成）。

## 目标结构

```text
lib/
  js/
    http.js        fetch + GBK 解码 + 超时 + 缓存
    market.js      代码归一化、板块、涨跌停、费率、T+1、交易时段
    kline.js       腾讯/新浪行情快照 + 日/周/月/分钟 K 线
    quote-tool.js  astock_quote 输出
    kline-tool.js  astock_kline 输出
    search.js      代码/名称/拼音检索
    screen.js      全市场条件筛选
    flow.js        个股资金流
    ledger.js      node:sqlite 台账（与现有表结构一致）
    portfolio.js   astock_record / astock_portfolio
    hints.js       止损/止盈/移动止盈/超仓/T+1 提示
    orders.js      条件单四件套
    hint-tool.js   astock_hint 输出
    receipt.js     成交回单解析
    sync.js        astock_sync
    business.js    astock_business（主营构成 / 门槛②）
    sentiment-data.js 七类舆情证据取数
    sentiment.js   舆情归集 / 背离 / 渲染
    sentiment-tool.js astock_sentiment
    events.js      astock_events（快讯 → 硬事件 → 资金印证）
    quant.js       三套策略 / 因子 / 打分 / 仓位
    pick-tool.js   astock_pick
    backtest.js    防未来函数滚动回测
    backtest-tool.js astock_backtest
    archive.js     本地日 K 存档
    archive-tool.js astock_archive
    actions.js     操作指示（先卖后买）
    act-tool.js    astock_act
    watch-tool.js  astock_watch 自选管理
    watch-plan.js  本地盯盘规则 / 阈值
    extra-data.js  扩展数据面取数
    extra-tool.js  astock_extra（17/17 action）
    hints.js       止损/止盈/移动止盈/超仓/T+1 提示
    calc.js        均线/RSI/波动率/回撤/复权/盈亏平衡价/股数
    quant.js       三套策略打分 + 仓位分配
    backtest.js    防未来函数回测
    archive.js     本地日 K 存档
    sentiment.js   舆情七类证据
    events.js      事件驱动
    business.js    主营构成
    extra.js       扩展数据面 17 类
    act.js         操作指示
    sync.js        成交回单同步
    panel.js       右栏面板数据（已有一半在 python/panel.py）
    maintenance.js 导出/导入/备份/快照
  tools.json       19 个工具 schema（保持不变）
  plugin.js        注册工具 + 面板端点 + 定时任务
  client.js        右栏 React 面板（已经是 JS）
```

## 进度

- [x] `astock_calc`：`lib/js/{http,market,kline,formula,format,calc}.js`
  - cost / adjust / ratio / summary / ma / rule_check（显式 rules）已与 Python 输出逐字对齐
  - `rule_check` 不传 rules（自动读盯盘计划）暂回退 Python
  - 测试：`test/js-formula.test.mjs` 6 项 + 插件路由 1 项
- [x] `astock_quote`：`lib/js/quote-tool.js` + `kline.js`（腾讯主源 / 新浪备源）
  - 与 Python 输出逐字对齐（仅 Windows 换行 CRLF 差异）；台账无 codes 时读持仓+自选
  - 修：JS `getUTCDay()` 周日=0（不能照抄 Python `weekday()` 周一=0）
  - 修：指数涨跌停 -1 视为无；停牌 price=0 用昨收回填并标记
- [x] `astock_kline`：`lib/js/kline-tool.js`
  - 腾讯 3 域名轮换 + 东财备源；日/周/月/1m/5m/15m/30m/60m
  - 与 Python 输出逐字对齐（MA20 9.803 的舍入口径已修）
- [x] `astock_search`：`lib/js/search.js`
  - 东财 suggest 的 JSONP 剥离 + `Connection: close` + 首次失败重试（CDN 偶发返回"用户搜索"）
- [x] `astock_screen`：`lib/js/screen.js`
  - 东财 clist 全市场分页 + 新浪排行备源；与 Python 输出逐字对齐
- [x] `astock_flow`：`lib/js/flow.js`
  - 东财 fflow 主源 + 新浪备源；与 Python 输出逐字对齐
- [x] `astock_record`：`lib/js/portfolio.js`
  - dry-run 预览 / 落账 / 资金未自动扣减提示；与 Python 输出逐字对齐
- [x] `astock_portfolio`：`lib/js/portfolio.js`
  - set_cash / trades / delete_trade / list / summary
  - **list/summary 暂返回文字总览**：`astock_board.py` 的三栏看板 JSON 尚未移植（下一步）
- [x] `astock_hint`：`lib/js/{hints,orders,hint-tool}.js`
  - 止损/止盈/移动止盈/加仓/减仓/单票占比/T+1/异动/放量全部规则
  - 买卖数量估算 + 条件单四件套 + plans 落库
  - 与 Python 输出逐字对齐（`no_sentiment=true` 场景；舆情段待 sentiment 迁移后接入）
- [x] `astock_sync`：`lib/js/{receipt,sync}.js`
  - 逐行 / CSV / TSV 回单解析、去重、金额校验、计划匹配与校价、落账
  - 与 Python 输出逐字对齐；顺带修了 Python `astock_mixin_sync.py` 缺 `LedgerError` 导入的崩溃
- [x] `astock_business`：`lib/js/business.js`
  - 东财 F10 主营构成 + 门槛② pass/below/absent/na/unknown 判定
  - 单只与批量体检；与 Python 输出逐字对齐
- [x] `astock_sentiment`：`lib/js/{sentiment-data,sentiment,sentiment-tool}.js`
  - 七类证据（公告/研报/新闻/热榜/龙虎榜/两融/股东户数/快讯）+ 背离提示
  - 与 Python 输出逐字对齐（`600000`、`002273`、`brief`、`scope` 子集）
  - `code=portfolio` 组合报告依赖 `astock_report.py`，暂回退 Python
- [x] `astock_events`：`lib/js/events.js`
  - 快讯流 → 公司硬事件 → 5 日主力资金印证 / 背离标记
  - 与 Python 无命中场景逐字一致；命中场景由单测覆盖
- [x] `astock_pick`：`lib/js/{quant,pick-tool}.js`
  - 三套策略、15 个因子、池内百分位打分、硬门槛、仓位分配、富围栏报告
  - 与 Python `no_grade=true` 输出逐字一致（`quality` 实测）
  - 推荐率前缀已接回测缓存（`astock_backtest`）
- [x] `astock_backtest`：`lib/js/{backtest,backtest-tool}.js`
  - 防未来函数滚动回测、推荐率分档、逐期明细、30 分钟缓存
  - 核心结果与 Python `as_dict()` 逐字段一致（合成数据 13 期/53.8%）
  - 存档优先取数已接入（`astock_archive`）
- [x] `astock_archive`：`lib/js/{archive,archive-tool}.js`
  - raw/qfq/hfq 三口径隔离、增量更新、概览、清理保护
  - 回测自动优先读存档、顺手写回在线数据
- [x] `astock_act`：`lib/js/{actions,act-tool}.js`
  - 先卖后买、T+1 裁剪、止损/止盈/换仓/超仓、资金闭环
  - `build_action_plan().as_dict()` 与 Python 逐字段一致
- [x] `astock_watch`：`lib/js/{watch-tool,watch-plan}.js`
  - `list / add / remove` + `plan / set_rules` 本地计划（`watch-plan.json`）
  - `set_rules` 支持整体替换 / 追加 / 按代码删除 / 阈值键，并把规则摘要同步进盯盘任务 prompt
  - `start/stop/status` 由 DSH 定时任务控制器处理
- [x] `astock_extra`：`lib/js/{extra-data,extra-tool}.js`
  - 17/17 个 action 全部迁移：hot / industry / board_flow / st / margin /
    block_trade / holders / dividend / lockup / lhb / concepts / chips /
    events / docs / macro / limit_sentiment / strong
  - 与 Python 逐字对齐（除可转债接口返回行数偶发差异）
- [x] **19 个工具全部走 JS**：`lib/plugin.js` 的工具执行分支不再调用 Python；
  面板/维护/邮件端点也已改走 JS，`python/` 与 `lib/bridge.js` 已删除（见 Phase 5）

## 关键口径修复（重写过程中发现的上游缺陷）

- `pyRound` 必须按 double 的十进制展开判断是否真 .5；先乘 10^d 会把
  `9.8035`（实际 9.8034999…）误抬成 9.804，K 线 MA20 曾因此与 Python 差一位。
- JS `Date.getUTCDay()`：周日 0、周六 6；Python `weekday()`：周一 0、周日 6。
  交易时段/交易日判断必须用 `1..5` 表示工作日。
- 指数快照的涨跌停字段腾讯返回 `-1`，必须视为"无"；同时 `kind=index`
  不应再按个股 10% 计算涨跌停（Python 侧已一并修）。
- 东财 `searchapi` 对 Node 的 keep-alive 连接会返回 JSONP/用户搜索，
  必须 `Connection: close`，且首次仍可能路由错，需重试一次。

## 宿主集成修复（去 Python 化之后暴露的两处）

- **配置值是惰性包装**：DSH 把每个配置字段包成 `{ get: () => current }`（为了热更新），
  不是原始值。直接当字符串用会得到 `"[object Object]"`；更糟的是 `path.dirname(包装对象)`
  抛 `The "path" argument must be of type string. Received an instance of Object`，
  **整个插件激活失败**——工具、面板端点全没，界面上只剩 404。
  现在 `config.js` 的 `unwrapConfigValue()` 统一拆包装，`applyDefaultPaths()` 只接受非空字符串
  （v0.5.1 修复，`test/smoke.test.mjs` 有回归用例）。
- **自检端点路径**：DSH 0.2.2 只把 `/api/*` 路由到插件注册的处理器，
  `/dsh-astock/info` 会被宿主直接回 400/404。端点已改到 `/api/dsh-astock/info`。
- **不能直接读未 inject 的服务**：自检 handler 里 `typeof ctx.interval` 会抛
  `cannot get property "timer" without inject`（整个请求 400）。改成在自己的
  `ctx.inject(['timer'])` 回调里记 `timerAvailable`。

## 已选顺序：按 19 个工具逐个替换

1. `astock_calc`
2. `astock_quote`
3. `astock_kline`
4. `astock_search`
5. `astock_screen`
6. `astock_flow`
7. `astock_record`
8. `astock_portfolio`
9. `astock_hint`
10. `astock_sync`
11. `astock_sentiment`
12. `astock_business`
13. `astock_events`
14. `astock_pick`
15. `astock_backtest`
16. `astock_archive`
17. `astock_act`
18. `astock_watch`
19. `astock_extra`

每个工具替换时：JS 实现 + 单测 + 与旧输出对照。19 个工具与宿主侧链路全部替换后，`python/` 已删除。

## 阶段

### Phase 0（本次）— 先让当前版本能用

- [x] 修 `spawn [object Object] ENOENT`：`pythonPath` 只接受字符串（该配置项现已随去 Python 化移除）
- [x] 默认数据目录改为 `~/.dsh/astock-data`，首次启动一次性迁移 `~/.lite-work/astock-data`
- [x] `@deepseek-ai/schemastery` 声明为 peerDependency，设置表单注册成功（宿主 Config 检查器已是 `schema`）

### Phase 1 — 核心（行情 + 台账）

- `http.js` / `market.js` / `ledger.js`
- `astock_quote`、`astock_kline`、`astock_search`、`astock_screen`、`astock_flow`
- `astock_record`、`astock_portfolio`、`astock_hint`
- 交付标准：这 8 个工具在**没有 Python** 的机器上可用；台账仍兼容现有 SQLite

### Phase 2 — 研究

- `calc.js`、`act.js`、`sync.js`、`archive.js`
- `astock_calc`、`astock_act`、`astock_sync`、`astock_archive`

### Phase 3 — 量化

- `quant.js`、`backtest.js`
- `astock_pick`、`astock_backtest`
- 重点：防未来函数、成本/滑点、样本外说明

### Phase 4 — 舆情与扩展

- `sentiment.js`、`events.js`、`business.js`、`extra.js`
- `astock_sentiment`、`astock_events`、`astock_business`、`astock_extra`

### Phase 5 — 删除 Python（已完成）

- [x] `python/`（94 个文件 / 2.29 MB）整目录删除
- [x] `lib/bridge.js`（子进程桥接、解释器探测、JSON 传输）删除
- [x] 面板 / 维护 / 邮件三条宿主侧链路改走 `lib/js/{panel,maintenance,alerts,notify,smtp}.js`
- [x] `package.json` 去掉 `python` 目录与 `pythonPath` / `timeoutMs` 配置项，`engines.node >= 22.5`
- [x] `scripts/generate-tools.mjs` 换成 `scripts/check-tools.mjs`（`tools.json` 成为事实源，只做校验）
- [x] `scripts/selftest.mjs` 改为纯 JS（不再探测解释器）
- [x] 全量测试：**144 条通过**；`node scripts/selftest.mjs` 在无 Python 环境可跑

## 兼容性约束

- **工具名 / 参数 schema 不变**（`lib/tools.json` 是事实源，`scripts/check-tools.mjs` 校验）。
- **台账表结构不变**：`node:sqlite` 直接读写 `positions/trades/watchlist/cash/plans/meta`，保证与旧台账、lite-work 台账兼容。
- **输出文案尽量逐字对齐**；对不齐的地方优先保证数字与口径正确，再逐步补文案。
- **数据源**：腾讯主源（GBK 用 `TextDecoder('gbk')`）、新浪/东财备源；限速与缓存沿用现有配置项。
- **不再有过渡期开关**：所有工具都走 JS；异常只记日志并返回可读错误，不回退子进程。

## 风险

- 财务计算错一位就误导人：每个公式都要有单测，并与旧输出做对照。
- 免费接口会变：解析层要容错，失败要给出可读原因。
- 回测的防未来函数是正确性核心，不能为了快而简化。
- 邮件去重状态从「进程内」改为落盘 `mail-state.json`（旧实现每个探针都是新进程，去重其实从未生效）。
