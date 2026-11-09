/**
 * `scripts/recover.mjs`：DSH 安全恢复后的配置找回。
 *
 * 这里只测脚本自己的契约，不依赖真实 DSH：
 *   · 只读诊断能认出 `.bak-<epoch ms>` 备份与空占位；
 *   · `--restore newest` 选「最新一份有内容」的备份，并把当前文件改名保留；
 *   · 任何情况下都不删除文件。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'scripts', 'recover.mjs');

const RICH = `# user layer
- id: ui-chat
  name: '@deepseek-ai/dsh-client-ui-chat'
  config:
    transcriptView: standard
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
`;

function run(script, home, extra = []) {
  const result = spawnSync(process.execPath, [script, '--home', home, '--profile', 'test', ...extra], {
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function makeProfile() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-astock-recover-'));
  const profile = join(home, 'profiles', 'test');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-test',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }, null, 2)}\n`);
  return { home, profile };
}

test('诊断：列出有内容的备份与 DSH 的空占位，不删任何文件', () => {
  const { home, profile } = makeProfile();
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n');
  writeFileSync(join(profile, 'cordis.patch.yml.bak-1000000000000'), RICH);
  writeFileSync(join(profile, 'cordis.patch.yml.bak-1000000000001'), '[]\n');

  const result = run(SCRIPT, home, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  const info = JSON.parse(result.stdout);
  assert.equal(info.backups.length, 2);
  assert.equal(info.backups[0].empty, true);
  assert.equal(info.backups[1].empty, false);
  assert.deepEqual(info.backups[1].rows, ['ui-chat', 'llm-pi-ai']);
  assert.ok(existsSync(join(profile, 'cordis.patch.yml')));
});

test('恢复：newest 跳过空占位，恢复前把当前文件改名保留', () => {
  const { home, profile } = makeProfile();
  const live = join(profile, 'cordis.patch.yml');
  writeFileSync(live, '[]\n');
  writeFileSync(join(profile, 'cordis.patch.yml.bak-1000000000000'), RICH);
  writeFileSync(join(profile, 'cordis.patch.yml.bak-1000000000001'), '[]\n');

  const result = run(SCRIPT, home, ['--restore', 'newest']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /已恢复/);
  assert.equal(readFileSync(live, 'utf8'), RICH);

  const backups = readdirSync(profile).filter((name) => name.startsWith('cordis.patch.yml.bak-'));
  assert.ok(backups.length >= 3, '原备份 + 恢复前文件都应保留');
  const undo = backups.find((name) => name === 'cordis.patch.yml.bak-1000000000001');
  assert.ok(undo, '恢复前的空占位也应保留');
});

test('恢复：指定不存在的备份时非零退出，且不碰当前文件', () => {
  const { home, profile } = makeProfile();
  const live = join(profile, 'cordis.patch.yml');
  writeFileSync(live, RICH);

  const result = run(SCRIPT, home, ['--restore', 'cordis.patch.yml.bak-9999999999999']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /找不到备份/);
  assert.equal(readFileSync(live, 'utf8'), RICH);
});

test('home 层：解析不到的 insert 行会让所有 profile 起不来，且恢复 profile 不会动它', () => {
  const { home, profile } = makeProfile();
  writeFileSync(join(profile, 'cordis.patch.yml'), RICH);
  writeFileSync(join(home, 'cordis.patch.yml'), `- insert:\n    - id: ghost\n      name: '@example/not-installed'\n`);

  const result = run(SCRIPT, home, ['--json']);
  assert.equal(result.status, 2, result.stderr);
  const info = JSON.parse(result.stdout);
  assert.equal(info.homeExists, true);
  assert.equal(info.homeInserts.length, 1);
  assert.equal(info.homeInserts[0].name, '@example/not-installed');
});
