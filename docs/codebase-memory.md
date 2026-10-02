# 跨客户端代码索引

## 使用约定

新仓库不自动建索引。仓库根目录的 `.codebase-memory/artifact.json` 是显式选择标记；工作区与三个独立子仓库已选择并入库。代理在会话开始确认最近 Git 根目录、索引 project/status，并在定位代码、理解结构、调用链和影响范围时先使用图谱工具；coverage 过时、缺失或跳过的部分回读源码。

MCP 配置使工具进入客户端的工具列表，使用约定使代理知道何时调用。两者都需要配置。模型是否遵循约定仍须从实际工具调用判断，不能把配置存在等同于每次任务必然调用。

工具的 project 标识以当前 `artifact.json` 与 `index_status` 为准，不硬编码上一会话的名称。CBM 可能按本机路径建立项目别名；Release 的源码身份由 GitHub 仓库、tag 和完整 commit SHA 验证，manifest 的 project 必须与发布图谱 metadata 一致，不要求跨机器沿用本地缓存别名。

## 新机器接入

1. 安装 Node.js、Git、GitHub CLI，并显式安装 `npm install -g codebase-memory-mcp@0.11.0`。发布附件下载通过 gh 使用当前用户已有认证；无需新增 API Key。
2. 在工作区先运行 `npm ci --ignore-scripts` 安装工具链开发依赖，再运行 `node scripts/install-codebase-memory-clients.mjs`。它在任何修改前只保存一次原始配置字节，安装用户级启动入口，然后配置 Codex、Claude Code、OpenCode v2 和 Pi。OpenCode 的旧配置使用 JSONC 结构化编辑并校验，原始备份不会被 CLI 写入的中间状态覆盖。不会建新索引、改 branch/tag、发布或提交。
3. 重启四个客户端。Codex/Claude Code/OpenCode 使用 stdio MCP；Pi 扩展按原生 MCP 注册表提供同名工具，并持有相同的 stdio MCP 会话直至 session_shutdown，使用相同参数和本地数据库。安装支持本机 Junction，不改权限或目录布局。

运行时脚本安装到用户目录 `~/.agents/codebase-memory/`，不依赖这个工作区所在路径。项目治理仍以各仓库 `AGENTS.md` 为真源。安装器固定 `auto_index=false`，保留 `auto_watch=true`；四个客户端均通过持久 MCP 会话注册已有数据库的原生 watcher。CBM 0.11.0 对已有持久目录会在刷新缓存时自动重新导出图谱，即使 `persistence=false` 也可能更新 `.codebase-memory/graph.db.zst` 和 `artifact.json`；watcher 同样会导出。日常启动因此可能留下索引生成文件变化，不自动提交或推送；按 Release/里程碑审阅并提交这些变化。

## 启动同步与 Release

客户端启动时，只处理最近 Git 仓库中已有索引的项目。工作区根启动还会检查 `workspace.json` 声明的子仓库，跳过没有索引标记的子仓库。先下载最新 Release 的已验证快照，再按当前检出代码刷新工作图谱；两者可以对应不同 commit，不能混用。

工作图谱不沿用其他机器快照中的名称：刷新不传 name override，让原生工具按本机规范化 Git 根目录生成 project；MCP 同样在这个根目录启动。子目录启动和 Desktop roots/list 均归一到最近的已选择 Git 根。工作区的独立子仓库各保留原生会话注册 watcher，Pi 的会话也不会在初始化后立即退出。查询使用当前 marker/status 返回的本地 project；代码修改无需重启即可由原生 watcher 更新。若用户另行关闭 watcher_enabled，则需要手动 refresh。

| 数据 | 位置 | 用途 |
|---|---|---|
| 入库快照 | 各仓库 `.codebase-memory/` | clone 时可得到已选择的共享图谱 |
| 工作图谱 | codebase-memory 本地数据库缓存 | 匹配当前 branch、未提交源码与 coverage |
| 发布快照 | GitHub Release 三个 `codebase-memory.*` 附件 | 对应不可变 tag 的源码 SHA |
| 本地发布快照 | `~/.cache/codebase-memory-releases/<owner>/<repo>/<commit>/` | 与云端附件校验一致的版本快照，不覆盖 checkout |

两个插件把生成和回读校验接入现有 `release.yml`。Core 当前没有 Release；其工作流仅在未来 Release published 后上传对应 tag 图谱，不主动创建 Release。总工作区不发版。

每份发布快照固定 codebase-memory-mcp 0.11.0、full 模式，包含原生图谱、原生 metadata、仓库/tag/commit/工具版本和 SHA-256 manifest。构建拒绝脏源码、HEAD/tag 不一致、工具版本不符或索引失败；原生 index_repository 必须明确返回 indexed，degraded、未知、缺失或其他状态均不得生成发布 manifest，不能用随后 ready/节点数大于零代替成功。同步拒绝身份、schema、图谱格式或校验值不符。下载后不切分支、不改 tag、不覆盖工作区文件。

GitHub 无法向关机或离线的电脑写文件。本地按用户确认的方式在下一次在线启动时补齐。旧 Release 没有附件时不回填历史发行；离线、下载或刷新失败不会阻止客户端启动，已有索引继续可用，代理需注意 freshness/coverage，下一次启动重试。

## 手动命令与维护

在目标仓库内执行 `node scripts/codebase-memory.mjs sync` 下载最新 Release，`sync vX.Y.Z` 下载指定版本，`refresh` 刷新工作缓存。`build vX.Y.Z` 要求 HEAD 与 tag 相同，更新本地持久快照并把 Release 附件写到 `.tmp/codebase-memory-release/`；它不会创建 tag 或 Release。

索引/发布脚本在每个独立仓库内各自可运行，不需要平级 checkout，也不进入插件 runtime/package。客户端启动脚本与安装器由工作区维护；修改后显式重跑安装器更新用户级副本。四个仓库的 Release 工具副本只处理开发索引，不承担 Core 的 discovery 业务算法。

普通 PR 合并不生成 Release 附件。当前流程只在授权的发行过程中生成云端发布快照；客户端的工作索引由启动刷新和适用的 watcher 更新。

## 验证入口

持久 MCP stdout 使用流式 UTF-8 解码，再按 JSONL 分帧；不得把每个 Buffer 单独转换后拼接，否则跨字节边界的中文和 emoji 会静默损坏。`scripts/codebase-memory-session.test.mjs` 的 [CBM-UTF8] 使用实际 McpSession 和隔离子进程，覆盖完整响应、三字节中文与四字节 emoji 的每个内部字节边界，并比较 content 与 structuredContent 的原始内容。子进程等父进程读完首块再发送剩余字节，确保操作系统不会合并测试分块。该测试由 `npm test` 和 CI 执行。

工作区 `npm test` 覆盖发布边界、降级状态、最近 Git 根、JSONC 首/中/末项及嵌套/注释、原始字节备份和 CLI 失败；`npm run test:mcp` 使用真实 0.11.0 验证新路径 clone、子目录启动和工作区独立子仓库修改源码后，保持同一 MCP 会话查询新符号。三个子仓库 CI 都执行 `npm run test:codebase-memory`，包括 structuredContent 和 content/text 两种原生降级返回。实际 Release 是否完成必须核对 workflow 和已发布附件；合并 PR、打 tag、创建 Release 仍须用户明确授权。

接口依据：[codebase-memory 配置](https://github.com/DeusData/codebase-memory-mcp/blob/v0.11.0/docs/CONFIGURATION.md)、[Pi 官方桥接生成器](https://github.com/DeusData/codebase-memory-mcp/blob/v0.11.0/src/cli/client_adapter.c)、[OpenCode v2 MCP schema](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/config/mcp.ts)、[Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。
