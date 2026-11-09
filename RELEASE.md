# 发布与分发（让别人能搜到、能装）

要让“别人也能看到并安装”，有三条路，按推荐顺序。

**当前状态（2026-11-09 15:30 更新）：**

| 事项 | 状态 |
|---|---|
| GitHub 仓库公开 | ✅ |
| topic `dsh-plugin`（及 deepseek-harness / a-share / stock / quant / trading-ledger） | ✅ 已加 |
| 收录 PR | ✅ [awesome-dsh-plugin#13535](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/13535)（`check` 已过） |
| 仓库年龄门槛（≥1 天） | ⏳ 门禁只差这一条，约 12 小时后自动通过，无需重新提交 |
| npm 发布 | ❌ 未发布：`laynepeng` 账号注册时邮箱填错，首次登录要邮箱 OTP，收不到（恢复流程见文末「npm 账号邮箱填错」） |
| `npm pack` 产物 | ✅ 63 个文件、约 285 KB；已用 tarball 装进干净 profile 实测：`0.8.6 / 19 tools / configSchema=true / 45 字段` |

| 方式 | 别人怎么装 | 能进市场搜索吗 | 成本 |
|---|---|---|---|
| **A. 发布 npm** | `dsh plugin add @laynepeng/dsh-astock` | ✅ 市场索引只收 npm 上有版本的包 | 需要 npm 账号 + 2FA |
| **B. GitHub 直装** | `dsh plugin add github:LaynePeng/dsh-astock` | ⚠️ 能被列表收录，但索引只给 `github:` 安装命令 | 仓库 public + 加 topic |
| **C. 本地 link** | 只有自己 | ❌ | 零成本，不适合分发 |

A 和 B 不冲突：发 npm 之后，GitHub 仓库仍然是源码与 issue 的入口。

---

## A. 发布到 npm

### 先确认名字

- 本项目包名：**`@laynepeng/dsh-astock`**（当前 npm 上 404，可用）
- ⚠️ npm 上的 **`dsh-astock` 已被另一位作者占用**，不是本项目。不要为了“好搜”改回无 scope 的名字，否则用户会装错。

### 发布

```sh
# 0. 确认要发的内容（不会真的发）
npm pack --dry-run

# 1. 登录 **npmjs**（本机 ~/.npmrc 的 registry 是 npmmirror，直接 npm login 会登到镜像上）
npm login --registry https://registry.npmjs.org/
npm whoami --registry https://registry.npmjs.org/     # 必须打印 laynepeng

# 2. 发布（publishConfig.registry 已指向 npmjs，access=public 也已声明）
npm publish --access public

# 3. 验证：能查到版本 + 能装上
npm view @laynepeng/dsh-astock version --registry https://registry.npmjs.org/
dsh plugin --profile desktop add @laynepeng/dsh-astock
```

> 已实测：把 `npm pack` 出来的 tarball 装进干净 profile，宿主能起来，
> `/api/dsh-astock/info` 返回 `version=0.8.6 / tools=19 / configSchema=true / settingsFields=45`，
> 每日维护也能正常跑。所以 npm 发布后唯一的不确定项只有登录与 2FA。

当前 `npm pack` 会带 63 个文件、约 285 KB（`lib/`、`cordis.patch.yml`、README、LICENSE、`scripts/recover.mjs`），没有 `tests/` 和临时文件。

发布前检查：

- [ ] `package.json` 的 `version` 已递增（当前 `0.8.6`）
- [ ] `npm test` 全绿（当前 184/184）
- [ ] `cordis.patch.yml` 里 insert 的 `name` 与 `package.json` 的 `name` 完全一致
- [ ] `files` 没漏掉 `lib/`、`cordis.patch.yml`、`scripts/recover.mjs`
- [ ] README 第一屏写明「不是 npm 上的 `dsh-astock`」，避免装错

> 关于 `peerDependencies`：`@deepseek-ai/schemastery` 已在 npm 上（3.19.0），npm 7+ 会自动装；DSH 自己也会把 `@deepseek-ai/*` 路由到宿主。不要把它改成 `dependencies`。

---

## B. 提交到插件市场（awesome-dsh-plugin）

市场列表维护在 `awesome-dsh-plugin/awesome-dsh-plugin`，数据源是 `data/plugins/` 下**一个插件一个 YAML**，两个 README 由脚本生成，**不要手改 README**。

### 提交前

- [ ] 仓库是 public（`https://github.com/LaynePeng/dsh-astock` 可匿名打开）
- [ ] 仓库创建已满 1 天
- [ ] 仓库加了 GitHub topic：`dsh-plugin`
- [ ] `package.json` 有 `dsh.bundle.patch`（已有）
- [ ] 描述里出现的数字/能力与代码一致（本项目：19 个工具、本地 SQLite 台账、无下单通道）

### 新增文件 `data/plugins/LaynePeng__dsh-astock.yml`

```yaml
url: https://github.com/LaynePeng/dsh-astock
name: LaynePeng/dsh-astock
category: tools
description:
  en: 'A-share assistant: 19 tools for quotes, K-line, screening, sentiment and backtests, plus a manual trade ledger, a sidebar panel, daily archive snapshots and risk-alert email. No broker connection or order placement.'
  zh: 'A 股助手：19 个行情/选股/舆情/回测工具，外加手工交易台账、右栏面板、每日存档与高风险邮件提醒；不接券商、不下单。'
```

规则要点（来自 `contributing.md`）：

- 只加**一个文件**；描述必须属实，写「19 个工具」就会有人去数。
- 描述含 `: `（冒号加空格）时**必须加引号**，否则 YAML 解析失败。
- 可选 `icon`：GitHub 托管的位图 URL。
- 不发 npm 也能收录，但市场展示的安装命令会是 `github:LaynePeng/dsh-astock`；发了 npm 则优先展示 npm 安装。
- 维护者会实际读代码核对描述，夸大是最常见的打回原因。

提交 PR 后：CI 校验 manifest / 仓库年龄 / 格式，合并后站点与 `dsh-plugin-catalog` npm 包自动重建。

---

## C. 用户端怎么“看到”你

市场索引（`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`）不会自动出现在每个用户的 DSH 里：

1. **内置发现页**：插件 → 发现（Discover）→ 索引源（Index sources）→ 添加上面这个 URL。
2. **装 dshmarket**：`dsh plugin --profile desktop add dshmarket`，界面里直接搜。
3. **对话式**：装 `dsh-find-plugin`，直接问 agent。
4. **不想等收录**：把仓库地址发人，`dsh plugin --profile desktop add github:LaynePeng/dsh-astock` 现在就能装。

---

## 发布后自检

```sh
# 1. 从 npm 装一遍（最好在干净 profile / 另一台机器）
dsh plugin --profile desktop add @laynepeng/dsh-astock

# 2. 宿主里确认装配成功
#    浏览器打开：http://127.0.0.1:<端口>/api/dsh-astock/info
#    期望：version=0.8.2、tools=19、configSchema=true、settingsFields=45

# 3. 装坏了能自救
node scripts/recover.mjs --profile desktop
```

> 第三方站点（dsh-plugin.org、dshfind.com）也会收录 GitHub 仓库，可以在那边按站点说明提交，属于锦上添花，不作为主渠道。

---

## npm 账号邮箱填错（收不到登录 OTP）

npm 的规则（官方文档原文）：

- **未验证邮箱不能发包**：*"You must verify your email address in order to publish packages to the registry."*
- **登录可能要邮箱 OTP**：没开 2FA 时，npm 会把一次性密码发到账号邮箱（`receiving-a-one-time-password-over-email`）。
- **邮箱填错/收不到**，官方给的自助恢复路径是提工单：

1. 打开 <https://www.npmjs.com/login>，用**用户名 + 密码**登录（邮箱不参与登录）。
2. 出现 Login Verification（要 OTP）时，点 **Try recovering your account**。
3. 工单里填你的邮箱，**How can we help?** 选 **Reset my email**，说明：用户名 `laynepeng`、注册的大致时间、注册时把邮箱写错了、从未收到验证邮件、希望改成哪个邮箱。
4. 提交后等 npm 支持处理；处理完用新邮箱收 OTP 登录，再到 Account Settings 确认 `email (verified)`。

**在修好之前**：不要为了发 npm 而新建第二个账号——`@laynepeng` scope 只有这个账号能用，换账号意味着包名要一起改（`package.json`、`cordis.patch.yml`、两份 README、本文件、`release/` 下的 PR 材料）。收录 PR 已经能用 `github:LaynePeng/dsh-astock` 安装，npm 不是阻塞项。
