/**
 * 插件配置 → astock 侧配置（`app.config["astock-plugin"]`）的映射。
 *
 * 为什么要这一层：上游插件把配置项以 **snake_case** 键读自 ``app.config``
 * （`ledger_path` / `commission_rate` / `stop_loss_pct` …）。DSH 的插件配置
 * 习惯写 camelCase，两者直接拼会悄无声息地全部落回默认值——那种「配了但没
 * 生效」的坑很难查。所以这里显式列映射表，并且：
 *
 *   · **只透传显式写了的键**：没写就让上游用它自己的默认值，保证与
 *     lite-work 版本行为一致（这里不复制一份默认值，避免两边漂移）；
 *   · `astock` 子对象最后合并，作为逃生口：可以直接写 python 侧的原始键，
 *     例如 ``astock: { pick_strategy: "quality", pick_max_positions: 3 }``。
 */

import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** DSH 侧 camelCase → 上游 snake_case。 */export const KEY_MAP = {
  ledgerPath: 'ledger_path',
  archivePath: 'archive_path',
  commissionRate: 'commission_rate',
  minCommission: 'min_commission',
  stampTaxRate: 'stamp_tax_rate',
  transferFeeRate: 'transfer_fee_rate',
  stopLossPct: 'stop_loss_pct',
  takeProfitPct: 'take_profit_pct',
  trailingPct: 'trailing_pct',
  addStepPct: 'add_step_pct',
  reduceStepPct: 'reduce_step_pct',
  enableAdd: 'enable_add',
  enableReduce: 'enable_reduce',
  positionCapPct: 'position_cap_pct',
  volumeRatioAlert: 'volume_ratio_alert',
  dropAlertPct: 'drop_alert_pct',
  riseAlertPct: 'rise_alert_pct',
  rateLimitPerSec: 'rate_limit_per_sec',
  httpTimeout: 'http_timeout',
  quoteCacheTtl: 'quote_cache_ttl',
  klineCacheTtl: 'kline_cache_ttl',
  panelStyle: 'panel_style',
  watchEnabled: 'watch_enabled',
  watchIntervalSeconds: 'watch_interval_seconds',
  pickStrategy: 'pick_strategy',
  pickMaxPositions: 'pick_max_positions',
  pickUniverse: 'pick_universe',
  pickCandidates: 'pick_candidates',
  pickMinAmountYuan: 'pick_min_amount_yuan',
  pickCashUsagePct: 'pick_cash_usage_pct',
  pickCashReserveYuan: 'pick_cash_reserve_yuan',
  archiveAutoUpdate: 'archive_auto_update',
  // DSH 专属：每日 15:05 自动存档 + 收盘净值（与「回测时顺手存档」分开）
  dailyArchive: 'daily_archive',
  backtestAutoGrade: 'backtest_auto_grade',
  // 回单校价容差（%）：成交价与计划价偏差超过该比例时标黄
  syncPriceTolerancePct: 'sync_price_tolerance_pct',
  // DSH 专属：工作日 15:05 盘后舆情报告（独立会话，每天一次模型调用）
  postCloseReport: 'post_close_report',
  // 高风险邮件通知（DSH 版直接走 SMTP，不再依赖 email-plugin）
  mailEnabled: 'mail_enabled',
  mailHost: 'mail_host',
  mailPort: 'mail_port',
  mailSecure: 'mail_secure',
  mailUsername: 'mail_username',
  mailPassword: 'mail_password',
  mailFrom: 'mail_from',
  mailTo: 'mail_to',
  mailMinLevel: 'mail_min_level',
  mailProbeSeconds: 'mail_probe_seconds',
};

/** 宿主侧参数（不传给 astock 配置字典）的键。 */
const BRIDGE_KEYS = new Set(['pythonPath', 'timeoutMs', 'workspace', 'astock']);

/**
 * 拆开宿主给的「惰性配置值」。
 *
 * DSH 的配置系统（设置表单 + 热更新）把每个字段包成 `{ get: () => current }`，
 * 而不是直接给原始值——这样改配置能即时生效。**踩过的坑**：直接把这个对象当
 * 字符串用，会得到 `"[object Object]"`（早期 `spawn [object Object] ENOENT`），
 * 或者更糟：`path.dirname({...})` 直接抛
 * `The "path" argument must be of type string. Received an instance of Object`，
 * 整个插件激活失败（19 个工具、面板端点全都没了，界面上只剩 404）。
 *
 * 所以**所有**配置读取都必须先过这里：`{get}` 就调一次拿真值，其它原样返回。
 */
export function unwrapConfigValue(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get();
    } catch {
      return undefined;
    }
  }
  return value;
}

/** 把 DSH 配置对象压成 astock 侧配置字典（自动拆开惰性值）。 */
export function toAstockConfig(config = {}) {
  const source = config && typeof config === 'object' ? config : {};
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (BRIDGE_KEYS.has(key)) continue;
    const plain = unwrapConfigValue(value);
    if (plain === undefined || plain === null || plain === '') continue;
    const target = KEY_MAP[key];
    if (target) out[target] = plain;
  }
  const raw = unwrapConfigValue(source.astock);
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      const plain = unwrapConfigValue(value);
      if (plain === undefined || plain === null) continue;
      out[key] = plain;
    }
  }
  return out;
}

/**
 * DSH 的数据目录（不再用 lite-work 的 `~/.lite-work`）。
 *
 * 优先 `DSH_HOME`（宿主注入），否则 `~/.dsh`；台账/存档/净值/备份都放这里。
 */
export function dshDataDir() {
  const home = String(process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh');
  return join(home, 'astock-data');
}

/**
 * 旧版数据目录（只用于一次性迁移，不再写入）。
 *
 * `DSH_ASTOCK_LEGACY_DIR` 是给测试与「lite-work 装在别处」的人用的逃生口：
 * 迁移逻辑必须能被验证，否则它会在每次跑测试时把开发机的真实台账灌进临时目录。
 */
function legacyDataDir() {
  const override = String(process.env.DSH_ASTOCK_LEGACY_DIR || '').trim();
  return override || join(homedir(), '.lite-work', 'astock-data');
}

/**
 * 一次性把 lite-work 目录里的台账/存档/净值/回测/备份搬到 DSH 数据目录。
 *
 * 只在新台账**不存在**时执行；失败不阻塞（用户可以手动搬）。复制时连
 * `-wal`/`-shm` 一起带过去，避免 SQLite 只拿到主文件丢掉最近事务。
 */
function migrateLegacyData(targetLedger, targetArchive) {
  try {
    if (!targetLedger || existsSync(targetLedger)) return;
    const legacy = legacyDataDir();
    const legacyLedger = join(legacy, 'ledger.sqlite');
    if (!existsSync(legacyLedger)) return;

    const dir = dirname(targetLedger);
    mkdirSync(dir, { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) {
      const source = `${legacyLedger}${suffix}`;
      if (existsSync(source)) copyFileSync(source, `${targetLedger}${suffix}`);
    }
    if (targetArchive && existsSync(join(legacy, 'archive.sqlite'))) {
      copyFileSync(join(legacy, 'archive.sqlite'), targetArchive);
    }
    for (const name of ['equity.jsonl', 'backtest.json']) {
      const source = join(legacy, name);
      if (existsSync(source)) copyFileSync(source, join(dir, name));
    }
    const backups = join(legacy, 'backups');
    if (existsSync(backups)) cpSync(backups, join(dir, 'backups'), { recursive: true });
  } catch {
    /* 迁移失败：新目录照常创建，用户可手动搬 */
  }
}

/**
 * 把存档从「旧的固定位置」搬到「台账同目录」。
 *
 * 0.8.1 及以前，存档写死在 `$DSH_HOME/astock-data/archive.sqlite`，即使台账被
 * 指到别处也一样。0.8.2 起改成跟着台账走（文档一直这么写）。对已经把台账改到
 * 别的目录的用户，这里做一次性复制：**只在新位置没有存档、且旧位置有时**才动，
 * 复制不删除，所以两边都还在。
 */
function migrateArchiveToLedgerDir(targetArchive) {
  try {
    if (!targetArchive || existsSync(targetArchive)) return;
    const previous = join(dshDataDir(), 'archive.sqlite');
    if (dirname(resolve(targetArchive)) === dirname(resolve(previous))) return;
    if (!existsSync(previous)) return;
    mkdirSync(dirname(targetArchive), { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) {
      const source = `${previous}${suffix}`;
      if (existsSync(source)) copyFileSync(source, `${targetArchive}${suffix}`);
    }
  } catch {
    /* 复制失败：新位置照常创建（存档是增量的，缺的部分下次会自动补齐） */
  }
}

/**
 * 给 astock 配置补上 DSH 的默认路径。
 *
 * 历史默认路径是 `~/.lite-work/...`；这里显式传 `ledger_path` /
 * `archive_path`，让新用户从一开始就落在 `~/.dsh/astock-data`。
 *
 * 只接受**非空字符串**：配置值可能是惰性包装、对象、数字（用户手改过），
 * 这些都不能进 `path.dirname`/`existsSync`——那会抛类型错误并让插件激活失败。
 */
export function applyDefaultPaths(astockConfig = {}) {
  const out = { ...(astockConfig || {}) };
  const dir = dshDataDir();
  const pickPath = (value, fallback) => (
    typeof value === 'string' && value.trim() ? value.trim() : fallback
  );
  const configuredLedger = pickPath(unwrapConfigValue(out.ledger_path), '');
  out.ledger_path = configuredLedger || join(dir, 'ledger.sqlite');
  // 存档**跟着台账走**（文档与设置页都是这么写的：留空＝与台账同目录）。
  // 写死成 `dshDataDir()` 会让「把台账指到别处」的用户仍在旧目录读写存档，
  // 换账户/换机器时容易把两套数据混在一起。
  const configuredArchive = pickPath(unwrapConfigValue(out.archive_path), '');
  out.archive_path = configuredArchive || join(dirname(out.ledger_path), 'archive.sqlite');
  // 只在**用默认位置**时迁移 lite-work 的旧数据：用户显式配了台账路径，
  // 就说明那一格是他要的库，往里灌别人的库是数据事故（也会让测试读到真数据）。
  if (!configuredLedger) migrateLegacyData(out.ledger_path, out.archive_path);
  // 存档跟着台账搬家：只在存档是默认推导出来的时候，把旧的固定位置复制过来。
  if (!configuredArchive) migrateArchiveToLedgerDir(out.archive_path);
  return out;
}

/** 宿主侧参数（只保留工作区；解释器与超时已随去 Python 化移除）。 */
export function hostOptions(config = {}) {
  const source = config && typeof config === 'object' ? config : {};
  const workspace = unwrapConfigValue(source.workspace);
  return {
    workspace: typeof workspace === 'string' ? workspace.trim() : '',
  };
}

/**
 * @deprecated 旧名字，等价于 `hostOptions`（保留一个版本，避免外部脚本直接断掉）。
 */
export const bridgeOptions = hostOptions;
