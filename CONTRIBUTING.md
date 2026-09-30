# 贡献说明

## 提交到哪里

- 子项目（core / OpenCode 插件 / Pi 扩展）的代码、测试、文档改动，**提交到对应子仓库**，按它自己的 `CONTRIBUTING.md` 走分支 + PR + required `CI`。
- 本仓库只接受跨项目协调内容：`workspace.json`、`scripts/`、`docs/`、`openspec/`、`AGENTS.md`、`README.md` 等。

## 分支与合并

- 从最新 `main` 建 `feat/*`、`fix/*`、`docs/*`、`chore/*` 分支，通过面向 `main` 的 pull request 合入，不直接改 `main`。
- 一次跨仓库需求，每个受影响的仓库各一个 PR；PR 描述里互相链接，并写明合入顺序（通常 core 在前）。

## 提交信息

使用 conventional commits：`feat:` / `fix:` / `chore:` / `docs:`，与各仓库历史保持一致。

## 本地校验

```sh
node scripts/workspace.mjs status    # 提交前先确认各仓库分支和未提交修改
node scripts/workspace.mjs verify    # 全部子仓库的提交前校验
```

`verify` 的具体命令登记在 `workspace.json`，与各子仓库 `AGENTS.md` 里的提交前校验保持一致。子仓库校验命令变化时，同一时间更新 `workspace.json`。

## 规格变更

- 只影响单个仓库的变更：在该仓库的 `openspec/changes/` 立提案。
- 影响多个仓库的契约或流程：在本仓库的 `openspec/changes/` 立提案（proposal / design / specs / tasks），实施并验证后用 OpenSpec CLI archive，再执行 `openspec validate --all --strict --no-interactive`；不得手工移动目录代替 archive。

## 测试完成标准

以 `litellm-discovery-core/docs/testing-standard.md` 为权威来源：每个 OpenSpec Scenario 要有可追踪的自动化证据；安全与失败边界要有真实负向输入；新增用户可见功能至少有一条纵向自动化链路；CI 全绿是必要条件，但不能替代 Scenario 级闭环。

## 用户文档

改动影响用户的实际使用方式（安装、配置、命令、默认值、刷新/缓存、错误降级、迁移）时，同一个 PR 里更新对应仓库的 README。确认没有用户可见变化时，在 PR 里写明 `No README change: no user-visible behavior`。

## 发版

总仓库不发版。子仓库的发版流程见各自的 `CONTRIBUTING.md`；合入用户可见变更（`feat:` / `fix:`）后，记得检查对应仓库的 tag / Release 是否落后于 `main`。打 tag 前先与维护者确认。
