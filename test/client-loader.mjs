/**
 * 客户端 bundle（lib/client.js）的离线契约测试。
 *
 * DSH 的客户端插件是「浏览器模块」：文件被求值时调用
 * `window.__ModuleLoader__.load({id, factory})`，factory 拿到的 `require` 由宿主
 * 提供。这里在 Node 里搭一个最小等价环境，验证：
 *   · 文件能被求值（语法/求值期错误会在这里暴露）
 *   · 导出了 apply / inject
 *   · apply 正确注册了「右栏 tab 类型」与「tab body」两段，且 key 对得上
 *
 * **不测渲染**：React 组件的视觉正确性只能在真实浏览器里看，用假渲染器测出来的
 * 「元素树对了」并不能证明它画得对，反而给人虚假的安全感。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** client 模块 id 必须与 npm 包名完全一致（DSH 用它去 factories 里查）。 */
const PACKAGE_NAME = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name;

/** 最小的 React 替身：组件在本测试里不会被真正渲染。 */
class ComponentStub {
  constructor(props) {
    this.props = props || {};
    this.state = {};
  }
}

const reactStub = {
  Component: ComponentStub,
  PureComponent: ComponentStub,
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
  createElement: (type, props, ...children) => ({ type, props, children }),
};

/**
 * jsx 替身要和 React 一样严格：
 *   · 缺 props（`jsx("br")`）在 React 里会直接抛 "Cannot read properties of undefined"，
 *     宽松的替身会把这种错误漏到真实浏览器里（0.8.4 的「交易页空白」就是这么来的）；
 *   · key 必须作为第三个参数传，不能塞进 props。
 */
function jsxLike(type, props, key) {
  assert.ok(props !== undefined, `jsx(${String(type)}) 缺少 props；React 会直接抛错`);
  assert.ok(!("key" in props), `jsx(${String(type)}) 的 key 要作为第三个参数传，不能放在 props 里`);
  return { type, props, key };
}

const jsxStub = {
  jsx: jsxLike,
  jsxs: jsxLike,
};

/**
 * 在受控的全局环境里求值客户端 bundle。
 * @returns {{ apply: Function, inject: string[], plugins: Map<string, object> }}
 */
export function loadClientBundle() {
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  const loaded = new Map();

  const moduleLoader = {
    load({ id, factory }) {
      assert.ok(id, 'bundle 必须声明 id');
      loaded.set(id, factory((name) => {
        if (name === 'react') return reactStub;
        if (name === 'react/jsx-runtime') return jsxStub;
        throw new Error(`未预期的 require(${name})——请把它加进 dsh.client.inject`);
      }));
    },
  };

  const previous = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
  };
  globalThis.window = { __ModuleLoader__: moduleLoader };
  // ensureCss 在无 document 时必须安静跳过（Node 侧就是这种情况）
  delete globalThis.document;

  try {
    // eslint-disable-next-line no-new-func
    new Function(source)();
  } finally {
    if (previous.window) Object.defineProperty(globalThis, 'window', previous.window);
    else delete globalThis.window;
    if (previous.document) Object.defineProperty(globalThis, 'document', previous.document);
  }

  // DSH 的 client-modules 用 package.json 的 name 作为模块 id：
  //   宿主执行 bundle → 到 factories 里找 package name → 找不到就回退到单包 URL
  //   再执行一次 → 第二次注册抛 "duplicate factory registration" → entry 激活失败。
  // 所以这里必须校验 id === 包名，而不是只校验“有个 id”。
  const ids = [...loaded.keys()];
  assert.deepEqual(ids, [PACKAGE_NAME], `bundle 必须以 id=${PACKAGE_NAME}（package.json name）注册，实际注册了 ${ids.join(', ')}`);
  const exports = loaded.get(PACKAGE_NAME);
  assert.ok(exports, 'bundle 必须导出 apply / inject');
  return exports;
}
