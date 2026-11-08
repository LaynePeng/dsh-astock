#!/usr/bin/env node
/**
 * 插件自检：19 个工具在不在、台账落在哪、邮件配置齐不齐。
 *
 * **不需要 Python、不需要 DSH 宿主**即可运行：
 *   node scripts/selftest.mjs
 */

import { selftest, toolNames } from '../lib/plugin.js';

const info = await selftest({});
const names = toolNames();

console.log(JSON.stringify({
  ...info,
  toolCount: names.length,
  tools: names,
}, null, 2));
