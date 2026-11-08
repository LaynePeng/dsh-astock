/**
 * 插件自己的设置存储（右栏「设置」页写入）。
 *
 * **为什么要自己存一份**：DSH 0.2.2 的「插件」页只给宿主能识别的配置行渲染表单，
 * 第三方 bundle 常常**看不到任何配置项**。邮件与 OAuth 又必须能改（还要显示
 * 设备码、轮询授权结果），所以这一层把关键设置收进插件自己的 `settings.json`：
 *
 *     ~/.dsh/astock-data/settings.json     邮件 / OAuth / 盘后复盘（含密码，0600）
 *     ~/.dsh/astock-data/oauth.json        refresh_token 与已授权账号（0600）
 *
 * **设计原则：能自动推导的绝不让人填。** 用户只需要选「哪家邮箱」+「邮箱账号」，
 * 服务器/端口/TLS/认证方式都由服务商预设决定；只有「自定义」才暴露这些字段。
 *
 * 读取顺序：**本地设置 > 宿主配置 > 内置默认**。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 服务商预设：选一个，发信参数全定。
 *
 * `auth` 决定走授权码还是 OAuth2；`provider` 是 OAuth 的预设键。
 * Outlook 个人版已关闭 SMTP Basic Auth，只能 OAuth2。
 */
export const PROVIDER_PRESETS = {
  outlook: {
    label: 'Outlook / Hotmail',
    auth: 'oauth2',
    provider: 'outlook',
    host: 'smtp-mail.outlook.com',
    port: 587,
    secure: false,
    hint: '微软账号：点「开始授权」用设备码登录，不需要密码/应用专用密码',
  },
  qq: {
    label: 'QQ 邮箱',
    auth: 'basic',
    provider: 'custom',
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    hint: 'QQ 邮箱设置里开启 SMTP 后生成的「授权码」，不是登录密码',
  },
  '163': {
    label: '163 邮箱',
    auth: 'basic',
    provider: 'custom',
    host: 'smtp.163.com',
    port: 465,
    secure: true,
    hint: '163 邮箱设置里开启 SMTP 后生成的「授权码」',
  },
  gmail: {
    label: 'Gmail',
    auth: 'basic',
    provider: 'custom',
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    hint: 'Gmail 需开两步验证后生成「应用专用密码」',
  },
  custom: {
    label: '自定义 SMTP',
    auth: 'basic',
    provider: 'custom',
    host: '',
    port: 587,
    secure: false,
    hint: '自己填服务器、端口与认证方式',
  },
};

/** 展示顺序（对象键顺序会把 '163' 排到最前，因为数字键优先）。 */
const PRESET_ORDER = ['outlook', 'qq', '163', 'gmail', 'custom'];

const PRESET_OPTIONS = PRESET_ORDER
  .filter((key) => PROVIDER_PRESETS[key])
  .map((value) => ({ value, label: PROVIDER_PRESETS[value].label }));

const isPreset = (key) => key !== 'custom';
const NOT_OUTLOOK = { key: 'mail_preset', notEquals: 'outlook' };

/**
 * 表单字段。
 *
 * `section` 决定分组（provider / account / delivery / advanced）；
 * `showWhen` 支持单条件、`anyOf`（或）、`all`（且）。
 */
export const MAIL_FIELDS = [
  {
    key: 'mail_enabled', section: 'delivery', label: '启用邮件通知', type: 'boolean', default: false,
    hint: '开启后由插件自己定时判定（零 token），只在触发阈值时发信',
  },
  {
    key: 'mail_preset', section: 'provider', label: '用哪家邮箱发信', type: 'preset', default: 'outlook',
    options: PRESET_OPTIONS,
    hint: '选好服务商，服务器/端口/TLS 会自动配好，不用手填',
  },
  {
    key: 'mail_username', section: 'account', label: '邮箱账号', type: 'string', default: '',
    hint: '完整地址，如 me@outlook.com',
  },
  {
    key: 'mail_password', section: 'account', label: '授权码 / 应用专用密码', type: 'password', default: '',
    hint: '服务商后台生成；不是登录密码',
    showWhen: { all: [{ key: 'mail_preset', notEquals: 'outlook' }] },
  },
  {
    key: 'mail_auth', section: 'advanced', label: '认证方式', type: 'select', default: 'basic',
    options: [
      { value: 'basic', label: 'SMTP 授权码' },
      { value: 'oauth2', label: 'OAuth2（XOAUTH2）' },
    ],
    hint: '自定义服务商才需要选；Outlook 固定 OAuth2，QQ/163/Gmail 固定授权码',
    showWhen: { key: 'mail_preset', equals: 'custom' },
  },
  {
    key: 'mail_host', section: 'advanced', label: 'SMTP 服务器', type: 'string', default: '',
    hint: '如 smtp.example.com',
    showWhen: { key: 'mail_preset', equals: 'custom' },
  },
  {
    key: 'mail_port', section: 'advanced', label: '端口', type: 'number', default: 587,
    hint: '465＝隐式 TLS，587＝STARTTLS',
    showWhen: { key: 'mail_preset', equals: 'custom' },
  },
  {
    key: 'mail_secure', section: 'advanced', label: '隐式 TLS（465）', type: 'boolean', default: false,
    hint: '465 端口选「是」；587 选「否」',
    showWhen: { key: 'mail_preset', equals: 'custom' },
  },
  {
    key: 'oauth_client_id', section: 'advanced', label: '客户端 ID', type: 'string', default: '',
    hint: '留空＝用内置公共客户端；自己注册了 Azure 应用才填',
    showWhen: { all: [{ key: 'mail_preset', equals: 'custom' }, { key: 'mail_auth', equals: 'oauth2' }] },
  },
  {
    key: 'oauth_tenant', section: 'advanced', label: '租户', type: 'string', default: '',
    hint: '留空＝consumers（个人账号）。组织账号填租户域名或 GUID，别填邮箱',
    showWhen: { all: [{ key: 'mail_preset', equals: 'custom' }, { key: 'mail_auth', equals: 'oauth2' }] },
  },
  {
    key: 'mail_to', section: 'delivery', label: '收件人', type: 'string', default: '',
    hint: '多个用逗号分隔；留空＝发给自己',
  },
  {
    key: 'mail_min_level', section: 'advanced', label: '通知阈值', type: 'select', default: 'urgent',
    options: [
      { value: 'urgent', label: '只发紧急（止损/止盈等）' },
      { value: 'action', label: '含需关注' },
      { value: 'info', label: '全部' },
    ],
    hint: '低于该级别的信号不会进邮件',
  },
  {
    key: 'mail_probe_seconds', section: 'advanced', label: '探测间隔（秒）', type: 'number', default: 300,
    hint: '最小 60；只在工作日 9:10–15:00 判定',
  },
];

/** 盘后复盘（零 token：本地拼装 + 现有 SMTP 直接发）。 */
export const REPORT_FIELDS = [
  {
    key: 'report_email', section: 'advanced', label: '盘后复盘发到邮箱', type: 'boolean', default: false,
    hint: '工作日 15:05 随「存档 + 净值」一起执行；不发模型请求，不花 token',
  },
  {
    key: 'report_email_top', section: 'advanced', label: '报告里带几只的舆情', type: 'number', default: 3,
    hint: '只对触发信号或持仓最多的前 N 只做舆情归集',
    showWhen: { key: 'report_email', equals: true },
  },
];

/**
 * 插件自身的配置（交易/风控/选股/盯盘）。
 *
 * 这些键与 astock 配置字典同名（snake_case），保存后直接合并进运行期配置，
 * 所以**不用改宿主配置页**也能调。改台账路径这类会影响数据位置的键刻意不暴露。
 */
export const PLUGIN_FIELDS = [
  // 交易与费用
  {
    key: 'commission_rate', section: 'trade', label: '佣金率', type: 'number', default: 0.00025,
    hint: '万 2.5 填 0.00025（万分比，不是百分比）',
  },
  { key: 'min_commission', section: 'trade', label: '最低佣金（元）', type: 'number', default: 5, hint: '不足 5 元按 5 元收' },
  { key: 'stamp_tax_rate', section: 'trade', label: '印花税', type: 'number', default: 0.0005, hint: '卖出单边，默认 0.0005' },
  { key: 'transfer_fee_rate', section: 'trade', label: '过户费', type: 'number', default: 0.00001, hint: '沪深都收，默认 0.00001' },
  { key: 'daily_archive', section: 'trade', label: '每日 15:05 自动存档', type: 'boolean', default: true, hint: '改完重启 DSH 生效' },
  { key: 'archive_auto_update', section: 'trade', label: '回测时顺手存档', type: 'boolean', default: true, hint: '回测取到的日 K 顺手写进本地存档' },

  // 风控阈值
  { key: 'stop_loss_pct', section: 'risk', label: '止损线（%）', type: 'number', default: 8, hint: '跌破成本 8% 触发止损提示' },
  { key: 'take_profit_pct', section: 'risk', label: '止盈线（%）', type: 'number', default: 15, hint: '涨到 15% 触发止盈提示' },
  { key: 'trailing_pct', section: 'risk', label: '移动止盈回撤（%）', type: 'number', default: 10, hint: '从最高点回撤 10% 提示' },
  { key: 'position_cap_pct', section: 'risk', label: '单票上限（%）', type: 'number', default: 25, hint: '超过就提示超仓' },
  { key: 'enable_add', section: 'risk', label: '启用加仓提示', type: 'boolean', default: false, hint: '跌到档位提示加仓' },
  { key: 'add_step_pct', section: 'risk', label: '加仓档位（%）', type: 'number', default: 5, hint: '每跌 5% 一档' },
  { key: 'enable_reduce', section: 'risk', label: '启用减仓提示', type: 'boolean', default: false, hint: '涨到档位提示减仓' },
  { key: 'reduce_step_pct', section: 'risk', label: '减仓档位（%）', type: 'number', default: 10, hint: '每涨 10% 一档' },

  // 异动提醒
  { key: 'volume_ratio_alert', section: 'alert', label: '放量阈值（倍）', type: 'number', default: 2, hint: '量比超过该值提示' },
  { key: 'drop_alert_pct', section: 'alert', label: '当日跌幅异动（%）', type: 'number', default: 5, hint: '当日跌 5% 提示' },
  { key: 'rise_alert_pct', section: 'alert', label: '当日涨幅异动（%）', type: 'number', default: 7, hint: '当日涨 7% 提示' },
  { key: 'sync_price_tolerance_pct', section: 'alert', label: '回单校价容差（%）', type: 'number', default: 1, hint: '成交回单与计划价偏差超过该值提示' },

  // 取数与缓存
  { key: 'rate_limit_per_sec', section: 'data', label: '请求速率上限（次/秒）', type: 'number', default: 5, hint: '越小越稳，越大越快' },
  { key: 'http_timeout', section: 'data', label: '取数超时（秒）', type: 'number', default: 10, hint: '单次 HTTP 请求超时' },
  { key: 'quote_cache_ttl', section: 'data', label: '行情缓存（秒）', type: 'number', default: 3, hint: '同一秒内重复请求复用缓存' },
  { key: 'kline_cache_ttl', section: 'data', label: 'K 线缓存（秒）', type: 'number', default: 60, hint: '日 K 短时间重复请求复用' },

  // 选股与回测
  {
    key: 'pick_strategy', section: 'pick', label: '默认策略', type: 'select', default: 'momentum',
    options: [
      { value: 'momentum', label: '趋势动量' },
      { value: 'reversal', label: '均值回归' },
      { value: 'quality', label: '质量价值' },
    ],
    hint: '面板「选股」会标出默认策略',
  },
  { key: 'pick_max_positions', section: 'pick', label: '最多买几只', type: 'number', default: 5, hint: '一轮最多选几只' },
  { key: 'pick_cash_usage_pct', section: 'pick', label: '现金使用比例（%）', type: 'number', default: 80, hint: '本轮最多动用多少现金' },
  { key: 'pick_cash_reserve_yuan', section: 'pick', label: '保留现金（元）', type: 'number', default: 0, hint: '始终留出这么多现金' },
  { key: 'pick_candidates', section: 'pick', label: '分析只数', type: 'number', default: 30, hint: '进入打分的候选数量' },
  { key: 'pick_min_amount_yuan', section: 'pick', label: '成交额门槛（元）', type: 'number', default: 0, hint: '低于该成交额的票不选' },
  { key: 'backtest_auto_grade', section: 'pick', label: '选股自动附推荐率', type: 'boolean', default: true, hint: '跑选股时顺带读回测缓存' },

  // 盯盘
  { key: 'watch_interval_seconds', section: 'watch', label: '盯盘间隔（秒）', type: 'number', default: 900, hint: '最小 300；改完重新「启动盯盘」生效' },
];

const SETTING_FIELDS = [...MAIL_FIELDS, ...REPORT_FIELDS, ...PLUGIN_FIELDS];
const FIELD_KEYS = SETTING_FIELDS.map((field) => field.key);
const SECRET_KEYS = new Set(['mail_password']);

/** 设置文件路径（与台账同目录）。 */
export function settingsPath(ledgerPath) {
  return path.join(path.dirname(String(ledgerPath || '')), 'settings.json');
}

/** OAuth 私有状态文件（refresh_token 等）。 */
export function oauthPath(ledgerPath) {
  return path.join(path.dirname(String(ledgerPath || '')), 'oauth.json');
}

function readJson(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file) || '.', { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows 上 chmod 基本无效，忽略
  }
}

/** 读本地设置（只返回认识的键；坏文件当空）。 */
export function loadSettings(ledgerPath) {
  const raw = readJson(settingsPath(ledgerPath));
  const out = {};
  for (const key of FIELD_KEYS) {
    if (raw[key] === undefined || raw[key] === null) continue;
    out[key] = raw[key];
  }
  return out;
}

/**
 * 保存本地设置：只合并传入的键，**空字符串表示清除该键**（回落到默认/宿主配置）。
 */
export function saveSettings(ledgerPath, patch = {}) {
  const file = settingsPath(ledgerPath);
  const current = readJson(file);
  const saved = [];
  for (const key of FIELD_KEYS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === '' || value === null || value === undefined) {
      delete current[key];
      saved.push(key);
      continue;
    }
    const coerced = coerce(key, value);
    if (coerced === undefined) continue;
    current[key] = coerced;
    saved.push(key);
  }
  writeJson(file, current);
  return { ok: true, saved, settings: loadSettings(ledgerPath) };
}

/** 按字段声明把表单值转成正确类型（字符串/数字/布尔）。 */
export function coerce(key, value) {
  const spec = SETTING_FIELDS.find((field) => field.key === key);
  if (!spec) return value;
  if (spec.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on', '是', '开'].includes(String(value).trim().toLowerCase());
  }
  if (spec.type === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return String(value).trim();
}

/**
 * 本地设置 → astock 配置键。
 *
 * 关键：**服务商预设决定发信参数**。选了 Outlook/QQ/163/Gmail，服务器、端口、
 * TLS、认证方式全部由预设给出，用户填的旧值一律忽略（否则「切了服务商还连旧服务器」）。
 * 只有 `custom` 才使用用户手填的值。
 */
export function settingsToAstock(settings = {}) {
  const out = {};
  for (const [key, value] of Object.entries(settings)) {
    if (FIELD_KEYS.includes(key) && value !== undefined && value !== null) out[key] = value;
  }

  // 没存过 mail_preset 的旧配置：按已填的服务器反推服务商，避免被默认值覆盖
  const host = String(out.mail_host || '').toLowerCase();
  let presetKey = String(out.mail_preset || '');
  if (!presetKey) {
    if (!host) presetKey = 'outlook';
    else if (host.includes('outlook') || host.includes('office365')) presetKey = 'outlook';
    else if (host.includes('qq.com')) presetKey = 'qq';
    else if (host.includes('163.com')) presetKey = '163';
    else if (host.includes('gmail')) presetKey = 'gmail';
    else presetKey = 'custom';
  }
  out.mail_preset = presetKey;

  const preset = PROVIDER_PRESETS[presetKey];
  if (preset && isPreset(presetKey)) {
    out.mail_auth = preset.auth;
    out.mail_provider = preset.provider;
    out.mail_host = preset.host;
    out.mail_port = preset.port;
    out.mail_secure = preset.secure;
  } else {
    // 自定义：认证方式默认 basic；选 OAuth2 时 provider 用 custom
    out.mail_auth = String(out.mail_auth || 'basic').toLowerCase() === 'oauth2' ? 'oauth2' : 'basic';
    out.mail_provider = 'custom';
  }
  return out;
}

/** 脱敏后的表单值（密码只回一个占位，绝不下发原文）。 */
export function maskedValues(settings = {}) {
  const out = {};
  for (const key of FIELD_KEYS) {
    if (SECRET_KEYS.has(key)) {
      out[key] = settings[key] ? '******' : '';
      continue;
    }
    // 没存过的键不要写 undefined：调用方会拿它和表单默认值合并
    if (!(key in settings)) continue;
    out[key] = settings[key];
  }
  return out;
}

/** 读 OAuth 私有状态（不含 access_token，它只活在内存里）。 */
export function loadOAuthState(ledgerPath) {
  const raw = readJson(oauthPath(ledgerPath));
  return {
    refresh_token: String(raw.refresh_token || ''),
    account: String(raw.account || ''),
    scope: String(raw.scope || ''),
    obtained_at: String(raw.obtained_at || ''),
  };
}

export function saveOAuthState(ledgerPath, state = {}) {
  writeJson(oauthPath(ledgerPath), {
    refresh_token: String(state.refresh_token || ''),
    account: String(state.account || ''),
    scope: String(state.scope || ''),
    obtained_at: String(state.obtained_at || ''),
  });
}

export function clearOAuthState(ledgerPath) {
  try {
    fs.rmSync(oauthPath(ledgerPath), { force: true });
  } catch {
    // 文件不存在也无所谓
  }
}

/** 表单结构（给客户端渲染；不含值）。 */
export function fieldSpecs() {
  return SETTING_FIELDS.map((field) => ({ ...field }));
}

/** 服务商预设（客户端切服务商时用它自动填值）。 */
export function presetSpecs() {
  return PRESET_ORDER
    .filter((key) => PROVIDER_PRESETS[key])
    .map((key) => ({ key, ...PROVIDER_PRESETS[key] }));
}
