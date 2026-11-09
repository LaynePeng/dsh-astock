/**
 * 高风险邮件通知（JS 版）：规则判定 + 去重限流 + 直接发 SMTP。
 *
 * **与上游的关系**：判断逻辑一条都没重写——信号来自 `lib/js/hints.js`（和
 * `astock_hint` 同一个引擎），去重/限流规则来自 `lib/js/notify.js`，正文用
 * 它的 `renderMail` / `renderMailHtml`。唯一替换掉的是**最后一跳**：上游通过
 * lite-work 的 email-plugin 发信（共享其凭据与 OAuth2），DSH 没有那个插件，
 * 这里用自带的 SMTP 客户端直接发。
 *
 * **为什么由插件自己定时、而不是让 Agent 调工具发**：发信这件事如果交给模型，
 * 就会出现「本该紧急提醒却因为模型选择不调工具而静默不发」。而且盯盘任务每次
 * 运行都要花 token。这里改成宿主侧定时跑一次（零 token），到点判定、到点发信。
 *
 * 判定口径（与上游一致，别改）：
 *   · 只发**阈值以上**的信号（默认 urgent；可调到 action）；
 *   · 同一标的同一信号默认 6 小时内不重复；
 *   · 每小时最多 12 封；
 *   · 只在盯盘时段内探测（工作日 9:10–15:00，午休跳过）——非交易时段直接跳过，
 *     免得深夜发一堆"没变化"的邮件。
 */

import path from 'node:path';

import { hintsConfig, buildPositionHints } from './hints.js';
import { snapshot } from './portfolio.js';
import {
  nowCn, shouldWatchNow,
} from './market.js';
import {
  DEDUP_SECONDS, MAX_MAILS_PER_HOUR, Notifier,
  levelRank, renderMail, renderMailHtml,
} from './notify.js';
import { sendMail as smtpSend, splitAddresses, bareAddress, sanitizeAddress } from './smtp.js';
import { sendViaGraph } from './graph.js';
import { oauthConfig, getAccessToken, resetTokenCache } from './oauth.js';

/** 信号级别排序（越大越严重）。 */
export const LEVEL_RANK = { info: 0, action: 1, urgent: 2 };

/** 默认发信阈值。与上游一致：默认只发 urgent，避免把日常波动变成邮件噪音。 */
export const DEFAULT_MIN_LEVEL = 'urgent';

/** 把插件配置整理成发信参数（缺项一律空，由调用方判定可不可用）。 */
export function mailConfig(own = {}) {
  // 账号/发件人/收件人都按**裸地址**处理：`姓名 <a@b>` 只允许出现在显示名里，
  // SMTP 信封（MAIL FROM / RCPT TO）与 AUTH LOGIN 只接受 a@b。
  const user = bareAddress(own.mail_username);
  const recipients = splitAddresses(own.mail_to).map(bareAddress).filter(Boolean);
  const auth = String(own.mail_auth || 'basic').trim().toLowerCase() === 'oauth2'
    ? 'oauth2' : 'basic';
  const oauth = oauthConfig(own);
  // OAuth2 模式下没手填 SMTP 就用服务商预设（Outlook：smtp-mail.outlook.com:587）
  const preset = auth === 'oauth2' ? oauth.smtp : null;
  const explicitHost = String(own.mail_host || '').trim();
  const explicitPort = Number(own.mail_port) || 0;
  const host = explicitHost || (preset ? preset.host : '');
  let port = explicitPort || (preset ? preset.port : 465);
  let secure = own.mail_secure !== false;
  if (preset) {
    // 465 + 隐式 TLS 是表单的「通用默认值」，不是用户对 Outlook 的选择：
    // Outlook 只认 587 + STARTTLS，这里按预设纠正，否则连上去就被断开。
    if (port === 465) port = preset.port;
    if (port === preset.port) secure = preset.secure;
  }
  return {
    enabled: Boolean(own.mail_enabled),
    auth,
    provider: oauth.provider,
    host,
    port,
    secure,
    username: user,
    password: auth === 'basic' ? String(own.mail_password || '') : '',
    // 发件人也只留裸地址：Layne Peng<a@b.com> 直接进 MAIL FROM 会回 501 5.1.7
    sender: sanitizeAddress(own.mail_from) || user,
    recipients: recipients.length ? recipients : (user ? [user] : []),
    min_level: String(own.mail_min_level || DEFAULT_MIN_LEVEL).toLowerCase(),
    // OAuth 相关（refresh_token 由调用方从 oauth.json 注入）
    oauth,
    refresh_token: String(own.oauth_refresh_token || ''),
  };
}

/** 发信前置条件检查。返回 {ready, reason}——原因用于设置页与日志。 */
export function mailReady(cfg = {}) {
  if (!cfg.enabled) return { ready: false, reason: '未启用邮件通知' };
  if (!cfg.host) return { ready: false, reason: '未填写 SMTP 服务器（mailHost）' };
  if (!cfg.username) return { ready: false, reason: '未填写邮箱账号' };
  if (cfg.auth === 'oauth2') {
    if (!cfg.refresh_token) {
      return { ready: false, reason: 'OAuth2 尚未授权：到右栏「设置」点「开始授权」完成一次授权' };
    }
  } else if (!cfg.password) {
    return { ready: false, reason: '未填写邮箱密码 / 授权码' };
  }
  if (!cfg.sender) return { ready: false, reason: '未填写发件人' };
  if (!cfg.recipients || !cfg.recipients.length) {
    return { ready: false, reason: '未填写收件人' };
  }
  if (!(cfg.min_level in LEVEL_RANK)) {
    return { ready: false, reason: `通知阈值只能是 ${Object.keys(LEVEL_RANK).join('/')}` };
  }
  return { ready: true, reason: '' };
}

/**
 * 真正发信：basic 用密码，oauth2 先换 access_token 再走 XOAUTH2。
 *
 * @returns {Promise<{ok: boolean, message: string}>} **绝不抛**
 */
export async function deliver(cfg, message, { send = smtpSend, graph = sendViaGraph, token: injected } = {}) {
  if (cfg.auth !== 'oauth2') {
    return send(cfg, message);
  }
  const token = injected || await getAccessToken(cfg.oauth, cfg.refresh_token);
  if (!token.ok) return { ok: false, message: token.message };

  // Outlook/Hotmail：优先走 Graph（HTTPS 443）。部分网络会在 SMTP 220 问候后
  // 直接断连（连 NOOP 都不回），那条路在这些网络里根本不可用。
  if (cfg.provider === 'outlook') {
    const viaGraph = await graph(cfg, { ...message, accessToken: token.token });
    if (viaGraph.ok) return viaGraph;
    const viaSmtp = await send(cfg, { ...message, accessToken: token.token });
    if (viaSmtp.ok) return viaSmtp;
    // 401/403 基本都是「旧授权只有 SMTP scope」：把重新授权说清楚，别让用户只看到 SMTP 断连
    if (viaGraph.code === 401 || viaGraph.code === 403) {
      return { ok: false, message: `${viaGraph.message}；SMTP 兜底也失败：${viaSmtp.message}` };
    }
    return { ok: false, message: `${viaGraph.message}；SMTP 兜底：${viaSmtp.message}` };
  }

  const first = await send(cfg, { ...message, accessToken: token.token });
  if (first.ok) return first;
  // 535 常见于 access_token 被提前吊销：清缓存再换一次，仍失败就把原因带回去
  if (/认证失败|535|5\.7\.139/.test(first.message || '')) {
    resetTokenCache();
    const again = await getAccessToken(cfg.oauth, cfg.refresh_token);
    if (again.ok) return send(cfg, { ...message, accessToken: again.token });
  }
  return first;
}

function hintsOf(position, quote, cfg, totalMv, equity, watchOnly = false) {
  let items;
  try {
    items = buildPositionHints(position, quote, cfg, {
      totalMarketValue: totalMv,
      totalEquity: equity,
      watchOnly,
    });
  } catch {
    // 单票算挂了不能拖垮整轮判定
    return [];
  }
  return items.map((h) => ({
    code: h.code,
    name: h.name,
    kind: h.kind,
    severity: h.severity,
    title: h.title,
    detail: h.detail,
    suggestion: h.suggestion,
  }));
}

/** 持仓 + 自选 → 阈值以上的信号列表（与面板同一套 hint 引擎）。 */
export async function collectSignals(ledger, config = {}, { limit = 20 } = {}) {
  const cfg = hintsConfig(config);
  const snap = await snapshot(ledger, { includeWatch: true });
  const data = snap?.data || {};
  const positions = data.positions || [];
  const quotes = data.quotes || {};
  const watchQuotes = data.watch_quotes || {};
  const totalMv = Number(data.total_market_value || 0);
  const equity = Number(data.equity || 0);

  let out = [];
  for (const p of positions) {
    const q = quotes[String(p.code || '')] || {};
    out = out.concat(hintsOf(p, q, cfg, totalMv, equity));
  }
  for (const [code, q] of Object.entries(watchQuotes)) {
    // 自选只报「与仓位无关」的信号（涨跌停/异动/放量），shares=0 即该语义
    out = out.concat(hintsOf({
      code, name: q?.name || code, shares: 0, cost_price: 0,
    }, q || {}, cfg, totalMv, equity, true));
  }
  // 严重的排前面：邮件开头就是最该看的那条
  out.sort((a, b) => levelRank(b.severity) - levelRank(a.severity));
  return out.slice(0, limit);
}

/** 默认去重状态文件（与台账同目录）。 */
export function mailStatePath(ledgerPath) {
  return path.join(path.dirname(String(ledgerPath || '')), 'mail-state.json');
}

let sharedNotifier = null;
let sharedNotifierPath = '';

function notifierFor(ledgerPath) {
  const file = mailStatePath(ledgerPath);
  if (!sharedNotifier || sharedNotifierPath !== file) {
    sharedNotifier = new Notifier(file);
    sharedNotifierPath = file;
  }
  return sharedNotifier;
}

function cnDateText(now) {
  const d = nowCn(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function cnTimeText(now) {
  const d = nowCn(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * 跑一轮判定 + 发信，返回可序列化的结果（供宿主日志/面板展示）。
 *
 * 设计原则：**任何一步失败都只降级、不抛**——探测失败不能影响行情与台账工具。
 */
export async function runOnce(ledger, config = {}, {
  notifier = null, now = new Date(), send = smtpSend, limit = 20,
} = {}) {
  const started = `${cnDateText(new Date())} ${cnTimeText(new Date())}`;
  const result = {
    ok: true,
    checkedAt: started,
    sent: false,
    signals: 0,
    picked: 0,
    fresh: 0,
    skipped: '',
    detail: '',
    blocked: [],
  };

  const cfg = mailConfig(config);
  const ready = mailReady(cfg);
  if (!ready.ready) {
    result.skipped = ready.reason;
    return result;
  }

  // 只在盯盘时段判定：上游探针同样如此（深夜发提醒既没用又扰人）
  try {
    const watching = shouldWatchNow(now);
    if (!watching.watch) {
      result.skipped = `当前不在盯盘时段：${watching.reason}`;
      return result;
    }
  } catch {
    // 时段判断异常时宁可继续（漏发比不发更糟）
  }

  let signals;
  try {
    signals = await collectSignals(ledger, config, { limit });
  } catch (error) {
    return { ...result, ok: false, detail: `信号计算失败：${error?.message ?? error}` };
  }

  result.signals = signals.length;
  const floor = LEVEL_RANK[cfg.min_level] ?? 2;
  const picked = signals.filter((e) => levelRank(e.severity) >= floor);
  result.picked = picked.length;
  if (!picked.length) {
    // 阈值把信号全拦掉时要说清楚，否则用户只会觉得"邮件怎么从来不响"
    result.blocked = signals.map((e) => ({
      code: e.code, kind: e.kind, severity: e.severity,
    }));
    result.skipped = `${signals.length} 条信号都低于阈值 ${cfg.min_level}`
      + '（可把设置页「通知阈值」调到 action 或 info）';
    return result;
  }

  const gate = notifier || notifierFor(ledger?.path || '');
  const fresh = [];
  for (const e of picked) {
    const check = gate.shouldSend(e.code, e.kind);
    if (check.sendable) fresh.push(e);
  }
  result.fresh = fresh.length;
  if (!fresh.length) {
    result.skipped = `命中的信号都在去重窗口内（同一标的同一信号 ${Math.round(DEDUP_SECONDS / 3600)} 小时内只发一次）`;
    return result;
  }

  const asOf = `${cnDateText(now)} ${String(cnTimeText(now)).slice(0, 5)}`;
  const { subject, text } = renderMail(fresh, asOf);
  const html = renderMailHtml(fresh, asOf);
  const sent = await deliver(cfg, { subject, text, html }, { send });
  result.detail = sent.message;
  result.sent = Boolean(sent.ok);
  result.subject = subject;
  if (sent.ok) {
    for (const e of fresh) gate.markSent(e.code, e.kind);
  } else {
    result.ok = false;
  }
  return result;
}

/**
 * 发一封测试邮件（设置页/面板的「发测试邮件」按钮）。
 *
 * 刻意**不经过交易时段与去重判断**：用户点按钮就是想立刻验证账号能不能发出去，
 * 这时候因为"现在是周末"而拒绝，等于让配置问题无从验证。
 */
export async function testSend(config = {}, { send = smtpSend, now = new Date() } = {}) {
  const cfg = mailConfig(config);
  const ready = mailReady(cfg);
  if (!ready.ready) return { ok: false, message: `配置不完整：${ready.reason}` };

  const nowText = `${cnDateText(now)} ${cnTimeText(now)}`;
  const subject = '[A股助手] 测试邮件';
  const viaGraph = cfg.auth === 'oauth2' && cfg.provider === 'outlook';
  const tlsLabel = viaGraph ? 'HTTPS' : (cfg.secure ? '隐式 TLS' : 'STARTTLS');
  const authLabel = cfg.auth === 'oauth2'
    ? `OAuth2（${cfg.provider === 'outlook' ? 'Outlook / Microsoft Graph' : cfg.provider}）`
    : 'SMTP 密码 / 授权码';
  const channelLabel = viaGraph ? 'Microsoft Graph（HTTPS 443）' : `SMTP ${cfg.host}:${cfg.port}`;
  const text = [
    '这是一封配置验证邮件。',
    '',
    `发送时间：${nowText}`,
    `发送通道：${channelLabel}（${tlsLabel}）`,
    `认证：${authLabel}`,
    `通知阈值：${cfg.min_level}`,
    '',
    '收到这封说明账号、凭据与网络都正常。真正的提醒只在盘中触发阈值时才发。',
    '—— 本邮件由插件自动发送，不构成投资建议。',
  ].join('\n');
  const html = '<div style="font:14px/1.7 -apple-system,Segoe UI,Roboto,sans-serif;color:#202124">'
    + '<p>这是一封 <b>A股助手</b> 的配置验证邮件。</p>'
    + `<p>发送时间：${nowText}<br>发送通道：${channelLabel}（${tlsLabel}）`
    + `<br>认证：${authLabel}<br>通知阈值：${cfg.min_level}</p>`
    + "<p style='color:#5f6368'>收到这封说明账号、凭据与网络都正常。"
    + '真正的提醒只在盘中触发阈值时才发。</p></div>';

  const sent = await deliver(cfg, { subject, text, html }, { send });
  return { ok: sent.ok, message: sent.message, recipients: cfg.recipients, auth: cfg.auth };
}

/** 设置页/状态查询用：配置是否可用 + 阈值 + 收件人（不回显密码）。 */
export function status(config = {}, { oauth = null } = {}) {
  const cfg = mailConfig(config);
  const ready = mailReady(cfg);
  const state = oauth || {};
  return {
    ready: ready.ready,
    reason: ready.reason,
    enabled: cfg.enabled,
    auth: cfg.auth,
    provider: cfg.provider,
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    username: cfg.username,
    sender: cfg.sender,
    recipients: cfg.recipients,
    minLevel: cfg.min_level,
    dedupeHours: Math.trunc(DEDUP_SECONDS / 3600),
    maxPerHour: MAX_MAILS_PER_HOUR,
    oauth: {
      provider: cfg.provider,
      authorized: Boolean(cfg.refresh_token),
      account: String(state.account || ''),
      obtainedAt: String(state.obtained_at || ''),
      tenant: cfg.oauth.tenant,
      clientId: cfg.oauth.clientId,
    },
  };
}
