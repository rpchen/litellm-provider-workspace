# litellm-provider

围绕 **LiteLLM provider 插件**的工作区总仓库。它把三个相关的独立项目放在同一个目录下，让"一个需求需要同时改多个项目"的场景更顺手。

用户只需要填 LiteLLM 地址和 API Key，插件就会自动发现有哪些 provider、协议、模型、能力和推理档位，并跟随 LiteLLM 端的变化。

## 包含的项目

| 项目 | 作用 | 面向谁 |
|---|---|---|
| [litellm-discovery-core](https://github.com/rpchen/litellm-discovery-core) | 与宿主无关的模型发现与元数据核心：把 LiteLLM 的模型信息整理成统一的模型描述 | 两个插件的开发者 |
| [opencode-litellm-provider](https://github.com/rpchen/opencode-litellm-provider) | OpenCode 插件 | OpenCode 用户 |
| [pi-litellm-provider](https://github.com/rpchen/pi-litellm-provider) | Pi 扩展 | Pi 用户 |

两个插件在构建时取 core 的 `main`，把它编进自己的发布产物，并记录所用的 commit。**用户安装插件时不需要 core，也不需要这个总仓库。**

## 项目规则入口

- AI 代理与贡献者的总约定从根 [AGENTS.md](AGENTS.md) 开始；跨仓库架构见 [docs/architecture.md](docs/architecture.md)，已确认的决策见 [docs/decisions.md](docs/decisions.md)。
- 进入某个子仓库工作前，先读那个仓库自己的 `AGENTS.md`，以它为准。
- 工作流 skills（事实基线 / 跨仓库变更 / retrospective）只维护在 `.agents/skills/`，是工具中立唯一副本；本仓库不使用 agent 专属目录存放项目规范。

## 这个仓库是怎么用的

三个子项目在各自的 GitHub 仓库里独立开发、评审、发版；本仓库只是把它们并排放好，并提供跨项目的协调工具和文档。子目录不会被提交进本仓库（已 gitignore），也不使用 git submodule，所以不用担心历史混在一起。

**跨仓库的工作从 workspace 根目录开始规划**（先读根 `AGENTS.md` 的依赖方向）；**单仓库的工作直接进入对应子仓库进行**，遵守它自己的 `AGENTS.md` / `CONTRIBUTING.md`。

### 第一次使用

```sh
git clone https://github.com/rpchen/litellm-provider.git
cd litellm-provider
node scripts/workspace.mjs clone     # 把三个子项目 clone 到当前目录
node scripts/workspace.mjs install   # 分别安装依赖
```

### 日常命令

```sh
node scripts/workspace.mjs status                  # 一眼看三个项目的分支、未提交修改、与远端的差异
node scripts/workspace.mjs fetch                   # 三个项目各自 git fetch
node scripts/workspace.mjs verify                  # 按各项目约定的顺序做提交前校验
node scripts/workspace.mjs verify litellm-discovery-core   # 只校验某一个
node scripts/workspace.mjs exec -- git log -1 --oneline    # 在三个项目里各执行一条命令
```

需要 Node.js 22、Bun 1.3，以及 `openspec` 命令行（各项目的 `validate:spec` 会用到）。

### 一个需求要改多个项目时

1. 先看 [AGENTS.md](AGENTS.md) 的"依赖方向"：通常先改 core，合入 `main` 后再改两个插件。
2. 每个受影响的项目各开一个功能分支、各自提 PR，在各自仓库里提交。
3. 跨项目的方案讨论、共享规则的变更，放在本仓库的 `openspec/` 里立提案。

更多约定见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [docs/decisions.md](docs/decisions.md)。
