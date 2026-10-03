# main 与 codebase-memory 同步审核修复

范围：Workspace #2、Core #25、OpenCode #52、Pi #44。仅维护索引工具链、测试、工作流、规范与说明；不合并 PR，不修改仓库策略，不更新产品源码、版本、dist 或 core provenance。

## 七类问题与回归入口

| 类别 | 根因 | 修复 | 回归证据 |
|---|---|---|---|
| main 前进与预算 | 只记录最初的 main；等待后不再确认；工作区耗尽预算可能变成 wait_ms=0 | 下载/校验后、切换前及最终激活后重新 fetch；变化时转向准确 SHA；Git、网络、重定向及工作区共用剩余正数预算；记录 remote_verified_at | CBM-RETARGET / WAIT-MAIN 的 new、finish；FINAL-REMOTE、TOTAL-BUDGET、WORKSPACE-BUDGET；缺失、损坏、网络、超时均无 ready |
| 并发检出 | 同 SHA 的分支被当作同一检出；通过当前 HEAD 快进 | Git common dir 的 PID/token 锁；分支、HEAD、tree、main ref、暂存/未暂存/未跟踪状态保护；detached 检出后 CAS 更新明确 main；回执重新读实际 Git | CONCURRENT-CHECKOUT 五类输入；PRESERVE-WORK 五类输入；COMMON-MUTEX 真实关联工作树，断言 ref、HEAD、文件及 staged diff |
| 发布队列及并发写入 | 固定 group 的一个 pending 槽位可能被旧 CI 替换；共享分支没有冲突重试 | 按完整源码 SHA 分组；只快进索引分支；409/422 重新读取父提交、退避及有界重试；已存在同 SHA 快照严格校验后幂等复用 | SHA-QUEUE 核对实际 workflow；CI-ORDER；PUBLISH-RACE 的独立 A/B/C 发布进程、实际 bare Git 对象/ref、每 SHA 留存及幂等 |
| 脏源码归属 | HEAD 不变无法证明索引来自干净源码 | 隔离 clone，detached 固定 SHA；原始与隔离检出前后核对；原生 git-clean-head、项目、root、数量与隔离来源证明必须一致 | FIXED-SOURCE；DIRTY-BUILD 原始/隔离源码改动不提交均失败且不生成 manifest；NATIVE-BASIS 拒绝重算校验和的脏来源 |
| 缓存落盘竞争 | rename 输家直接报 ENOTEMPTY；Windows 也可能短暂 EPERM | 严格验证赢家身份、三文件、SHA-256、远端 blob 后复用；损坏/错误身份不信任；无赢家的临时权限错误仅有界重试 | CACHE-RACE 三种赢家；PARALLEL-CACHE 两个独立 checkout/子进程；CACHE-RETRY 的短暂/永久权限错误 |
| MCP 参数门禁 | 只比较 project 原始字符串，遗漏比较目标、别名、路径与旧数据库名 | 从原生 tools/list schema 识别项目字段；原生 index_status 解析 root 与数据库内部项目；覆盖接受的别名参数、路径、双方比较、原生路径名与 main 快照名 | PROJECT-GATE；MCP-GATE 实际原生 schema＋stdio 六种失败调用；损坏 metadata＋陈旧数据库 root 的单测 |
| 已选择子仓 metadata | 异常被当作未启用，子仓从预期集合消失 | 显式选择与未启用分开；损坏/身份不符阻止整体准备；缺失工作 artifact 仍纳入集合并恢复；所有预期回执与 Git/marker 身份核对 | SELECTED-METADATA 三类；MISSING-METADATA 恢复成功/失败；ALL-RECEIPTS 缺失、重复、伪造 branch/index SHA/marker SHA |

共享实现、36 条 main 回归、Git API fixture 与历史回放脚本在四仓库逐字节同步。Workspace 的 15 条 client 回归维护跨客户端入口，其中 [CBM-PREPARE-ROUNDS]、[CBM-STARTUP-ISOLATION]、[CBM-LIFECYCLE-EARLY] 是本轮异步生命周期修复的负向控制。每个 Scenario 在三个子仓 `harden-main-index-sync` tasks 中映射到同名自动化入口。

## 负向控制与实际 I/O

`node scripts/codebase-memory-review-baseline.mjs 387c1b2 7e9b0e1` 对两段历史实现复用同一断言，只把 `api()` 的签名与函数体换成 fixture hook（此前切到 `missing()` 会删掉 `remaining()` 等旧状态机仍调用的辅助函数，把真实旧故障掩盖成 ReferenceError）。审核前提交下 11 条所选用例失败，复现旧 SHA 被报 ready、同 SHA 用户分支被快进、未提交源码被接受、有效缓存 rename 输家失败和旧队列 group；携带锁前快照的 `7e9b0e1` 下 [CBM-QUEUED-LOCK] 与 [CBM-QUEUED-USER-CHANGE] 均失败。

实际旧 stdio client 加同一 native 回归，六个调用的 `isError` 全为 false；修复后全部拒绝。另一个真实 Git 控制中，旧 workingRoots 忽略损坏的已选择 child，仅返回父仓；新实现抛出 metadata 错误。fixture 使用临时 bare remote、独立 checkout、实际 Git 分支/ref/HEAD/文件/暂存状态；索引服务可模拟，Git 状态并非 mock。

## CI、宿主与本机安装

实施源码核验提交及 CI：

| 仓库 | 实施提交 | CI |
|---|---|---|
| Workspace | 7e9b0e1b1e43ded710632f2cfbe2e765db979a72 | [tooling](https://github.com/rpchen/litellm-provider-workspace/actions/runs/37026644204) |
| Core | ec790eea53e128eb53b0233c0df27784fd018ff8 | [CI](https://github.com/rpchen/litellm-discovery-core/actions/runs/37025720559) |
| OpenCode | 20cd9b652e21227cec4bd9ca498e3de1f64d4eea | [CI 与 Real OpenCode 2.0.16 E2E](https://github.com/rpchen/opencode-litellm-provider/actions/runs/37025748244) |
| Pi | 59037f7b46efda53da8a7b5e86f1e693804110e1 | [CI 与 Real Pi 0.87.1 E2E](https://github.com/rpchen/pi-litellm-provider/actions/runs/37025771834) |

以上是实施阶段已通过的不可变提交；归档与最后修订后的最终 head/CI 以各 PR 的最终交付回执为准，交付前再次核验，不把旧 head 的成功转称为最新 head 成功。

本机四个已安装模块按原始字节备份后更新；四客户端引用统一入口，配置文件不写入。新启动的同一 stdio 包装器执行失败门禁，Pi 通过同一 transport 转发。共享源码与已安装模块需逐字节匹配。

本地 Workspace 完整回归 53/53 通过，含真实 native stdio 六种参数门禁；Core 与 Pi 的适用本地校验已通过。OpenCode 的共享回归、verify:dist 与 typecheck 通过，但本机完整 Bun 产品测试出现 Windows 文件占用及 Bun 1.3.10 integer overflow 崩溃，不能宣称本地完整通过；对应精确提交 CI 与真实宿主 E2E 通过。没有因此改产品脚本、放宽断言或升级本机工具。

两个 adapter 的固定 core provenance 保持 8e155e0efe90f1e9e7c8e973239c206a97011477，与既有 core/main 的差异为原有事实；本轮无产品 Core 变更，不重编 dist。版本、tag、Release 与四个 main 均保持原状态。

## 验证边界

1. ready 是 `remote_verified_at` 的事实；GitHub main 此后仍可继续前进。正数预算耗尽必失败，wait_ms=0 只允许立即尝试、不等待发布或循环追赶变化。
2. Git common 锁约束这套客户端；外部编辑器/直接 Git 不参与锁。修改前后的状态保护、CAS、正常 Git 切换及最终回读负责检测冲突；不使用 force、reset --hard、clean 或 stash。
3. 新任务主动调用 prepare 仍依赖 AGENTS/代理约定；MCP 不知道宿主的新任务边界，不能拦截任意 shell/编辑器。四客户端配置核验、实际 native stdio 与 Pi loader 证据不能替代四宿主逐提示词强制拦截；现有已连接宿主的热重载不在本轮验证内。
4. GitHub [默认 concurrency 语义](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) 已核对，发布器实际 Git 并发已测；PR 保持未合并，本轮没有在真实远端 main 运行新版发布/Release 工作流。不可恢复的网络/权限失败须重跑失败工作流，不能称为 ready。旧的无隔离来源证明快照保持不可变，新 verify 不将其声明为 ready。
5. 本地日志与历史控制副本保留于被忽略的 `.tmp/`；Windows 的临时文件占用曾导致清理/生成失败，测试自身清理使用有界重试，断言保持原强度。产品构建脚本未因此改动；产品完整门禁以对应精确 head CI 的 Linux 实际结果核验。本轮不连接真实 LiteLLM、不改宿主凭据、不发布产品。
