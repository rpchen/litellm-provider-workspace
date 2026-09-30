# AGENTS.md

本文件是 AI 编码代理在本工作区（`litellm-provider` 总项目）工作时必须遵守的约定。跨仓库协作与治理的工作流见 `.agents/skills/`（`workspace-baseline` / `cross-repo-change` / `project-retrospective`）。

## 这是什么

`litellm-provider` 是 **工作区总仓库**：把围绕 LiteLLM provider 插件的 3 个独立 GitHub 仓库放在同一个目录下，方便一次需求跨仓库修改、统一校验。它自己只承载跨仓库的协调内容，**不包含任何子项目代码**。它不是 monorepo，也不是第四个产品仓库。

| 子目录 | GitHub 仓库 | 角色 |
|---|---|---|
| `litellm-discovery-core/` | rpchen/litellm-discovery-core | 宿主无关的 discovery core，被两个插件在构建期编入 `dist` |
| `opencode-litellm-provider/` | rpchen/opencode-litellm-provider | OpenCode v2 插件 |
| `pi-litellm-provider/` | rpchen/pi-litellm-provider | Pi 扩展 |

三个子仓库分别拥有独立的 Git、OpenSpec、CI、Release 和自己的 `AGENTS.md`。**修改任何子仓库前，必须先读目标仓库自己的 `AGENTS.md`**；本文件只定义跨仓库边界，不覆盖子仓库约定。

## 仓库职责

`litellm-discovery-core` 是宿主无关 LiteLLM discovery / 模型语义的**唯一业务真源**，包括但不限于：LiteLLM 归一化、deployment/model 分组、协议判定、models.dev 匹配与 fallback、模型能力、modalities、推理变体、context/output 限制、价格语义、中立 `ModelSpec`、共享 diagnostics 业务语义。**两个 adapter 不得复制 Core 的业务算法。**

- `pi-litellm-provider` 负责 Pi 宿主边界：credential/login、endpoint 运行状态、provider/model 注册、commands/UI、lifecycle、Core → Pi model mapping。
- `opencode-litellm-provider` 负责 OpenCode 宿主边界：credential/connect、endpoint 运行状态、integration/provider/model 注册、commands/RPC/TUI、lifecycle、Core → OpenCode model mapping。

## 硬性边界

1. **子目录是独立 git 仓库**，各自有 remote、分支、CI、发版和 openspec。总仓库已 gitignore 它们；在子目录内执行的 git 命令只作用于该子仓库，在根目录执行的 git 只作用于总仓库。
2. **在哪个仓库改，就在哪个仓库提交**：一次跨仓库需求 = 每个受影响仓库各自一个功能分支 + PR，不得把子仓库文件提交进总仓库。
3. **进入子目录工作时，遵循该子目录自己的 `AGENTS.md`**（测试标准、发版流程、`dist` 产物规则、凭据规则等以子仓库为准），本文件不覆盖它们。
4. 开始工作前先核对：子仓库当前分支、工作区是否有未提交修改、与 `origin/main` 的差异（`node scripts/workspace.mjs status`）。不得覆盖、清理、stash 他人或用户未提交的修改。
5. 不得在任何仓库、fixture、文档、日志中写入真实 API Key、内网地址、PAT、npm token；示例用 `sk-xxx`、`http://litellm.example:4000`。真实环境验证的凭据来源见各子仓库 AGENTS.md。

## 依赖方向（跨仓库改动的顺序）

```
litellm-discovery-core  ──(构建期取 main 的完整 SHA，编入 dist)──▶  opencode-litellm-provider
                                                                └▶  pi-litellm-provider
```

- 宿主无关逻辑（地址/响应归一化、部署分组、协议判定、models.dev 匹配、能力/价格/限制、推理变体、指纹）**只在 core 维护**；插件不得复制业务逻辑，core 不得引入宿主 SDK。
- 插件安装时不依赖平级目录，也不在运行时下载 core；插件通过 `dist/core-provenance.json` 记录所编入 core 的 SHA。**总仓库里的平级布局只为开发方便，不得成为任何仓库的构建/运行依赖。**
- 需要同时改 core 与插件时的顺序：
  1. 先在 core 开分支 → PR → 合入 `main`（core 合入后才有可被插件引用的稳定 SHA）。
  2. 再在两个插件各自：以 `build:dist` 拉取新 core SHA、更新 `dist/`、调整适配层，走各自 PR。
  3. 用 `node scripts/workspace.mjs verify` 分别做提交前校验。
- 详细架构与依赖方向说明见 `docs/architecture.md`。

## 共享质量权威

三仓库统一的测试与完成标准，权威来源只有一份：

`litellm-discovery-core/docs/testing-standard.md`

本文件与两个 adapter 的文档只引用它，不复制完整测试规范。

## 知识真源

长期项目知识按优先级来自：

1. 各层级 `AGENTS.md`（本文件 + 子仓库各自的 `AGENTS.md`）；
2. `docs/decisions.md` / ADR（总仓库与各子仓库各自的决策记录）；
3. Core `docs/testing-standard.md`；
4. 各子仓库 canonical `openspec/specs/`；
5. Git / GitHub / provenance / Release 的当前事实（remote、branch、HEAD、tag、`dist/core-provenance.json` 等）。

聊天历史、AI memory、上一会话的结论**不能代替当前事实核查**；开工前按 `.agents/skills/workspace-baseline` 重建事实基线。

## Workspace 安全边界

- 不自动 `reset`、不自动 `clean`、不自动 `stash`；
- 不覆盖用户未提交的修改；发现脏工作区只记录状态，不做清理、stash、reset 或提交；
- 不让 workspace repo 管理子 repo 内容（不 submodule、不 monorepo、不把子仓库文件提交进总仓库）；
- 跨仓库任务必须分别遵守每个受影响仓库自己的完成标准，**一个仓库完成不代表跨仓库 change 整体完成**。

## 目录结构

| 路径 | 用途 |
|---|---|
| `workspace.json` | 工作区清单：子仓库 URL、分支、安装命令与提交前校验命令（与各子仓库 AGENTS.md 对齐） |
| `scripts/` | 跨仓库脚本：`workspace.mjs` 提供 clone / status / fetch / install / verify / exec；`status.ps1` 提供只读状态快照 |
| `docs/` | 跨仓库文档：`docs/decisions.md` 记录用户确认的决策（工作前必读）；`docs/architecture.md` 说明三仓库总体架构 |
| `.agents/skills/` | 项目级 portable skills 的**唯一真源**（agent-neutral）：workspace 跨仓库协作与治理的工作流 skills。不要创建或使用 `.codex/`、`.pi/`、`.opencode/`、`.claude/` 等目录承载 workspace 的项目规范或 skills 副本 |
| `.github/` | 总仓库的 PR 模板 |
| `.tmp/` | 临时草稿区（gitignore，可随时整体清空）；需保留的产物必须移到正式目录 |

## 规则

1. **临时文件**一律放 `.tmp/`；需要保留的脚本放 `scripts/`，文档放 `docs/`。
2. **agent-neutral**：workspace 的项目规范与 skills 只在根 `AGENTS.md`、`.agents/skills/`、`docs/`、`scripts/` 维护，不向 `.codex/`、`.pi/`、`.opencode/`、`.claude/` 复制；子仓库内部若有自己的 skills 约定，以子仓库为准。
3. **OpenSpec 分工**：workspace 总仓库**不维护 OpenSpec**（产品 specification 只存在于三个子仓库各自的 `openspec/`）。只影响一个仓库的变更，在该仓库自己的 `openspec/` 立提案；同时改变多个仓库契约或流程的变更（如 core 公共 API 变化、跨仓库发版顺序、共享测试标准），在每个受影响子仓库各自的 `openspec/` 立提案并互相引用，跨仓库的协作规则同步沉淀在本文件、`docs/` 与 `.agents/skills/`。
4. **新增子仓库**：在 `workspace.json` 登记、在 `.gitignore` 加 `/<name>/`、在本文件与 README 的表格补一行，再 clone。
5. **提交**：conventional commits（`feat:` / `fix:` / `chore:` / `docs:`）；子仓库的 openspec 在途变更在该子仓库内随实施一起提交，完成后 archive。
6. **发版**：总仓库本身不发版、不打 tag、不发布 npm。各子仓库发版按其自己的 AGENTS.md / CONTRIBUTING.md 执行，打 tag 前向用户确认。
7. **不自行合并 PR、打 tag、创建 Release、推送到 main**，除非用户明确要求。
8. **知识沉淀**：长期有效的经验必须写进正确的权威文件（子仓库的实现/测试经验写子仓库，跨仓库经验写总仓库 `docs/` 与 skills），不得依赖 AI 会话记忆。