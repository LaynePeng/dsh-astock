/**
 * HTTP 小工具：超时、GBK 解码、内存缓存。
 *
 * 腾讯行情是 GBK（`qt.gtimg.cn`），K 线是 UTF-8 JSON；Node 22 自带
 * `TextDecoder('gbk')`（full ICU），不需要 iconv 依赖。
 */

const cache = new Map();

/** 清空缓存（测试/手动刷新用）。 */
export function clearCache() {
  cache.clear();
}

function cacheGet(key, ttlMs) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > ttlMs) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  // 简单上限，避免长跑进程无限增长
  if (cache.size > 500) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

/**
 * 取文本。
 * @param {string} url
 * @param {{encoding?: string, timeoutMs?: number, headers?: object, cacheTtlMs?: number}} [options]
 */
export async function fetchText(url, {
  encoding = 'utf-8', timeoutMs = 10_000, headers = {}, cacheTtlMs = 0,
} = {}) {
  const key = `${encoding}|${url}`;
  if (cacheTtlMs > 0) {
    const hit = cacheGet(key, cacheTtlMs);
    if (hit !== undefined) return hit;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  let response;
  try {
    response = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-astock',
        ...headers,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}：${url}`);
  }
  const buffer = await response.arrayBuffer();
  const text = new TextDecoder(encoding).decode(buffer);
  if (cacheTtlMs > 0) cacheSet(key, text);
  return text;
}

/** 取 JSON（UTF-8）。 */
export async function fetchJson(url, options = {}) {
  const text = await fetchText(url, { ...options, encoding: 'utf-8' });
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`接口返回的不是 JSON：${text.slice(0, 160)}`);
  }
}
