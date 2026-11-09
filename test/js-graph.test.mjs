/**
 * Graph 发信通道（Outlook OAuth2 优先走 443 HTTPS）。
 *
 * 背景：部分网络在 SMTP 220 问候后直接断连（连 NOOP 都不回），SMTP 不可用；
 * Graph 只要能上网就能发。这里测的是 Graph 请求本身与 deliver 的分流逻辑。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { sendViaGraph, GRAPH_SEND_URL } from '../lib/js/graph.js';
import { deliver } from '../lib/js/alerts.js';

function cfg(over = {}) {
  return {
    enabled: true,
    auth: 'oauth2',
    provider: 'outlook',
    host: 'smtp-mail.outlook.com',
    port: 587,
    secure: false,
    username: 'appamail@hotmail.com',
    sender: 'appamail@hotmail.com',
    recipients: ['appamail@hotmail.com'],
    min_level: 'urgent',
    ...over,
  };
}

function fakeFetch(status, body = '') {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
      };
    },
  };
}

test('Graph：202 视为成功，请求体包含收件人/主题/正文', async () => {
  const { calls, fetchImpl } = fakeFetch(202);
  const result = await sendViaGraph(cfg(), {
    subject: '[A股助手] 测试邮件',
    text: '纯文本',
    html: '<p>HTML</p>',
    accessToken: 'token-1',
  }, { fetchImpl });
  assert.equal(result.ok, true);
  assert.match(result.message, /Microsoft Graph/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, GRAPH_SEND_URL);
  assert.equal(calls[0].init.headers.authorization, 'Bearer token-1');
  const payload = JSON.parse(calls[0].init.body);
  assert.equal(payload.message.subject, '[A股助手] 测试邮件');
  assert.equal(payload.message.body.contentType, 'HTML');
  assert.equal(payload.message.body.content, '<p>HTML</p>');
  assert.deepEqual(payload.message.toRecipients, [{
    emailAddress: { address: 'appamail@hotmail.com' },
  }]);
  assert.equal(payload.saveToSentItems, true);
});

test('Graph：401 提示重新授权（旧 SMTP scope 不适用），403 提示管理员同意', async () => {
  const unauthorized = await sendViaGraph(cfg(), { subject: 's', text: 't', accessToken: 'x' }, {
    fetchImpl: fakeFetch(401, '{"error":"InvalidAuthenticationToken"}').fetchImpl,
  });
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.code, 401);
  assert.match(unauthorized.message, /重新授权/);

  const forbidden = await sendViaGraph(cfg(), { subject: 's', text: 't', accessToken: 'x' }, {
    fetchImpl: fakeFetch(403, '{"error":"ErrorAccessDenied"}').fetchImpl,
  });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.code, 403);
  assert.match(forbidden.message, /管理员同意/);
});

test('deliver：Outlook 优先 Graph；Graph 失败再兜底 SMTP 并把两边原因都带出来', async () => {
  const calls = [];
  const graph = async () => ({ ok: false, code: 401, message: 'Graph 认证失败，请重新授权' });
  const smtp = async () => ({ ok: false, message: 'SMTP 连接被服务器关闭（失败步骤 ehlo）' });
  const result = await deliver(cfg(), { subject: 's', text: 't' }, {
    graph,
    send: smtp,
    token: { ok: true, token: 'tok' },
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /重新授权/);
  assert.match(result.message, /SMTP 兜底也失败/);
  assert.equal(calls.length, 0);
});

test('deliver：Graph 成功就不再碰 SMTP', async () => {
  let smtpCalled = false;
  const result = await deliver(cfg(), { subject: 's', text: 't' }, {
    graph: async () => ({ ok: true, message: '已通过 Microsoft Graph 发送' }),
    send: async () => { smtpCalled = true; return { ok: true, message: 'smtp' }; },
    token: { ok: true, token: 'tok' },
  });
  assert.equal(result.ok, true);
  assert.equal(smtpCalled, false);
});
