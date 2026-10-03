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

## 代码索引与客户端接入（2026-10-02）

- 用户明确选择为工作区和三个子仓库建索引并入库；新仓库不自动索引。
- 日常 Codex、OpenCode v2、Claude Code 使用 MCP；Pi 通过扩展提供同一原生工具注册表。会话使用约定与 MCP 配置同时生效，缺失/过时 coverage 回读源码。
- 两个插件的现有 Release 工作流生成绑定 tag SHA 的图谱、metadata 与 SHA-256 manifest，并发布后回读校验；Core 仅在未来 Release published 后附加索引，不主动创建 Release；总工作区仍不发版。
- 用户确认本地在下一次启动任一编码工具时同步最新 Release，工作图谱按当前检出源码另行刷新。发布快照单独缓存，不切分支或覆盖 checkout；离线下次重试。
- 本次是开发索引与发布工具改动，不改变 discovery 公共 API、插件 dist/provenance 或发版授权边界；四个 PR 可独立评审。

## 索引工具审核修复（2026-10-02）

- 工作图谱由原生工具按本机规范化 Git 根派生 project；发布快照名称不作为本机缓存身份。MCP 启动目录与工作索引根一致，工作区独立子仓库和 Pi 保留持久原生连接以注册 watcher，继续保持 `auto_index=false`。
- OpenCode 迁移使用 `jsonc-parser` 结构化编辑；配置在首次迁移或原生 CLI 写入前按原始字节备份一次，同次安装的后续更新和失败不得覆盖该备份。依赖只属于私有工作区工具链，客户端运行时不需要它。
- 四仓库发布工具必须解析原生 `indexed` 成功状态；`degraded`、未知、缺失或其他状态在生成 manifest 前失败。`ready` 与正节点数只用于可用性检查，不能证明完整成功。
- 回归覆盖两种 MCP 返回格式、JSONC 项位置/嵌套/注释及 CLI 失败；原生 MCP 测试验证新路径与子目录启动后的实时更新。长期维护证据以脚本、文档和各子仓库 canonical OpenSpec 为准。

## 异步生命周期修复（2026-10-03）

复审指出上一轮仍有三处 P2 异步生命周期缺陷和一处回归时序失效，本轮集中修复：

- **准备轮次隔离**：`ReadinessGate` 为每个仓库维护递增轮次，`beginRound` 后的 `success`/`fail` 只在回调轮次仍是最新时生效。启动后台准备的成功不再清除更新的显式 prepare 失败；旧回调也不能覆盖较新失败。
- **关闭状态与后台取消**：进程统一跟踪准备子进程与创建中/已建立的 native 会话；宿主 stdin EOF（以及 SIGINT/SIGTERM）立即进入关闭状态，取消在跑准备、释放所有会话，关闭后才完成的创建也会立刻释放，不再出现 observer 泄漏或残留 wrapper。
- **握手完全解耦**：协议进程不再执行任何同步项目身份解析。启动根 `git rev-parse` 改为异步；工作区清单扫描与宿主上报根的 alias/路径归一化移入独立 `roots` / `opted` 子进程并只回传 JSON；扫描期间查询由门禁 pending 挡住，等本次准备结果而不穿透。
- **回归时序校正**：排队用例的 barrier 改由 fixture 注入实现自身锁前的 `services.repository` 读取（旧版在调用 prepareMain 前等待，卡不住真正的锁前快照，2/2 误通过）；历史回放脚本改成替换 `api()` 签名与函数体，并新增携带锁前快照的提交作为第二个负向控制。

回归证据：Workspace `npm test` 61/61、`npm run test:mcp` 1/1；三个子仓 `npm run test:codebase-memory` 各 42/42；历史回放 `387c1b2` 11 条用例失败、`7e9b0e1` 排队两例失败。新增 [CBM-PREPARE-ROUNDS]、[CBM-STARTUP-ISOLATION]、[CBM-LIFECYCLE-EARLY] 对上一版客户端均失败，[CBM-LIFECYCLE-NORMAL] 覆盖正常退出后已建立 watcher 会话确实消失。

## 其他待办（需要另行确认后再做）

- 子仓库文档中若有"物理嵌套在 LiteLLM 部署仓库目录下"之类的旧描述（如 `pi-litellm-provider/AGENTS.md`、`openspec/config.yaml`），应在各自仓库通过 PR 更新；这不在总仓库迁移范围内。

## 每次合并与新任务的索引一致性（2026-10-02）

用户明确要求每次审核通过并合并的 PR 收尾时，本地与远端索引一致；任一客户端新任务先同步最新代码与索引。该要求替代此前“只按 Release 更新共享快照”的日常策略。已审核源码由 PR CI 生成候选索引，准确 merge SHA 的完整 CI 成功后发布到长期 `codebase-memory-index` 分支，以 source SHA 作为不可变目录。source main 只跟踪 selection.json，原生生成文件在移除 Git 跟踪前备份。finish 取得远端同一快照并校验全部字节，ready 才算完成；prepare 每个新任务都执行，MCP 复用连接不豁免。工作目录未完成工作保留，准备失败不冒充最新。Release 附件继续保留，产品 API/dist/provenance、版本/tag/Release 授权边界不变。

## main 索引同步审核修复（2026-10-02）

本轮修复现有四条 PR 的七类安全缺陷：最终 main 再核验、symbolic branch 保护、SHA 隔离排队、固定干净源码、缓存竞争赢家校验、MCP 项目身份门禁和已选子仓完整回执。保持每 SHA 不可变快照、现有仓库合并/保护策略和产品边界；不合并、不发版、不变更 dist/provenance。MCP 能阻止失败项目的图谱工具访问，宿主新任务的 prepare 调用和任意 shell/编辑器行为仍是文档约定，不能伪称强制拦截。详细协议、来源兼容边界与回归入口见 docs/codebase-memory.md。
