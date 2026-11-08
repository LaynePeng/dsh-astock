/**
 * SMTP 发信的**集成测试**：起一个本地假 SMTP 服务器，用真实的 `runSession`
 * 走完 EHLO → AUTH → MAIL FROM → RCPT TO → DATA → QUIT。
 *
 * 为什么必须有这层：`501 5.1.7 Invalid address` 是服务器对**信封地址**的判定，
 * 单元测试测不出来。这里让假服务器像真服务器一样严格校验地址（非 ASCII、
 * 带尖括号的显示名都回 501），从而复现并锁死这类故障。
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';

import * as smtp from '../lib/js/smtp.js';
import * as alerts from '../lib/js/alerts.js';

/** 本地假 SMTP 服务器：严格校验信封地址，记录收到的命令。 */
function startFakeSmtp({ authMode = 'login' } = {}) {
  const state = { commands: [], data: [], rejected: [] };
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let authStep = 0;
    socket.write('220 fake.local ESMTP\r\n');
    const reply = (line) => socket.write(`${line}\r\n`);
    const addressOf = (line) => {
      const m = line.match(/<([^>]*)>/);
      return m ? m[1] : '';
    };
    const validAddress = (addr) => /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(addr);

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\r\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            reply('250 2.0.0 queued');
          } else {
            state.data.push(line);
          }
        } else if (authStep === 1) {
          authStep = 2;
          reply('334 UGFzc3dvcmQ6');
        } else if (authStep === 2) {
          authStep = 3;
          reply('235 2.7.0 accepted');
        } else if (line.startsWith('EHLO')) {
          reply('250-fake.local');
          reply('250 AUTH LOGIN PLAIN');
        } else if (line === 'AUTH LOGIN') {
          authStep = 1;
          reply('334 VXNlcm5hbWU6');
        } else if (line === 'AUTH XOAUTH2' || line.startsWith('AUTH XOAUTH2 ')) {
          reply('235 2.7.0 accepted');
        } else if (line.startsWith('MAIL FROM')) {
          const addr = addressOf(line);
          state.commands.push(`MAIL FROM:<${addr}>`);
          if (!validAddress(addr)) {
            state.rejected.push(`MAIL FROM:<${addr}>`);
            reply('501 5.1.7 Invalid address');
          } else {
            reply('250 2.1.0 ok');
          }
        } else if (line.startsWith('RCPT TO')) {
          const addr = addressOf(line);
          state.commands.push(`RCPT TO:<${addr}>`);
          if (!validAddress(addr)) {
            state.rejected.push(`RCPT TO:<${addr}>`);
            reply('501 5.1.7 Invalid address');
          } else {
            reply('250 2.1.5 ok');
          }
        } else if (line === 'DATA') {
          inData = true;
          reply('354 go ahead');
        } else if (line === 'QUIT') {
          reply('221 bye');
        }
        index = buffer.indexOf('\r\n');
      }
    });
  });
  return { server, state, authMode };
}

async function withFakeSmtp(fn) {
  const { server, state } = startFakeSmtp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn({ port, state });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => resolve(socket));
    socket.once('error', reject);
  });
}

test('SMTP：发件人带中文显示名也能发出去（信封自动取裸地址）', async () => {
  await withFakeSmtp(async ({ port, state }) => {
    const conn = new smtp.SmtpConnection(await connect(port), { timeoutMs: 3000 });
    const result = await smtp.runSession(conn, {
      secure: true,
      cfg: {
        enabled: true,
        auth: 'basic',
        host: 'fake.local',
        username: 'me@qq.com',
        password: 'secret',
        sender: '张三 <me@qq.com>',
        recipients: ['李四 <you@qq.com>'],
      },
      subject: '测试',
      text: '正文',
    });
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(state.rejected, []);
    assert.ok(state.commands.includes('MAIL FROM:<me@qq.com>'));
    assert.ok(state.commands.includes('RCPT TO:<you@qq.com>'));
    // 邮件头里同样不应出现嵌套尖括号
    const from = state.data.find((line) => line.startsWith('From:'));
    assert.match(from, /<me@qq\.com>$/);
  });
});

test('SMTP：地址里混进全角字符时也能洗干净（不再 501）', async () => {
  await withFakeSmtp(async ({ port, state }) => {
    const conn = new smtp.SmtpConnection(await connect(port), { timeoutMs: 3000 });
    const result = await smtp.runSession(conn, {
      secure: true,
      cfg: {
        enabled: true,
        auth: 'basic',
        host: 'fake.local',
        username: 'me@qq.com',
        password: 'secret',
        sender: 'me＠qq.com',
        recipients: ['you@qq.com\u200b'],
      },
      subject: 'x',
      text: 'y',
    });
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(state.rejected, []);
  });
});

test('SMTP：确实无效的地址在发信前就被拦下（不连服务器）', async () => {
  const result = await smtp.sendMail({
    enabled: true,
    auth: 'basic',
    host: '127.0.0.1',
    port: 1,
    username: 'me@qq.com',
    password: 'secret',
    sender: 'me@qq',
    recipients: ['you@qq.com'],
  }, { subject: 'x', text: 'y' });
  assert.equal(result.ok, false);
  assert.match(result.message, /发件人不是有效邮箱地址/);
});

test('SMTP：服务器回 501 时错误里带实际信封与失败步骤', async () => {
  await withFakeSmtp(async ({ port }) => {
    const conn = new smtp.SmtpConnection(await connect(port), { timeoutMs: 3000 });
    // 绕过 sanitize 直接构造非法信封：模拟「清洗后仍然非法」的极端情况
    const result = await smtp.runSession(conn, {
      secure: true,
      cfg: {
        enabled: true,
        auth: 'basic',
        host: 'fake.local',
        username: 'me@qq.com',
        password: 'secret',
        sender: 'bad@@qq.com',
        recipients: ['you@qq.com'],
      },
      subject: 'x',
      text: 'y',
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /501/);
    assert.match(result.message, /MAIL FROM/);
  });
});

test('SMTP：XOAUTH2 模式不带密码也能过认证（Outlook 路径）', async () => {
  await withFakeSmtp(async ({ port, state }) => {
    const conn = new smtp.SmtpConnection(await connect(port), { timeoutMs: 3000 });
    const result = await smtp.runSession(conn, {
      secure: true,
      cfg: {
        enabled: true,
        auth: 'oauth2',
        host: 'fake.local',
        username: 'me@outlook.com',
        password: '',
        sender: 'me@outlook.com',
        recipients: ['you@qq.com'],
      },
      subject: 'x',
      text: 'y',
      accessToken: 'token-abc',
    });
    assert.equal(result.ok, true, result.message);
    assert.ok(state.commands.includes('MAIL FROM:<me@outlook.com>'));
  });
});

test('地址清洗：各种脏输入都能得到合法信封地址', () => {
  assert.equal(smtp.sanitizeAddress('张三 <a@b.com>'), 'a@b.com');
  assert.equal(smtp.sanitizeAddress('"a@b.com"'), 'a@b.com');
  assert.equal(smtp.sanitizeAddress(' a@b.com '), 'a@b.com');
  assert.equal(smtp.sanitizeAddress('a＠b.com'), 'a@b.com'); // 全角 @ 折成 ASCII
  assert.equal(smtp.sanitizeAddress('a@b.com\u200b'), 'a@b.com');
  assert.equal(smtp.looksLikeEmail('a@b.com'), true);
  assert.equal(smtp.looksLikeEmail('a@b'), false);
  assert.equal(smtp.looksLikeEmail('张三 <a@b.com>'), true);
});

test('SMTP：用户实际配置（Outlook OAuth2 + 发件人带姓名）信封是干净的', async () => {
  // 复现 501 5.1.7 的真实配置：mail_from = "Layne Peng<appamail@hotmail.com>"
  const cfg = alerts.mailConfig({
    mail_enabled: true,
    mail_auth: 'oauth2',
    mail_username: 'appamail@hotmail.com',
    mail_from: 'Layne Peng<appamail@hotmail.com>',
    mail_to: '',
  });
  assert.equal(cfg.sender, 'appamail@hotmail.com');
  assert.deepEqual(cfg.recipients, ['appamail@hotmail.com']);

  await withFakeSmtp(async ({ port, state }) => {
    const conn = new smtp.SmtpConnection(await connect(port), { timeoutMs: 3000 });
    const result = await smtp.runSession(conn, {
      secure: true,
      cfg: { ...cfg, host: 'fake.local' },
      subject: 's',
      text: 't',
      accessToken: 'tok',
    });
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(state.rejected, []);
    assert.ok(state.commands.includes('MAIL FROM:<appamail@hotmail.com>'));
    assert.ok(state.commands.includes('RCPT TO:<appamail@hotmail.com>'));
  });
});