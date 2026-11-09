#!/usr/bin/env node
/**
 * 找回被 DSH「安全恢复」改名的 profile 配置。
 *
 * 背景（这不是本插件删的文件）：
 *   桌面版在宿主启动失败时，恢复对话框里的「停用第三方插件」会调用 DSH 的
 *   `sanitizeProfile`：把 `profiles/<name>/cordis.patch.yml` **改名**成
 *   `cordis.patch.yml.bak-<毫秒时间戳>`，再写一个 `[]` 占位、把 bundle 列表
 *   恢复成官方默认。原配置没有丢，只是名字变了，从界面上看就像「整个配置被清空」。
 *
 * 本脚本只做两件事，默认全是只读：
 *   1. 列出备份、当前 patch 与 profile 的装配状态（哪个 bundle / insert 行解析不到）；
 *   2. 用 `--restore` 明确要求时，把某个备份放回 `cordis.patch.yml`（先把当前
 *      文件改名成 `.bak-<现在>`，不删除任何东西）。
 *
 * 用法：
 *   node scripts/recover.mjs                       # 诊断（只读）
 *   node scripts/recover.mjs --profile desktop
 *   node scripts/recover.mjs --home ~/.dsh --profile web
 *   node scripts/recover.mjs --restore newest      # 把最新备份放回去
 *   node scripts/recover.mjs --restore cordis.patch.yml.bak-1762500000000
 *
 * 退出码：0 = 正常；1 = 参数/路径错误；2 = 需要人工处理（有解析不到的装配项）。
 */

import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const PATCH_NAME = 'cordis.patch.yml';
const BACKUP_RE = /^cordis\.patch\.yml\.bak-(\d{10,16})$/u;

function usage() {
  console.log(`用法：
  node scripts/recover.mjs [--home <DSH_HOME>] [--profile <name>] [--restore newest|<备份文件名>]

  --home       DSH 数据根，默认 $DSH_HOME 或 ~/.dsh
  --profile    profile 名，默认 desktop
  --restore    明确要求恢复；不带该参数时只读诊断
  --json       以 JSON 输出（便于脚本处理）`);
}

function parseArgs(argv) {
  const options = { home: '', profile: 'desktop', restore: '', json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--home' || arg === '--profile' || arg === '--restore') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        console.error(`参数 ${arg} 缺少值`);
        usage();
        process.exit(1);
      }
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    console.error(`未知参数：${arg}`);
    usage();
    process.exit(1);
  }
  return options;
}

/** 读一个 patch 文件里的行 id（只用于展示，不做 YAML 完整解析）。 */
function patchRowIds(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const ids = [];
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.replace(/#.*$/u, '');
    // 只认顶层行：嵌套 config 里的 `- id:`（模型 id、规则 id）不是 loader 行。
    const match = /^-\s*id:\s*['"]?([^'"\s]+)['"]?\s*$/u.exec(line);
    if (match) {
      const id = match[1];
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/** 读一个 patch 文件里 insert 块声明的模块名（尽力而为；解析不到就跳过）。 */
function insertedPackageNames(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const names = [];
  let insertIndent = null;
  let inPayload = false;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.replace(/#.*$/u, '');
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (trimmed === 'insert:' || /^(-?\s*)?insert:\s*(#.*)?$/u.test(trimmed)) {
      insertIndent = indent;
      inPayload = false;
      continue;
    }
    if (insertIndent !== null && indent <= insertIndent && /^-?/u.test(trimmed)) {
      insertIndent = null;
      inPayload = false;
    }
    if (insertIndent === null) continue;
    if (/^config:\s*/u.test(trimmed)) {
      inPayload = true;
      continue;
    }
    if (inPayload) continue;
    const match = /^-\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/u.exec(trimmed)
      ?? /^name:\s*['"]?([^'"\s]+)['"]?\s*$/u.exec(trimmed);
    if (match) names.push(match[1]);
  }
  return [...new Set(names)];
}

/** 判断一个模块名能否从 profile 根解析到（Node 的真实解析路径）。 */
function resolveFromProfile(profileDir, name) {
  if (!name || name.startsWith('.') || name.startsWith('/') || name.startsWith('cordis:') || name.includes('://')) {
    return { name, kind: 'non-package', ok: true };
  }
  try {
    const require = createRequire(join(profileDir, 'package.json'));
    return { name, kind: 'package', ok: true, path: require.resolve(name) };
  } catch (error) {
    return { name, kind: 'package', ok: false, reason: error?.code || String(error?.message ?? error) };
  }
}

/** 列出 `cordis.patch.yml.bak-<时间戳>`，按时间戳从新到旧。 */
function listBackups(profileDir) {
  let entries = [];
  try {
    entries = readdirSync(profileDir);
  } catch {
    return [];
  }
  const backups = [];
  for (const name of entries) {
    const match = BACKUP_RE.exec(name);
    if (!match) continue;
    const file = join(profileDir, name);
    let size = 0;
    try { size = statSync(file).size; } catch { /* 读不到大小就按 0 */ }
    const rows = patchRowIds(file);
    backups.push({
      name,
      file,
      stamp: Number(match[1]),
      bytes: size,
      rows,
      // DSH 的安全恢复会在原地写一个 `[]` 占位；这样的小文件不可能是用户配置，
      // 不能让 `--restore newest` 把它当成「最新备份」再恢复回去。
      empty: rows.length === 0 && size < 64,
    });
  }
  backups.sort((left, right) => right.stamp - left.stamp);
  return backups;
}

function humanTime(epochMs) {
  try {
    return new Date(epochMs).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}

function inspect(profileDir, profileName, homeDir) {
  const patchFile = join(profileDir, PATCH_NAME);
  const liveRows = patchRowIds(patchFile);
  const liveBytes = existsSync(patchFile) ? statSync(patchFile).size : 0;
  const backups = listBackups(profileDir);

  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  } catch { /* 读不到就是没有清单 */ }
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
  const dependencies = manifest?.dependencies && typeof manifest.dependencies === 'object'
    ? manifest.dependencies : {};
  // 官方 bundle（dsh-base / dsh-web-app 等）由宿主自己的解析器提供，不装进
  // profile 的 node_modules；它们解析不到是正常的，不能报成故障。
  const missingBundles = bundles
    .filter((name) => dependencies[name] !== undefined || !String(name).startsWith('@deepseek-ai/'))
    .map((name) => resolveFromProfile(profileDir, name))
    .filter((item) => !item.ok);
  const inserts = insertedPackageNames(patchFile)
    .map((name) => resolveFromProfile(profileDir, name))
    .filter((item) => !item.ok);

  // home 层（$DSH_HOME/cordis.patch.yml）会影响**所有** profile；桌面版的安全
  // 恢复只改名 profile 层的 patch，不动 home 层。坏行如果在这里，恢复后依旧起不来。
  const homePatchFile = join(homeDir, PATCH_NAME);
  const homeExists = existsSync(homePatchFile);
  const homeRows = patchRowIds(homePatchFile);
  const homeInserts = insertedPackageNames(homePatchFile)
    .map((name) => resolveFromProfile(profileDir, name))
    .filter((item) => !item.ok);

  return {
    profileDir,
    profile: profileName,
    patchFile,
    liveBytes,
    liveRows,
    backups,
    bundles,
    missingBundles,
    inserts,
    homePatchFile,
    homeExists,
    homeRows,
    homeInserts,
  };
}

function printReport(info, json) {
  if (json) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  console.log(`profile：${info.profileDir}`);
  console.log(`当前 patch：${PATCH_NAME}（${info.liveBytes} 字节，${info.liveRows.length} 个 id）`);
  if (info.liveRows.length === 0) {
    console.log('  ⚠ 当前 patch 里没有行——如果是 DSH 安全恢复之后的占位 []，你的原配置应在下面的备份里。');
  }
  console.log();
  if (info.backups.length === 0) {
    console.log('备份：没有找到 cordis.patch.yml.bak-*（说明这台机器没走过 DSH 的「停用第三方插件」恢复）。');
  } else {
    console.log(`备份：${info.backups.length} 个（从新到旧）`);
    for (const backup of info.backups) {
      console.log(`  · ${backup.name}（${humanTime(backup.stamp)}，${backup.bytes} 字节，${backup.rows.length} 个顶层 id）`
        + (backup.empty ? '  ← 空占位，不建议恢复' : ''));
    }
  }
  console.log();
  console.log(`profile 装配：${info.bundles.length} 个 bundle`);
  if (info.missingBundles.length === 0) {
    console.log('  ✓ 每个 bundle 都能从 profile 根解析到');
  } else {
    console.log('  ✗ 这些 bundle 解析不到（冷启动会报错/跳过，先装回来或从列表里移除）：');
    for (const item of info.missingBundles) console.log(`    - ${item.name}：${item.reason}`);
  }
  if (info.inserts.length > 0) {
    console.log('  ✗ 当前 patch 里有 insert 行指向未安装的包（这是最常见的启动失败原因）：');
    for (const item of info.inserts) console.log(`    - ${item.name}：${item.reason}`);
  }
  console.log();
  if (!info.homeExists) {
    console.log(`home 层：没有 ${info.homePatchFile}（正常，不影响任何 profile）`);
  } else {
    console.log(`home 层：${info.homePatchFile}（${info.homeRows.length} 个顶层 id，**影响所有 profile**）`);
    if (info.homeInserts.length > 0) {
      console.log('  ✗ home 层里有 insert 行指向未安装的包——桌面版恢复不会动这一层，恢复后仍然起不来：');
      for (const item of info.homeInserts) console.log(`    - ${item.name}：${item.reason}`);
    } else {
      console.log('  ✓ home 层没有解析不到的 insert 行');
    }
  }
  console.log();
  const restorable = info.backups.filter((backup) => !backup.empty);
  if (restorable.length > 0) {
    if (info.liveRows.length === 0) {
      console.log('下一步（当前 patch 是空的，很可能刚被 DSH 安全恢复过）：');
    } else {
      console.log('如需把某份备份放回去（会先把当前文件改名保留）：');
    }
    console.log(`  node scripts/recover.mjs --profile ${info.profile} --restore newest`);
  }
}

function restoreBackup(info, selector, json) {
  // `newest` 跳过 DSH 恢复留下的空占位，选最新的一份有内容的备份。
  const wanted = selector === 'newest'
    ? info.backups.find((backup) => !backup.empty)
    : info.backups.find((backup) => backup.name === selector || backup.file === selector);
  if (!wanted) {
    console.error(`找不到备份：${selector}`);
    if (info.backups.length === 0) console.error('这个 profile 里没有 .bak-* 备份。');
    else console.error('可选：' + info.backups.map((backup) => backup.name).join('、'));
    process.exit(1);
  }

  // 当前文件先改名保留：恢复放错了还能再回来；绝不删除。
  // 写入走「临时文件 + rename」，中途失败时把当前文件放回原处。
  let undoPath = '';
  if (existsSync(info.patchFile)) {
    undoPath = `${info.patchFile}.bak-${Date.now()}`;
    renameSync(info.patchFile, undoPath);
  }
  let mode = 0o600;
  try {
    mode = statSync(wanted.file).mode & 0o777;
  } catch { /* 读不到权限就用 0600 */ }
  const temp = `${info.patchFile}.restore-${process.pid}`;
  try {
    writeFileSync(temp, readFileSync(wanted.file), { mode });
    renameSync(temp, info.patchFile);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* 临时文件可能根本没写出来 */ }
    if (undoPath) {
      try {
        renameSync(undoPath, info.patchFile);
        undoPath = '';
      } catch { /* 放不回去时保留 undoPath，下面会打印出来 */ }
    }
    console.error(`恢复失败：${error?.message ?? error}`);
    if (undoPath) console.error(`恢复前的当前文件仍在：${undoPath}`);
    process.exit(1);
  }
  const result = {
    ok: true,
    restored: wanted.name,
    bytes: wanted.bytes,
    rows: wanted.rows.length,
    profileDir: info.profileDir,
    undoPath: undoPath || null,
    note: '已在原位置保留备份文件；如果恢复的不是你想要的那份，把 undoPath 改回 cordis.patch.yml 即可。',
  };
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`已恢复：${wanted.name} → ${PATCH_NAME}（${wanted.bytes} 字节，${wanted.rows.length} 个 id）`);
    if (undoPath) console.log(`恢复前的当前文件已保留在：${undoPath}`);
    console.log('请完全退出 DSH 再重新启动（桌面版关窗口；命令行 Ctrl+C），然后验证：');
    console.log(`  dsh --profile ${info.profile} --dump-config`);
  }
  return result;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  // Windows 的 cmd 不会展开 `~`；这里自己展开一次，免得 `--home ~/.dsh` 被当成
  // 当前目录下的相对路径。
  const expandHome = (value) => String(value || '').trim()
    .replace(/^~(?=$|[\\/])/, homedir());
  const home = expandHome(options.home)
    || expandHome(process.env.DSH_HOME)
    || join(homedir(), '.dsh');
  const profileDir = resolve(join(home, 'profiles', options.profile));
  if (!existsSync(profileDir)) {
    console.error(`找不到 profile：${profileDir}`);
    console.error('用 --home 指定 DSH 数据根（默认 $DSH_HOME 或 ~/.dsh），用 --profile 指定 profile 名。');
    process.exit(1);
  }

  const info = inspect(profileDir, options.profile, home);
  if (options.restore) {
    restoreBackup(info, options.restore, options.json);
    return;
  }

  printReport(info, options.json);
  if (info.missingBundles.length > 0 || info.inserts.length > 0 || info.homeInserts.length > 0) process.exitCode = 2;
}

main();
