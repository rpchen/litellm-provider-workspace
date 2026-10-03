---
name: workspace-baseline
description: Establish the factual baseline of the LiteLLM Provider multi-repository workspace before planning or implementation.
---

# workspace-baseline：重建工作区事实基线

在开始新的规划、实现、修复、Release 或跨会话继续工作前，用本 skill 重新建立事实基线。**不得因为上一会话声称已完成，就跳过事实检查**；聊天历史、AI memory、上一会话结论不能代替当前事实核查。

已选择 merged-main 分发的仓库，每个新任务先按 AGENTS.md 调用 prepare_codebase_task（mode=new），确认最新 main 与准确 SHA 的索引都 ready。该准备协议承担已授权的安全 fast-forward；本 skill 随后只读记录事实，不自行切分支。未完成工作只能显式 resume，不能把 resume 结果称为新任务准备完成。

## 检查范围

对本次任务涉及的每个仓库（从 `litellm-discovery-core`、`pi-litellm-provider`、`opencode-litellm-provider` 中选取，必要时含 workspace 总仓库本身）逐一核对：

1. **remote**：`git remote -v`，确认仓库地址与预期一致。
2. **当前 branch**：`git branch --show-current`；是否在合适的功能分支或 `main`。
3. **working tree**：`git status --short --branch`；是否存在未提交修改（只记录状态，不清理、不 stash、不 reset，不覆盖）。
4. **remote main HEAD**：`git fetch --prune` 后对比本地 `main` 与 `origin/main`（fetch 只更新远端引用，不得自动 merge/rebase）。
5. **open PR**：用 `gh pr list`（或 GitHub 页面）确认是否有在途 PR。
6. **最新 tag / Release**：`git ls-remote --tags origin`、`gh release list`，判断 Release 是否落后于 `main` 上的用户可见变更。
7. **相关子仓库的 active OpenSpec changes**：`openspec list`（在对应子仓库目录内执行；workspace 总仓库无 OpenSpec），确认在途变更。
8. **canonical specs**：浏览相关子仓库 `openspec/specs/` 当前能力与规格。
9. **README 当前版本 / 安装示例**：README 中固定的版本号、安装命令是否与最新 tag/Release 一致。
10. **Pi/OpenCode `dist/core-provenance.json`**：两个插件各自编入的 core SHA 是什么，与 core `origin/main` 当前 HEAD 是否一致（不一致 = 漂移，记录）。
11. **Core `AGENTS.md`**：当前版本的约定（尤其测试与完成标准）。
12. **Core `docs/testing-standard.md`**：当前版本的第 8、10、11 节约定（Discovery 不变量、收尾、基线/retrospective）。

## 输出格式

事实基线检查完成后，输出至少包含：

1. **当前事实基线**：每个仓库的 remote、branch、HEAD SHA、working tree 状态、与远端的 ahead/behind、最新 tag/Release、active OpenSpec（各子仓库）。
2. **漂移 / 未完成项**：发现的任何漂移（provenance 落后、README 版本落后、tag/Release 落后、active change 未归档、文档与实现不一致），逐条列出并标注所在仓库。
3. **本次任务涉及哪些仓库**：明确列出，并说明其余仓库不涉及。
4. **每个仓库承担什么职责**：core = 宿主无关业务语义真源；Pi/OpenCode adapter = 宿主边界与用户交互；workspace 总仓库 = 跨仓库协调。修改任何子仓库前先读它自己的 `AGENTS.md`。

## 边界

- 本 skill 只做只读检查（`git fetch` 允许，因为它不修改工作区）；不得 merge、rebase、reset、clean、stash、checkout。
- 检查结果只用于建立基线；发现的漂移若不属于本次任务范围，记录后不在本次顺手修改。
- 涉及多仓库推进流程时，结合 `.agents/skills/cross-repo-change` 使用；会话收尾用 `.agents/skills/project-retrospective`。
