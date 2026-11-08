/**
 * 极简 SMTP 客户端（零依赖，只用 node:net / node:tls）。
 *
 * **为什么要自己写**：DSH 里没有 email-plugin，而发信又不能交给模型（模型选择
 * 不调工具就等于静默漏发）。插件要在宿主侧定时发提醒，就必须自带一条发信通道。
 *
 * 支持的范围刻意收窄到「个人邮箱发提醒」够用的程度：
 *   · 465 隐式 TLS / 587 STARTTLS（**不接受明文直发密码的降级**）；
 *   · AUTH LOGIN / AUTH PLAIN（授权码与应用专用密码都走这两条）；
 *   · multipart/alternative（纯文本 + HTML），主题与发件人按 RFC 2047 编码。
 *
 * 不支持：OAuth2（XOAUTH2）、附件、DKIM。这些都不影响「发一封提醒给自己」。
 *
 * 约定：`sendMail()` **绝不抛异常**，一律返回 `{ok, message}`——发信失败只该
 * 降级成一条日志，不该打断定时探测。
 */

import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import crypto from 'node:crypto';

/** SMTP 超时（秒）。公共网络下 15 秒足够；再长说明网络有问题，不该拖住探测。 */
export const SMTP_TIMEOUT_MS = 15_000;

/** 收件人：字符串（逗号/中文逗号分隔）或列表 → 地址列表。 */
export function splitAddresses(raw) {
  if (typeof raw === 'string') {
    return raw.replace(/，/g, ',').replace(/;/g, ',').split(',')
      .map((p) => p.trim())
      .filter(Boolean);
  }
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim()).filter(Boolean);
  }
  return [];
}

/**
 * 从「姓名 <a@b.com>」里取出纯邮箱地址。
 *
 * SMTP 信封（MAIL FROM / RCPT TO）只接受裸地址：带显示名会直接回
 * `501 5.1.7 Invalid address`。显示名只属于邮件头，不属于信封。
 */
export function bareAddress(value) {
  const text = String(value ?? '').trim();
  const angled = text.match(/<([^<>]+)>/);
  return (angled ? angled[1] : text).trim();
}

/** 严格的邮箱地址校验：只允许 ASCII（中文/全角字符会让服务器回 501 5.1.7）。 */
const ADDRESS_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/** 粗判是不是一个邮箱地址（SMTP 信封用；不追求 RFC 全量校验）。 */
export function looksLikeEmail(value) {
  return ADDRESS_RE.test(sanitizeAddress(value));
}

/**
 * 把地址洗成服务器一定接受的形式。
 *
 * 用户从通讯录/微信/网页复制来的地址经常带：全角字符、零宽空格、首尾引号、
 * 中文姓名、多余的点——这些都会让服务器回 `501 5.1.7 Invalid address`，
 * 而错误里不会告诉你是哪个字符。这里统一清掉，只保留 ASCII 邮箱字符。
 */
export function sanitizeAddress(value) {
  // NFKC 把全角 ＠／．／字母折成 ASCII（中文输入法最容易打出全角 @）
  let text = bareAddress(String(value ?? '').normalize('NFKC'))
    .replace(/^["']+|["']+$/g, '');
  text = text.replace(/[\s\u200B-\u200D\uFEFF]/g, '');
  text = text.replace(/[^\x20-\x7E]/g, '');
  const at = text.lastIndexOf('@');
  if (at < 0) return text;
  const local = text.slice(0, at).replace(/^\.+|\.+$/g, '');
  const domain = text.slice(at + 1).replace(/^\.+|\.+$/g, '').toLowerCase();
  return `${local}@${domain}`;
}

function b64(text) {
  return Buffer.from(String(text ?? ''), 'utf8').toString('base64');
}

/** RFC 2047 编码（非 ASCII 才编码，纯 ASCII 原样保留）。 */
function encodeHeader(text) {
  const value = String(text ?? '');
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${b64(value)}?=`;
}

/** 正文 base64 折行（每行 76 字符，符合 RFC 2045）。 */
function wrapBase64(text) {
  const raw = b64(text);
  const lines = [];
  for (let i = 0; i < raw.length; i += 76) lines.push(raw.slice(i, i + 76));
  return lines.join('\r\n');
}

/** 本地时区的 RFC 2822 时间（Python 的 formatdate(localtime=True) 等价物）。 */
function rfc2822Date(now = new Date()) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${days[now.getDay()]}, ${pad(now.getDate())} ${months[now.getMonth()]} `
    + `${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}:`
    + `${pad(now.getSeconds())} ${sign}${pad(Math.trunc(abs / 60))}${pad(abs % 60)}`;
}

/** 组一封 multipart/alternative 邮件（纯文本 + 可选 HTML）。 */
export function buildMessage({
  from, to, subject, text, html = '', messageId = '', date = '',
}) {
  // 邮件头里的地址同样要裸地址：`A股助手 <姓名 <a@b>>` 是非法头
  const fromAddr = bareAddress(from);
  const toAddrs = (Array.isArray(to) ? to : [to]).map(bareAddress).filter(Boolean);
  const domain = fromAddr.split('@').pop() || 'localhost';
  const boundary = `=_astock_${crypto.randomBytes(8).toString('hex')}`;
  const headers = [
    `From: ${encodeHeader('A股助手')} <${fromAddr}>`,
    `To: ${toAddrs.join(', ')}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date || rfc2822Date()}`,
    `Message-ID: <${messageId || `${crypto.randomBytes(12).toString('hex')}@${domain}`}>`,
    'MIME-Version: 1.0',
  ];

  if (!html) {
    return [
      ...headers,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(text),
    ].join('\r\n');
  }

  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(text),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(html),
    '',
    `--${boundary}--`,
  ].join('\r\n');
}

/** DATA 阶段的点转义：以 `.` 开头的行前面再加一个点。 */
export function dotStuff(message) {
  return String(message).split('\r\n').map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}

/**
 * 一条 SMTP 连接（读应答 → 发命令）。
 *
 * 导出是为了让单测能用本地假服务器验证协议状态机（含问候语早于 `read()`
 * 到达、点转义这些容易写错的地方），正常调用方只用 `sendMail()`。
 */
export class SmtpConnection {
  constructor(socket, { timeoutMs = SMTP_TIMEOUT_MS } = {}) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buffer = '';
    this.lines = [];
    this.waiters = [];
    this.replies = [];
    this.closed = false;
    this.error = null;
    this.attach(socket);
    socket.setTimeout(timeoutMs, () => {
      this.fail(new Error(`SMTP 超时（${Math.round(timeoutMs / 1000)} 秒无响应）`));
    });
  }

  attach(socket) {
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => {
      if (!this.closed) this.fail(new Error('SMTP 连接被服务器关闭'));
    });
  }

  detach() {
    // 升级 TLS 时旧 socket 的监听要摘掉，否则它的 close 会把新连接判死
    try {
      this.socket.removeAllListeners('data');
      this.socket.removeAllListeners('error');
      this.socket.removeAllListeners('close');
      this.socket.removeAllListeners('timeout');
    } catch {
      // 忽略
    }
  }

  fail(error) {
    this.closed = true;
    this.error = error;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  onData(chunk) {
    this.buffer += chunk.toString('utf8');
    let index = this.buffer.indexOf('\r\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      this.lines.push(line);
      // 多行应答以 "250-" 续行，最后一行是 "250 "（三位码后跟空格）
      if (/^\d{3} /.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), lines: this.lines };
        this.lines = [];
        const waiter = this.waiters.shift();
        // 应答可能早于 `read()` 到达（连接建立瞬间的 220 问候语就是这样）：
        // 没人等就排队，别丢掉——丢了只能等超时。
        if (waiter) waiter.resolve(reply);
        else this.replies.push(reply);
      }
      index = this.buffer.indexOf('\r\n');
    }
  }

  /** 等下一条应答（超时/断开都会 reject）。 */
  read() {
    if (this.replies.length) return Promise.resolve(this.replies.shift());
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`SMTP 超时（${Math.round(this.timeoutMs / 1000)} 秒无响应）`));
      }, this.timeoutMs);
      this.waiters.push({
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  write(text) {
    this.socket.write(`${text}\r\n`);
  }

  /** 发一条命令并校验应答码；不符合就抛可读错误。 */
  async command(text, expected = [250]) {
    if (text) this.write(text);
    const reply = await this.read();
    if (expected.length && !expected.includes(reply.code)) {
      const detail = reply.lines.join(' / ');
      const error = new Error(`SMTP ${reply.code}：${detail}`);
      error.smtpCode = reply.code;
      error.smtpDetail = detail;
      throw error;
    }
    return reply;
  }

  async upgradeTls(host) {
    this.detach();
    const secure = await new Promise((resolve, reject) => {
      const socket = tls.connect({
        socket: this.socket,
        servername: host,
        rejectUnauthorized: true,
      }, () => resolve(socket));
      socket.once('error', reject);
    });
    this.socket = secure;
    this.buffer = '';
    this.lines = [];
    this.closed = false;
    this.attach(secure);
    secure.setTimeout(this.timeoutMs, () => {
      this.fail(new Error(`SMTP 超时（${Math.round(this.timeoutMs / 1000)} 秒无响应）`));
    });
  }

  close() {
    try {
      this.socket.end();
      this.socket.destroy();
    } catch {
      // 忽略
    }
  }
}

/** 发信前置条件检查。返回 {ready, reason}。 */
export function mailReady(cfg = {}) {
  if (!cfg.enabled) return { ready: false, reason: '未启用邮件通知' };
  if (!cfg.host) return { ready: false, reason: '未填写 SMTP 服务器（mailHost）' };
  if (!cfg.username) return { ready: false, reason: '未填写邮箱账号' };
  // OAuth2 用 access_token 登录，不需要密码；密码只属于 basic 模式
  if (cfg.auth !== 'oauth2' && !cfg.password) {
    return { ready: false, reason: '未填写邮箱账号或密码' };
  }
  if (!cfg.sender) return { ready: false, reason: '未填写发件人' };
  if (!looksLikeEmail(cfg.sender)) {
    return { ready: false, reason: `发件人不是有效邮箱地址（${cfg.sender}）：请填纯地址，如 me@qq.com` };
  }
  if (!Array.isArray(cfg.recipients) || !cfg.recipients.length) {
    return { ready: false, reason: '未填写收件人' };
  }
  const bad = cfg.recipients.map(sanitizeAddress).filter((addr) => !looksLikeEmail(addr));
  if (bad.length) {
    return { ready: false, reason: `收件人不是有效邮箱地址：${bad.join('、')}` };
  }
  return { ready: true, reason: '' };
}

/**
 * 与服务器完成一轮对话（EHLO → AUTH → MAIL FROM → RCPT TO → DATA → QUIT）。
 *
 * 单独导出是为了能对着**本地假服务器**跑集成测试：真实故障（发件人带显示名、
 * 地址里混进全角字符 → `501 5.1.7 Invalid address`）只有在这条路径上才测得出来。
 *
 * @returns {Promise<{ok: boolean, message: string}>} **绝不抛**
 */
export async function runSession(conn, {
  cfg = {}, subject = '', text = '', html = '', accessToken = '', hostname = '', secure = true,
} = {}) {
  // 信封只用**洗过的裸地址**：显示名、全角字符、零宽空格都会让服务器回 501 5.1.7
  const envelopeFrom = sanitizeAddress(cfg.sender);
  const envelopeTo = (cfg.recipients || []).map(sanitizeAddress).filter(Boolean);
  const hello = hostname || os.hostname() || 'localhost';
  let stage = 'greeting';
  try {
    await conn.command('', [220]);
    stage = 'ehlo';
    await conn.command(`EHLO ${hello}`, [250]);
    if (!secure) {
      stage = 'starttls';
      await conn.command('STARTTLS', [220]);
      await conn.upgradeTls(cfg.host);
      await conn.command(`EHLO ${hello}`, [250]);
    }

    stage = 'auth';
    const user = sanitizeAddress(cfg.username) || String(cfg.username || '');
    const pass = String(cfg.password || '');
    if (cfg.auth === 'oauth2') {
      const token = String(accessToken || '');
      if (!token) throw Object.assign(new Error('OAuth2 模式缺少 access_token'), { smtpCode: 535 });
      const payload = b64(`user=${user}\x01auth=Bearer ${token}\x01\x01`);
      try {
        await conn.command(`AUTH XOAUTH2 ${payload}`, [235]);
      } catch (error) {
        // 失败时服务器会回 334 + base64 错误详情，必须先回一个空行结束
        if (error?.smtpCode === 334) await conn.command('', [535]);
        throw error;
      }
    } else {
      try {
        await conn.command('AUTH LOGIN', [334]);
        await conn.command(b64(user), [334]);
        await conn.command(b64(pass), [235]);
      } catch (error) {
        if (error?.smtpCode === 504 || error?.smtpCode === 502) {
          await conn.command(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`, [235]);
        } else {
          throw error;
        }
      }
    }

    stage = 'mail-from';
    await conn.command(`MAIL FROM:<${envelopeFrom}>`, [250]);
    stage = 'rcpt-to';
    for (const recipient of envelopeTo) {
      await conn.command(`RCPT TO:<${recipient}>`, [250, 251]);
    }
    stage = 'data';
    await conn.command('DATA', [354]);
    const message = buildMessage({
      from: envelopeFrom, to: envelopeTo, subject, text, html,
    });
    await conn.command(`${dotStuff(message)}\r\n.`, [250]);
    stage = 'quit';
    try {
      await conn.command('QUIT', [221]);
    } catch {
      // QUIT 失败无所谓，信已经收了
    }
    conn.close();
    return { ok: true, message: `已发送给 ${envelopeTo.join(', ')}` };
  } catch (error) {
    try { conn.close(); } catch { /* 忽略 */ }
    return {
      ok: false,
      message: describeSmtpError(error, { envelopeFrom, envelopeTo, stage }),
    };
  }
}

/** 把 SMTP 错误翻成能直接照着改的说明（含实际使用的信封地址与失败步骤）。 */
function describeSmtpError(error, { envelopeFrom, envelopeTo, stage }) {
  const code = error?.smtpCode;
  const detail = error?.smtpDetail || '';
  const envelope = `信封 MAIL FROM:<${envelopeFrom}> → RCPT TO:<${(envelopeTo || []).join('>, <')}>`;
  const where = stage ? `，失败步骤 ${stage}` : '';
  if (code === 535 || /5\.7\.139/.test(detail)) {
    return `SMTP 认证失败（${code}）：多数服务商要求用「授权码/应用专用密码」而不是登录密码；`
      + 'Outlook 个人版已关闭 SMTP Basic Auth，请改用 OAuth2 授权';
  }
  if (code === 501) {
    return `SMTP 拒绝地址（501 5.1.7）：${detail || '地址格式无效'}。${envelope}${where}`
      + '——请检查邮箱账号/收件人是否为纯 ASCII 地址（不要带姓名、中文或全角字符）';
  }
  if (code) return `SMTP 错误：${code}：${detail}（${envelope}${where}）`;
  const reason = error?.message || String(error);
  return `发信失败：${reason}（${envelope}${where}）`;
}

/**
 * 发一封邮件。**绝不抛异常**。
 *
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function sendMail(cfg = {}, {
  subject = '', text = '', html = '', accessToken = '',
} = {}) {
  const check = mailReady(cfg);
  if (!check.ready) return { ok: false, message: check.reason };
  // OAuth2 没拿到 token 就别去连服务器了（否则错误会变成莫名其妙的认证失败）
  if (cfg.auth === 'oauth2' && !accessToken) {
    return { ok: false, message: 'OAuth2 模式缺少 access_token：请先在「设置」里完成授权' };
  }

  const host = String(cfg.host);
  const port = Number(cfg.port) || 465;
  const secure = cfg.secure !== false;
  const hostname = os.hostname() || 'localhost';
  let socket;
  try {
    socket = await new Promise((resolve, reject) => {
      const connect = secure ? tls.connect : net.connect;
      const s = connect({ host, port }, () => resolve(s));
      s.setTimeout(SMTP_TIMEOUT_MS, () => {
        s.destroy(new Error(`连接 ${host}:${port} 超时`));
      });
      s.once('error', reject);
    });
  } catch (error) {
    const reason = error?.message || String(error);
    if (/ENOTFOUND|EAI_AGAIN/.test(reason)) {
      return { ok: false, message: `找不到 SMTP 服务器 ${host}（检查地址拼写或网络/DNS）` };
    }
    if (/ECONNREFUSED|ETIMEDOUT|超时/.test(reason)) {
      return { ok: false, message: `连接 ${host}:${port} 失败：${reason}` };
    }
    return { ok: false, message: `连接 ${host}:${port} 失败：${reason}` };
  }

  const conn = new SmtpConnection(socket);
  return runSession(conn, {
    cfg, subject, text, html, accessToken, hostname, secure,
  });
}
