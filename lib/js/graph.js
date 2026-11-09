/**
 * 通过 Microsoft Graph 发信（HTTPS）。
 *
 * **为什么要这条通道**：Outlook/Hotmail 的 SMTP（smtp-mail.outlook.com:587）在
 * 部分网络下会在服务器返回 220 问候后直接断开——连 EHLO 都收不到回复（实测
 * `NOOP` 也会被断）。这不是配置问题，SMTP 那条路在这些网络里根本走不通。
 *
 * Graph 走 443 + HTTPS，只要能打开网页就能发信，所以 Outlook 的 OAuth2 账号
 * 优先用它；SMTP 只作为兜底（部分地区 SMTP 正常、Graph 被组织策略禁用）。
 *
 * 边界：只做「发一封纯文本/HTML 邮件」，不读信、不碰附件、不访问其它 Graph API。
 */

import { looksLikeEmail, sanitizeAddress } from './smtp.js';

/** Graph sendMail 端点（发件人固定为授权账号本人）。 */
export const GRAPH_SEND_URL = 'https://graph.microsoft.com/v1.0/me/sendMail';

/**
 * 用 refresh_token 换来的 access_token 发信。
 *
 * @param {object} cfg mailConfig() 的结果
 * @param {{subject?: string, text?: string, html?: string, accessToken?: string}} message
 * @param {{fetchImpl?: Function}} [options] 测试注入
 * @returns {Promise<{ok: boolean, message: string, code?: number}>} **绝不抛**
 */
export async function sendViaGraph(cfg = {}, message = {}, { fetchImpl = fetch } = {}) {
  const token = String(message.accessToken || '');
  if (!token) return { ok: false, message: 'Graph 发信缺少 access_token：请先在「配置」里完成授权' };

  const recipients = (cfg.recipients || []).map(sanitizeAddress).filter(Boolean);
  if (!recipients.length) return { ok: false, message: '未填写收件人' };
  const bad = recipients.filter((addr) => !looksLikeEmail(addr));
  if (bad.length) return { ok: false, message: `收件人不是有效邮箱地址：${bad.join('、')}` };

  const subject = String(message.subject || '');
  const html = String(message.html || '');
  const text = String(message.text || '');
  const payload = {
    message: {
      subject,
      body: {
        contentType: html ? 'HTML' : 'Text',
        content: html || text,
      },
      toRecipients: recipients.map((address) => ({ emailAddress: { address } })),
    },
    saveToSentItems: true,
  };

  let response;
  try {
    response = await fetchImpl(GRAPH_SEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return { ok: false, message: `连接 Microsoft Graph 失败：${error?.message ?? error}` };
  }

  if (response.status === 202 || response.ok) {
    return { ok: true, message: '已通过 Microsoft Graph 发送' };
  }

  let detail = '';
  try {
    detail = String(await response.text()).slice(0, 300);
  } catch {
    /* 响应体读不出来就只报状态码 */
  }
  if (response.status === 401) {
    return {
      ok: false,
      code: 401,
      message: 'Microsoft Graph 认证失败（401）：请在「配置 → 邮件」重新授权一次'
        + '（新版改用 Graph 的 Mail.Send 权限，旧的 SMTP 授权不适用于 Graph）',
    };
  }
  if (response.status === 403) {
    return {
      ok: false,
      code: 403,
      message: 'Microsoft Graph 权限不足（403）：请重新授权并同意「发送邮件」权限；'
        + '若是企业账号，还需要管理员同意该应用',
    };
  }
  return {
    ok: false,
    code: response.status,
    message: `Graph 发信失败 HTTP ${response.status}：${detail || '无响应体'}`,
  };
}
