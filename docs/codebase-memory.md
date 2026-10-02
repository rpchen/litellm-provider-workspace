# 跨客户端代码索引

## 使用约定

新仓库不自动建索引。仓库根目录的 `.codebase-memory/artifact.json` 是显式选择标记；工作区与三个独立子仓库已选择并入库。代理在会话开始确认最近 Git 根目录、索引 project/status，并在定位代码、理解结构、调用链和影响范围时先使用图谱工具；coverage 过时、缺失或跳过的部分回读源码。

MCP 配置使工具进入客户端的工具列表，使用约定使代理知道何时调用。两者都需要配置。模型是否遵循约定仍须从实际工具调用判断，不能把配置存在等同于每次任务必然调用。

工具的 project 标识以当前 `artifact.json` 与 `index_status` 为准，不硬编码上一会话的名称。CBM 可能按本机路径建立项目别名；Release 的源码身份由 GitHub 仓库、tag 和完整 commit SHA 验证，manifest 的 project 必须与发布图谱 metadata 一致，不要求跨机器沿用本地缓存别名。

## 新机器接入

1. 安装 Node.js、Git、GitHub CLI，并显式安装 `npm install -g codebase-memory-mcp@0.11.0`。发布附件下载通过 gh 使用当前用户已有认证；无需新增 API Key。
2. 在工作区运行 `node scripts/install-codebase-memory-clients.mjs`。它备份将改动的配置，安装用户级启动入口，然后配置 Codex、Claude Code、OpenCode v2 和 Pi。不会建新索引、改 branch/tag、发布或提交。
3. 重启四个客户端。Codex/Claude Code/OpenCode 使用 stdio MCP；Pi 原生没有 MCP client，因此扩展按原生 MCP 注册表提供同名工具，使用相同参数和本地数据库。安装支持本机 Junction，不改权限或目录布局。

运行时脚本安装到用户目录 `~/.agents/codebase-memory/`，不依赖这个工作区所在路径。项目治理仍以各仓库 `AGENTS.md` 为真源。安装器固定 `auto_index=false`；支持 MCP 的客户端保留 `auto_watch=true`，Pi 在 session_start 刷新。默认 watcher 可在本地源码变化后更新缓存及持久图谱，产生 `.codebase-memory/` 文件变化；它不自动提交或推送。

## 启动同步与 Release

客户端启动时，只处理最近 Git 仓库中已有索引的项目。工作区根启动还会检查 `workspace.json` 声明的子仓库，跳过没有索引标记的子仓库。先下载最新 Release 的已验证快照，再按当前检出代码刷新工作图谱；两者可以对应不同 commit，不能混用。

| 数据 | 位置 | 用途 |
|---|---|---|
| 入库快照 | 各仓库 `.codebase-memory/` | clone 时可得到已选择的共享图谱 |
| 工作图谱 | codebase-memory 本地数据库缓存 | 匹配当前 branch、未提交源码与 coverage |
| 发布快照 | GitHub Release 三个 `codebase-memory.*` 附件 | 对应不可变 tag 的源码 SHA |
| 本地发布快照 | `~/.cache/codebase-memory-releases/<owner>/<repo>/<commit>/` | 与云端附件校验一致的版本快照，不覆盖 checkout |

两个插件把生成和回读校验接入现有 `release.yml`。Core 当前没有 Release；其工作流仅在未来 Release published 后上传对应 tag 图谱，不主动创建 Release。总工作区不发版。

每份发布快照固定 codebase-memory-mcp 0.11.0、full 模式，包含原生图谱、原生 metadata、仓库/tag/commit/工具版本和 SHA-256 manifest。构建拒绝脏源码、HEAD/tag 不一致、工具版本不符或索引失败；同步拒绝身份、schema、图谱格式或校验值不符。下载后不切分支、不改 tag、不覆盖工作区文件。

GitHub 无法向关机或离线的电脑写文件。本地按用户确认的方式在下一次在线启动时补齐。旧 Release 没有附件时不回填历史发行；离线、下载或刷新失败不会阻止客户端启动，已有索引继续可用，代理需注意 freshness/coverage，下一次启动重试。

## 手动命令与维护

在目标仓库内执行 `node scripts/codebase-memory.mjs sync` 下载最新 Release，`sync vX.Y.Z` 下载指定版本，`refresh` 刷新工作缓存。`build vX.Y.Z` 要求 HEAD 与 tag 相同，更新本地持久快照并把 Release 附件写到 `.tmp/codebase-memory-release/`；它不会创建 tag 或 Release。

索引/发布脚本在每个独立仓库内各自可运行，不需要平级 checkout，也不进入插件 runtime/package。客户端启动脚本与安装器由工作区维护；修改后显式重跑安装器更新用户级副本。四个仓库的 Release 工具副本只处理开发索引，不承担 Core 的 discovery 业务算法。

普通 PR 合并不生成 Release 附件。当前流程只在授权的发行过程中生成云端发布快照；客户端的工作索引由启动刷新和适用的 watcher 更新。

## 验证入口

`node --test scripts/codebase-memory.test.mjs` 覆盖显式选择、tag 身份、脏源码/失败拒绝、损坏校验和、独立下载及重复/离线启动边界。三个子仓库 CI 都执行 `npm run test:codebase-memory`。实际 Release 是否完成必须核对 workflow 和已发布附件；合并 PR、打 tag、创建 Release 仍须用户明确授权。

接口依据：[codebase-memory 配置](https://github.com/DeusData/codebase-memory-mcp/blob/v0.11.0/docs/CONFIGURATION.md)、[Pi 官方桥接生成器](https://github.com/DeusData/codebase-memory-mcp/blob/v0.11.0/src/cli/client_adapter.c)、[OpenCode v2 MCP schema](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/config/mcp.ts)、[Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。
