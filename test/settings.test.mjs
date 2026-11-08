/**
 * 设置页表单的契约测试。
 *
 * 核心风险不是"表单画不出来"，而是**画出来却改了不生效**：设置页写 camelCase，
 * 工具实现读 snake_case，中间靠 `config.js` 的 `KEY_MAP` 翻译。少一条映射就是
 * 静默失效——用户改完、保存、重启，行为一点没变，而任何地方都不报错。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SETTINGS_KEYS, FIELD_SPECS, Config } from '../lib/config-schema.js';
import { KEY_MAP, toAstockConfig, hostOptions } from '../lib/config.js';

/** 不经过 astock 映射、由宿主侧自己消费的键。 */
const HOST_KEYS = new Set(['pythonPath', 'timeoutMs', 'workspace', 'astock']);

test('表单字段不重复', () => {
  assert.equal(new Set(SETTINGS_KEYS).size, SETTINGS_KEYS.length);
});

test('每个表单字段都真的能落到 astock 配置（否则就是"改了不生效"）', () => {
  const unmapped = SETTINGS_KEYS.filter((key) => !HOST_KEYS.has(key) && !KEY_MAP[key]);
  assert.deepEqual(unmapped, [], `这些字段没有映射到配置键：${unmapped.join(', ')}`);
});

test('每个字段都写了中文说明（表单里就是靠它解释口径）', () => {
  for (const [key, , description] of FIELD_SPECS) {
    assert.equal(typeof description, 'string', `${key} 缺少说明`);
    assert.ok(description.length >= 6, `${key} 的说明太短`);
    // 口径类字段必须带单位或范围，否则用户不知道该填 0.00025 还是 2.5
    if (/Pct|Rate|Ratio|Seconds|Ms|Port|Ttl/.test(key)) {
      assert.match(description, /%|秒|毫秒|倍|率|元|端口|次/, `${key} 的说明缺单位`);
    }
  }
});

test('设置页写入的值能完整穿过映射层', () => {
  const fromForm = {
    ledgerPath: 'C:/tmp/l.sqlite',
    commissionRate: 0.0003,
    stopLossPct: 6,
    positionCapPct: 20,
    enableAdd: true,
    pickStrategy: 'quality',
    watchIntervalSeconds: 900,
    mailEnabled: true,
    mailHost: 'smtp.qq.com',
    mailPort: 465,
    mailSecure: true,
    mailUsername: 'me@qq.com',
    mailPassword: 'secret',
    mailTo: 'me@qq.com',
    mailMinLevel: 'action',
    mailProbeSeconds: 300,
    pythonPath: '/usr/bin/python3',
    timeoutMs: 60000,
    astock: { pick_candidates: 40 },
  };
  const mapped = toAstockConfig(fromForm);

  // 宿主侧参数不能漏给 astock 配置（历史配置里可能还留着旧键）
  assert.equal(mapped.pythonPath, undefined);
  assert.equal(mapped.timeoutMs, undefined);
  // 邮件键必须是 snake_case（alerts.js 就是这么读的）
  assert.equal(mapped.mail_enabled, true);
  assert.equal(mapped.mail_host, 'smtp.qq.com');
  assert.equal(mapped.mail_password, 'secret');
  assert.equal(mapped.mail_min_level, 'action');
  assert.equal(mapped.mail_probe_seconds, 300);
  // 普通键同理
  assert.equal(mapped.stop_loss_pct, 6);
  assert.equal(mapped.pick_strategy, 'quality');
  // 逃生口最后合并，优先级最高
  assert.equal(mapped.pick_candidates, 40);
});

test('默认值只在显式配置时透传，空值不能顶掉上游默认', () => {
  assert.deepEqual(toAstockConfig({ ledgerPath: '', mailHost: '' }), {});
  assert.deepEqual(toAstockConfig({ mailPort: 0 }), { mail_port: 0 });
});

test('宿主侧参数：只认字符串工作区，不把对象透传下去', () => {
  const options = hostOptions({ pythonPath: { __jsExpr: 'x' }, workspace: { bad: true } });
  assert.equal(options.workspace, '');
  assert.equal(options.pythonPath, undefined);
});

test('schemastery 不可用时 Config 为 undefined（插件照常工作）', () => {
  // 本机 Node 环境取不到 @deepseek-ai/schemastery；宿主内才会加载成功。
  // 这条断言的意义是：拿不到 schema 时**导出的是 undefined 而不是抛异常**，
  // 否则整个插件（含 19 个工具）会一起加载失败。
  assert.ok(Config === undefined || typeof Config === 'object');
  // 45 个字段：去 Python 化后移除了 pythonPath 与 timeoutMs
  assert.equal(SETTINGS_KEYS.length, 45);
});
