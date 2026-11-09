/**
 * 路径推导（lib/config.js 的 `applyDefaultPaths`）。
 *
 * 这一层曾经有两个「跑测试时才暴露、真实用户会丢数据」的坑，所以单独测：
 *   · 台账改成自定义路径后，**不该**把 lite-work 的旧台账灌进那个库；
 *   · 存档应当跟着台账走（文档与设置页都是这么写的），而不是写死在
 *     `$DSH_HOME/astock-data`。
 *
 * 全部用临时 DSH_HOME + 临时台账路径，不碰真实 `~/.dsh` 与 `~/.lite-work`。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { applyDefaultPaths, dshDataDir } from '../lib/config.js';

/** 每个用例一套独立的 DSH_HOME，跑完恢复原值。 */
function withHome() {
  const previous = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'dsh-astock-cfg-'));
  process.env.DSH_HOME = home;
  return {
    home,
    dataDir: join(home, 'astock-data'),
    restore() {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
    },
  };
}

test('默认路径：台账与存档都在 $DSH_HOME/astock-data 下', () => {
  const scope = withHome();
  try {
    assert.equal(dshDataDir(), scope.dataDir);
    const config = applyDefaultPaths({});
    assert.equal(config.ledger_path, join(scope.dataDir, 'ledger.sqlite'));
    assert.equal(config.archive_path, join(scope.dataDir, 'archive.sqlite'));
  } finally {
    scope.restore();
  }
});

test('自定义台账：存档跟着台账目录，不再留在默认目录', () => {
  const scope = withHome();
  try {
    const ledger = join(mkdtempSync(join(tmpdir(), 'dsh-astock-ledger-')), 'ledger.sqlite');
    const config = applyDefaultPaths({ ledger_path: ledger });
    assert.equal(config.ledger_path, ledger);
    assert.equal(config.archive_path, join(dirname(ledger), 'archive.sqlite'));
  } finally {
    scope.restore();
  }
});

/** 造一份 lite-work 旧数据，并把迁移源指到它（不碰真实的 ~/.lite-work）。 */
function withLegacyData() {
  const previous = process.env.DSH_ASTOCK_LEGACY_DIR;
  const legacy = mkdtempSync(join(tmpdir(), 'dsh-astock-legacy-'));
  writeFileSync(join(legacy, 'ledger.sqlite'), 'legacy-ledger-bytes');
  writeFileSync(join(legacy, 'archive.sqlite'), 'legacy-archive-bytes');
  process.env.DSH_ASTOCK_LEGACY_DIR = legacy;
  return {
    legacy,
    restore() {
      if (previous === undefined) delete process.env.DSH_ASTOCK_LEGACY_DIR;
      else process.env.DSH_ASTOCK_LEGACY_DIR = previous;
    },
  };
}

test('默认台账：把 lite-work 的旧数据一次性搬过来', () => {
  const scope = withHome();
  const legacy = withLegacyData();
  try {
    const config = applyDefaultPaths({});
    assert.equal(readFileSync(config.ledger_path, 'utf8'), 'legacy-ledger-bytes');
    assert.equal(readFileSync(config.archive_path, 'utf8'), 'legacy-archive-bytes');
  } finally {
    legacy.restore();
    scope.restore();
  }
});

test('自定义台账：不会把 lite-work 的旧台账复制进来', () => {
  const scope = withHome();
  const legacy = withLegacyData();
  try {
    const ledger = join(mkdtempSync(join(tmpdir(), 'dsh-astock-ledger-')), 'custom.sqlite');
    const config = applyDefaultPaths({ ledger_path: ledger });
    assert.equal(config.ledger_path, ledger);
    // 目标库可能是用户自己建的/别处拷来的，绝不能因为「不存在」就灌旧数据
    assert.equal(existsSync(ledger), false);
  } finally {
    legacy.restore();
    scope.restore();
  }
});

test('存档搬家：旧固定位置有存档、新位置没有时复制一次（不删除旧的）', () => {
  const scope = withHome();
  try {
    const legacyArchive = join(scope.dataDir, 'archive.sqlite');
    mkdirSync(scope.dataDir, { recursive: true });
    writeFileSync(legacyArchive, 'legacy-archive-bytes');

    const ledger = join(mkdtempSync(join(tmpdir(), 'dsh-astock-ledger-')), 'ledger.sqlite');
    const config = applyDefaultPaths({ ledger_path: ledger });
    const moved = join(dirname(ledger), 'archive.sqlite');
    assert.equal(config.archive_path, moved);
    assert.ok(existsSync(moved), '新位置应当拿到一份副本');
    assert.ok(existsSync(legacyArchive), '旧位置的存档不能被删除');

    // 第二次调用不该再覆盖（新位置已存在，用户可能已经在里面追加了数据）
    writeFileSync(moved, 'newer-bytes');
    applyDefaultPaths({ ledger_path: ledger });
    assert.equal(readFileSync(moved, 'utf8'), 'newer-bytes');
  } finally {
    scope.restore();
  }
});

test('存档搬家：默认台账位置不搬（旧新是同一个目录）', () => {
  const scope = withHome();
  try {
    mkdirSync(scope.dataDir, { recursive: true });
    writeFileSync(join(scope.dataDir, 'archive.sqlite'), 'x');
    const config = applyDefaultPaths({});
    assert.equal(config.archive_path, join(scope.dataDir, 'archive.sqlite'));
  } finally {
    scope.restore();
  }
});

test('空字符串/错误类型按未配置处理（不能让激活抛类型错误）', () => {
  const scope = withHome();
  try {
    const config = applyDefaultPaths({ ledger_path: '   ', archive_path: 42 });
    assert.equal(config.ledger_path, join(scope.dataDir, 'ledger.sqlite'));
    assert.equal(config.archive_path, join(scope.dataDir, 'archive.sqlite'));
  } finally {
    scope.restore();
  }
});
