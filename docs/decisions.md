# 决策记录

记录总仓库的结构决策与背景，避免重复讨论。子项目内部的决策见各自仓库的 `docs/decisions.md`。

## 已确认的决策

| 主题 | 决策 | 背景 / 理由 |
|---|---|---|
| 组织方式（2026-09-29） | 新建工作区总仓库 `litellm-provider`，三个子项目作为**嵌套的独立 git 仓库**并排放在其下；总仓库 gitignore 子目录，不使用 git submodule / subtree / monorepo 合并 | 三个项目围绕同一能力，常常一个需求要跨仓库改动，分散在不同位置很别扭。但 Pi 与 OpenCode 的 manifest、发行方式不同（OpenCode 走 Git package 并提交 `dist/`，Pi 走 `pi install git:`），此前已决定分仓（见 `pi-litellm-provider/docs/decisions.md`），本次不改变这一点 |
| 不用 submodule | 子仓库用 `workspace.json` + `scripts/workspace.mjs` 管理，而不是 submodule | submodule 会把子仓库的固定提交记进总仓库，与"子仓库各自独立演进、core 由插件在构建期取 main 的 SHA"的模型重复，还会带来额外的更新噪音 |
| 平级布局不是依赖 | 平级目录只为开发方便；任何仓库的构建、CI、安装、运行都不得依赖平级目录 | 用户安装插件时没有平级仓库；插件通过 `dist/core-provenance.json` 记录所编入 core 的 SHA，保证可复验 |
| 总仓库职责 | 只承载跨仓库协调：工作区清单与脚本、跨仓库文档、AI 代理约定（`.agents/skills/`）；不含子项目代码、不发版、不维护 OpenSpec | 保持子仓库为唯一事实来源，避免出现两份 |
| 治理约定 | 沿用子仓库的约定：功能分支 + PR + required CI；conventional commits；规格由**各子仓库自己的 OpenSpec** 管理（workspace 不维护）；简体中文文档；示例用 `sk-xxx` / `http://litellm.example:4000` | 与三个子仓库保持一致 |
| 测试标准 | 共享测试标准以 `litellm-discovery-core/docs/testing-standard.md` 为权威 | 已在 core 与两个插件的 AGENTS.md 中约定 |
| Workspace 远端与 bootstrap（2026-09-30） | workspace 总仓库发布到 GitHub public 仓库 [`rpchen/litellm-provider-workspace`](https://github.com/rpchen/litellm-provider-workspace)，默认分支 `main`；新机器用 `scripts/bootstrap.ps1` 按 `workspace.json` 恢复三仓库开发环境 | 仅凭 workspace 仓库即可恢复完整开发 workspace；bootstrap 只创建缺失子仓库，已有子仓库只检查不改动（origin 不匹配即 fail closed），不使用 submodule、不自动装依赖 |
| 移除 workspace OpenSpec（2026-09-30） | workspace 总仓库删除 `openspec/` 目录与 OpenSpec 专用 skills；产品 specification 只存在于三个子仓库各自的 OpenSpec；跨仓库协作规则沉淀在 `AGENTS.md` / `docs/` / `.agents/skills/` | workspace 只负责跨仓库协作与开发基础设施，不承担产品 specification 职责 |

## 待办（需要另行确认后再做）

- 子仓库文档中若有"物理嵌套在 LiteLLM 部署仓库目录下"之类的旧描述（如 `pi-litellm-provider/AGENTS.md`、`openspec/config.yaml`），应在各自仓库通过 PR 更新；这不在总仓库迁移范围内。
