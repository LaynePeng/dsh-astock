/**
 * Cordis 装配入口（**稳定壳**）。
 *
 * 为什么实现不写在这里：Cordis 重新启用插件时，宿主进程里 Node 的 ESM 缓存
 * 会按文件 URL 命中**旧模块对象**——改了源码、点了启停，跑的还是上一版。
 * 实测表现：修掉一个激活错误后反复启停，报错原文一字不变。
 *
 * 所以这里只留三件事（`name` / `inject` / `apply`），真正的实现在
 * `plugin.js`，并带上**唯一查询串**动态 import：每次启用都重新解析一次模块，
 * 改完 `plugin.js` 或重新导出 `tools.json` 后启停即可生效，不必重启 DSH。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Config } from './config-schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 设置页表单的 schema（DSH 设置 → 插件 → A股助手）。
 *
 * 必须从**入口模块**导出：宿主读的是 package.json `main` 指向的文件，
 * 也就是这个壳。实现在 `lib/config-schema.js`。
 */
export { Config };

/** Cordis 插件名（与 package.json 的 name 一致）。 */
export const name = 'dsh-astock';

/** 依赖的工具注册表与系统提示服务。 */
export const inject = ['tools', 'systemPrompt'];

/** 用 package.json 版本 + 时间戳做缓存键：改版本或重新启用都会重新加载。 */
function cacheKey() {
  let version = '0';
  try {
    version = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version || '0';
  } catch {
    /* 读不到版本就用时间戳兜底 */
  }
  return `v=${version}-${Date.now()}`;
}

/**
 * 装进 DSH（转交给 plugin.js）。
 *
 * 键会经由 `globalThis` 传给实现：实现里的**静态依赖**（config.js / schedule.js /
 * lib/js/*）也得跟着一起重新加载，否则改完子模块还是要重启进程才生效——Node 按
 * URL 缓存模块，`plugin.js?k` 换了，它 import 的 `./config.js` 没换。
 *
 * @param {object} ctx Cordis 上下文
 * @param {object} [config] 插件配置
 */
export async function apply(ctx, config = {}) {
  const key = cacheKey();
  globalThis.__DSH_ASTOCK_BOOT_KEY__ = key;
  const impl = await import(new URL(`./plugin.js?${key}`, import.meta.url).href);
  return impl.apply(ctx, config);
}
