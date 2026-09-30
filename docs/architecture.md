# 架构：三仓库总体结构

本文只说明跨仓库的总体架构与依赖方向；各仓库内部的详细设计与决策见各自仓库的 `docs/`（ADR / `docs/decisions.md`），本文不复制它们。

## 总体拓扑

```text
                 litellm-discovery-core
                    neutral semantics
                          |
             +------------+------------+
             |                         |
             v                         v
   pi-litellm-provider      opencode-litellm-provider
          Pi                       OpenCode
```

## 三个仓库

| 仓库 | 角色 | 说明 |
|---|---|---|
| `litellm-discovery-core` | 宿主无关的共享语义层 | LiteLLM 归一化、deployment/model 分组、协议判定、models.dev 匹配与 fallback、能力/模态/推理变体、context/output 限制、价格语义、中立 `ModelSpec`、共享 diagnostics 业务语义的唯一真源 |
| `pi-litellm-provider` | Pi 宿主适配 | credential/login、endpoint 运行状态、provider/model 注册、commands/UI、lifecycle、Core → Pi model mapping |
| `opencode-litellm-provider` | OpenCode 宿主适配 | credential/connect、endpoint 运行状态、integration/provider/model 注册、commands/RPC/TUI、lifecycle、Core → OpenCode model mapping |

三个仓库是**完全独立的 Git 仓库**（各自的 remote、分支、CI、发版、OpenSpec 与 `AGENTS.md`）。workspace 总仓库把它们并排放置只为开发方便，不构成任何构建/运行依赖。

## 依赖方向

**允许（且只允许）：**

- Pi → Core
- OpenCode → Core

**禁止：**

- Core → Pi
- Core → OpenCode
- Pi → OpenCode
- OpenCode → Pi

### Core 与 adapter 的分工

- **Core 负责共享业务语义**：所有宿主无关的 discovery / 模型语义只在 core 维护。core 不得引入 Pi、OpenCode 或其他宿主 SDK，保持零运行时依赖。
- **两个 adapter 负责宿主相关生命周期与用户交互**：凭据、注册、命令、UI/RPC/TUI、宿主映射。adapter 不得复制 core 的业务算法。

### 构建期绑定，而非运行时依赖

两个 adapter 在**构建期**取 core `main` 的完整 SHA，把 core 源码编入自己的 `dist/`，并记录在 `dist/core-provenance.json`：

```text
litellm-discovery-core  ──(build:dist，构建期按完整 SHA 编入 dist，记录于 core-provenance.json)──▶  opencode-litellm-provider
                                                                                              └▶  pi-litellm-provider
```

- 插件安装与运行时**不下载 core、不依赖平级目录**；`dist/core-provenance.json` 保证任何一次产物可追溯到唯一的 core commit。
- workspace 平级布局不是依赖：用户安装任一插件时既不需要 core 仓库，也不需要 workspace 总仓库。
- core 合入 `main` 之后的更新不会改变已发布插件；下一次 adapter 更新构建（`build:dist`）才包含新 core。

## 跨仓库改动的推进顺序

1. 先在 core 开分支 → PR → 合入 `main`（产生可被引用的稳定 SHA）。
2. 再在两个 adapter 各自：以 `build:dist` 拉取新 core SHA、更新 `dist/` 与 `dist/core-provenance.json`、调整适配层，走各自 PR。
3. 各仓库分别执行自己 `AGENTS.md` 规定的提交前校验（也可用 `node scripts/workspace.mjs verify` 逐仓执行）。

通用流程见 `.agents/skills/cross-repo-change/`；事实基线检查见 `.agents/skills/workspace-baseline/`。

## 质量与完成标准

共享测试与完成标准的权威来源：`litellm-discovery-core/docs/testing-standard.md`（本文与根 `AGENTS.md` 只引用，不复制）。