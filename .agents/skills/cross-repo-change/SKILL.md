---
name: cross-repo-change
description: Advance a change that spans litellm-discovery-core and the Pi/OpenCode adapter repositories, from responsibility analysis to retrospective.
---

# cross-repo-change：跨仓库变更通用推进流程

一个需求需要同时改动 `litellm-discovery-core` 与/或两个 adapter 时，按本流程推进。**一个仓库完成，不代表跨仓库 change 已整体完成**；每个仓库必须分别满足它自己 `AGENTS.md` 的完成标准。

前置：先运行 `.agents/skills/workspace-baseline` 建立事实基线，并确认本次 change 在正确的 openspec 立案（只影响一个仓库 → 该仓库自己的 `openspec/`；影响多仓库契约/流程 → workspace 总仓库 `openspec/`，并在各受影响仓库的变更中引用）。

## 推进步骤

1. **判断责任边界**：需求里的逻辑属于哪一层？宿主无关语义（归一化、分组、协议、能力、价格、限制、推理变体、指纹）→ core；宿主生命周期/用户交互（凭据、注册、命令、UI）→ 对应 adapter。禁止 adapter 复制 core 业务算法，禁止 core 引入宿主 SDK。
2. **判断是否需要 Core 修改**：若 adapter 侧无法在不复制业务逻辑的前提下实现需求，或语义需要两插件共享/一致，则 core 必须先改；否则只在 adapter 改。
3. **Core spec / implementation / tests**（若涉及）：在 core 仓库自己的 openspec 立案 → 实现 → 按 `litellm-discovery-core/AGENTS.md` 与 `docs/testing-standard.md` 补测试（每个 Scenario 有可追踪自动化证据；安全/失败边界有负向测试）。
4. **Core 完成自动化证据**：跑 core 的提交前校验（`npm run typecheck`、`bun test`、`npm run build:dist`、`npm run test:package`、`npm run validate:spec`），PR 合入 `main`。**core 合入 main 并产生稳定 SHA 后，才进入 adapter 步骤。**
5. **更新 Pi/OpenCode adapter**：各自开功能分支，用 `build:dist` 拉取新 core SHA、更新 `dist/` 与 `dist/core-provenance.json`、调整宿主适配层；**一次更新构建只使用一个 core SHA**。
6. **adapter Scenario evidence**：每个 adapter 的 OpenSpec Scenario 都要有可追踪自动化证据（Pi：贯穿 Core → Pi state → command/UI；OpenCode：贯穿 Core → ProviderSnapshot → command/RPC → TUI）。
7. **适用的真实宿主 E2E**：涉及宿主契约/用户可见宿主行为的变更，必须让对应真实宿主门禁通过（Pi 0.87.1 E2E / OpenCode 2.0.16 E2E，见各自 AGENTS.md）。模拟宿主不能替代。
8. **README 同步**：改动影响用户实际使用方式（安装、配置、命令、默认值、错误降级、迁移）的仓库，同一 PR 更新其 README；无用户可见变化时在 PR 写明 `No README change: no user-visible behavior`。
9. **OpenSpec task/evidence**：把实施与证据回填到各仓库 change 的 tasks；跨仓库 change 的任务按仓库分组、标注 PR 依赖与合入顺序。
10. **OpenSpec archive + strict validation**：每个仓库的 change 完成后，用 OpenSpec CLI archive（不手工移动目录），同步 canonical specs，并执行 `openspec validate --all --strict --no-interactive`。
11. **PR / CI**：每个仓库一个 PR，PR 描述互链并写明合入顺序（通常 core 在前）；required CI 全绿。不得自行合并，除非用户明确要求。
12. **适用时 Release**：合入 `feat:`/`fix:` 的子仓库按其 AGENTS.md 发版（版本号提升、tag、Release）；打 tag 前向用户确认，不自行打 tag/Release。
13. **retrospective**：全部仓库完成后，运行 `.agents/skills/project-retrospective` 收尾。

## 边界

- 各仓库在它自己的仓库内提交：功能分支 + PR，禁止把子仓库文件提交进 workspace 总仓库。
- 修改任何子仓库前，先读该仓库的 `AGENTS.md`；凭据、E2E、发版细节以子仓库为准。
- 不覆盖任何仓库中用户未提交的修改；不自行 merge、rebase、reset、clean、stash。