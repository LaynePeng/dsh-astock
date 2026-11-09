# PR：收录 LaynePeng/dsh-astock

目标仓库：`awesome-dsh-plugin/awesome-dsh-plugin`

## 分支 / 文件

- 只新增一个文件：`data/plugins/LaynePeng__dsh-astock.yml`
- 文件内容就在本目录的 [`LaynePeng__dsh-astock.yml`](./LaynePeng__dsh-astock.yml)
- 不要手改 `README.md` / `README.zh.md`（由脚本从 `data/plugins/` 生成）

## PR 标题

```text
Add LaynePeng/dsh-astock — A-share tools, trade ledger and sidebar panel
```

## PR 正文

```markdown
### What it is

`LaynePeng/dsh-astock` — an A-share assistant for DSH:

- 19 tools: quote / K-line / search / screening / fund flow / sentiment / events /
  portfolio / record / hint / pick / backtest / archive / act / watch / extra …
- a local SQLite trade ledger (manual entries; no broker connection, no order placement)
- a sidebar panel (positions / picks / maintenance / config) with exports and backups
- a daily 15:05 archive + closing-equity snapshot, and optional risk-alert email

### Install

- npm: `dsh plugin --profile desktop add @laynepeng/dsh-astock`
- GitHub: `dsh plugin --profile desktop add github:LaynePeng/dsh-astock`

`package.json` declares `dsh.bundle.patch` (`./cordis.patch.yml`); the bundle patch
inserts `id: dsh-astock`, `name: @laynepeng/dsh-astock`.

### Notes

- Not the npm package `dsh-astock` (that name belongs to a different project;
  the README says so explicitly).
- `@deepseek-ai/schemastery` is a `peerDependencies` entry, routed to the host.
- Repository has the `dsh-plugin` topic.
```

## 提交前检查

- [ ] `https://github.com/LaynePeng/dsh-astock` 匿名可访问
- [ ] 仓库已创建满 1 天
- [ ] 仓库已加 topic `dsh-plugin`
- [ ] `npm publish --access public` 已完成，`npm view @laynepeng/dsh-astock version` 有输出
- [ ] 描述里的「19 tools」与 `lib/tools.json` 一致
- [ ] PR 只新增 1 个文件（上限 3 个）
