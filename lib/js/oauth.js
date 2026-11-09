/**
 * OAuth2（Microsoft 设备码流程）——给 Outlook / Hotmail / Microsoft 365 发信用的。
 *
 * 背景：Outlook 个人版已关闭 SMTP Basic Auth（`535 5.7.139`），只认 XOAUTH2。
 * lite-work 的 email-plugin 用「设备码授权 + 公共客户端」把这件事做到了零配置，
 * 这里按同样的路子实现（端点、scope、内置 client_id 都对齐它）：
 *
 *   1. `startDeviceCode()` 申请设备码 → 用户看到 `user_code` 与验证地址；
 *   2. 用户在浏览器里输入码并同意 → 我们轮询 token 端点；
 *   3. 拿到 `refresh_token` 后落盘（`oauth.json`，0600），之后静默续期；
 *   4. 发信时用 `AUTH XOAUTH2` 把 access_token 交给 SMTP（见 smtp.js）。
 *
 * 刻意不做的：授权码流程（需要本地 loopback 监听与浏览器跳转，DSH 宿主里
 * 起监听端口有权限/防火墙的不确定性）。设备码流程对个人账号足够，且
 * 只需要用户复制一次码。
 */

/** 内置公共客户端（lite-work 在 Azure 注册的多租户公共客户端）。 */
export const PUBLIC_CLIENT_IDS = {
  outlook: 'bec6c4fa-626d-4382-860f-0e3e4900ffd1',
};

/** 默认租户：个人账号（Hotmail / Outlook / Live）。 */
export const DEFAULT_TENANT = 'consumers';

/**
 * Outlook 发信所需的最小 scope。
 *
 * 0.8.8 起改用 Microsoft Graph 的 `Mail.Send`（HTTPS 443）：部分网络会在
 * SMTP 220 问候后直接断连，SMTP 那条路走不通。旧的 SMTP scope 不适用于
 * Graph，升级后需要重新授权一次。
 */
export const DEFAULT_SCOPE = 'offline_access https://graph.microsoft.com/Mail.Send';

/** SMTP 服务器预设（OAuth2 模式下用户不必手填）。 */
export const PROVIDER_SMTP = {
  outlook: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
};

const AUTH_BASE = 'https://login.microsoftonline.com';
const HTTP_TIMEOUT_MS = 20_000;

/** access_token 内存缓存（按 client+账号+refresh_token 尾段区分）。 */
const tokenCache = new Map();

function postForm(url, data) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && value !== null && value !== '') body.set(key, String(value));
  }
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  }).then(async (response) => {
    const text = await response.text();
    let payload = {};
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text.slice(0, 300) };
    }
    return { status: response.status, payload };
  });
}

/** 把 Azure 的错误码翻成人话（用户拿 AADSTS 天书没法排查）。 */
export function explainOAuthError(payload = {}, status = 0) {
  const code = String(payload.error || '');
  const desc = String(payload.error_description || payload.raw || '');
  const aad = (desc.match(/AADSTS\d+/) || [''])[0];
  const map = {
    AADSTS7000215: '客户端密钥不对（自定义应用才需要；用内置客户端请清空密钥）',
    AADSTS700016: '客户端 ID 不存在（Azure 应用 ID 填错了？）',
    AADSTS900023: '租户标识无效：个人账号请留空（默认 consumers），不要填邮箱',
    AADSTS65001: '用户/管理员未同意该应用（换用内置客户端，或让管理员授权）',
    AADSTS500011: '该账号不在这个租户里：组织账号要填对应租户，个人账号用 consumers',
    AADSTS50034: '账号不存在或不在该租户',
    AADSTS70000: '授权被拒（可能账号不支持 SMTP AUTH，或组织策略关闭）',
  };
  if (aad && map[aad]) return `${map[aad]}（${aad}）`;
  if (code === 'authorization_pending') return '等待你在浏览器里完成授权…';
  if (code === 'slow_down') return '轮询太快，稍后继续';
  if (code === 'expired_token') return '设备码已过期，请重新发起授权';
  if (code === 'authorization_declined' || code === 'access_denied') return '你在浏览器里拒绝了授权';
  if (code === 'invalid_client') return `客户端校验失败：${desc || '检查客户端 ID'}`;
  if (code === 'invalid_grant') return `授权已失效（refresh_token 过期或被吊销），请重新授权`;
  if (status === 0) return `网络错误：${desc || '连不上登录服务'}`;
  return `${code || `HTTP ${status}`}：${desc.slice(0, 200) || '未知错误'}`;
}

/**
 * 把配置整理成 OAuth 参数。
 *
 * @param {object} own 插件配置（snake_case；mail_* 与 oauth_*）
 */
export function oauthConfig(own = {}) {
  // 已经规范化过的对象（`mailConfig()` 里存的 `oauth` 字段）直接返回：
  // 再走一遍原始键会让 `oauth_token_endpoint` 丢失，从而退回微软默认端点。
  if (own && typeof own.tokenUrl === 'string' && own.tokenUrl) {
    return {
      provider: String(own.provider || 'outlook'),
      tenant: String(own.tenant || DEFAULT_TENANT),
      tenantFixed: Boolean(own.tenantFixed),
      clientId: String(own.clientId || ''),
      clientSecret: String(own.clientSecret || ''),
      scope: String(own.scope || DEFAULT_SCOPE),
      tokenUrl: own.tokenUrl,
      deviceUrl: String(own.deviceUrl || ''),
      smtp: own.smtp || null,
    };
  }
  const provider = String(own.mail_provider || 'outlook').trim().toLowerCase();
  const tenantRaw = String(own.oauth_tenant || '').trim();
  // 用户常把邮箱填进「租户」→ Azure 报 AADSTS900023 且不指向字段，这里提前纠正
  const looksLikeEmail = tenantRaw.includes('@');
  const tenant = tenantRaw && !looksLikeEmail ? tenantRaw : DEFAULT_TENANT;
  const clientId = String(own.oauth_client_id || '').trim()
    || PUBLIC_CLIENT_IDS[provider]
    || '';
  const scope = String(own.oauth_scope || '').trim() || DEFAULT_SCOPE;
  const base = `${AUTH_BASE}/${tenant}/oauth2/v2.0`;
  return {
    provider,
    tenant,
    tenantFixed: Boolean(tenantRaw && tenant !== tenantRaw),
    clientId,
    clientSecret: String(own.oauth_client_secret || '').trim(),
    scope,
    tokenUrl: String(own.oauth_token_endpoint || '').trim() || `${base}/token`,
    deviceUrl: String(own.oauth_devicecode_endpoint || '').trim() || `${base}/devicecode`,
    smtp: PROVIDER_SMTP[provider] || null,
  };
}

/** 第一步：申请设备码。 */
export async function startDeviceCode(own = {}) {
  const cfg = oauthConfig(own);
  if (!cfg.clientId) {
    return { ok: false, message: '缺少客户端 ID：内置客户端不支持该服务商，请在设置里填写' };
  }
  if (!cfg.deviceUrl) {
    return { ok: false, message: '该服务商没有设备码端点，请改用 SMTP 密码方式' };
  }
  let res;
  try {
    res = await postForm(cfg.deviceUrl, { client_id: cfg.clientId, scope: cfg.scope });
  } catch (error) {
    return { ok: false, message: `申请设备码失败：${error?.message ?? error}` };
  }
  const payload = res.payload || {};
  if (!payload.device_code) {
    return { ok: false, message: `申请设备码失败：${explainOAuthError(payload, res.status)}` };
  }
  return {
    ok: true,
    deviceCode: String(payload.device_code),
    userCode: String(payload.user_code || ''),
    verificationUri: String(payload.verification_uri || payload.verification_url || ''),
    expiresIn: Number(payload.expires_in) || 900,
    interval: Number(payload.interval) || 5,
    message: String(payload.message || ''),
    hint: cfg.tenantFixed ? `租户已自动改为 ${cfg.tenant}（不要填邮箱）` : '',
  };
}

/** 第二步：单次轮询。返回 {status: pending|done|error}。 */
export async function pollDeviceCode(own = {}, deviceCode = '') {
  const cfg = oauthConfig(own);
  if (!deviceCode) return { status: 'error', message: '没有设备码，请先点「开始授权」' };
  let res;
  try {
    res = await postForm(cfg.tokenUrl, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: cfg.clientId,
      device_code: deviceCode,
      client_secret: cfg.clientSecret,
    });
  } catch (error) {
    return { status: 'error', message: `轮询失败：${error?.message ?? error}` };
  }
  const payload = res.payload || {};
  if (payload.access_token) {
    return {
      status: 'done',
      accessToken: String(payload.access_token),
      refreshToken: String(payload.refresh_token || ''),
      expiresIn: Number(payload.expires_in) || 3600,
      scope: String(payload.scope || cfg.scope),
    };
  }
  const code = String(payload.error || '');
  if (code === 'authorization_pending') return { status: 'pending', message: '等待你在浏览器里完成授权…' };
  if (code === 'slow_down') return { status: 'pending', slowDown: true, message: '轮询太快，已放慢' };
  return { status: 'error', message: explainOAuthError(payload, res.status) };
}

function cacheKey(cfg, refreshToken) {
  return `${cfg.provider}|${cfg.clientId}|${cfg.tokenUrl}|${String(refreshToken).slice(-12)}`;
}

/**
 * 取可用 access_token（内存缓存 + refresh_token 续期）。
 *
 * @returns {Promise<{ok: boolean, token?: string, message?: string}>}
 */
export async function getAccessToken(own = {}, refreshToken = '') {
  const cfg = oauthConfig(own);
  if (!refreshToken) {
    return { ok: false, message: '尚未授权：请在右栏「设置」里完成 OAuth 授权' };
  }
  if (!cfg.clientId || !cfg.tokenUrl) {
    return { ok: false, message: 'OAuth 配置不完整：缺少客户端 ID 或 token 端点' };
  }
  const key = cacheKey(cfg, refreshToken);
  const hit = tokenCache.get(key);
  if (hit && hit.exp > Date.now()) return { ok: true, token: hit.token };

  let res;
  try {
    res = await postForm(cfg.tokenUrl, {
      grant_type: 'refresh_token',
      client_id: cfg.clientId,
      refresh_token: refreshToken,
      scope: cfg.scope,
      client_secret: cfg.clientSecret,
    });
  } catch (error) {
    return { ok: false, message: `刷新 access_token 失败：${error?.message ?? error}` };
  }
  const payload = res.payload || {};
  if (!payload.access_token) {
    return { ok: false, message: `刷新 access_token 失败：${explainOAuthError(payload, res.status)}` };
  }
  const ttl = Number(payload.expires_in) || 3600;
  tokenCache.set(key, { token: String(payload.access_token), exp: Date.now() + Math.max(ttl - 120, 60) * 1000 });
  return { ok: true, token: String(payload.access_token) };
}

/** 清掉内存里的 access_token（换账号 / 发信被拒时用）。 */
export function resetTokenCache() {
  tokenCache.clear();
}
