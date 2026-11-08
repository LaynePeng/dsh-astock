/**
 * 盯盘通知的渲染与去重/限流（JS 版）。
 *
 * 与上游 `astock_notify.py` 的关系：**只搬渲染与限流规则**，不搬它的发信路径。
 * 上游依赖 lite-work 的 email-plugin（OAuth2 与凭据共享），DSH 没有那个插件，
 * 所以最后一跳换成本插件自带的 SMTP 客户端（见 `lib/js/smtp.js`）。
 *
 * 刻意保留的数字（改这里就等于改产品行为，别顺手调）：
 *   · 同一 (code, kind) 信号 6 小时内不重复发；
 *   · 每小时最多 12 封。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 每小时的邮件上限（防抖：接口抖动不该变成邮件轰炸）。 */
export const MAX_MAILS_PER_HOUR = 12;

/** 同一 (code, kind) 信号在多少秒内不重复发。 */
export const DEDUP_SECONDS = 6 * 3600;

const LEVEL_RANK = { info: 0, action: 1, urgent: 2 };
const LEVEL_LABEL = { urgent: '🔴 紧急', action: '🟠 需关注', info: '⚪ 提示' };

export function levelRank(severity) {
  return LEVEL_RANK[String(severity || '')] ?? 0;
}

/** 信号列表 → {subject, text}。 */
export function renderMail(entries = [], asOf = '') {
  const list = Array.isArray(entries) ? entries : [];
  const urgent = list.filter((e) => e.severity === 'urgent');
  const head = urgent.length ? '🔴 紧急' : '🟠 需关注';
  const names = list.slice(0, 3)
    .map((e) => e.name || e.code || '?')
    .join('、');
  const subject = `[A股助手]${head} ${names}${list.length > 3 ? '…' : ''}`;

  const lines = [`盯盘发现 ${list.length} 条信号（${asOf}）`, ''];
  for (const e of list.slice(0, 20)) {
    lines.push(`${LEVEL_LABEL[e.severity] || ''} ${e.name || ''}(${e.code})`);
    lines.push(`  ${e.title || ''}`);
    if (e.detail) lines.push(`  ${e.detail}`);
    if (e.suggestion) lines.push(`  → ${e.suggestion}`);
    lines.push('');
  }
  lines.push('—— 以上为按既定规则算出的提醒，仅供参考，不构成投资建议。');
  lines.push('若你已挂条件单，券商会自动执行；本邮件只提醒【计划外】的变化。');
  return { subject, text: lines.join('\n') };
}

function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** HTML 版正文（手机上分色块更易读）。 */
export function renderMailHtml(entries = [], asOf = '') {
  const list = Array.isArray(entries) ? entries : [];
  const color = { urgent: '#d93025', action: '#e37400', info: '#5f6368' };
  const rows = list.slice(0, 20).map((e) => {
    const c = color[e.severity] || '#5f6368';
    let block = `<div style="margin:0 0 14px;padding:10px 12px;border-left:4px solid ${c};`
      + 'background:#fafafa;border-radius:4px">'
      + `<div style="font-weight:600;color:${c}">${LEVEL_LABEL[e.severity] || ''} `
      + `${esc(e.name)}(${esc(e.code)})</div>`
      + `<div style="margin:4px 0;color:#202124">${esc(e.title)}</div>`;
    if (e.detail) {
      block += `<div style="color:#5f6368;font-size:13px">${esc(e.detail)}</div>`;
    }
    if (e.suggestion) {
      block += `<div style="margin-top:6px;color:#1a73e8">→ ${esc(e.suggestion)}</div>`;
    }
    return `${block}</div>`;
  }).join('');

  return '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;'
    + 'max-width:640px;margin:0 auto;padding:16px">'
    + `<h3 style="margin:0 0 4px">盯盘发现 ${list.length} 条信号</h3>`
    + `<div style="color:#5f6368;font-size:13px;margin-bottom:16px">${esc(asOf)}</div>`
    + rows
    + '<hr style="border:none;border-top:1px solid #eee;margin:16px 0">'
    + '<div style="color:#80868b;font-size:12px;line-height:1.6">'
    + '以上为按既定规则算出的提醒，仅供参考，不构成投资建议。<br>'
    + '若你已挂条件单，券商会自动执行；本邮件只提醒【计划外】的变化。</div>'
    + '</div>';
}

/**
 * 去重 + 限流。
 *
 * 与 Python 版的差别：那边每个探针都是新进程，`_last_sent` 一退出就没了，
 * 等于**去重从来没生效过**。这里把状态落到 `mail-state.json`（与台账同目录），
 * 进程重启后仍然记得发过什么——否则同一条止损信号会被每 5 分钟发一次。
 */
export class Notifier {
  constructor(statePath = '') {
    this.statePath = String(statePath || '');
    this.lastSent = {};
    this.sentTimes = [];
    this.load();
  }

  load() {
    if (!this.statePath) return;
    try {
      if (!fs.existsSync(this.statePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      if (raw && typeof raw === 'object') {
        this.lastSent = raw.lastSent && typeof raw.lastSent === 'object' ? raw.lastSent : {};
        this.sentTimes = Array.isArray(raw.sentTimes)
          ? raw.sentTimes.map(Number).filter((n) => Number.isFinite(n))
          : [];
      }
    } catch {
      // 状态文件坏了就当作没有：宁可多发一封，也不能让探测因此挂掉
      this.lastSent = {};
      this.sentTimes = [];
    }
  }

  save() {
    if (!this.statePath) return;
    try {
      fs.mkdirSync(path.dirname(this.statePath) || '.', { recursive: true });
      const now = Date.now() / 1000;
      // 顺手清掉过期记录，文件不会无限长大
      const lastSent = {};
      for (const [key, at] of Object.entries(this.lastSent)) {
        if (now - Number(at) < DEDUP_SECONDS * 2) lastSent[key] = Number(at);
      }
      this.lastSent = lastSent;
      this.sentTimes = this.sentTimes.filter((t) => now - t < 3600 * 2);
      fs.writeFileSync(this.statePath, JSON.stringify({
        lastSent: this.lastSent,
        sentTimes: this.sentTimes,
        updatedAt: new Date().toISOString(),
      }), 'utf8');
    } catch {
      // 落盘失败不影响本轮判定
    }
  }

  shouldSend(code, kind, now = Date.now() / 1000) {
    const key = `${code}|${kind}`;
    const last = Number(this.lastSent[key]);
    if (Number.isFinite(last) && now - last < DEDUP_SECONDS) {
      const left = Math.trunc((DEDUP_SECONDS - (now - last)) / 60);
      return { sendable: false, reason: `同一信号 ${left} 分钟内已提醒过` };
    }
    this.sentTimes = this.sentTimes.filter((t) => now - t < 3600);
    if (this.sentTimes.length >= MAX_MAILS_PER_HOUR) {
      return { sendable: false, reason: `已达每小时上限 ${MAX_MAILS_PER_HOUR} 封` };
    }
    return { sendable: true, reason: '' };
  }

  markSent(code, kind, now = Date.now() / 1000) {
    this.lastSent[`${code}|${kind}`] = now;
    this.sentTimes.push(now);
    this.save();
  }
}
