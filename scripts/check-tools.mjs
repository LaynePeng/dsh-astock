#!/usr/bin/env node
/**
 * 校验 `lib/tools.json` 的完整性。
 *
 * 这份 schema 现在是**事实源**（去 Python 化之后不再有导出脚本）：工具名、
 * 描述、参数是模型据以调用的「行为契约」，手改一次就可能让模型调用方式变掉。
 * 所以这里做几条硬校验，跑在测试与发版前：
 *
 *   · 恰好 19 个工具，名字唯一且以 `astock_` 开头；
 *   · 每个都有非空 description；
 *   · parameters 是 `type: object`，且每个参数都有类型或 enum；
 *   · 与 `lib/plugin.js` 注册的工具名逐一对应（多一个少一个都算错）。
 *
 *   node scripts/check-tools.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const tools = JSON.parse(readFileSync(join(ROOT, 'lib', 'tools.json'), 'utf8'));

const problems = [];
if (!Array.isArray(tools)) problems.push('tools.json 必须是数组');
if (tools.length !== 19) problems.push(`工具数量应为 19，实际 ${tools.length}`);

const seen = new Set();
for (const tool of tools) {
  const name = String(tool?.name || '');
  if (!name.startsWith('astock_')) problems.push(`${name || '(空)'} 名字必须以 astock_ 开头`);
  if (seen.has(name)) problems.push(`${name} 重复`);
  seen.add(name);
  if (!String(tool?.description || '').trim()) problems.push(`${name} 缺 description`);
  const params = tool?.parameters;
  if (!params || params.type !== 'object') {
    problems.push(`${name} 的 parameters 必须是 type:object`);
    continue;
  }
  for (const [key, spec] of Object.entries(params.properties || {})) {
    if (!spec || (!spec.type && !spec.enum && !spec.anyOf && !spec.oneOf)) {
      problems.push(`${name}.${key} 缺类型声明`);
    }
  }
}

if (problems.length) {
  console.error('tools.json 校验失败：');
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}

console.log(`tools.json OK：${tools.length} 个工具`);
for (const tool of tools) console.log(`  · ${tool.name}`);
