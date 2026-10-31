# CI/E2E 审计与实施验收（2026-10-31）

结论：OpenCode 的慢主要来自串行自然刷新链，不是安装或排队。把独立因果链放到四个真实隔离宿主后，完整覆盖的同条件对照关键路径由806秒降到296–302秒；加入当前交付探针/实际输入复用并取消无用harness安装后的最终完整运行为351秒（5分51秒）；中间368/363秒作为阶段数据保留，不混作最终口径。真实版本元数据PR已验证可保留常规CI与当前交付、复用完整基线，E2E分支55秒；并未减少CI触发次数。Pi tag Release继续完整E2E。

本次四仓均只开草稿PR，不合并、打tag或发布。主分支规则不改。正式生效顺序为[Core #40](https://github.com/rpchen/litellm-discovery-core/pull/40) → [OpenCode #74](https://github.com/rpchen/opencode-litellm-provider/pull/74) / [Pi #64](https://github.com/rpchen/pi-litellm-provider/pull/64) → [Workspace #4](https://github.com/rpchen/litellm-provider-workspace/pull/4)。最终CI与临时验收清理状态见第4节；未完成项不当作已通过。

## 1. 基线、流程与统一计时口径

开工重新核对的main：OpenCode `bdd64df970a6001b35f55ecee6b2efb25d3a0324`（v0.11.2）、Pi `909734e07d786821e3ea6ce23ac9aa3fdb6780da`（最新v0.11.1 tag为`7c0367e`）、Core `1ff0979c8f22ec06479331d94ced2cf466f1fd42`；两个adapter的Core provenance均固定该Core SHA，工作区初始干净。审计、分组、分流均没有改产品src/dist/fixtures或更新Core业务SHA。后续临时验收候选的版本号不是新Release。

CI由PR/main事件触发：常规CI与真实宿主E2E并行，不能相加当整轮等待。queue指Actions创建到首次job启动；job含checkout、安装、测试和清理；E2E step不含宿主环境安装；run wall是整条运行时长。表中均为秒，只有同列同边界可直接比较。

| OpenCode阶段 | run | queue | 常规CI job | E2E job | E2E step | run wall |
|---|---|---:|---:|---:|---:|---:|
| 修复PR #72 | [41156193640](https://github.com/rpchen/opencode-litellm-provider/actions/runs/41156193640) | 2 | 111 | 816 | 790 | 820 |
| 修复合入main | [41160301361](https://github.com/rpchen/opencode-litellm-provider/actions/runs/41160301361) | 3 | 111 | 824 | 794 | 829 |
| 版本PR #73 | [41161632034](https://github.com/rpchen/opencode-litellm-provider/actions/runs/41161632034) | 3 | 145 | 823 | 793 | 828 |
| 版本合入main | [41162641853](https://github.com/rpchen/opencode-litellm-provider/actions/runs/41162641853) | 3 | 146 | 791 | 773 | 795 |
| v0.11.2 Release | [41163793076](https://github.com/rpchen/opencode-litellm-provider/actions/runs/41163793076) | 2 | — | — | 无真实宿主E2E | 123（Release job119） |

OpenCode四轮E2E job总3254秒（54分14秒），不含各轮排队；不能与Pi的净测试step总和对比。main版本轮的环境分解：checkout约1.5秒、Node setup约1.2秒、npm ci约6.1秒、解析latest约0.45秒、全局宿主安装约6秒；脚本内真实plugin add约18.7秒、7次server重启约21秒已经包含在E2E step中，不能再加一次。被审计成功轮宿主2.2.5、Node22.23.4；常规CI另用Node22.14.0/Bun1.3.10。

| Pi阶段 | run | queue | 常规CI job | E2E job | E2E step | run wall |
|---|---|---:|---:|---:|---:|---:|
| 修复PR #61 | [39559548133](https://github.com/rpchen/pi-litellm-provider/actions/runs/39559548133) | 3 | 73 | 64 | 50 | 76 |
| 修复合入main | [39570965709](https://github.com/rpchen/pi-litellm-provider/actions/runs/39570965709) | 3 | 88 | 67 | 51 | 91 |
| 版本PR #62 | [39577133736](https://github.com/rpchen/pi-litellm-provider/actions/runs/39577133736) | 3 | 91 | 95 | 81 | 99 |
| 版本合入main | [39577630365](https://github.com/rpchen/pi-litellm-provider/actions/runs/39577630365) | 3 | 97 | 95 | 81 | 100 |
| v0.11.1 Release | [39578106459](https://github.com/rpchen/pi-litellm-provider/actions/runs/39578106459) | 3 | — | 单Release job180 | 82 | 184 |

Pi历史E2E job中宿主安装4–5秒、Node setup4–5秒、checkout约1秒；常规CI npm ci为4–7秒。Release是串行job，包含npm ci6秒、宿主安装4秒、真实E2E82秒及打包/tag/附件/索引职责。五轮测试step合计345秒；这不是五条job或run之和。以上历史Pi均0.87.1/Node22.19.0/Bun1.3.10；后续main已改latest，实施中解析到Pi1.4.0，不能把两版本耗时差直接归功于本次分流。

## 2. 重复输入与必须重跑的边界

| 对比 | 已核实相同/允许差异 | 不同或仍需确认 | 处理 |
|---|---|---|---|
| OpenCode修复PR→修复main | `2f40263`/`b5a25e0`及后续版本点的src/test、E2E脚本和ci.yml blob一致 | commit身份不同，PR实际checkout为merge ref；历史未记录完整安装锁 | 新机制分别比较candidate/harness完整Git树，不能只看相同SHA或PR标题 |
| OpenCode版本PR #73→main | 仅manifest/lock根version、runtime identity pluginVersion、README/current notes；其他dist/provenance一致 | PR #73实测checkout `c3a4ab5`，安装head为`ddf19da`；精确宿主之外的旧安装依赖证据缺失 | 历史run不追认为新可复用基线；先新跑完整四组 |
| Pi修复PR #61→main | adapter src未改，Core更新含blocked过滤与固定fixture | E2E本身增加blocked场景，provenance和编入产物改变 | 新产品/测试输入，必须完整验证；“无src变化”不能跳过 |
| Pi版本PR #62→main | manifest/lock、identity版本和README/notes，其他产品字节一致 | 每轮解析宿主和实际peer/安装环境原无完整机器记录 | 当前交付必须真实安装加载/身份/注册/请求，匹配新完整基线后才复用矩阵 |
| main→tag Release | Pi版本main/tag同commit；OpenCode也从固定发布提交交付 | Pi的pi install tag解析路径仅真实Release E2E覆盖；附件与tag/版本/归档路径有发行责任 | 本轮保留Pi tag完整E2E及两仓所有Release步骤，不跨Release复用 |

同一个PR追加版本准备commit仍触发CI；把发行准备放进同PR本身不减少触发次数。可以在产品完成时一并准备版本元数据，减少维护者操作，但本方案的收益来自单轮提速和实际输入复用，不给这种组织方式虚构轮数收益。

每轮仍解析一次latest并生成普通私有npm host manifest/lock；不同host、锁、Node/npm、OS/arch、runner image或配置都完整跑。外部依赖也要来自实际宿主安装副本：OpenCode读npm generation锁，Pi核实真实Git clone与宿主loader提供peer；不把仓库dev lock当运行时证明。OpenCode postinstall还可能按CPU/libc选择平台包，因此比较实际PATH执行文件摘要。不同/缺证据不阻断完整测试，但禁止复用。

## 3. OpenCode单轮瓶颈与改法

原日志可见约555–558次CLI派生；单次CLI通常约74–87ms。19个需新发现的等待累计约505秒，平均26.6秒；脚本持续观测宿主30秒自然刷新，下一段常从刷新结束重新等待下一周期。GET registry等待另约74秒。密集轮询间隔并不等于可删掉的无效CPU工作，缩短1秒sleep不能凭空省500秒；强制trigger会跳过TTL/backoff，削弱LKG与自然恢复证明，未采用。

Pi用持久RPC事件流，宿主按需refreshModels；其30秒常量不等于E2E必须睡30秒。两仓单轮差异首先是机制，不能简单归为runner快慢。

采用四个独立真实HOME/XDG/宿主/fake服务：A保留安装/凭据/激活/冷启动snapshot/63次真实模型请求/blocked/管理→legacy→ghostless历史状态；B价格/LKG；C元数据恢复与删除修复；D通知/真实重启/500与401恢复。每组真实重建所需前置，不写snapshot/ack伪造状态，不改产品timer、TTL或退避。原189条OpenCode assert仅一条改成await读取，Pi164条全部保留；文本比较仅是辅助证据，真实运行另验。

新增group/phase/wait/CLI计时，能把安装、自然等待、场景和清理分开。phase嵌套不可相加当墙钟。真实CI又定位到A管理重启的一次同步CLI耗14.5秒，阻塞同进程fake服务；仅该处改相同HTTP route/body/auth的异步请求，保留全部后续TUI断言并单独计时。后续完整运行41179401172已测得此调用355ms，management从45.3降到31.0秒；整轮还受resolve与环境方差影响。

## 4. 实施验收与收益（实测/待完成分开）

| 验收 | 证据 | 结果 |
|---|---|---|
| 同输入旧串行1轮/完整四组2轮 | [41173828296](https://github.com/rpchen/opencode-litellm-provider/actions/runs/41173828296)、[41173813192](https://github.com/rpchen/opencode-litellm-provider/actions/runs/41173813192)，candidate facb0c0、同host lock/Node/npm | 关键路径806→296/302秒，约63%减少；runner总804→976/984秒，增加约21–22%，不是费用节省证明 |
| 加入分流后的OpenCode完整基线 | [41178587569](https://github.com/rpchen/opencode-litellm-provider/actions/runs/41178587569)，candidate5069db5 | full/四组complete；resolve53秒，关键368秒，runner1058秒。略超原4–6分钟工程目标，后续A阻塞修复待测 |
| OpenCode真实PR版本元数据 | [41179240839](https://github.com/rpchen/opencode-litellm-provider/actions/runs/41179240839)，candidate40279ae、merge harness83e33db | delivery成功，17秒真实探针；正确引用41178587569/1，四组明确skipped；E2E关键55秒、常规CI128秒，两required通过；未产出新full基线，禁止递归 |
| Pi修复后的完整基线 | [41179193705](https://github.com/rpchen/pi-litellm-provider/actions/runs/41179193705)，candidate05dd726、merge harness534bfed | 两required成功，full/complete；已修浅checkout缺少current PR head问题；原临时候选CRLF失败不计正例 |
| Pi同PR追加提交复用 | [41179482645](https://github.com/rpchen/pi-litellm-provider/actions/runs/41179482645)，candidate03c037b、merge harnessb85df2e | delivery成功，探针3.762秒、host job25秒、常规CI74秒；引用41179193705/1，full步骤skipped，未产出full基线 |
| OpenCode实际B失败传播 | [41179266423](https://github.com/rpchen/opencode-litellm-provider/actions/runs/41179266423)，临时candidate d127c72 | B failure、A/C/D success，唯一required aggregate failure；整体非success，既有main-only/success索引条件不满足 |
| OpenCode异步调用完整验收 | [41179401172](https://github.com/rpchen/opencode-litellm-provider/actions/runs/41179401172)，candidatee114658 | 全组/常规CI成功、基线full/complete，调用14.5秒→355ms；关键363秒，runner1045秒；最终删除多余harness安装另待CI |
| Pi当前交付失败阻断 | [41179734333](https://github.com/rpchen/pi-litellm-provider/actions/runs/41179734333)，仅临时candidate0a8f921注入故障 | delivery步骤失败→必需host check失败，常规CI成功，无旧绿绕过；故障代码未进入实现分支 |
| Pi归档后最终提交 | [41180384221](https://github.com/rpchen/pi-litellm-provider/actions/runs/41180384221)，64ef863/merge41a8ed8 | 两required通过；full/complete基线回读通过 |
| Core归档后最终提交 | [41180398732](https://github.com/rpchen/litellm-discovery-core/actions/runs/41180398732)，e04b78e | 必需CI通过；仅政策/规格，无产品API或dist变更 |
| OpenCode归档后最终提交 | [41180343410](https://github.com/rpchen/opencode-litellm-provider/actions/runs/41180343410)，9a0530b/merge8cacf36，无harness开发依赖安装 | 两required及A–D通过，full/complete；关键351秒、含排队run354秒、runner994秒 |

最终OpenCode分解：初始queue3秒；resolve60秒（宿主解析/安装10秒、真实交付探针22秒、规划15秒、helper测试2秒，其余checkout/setup/上传）；A/B/C/D job277/183/215/252秒，实际E2E step259/169/200/238秒，宿主锁安装各5–8秒；aggregate7秒，各依赖组启动queue2–3秒。harness开发包安装已取消，但宿主安装与脚本内真实plugin add均保留，plugin add时间已包含在测试step内。常规CI126秒并行运行，不与E2E相加。A管理重启开selector实测327ms；自然刷新和整条恢复链不缩减。

最终完整分支351秒较串行对照806秒少455秒（约56%）；相关runner总994秒较804秒多190秒（约24%），不能当费用节省。旧串行精确同candidate/锁对照为phase2数据；最终候选的宿主、实际依赖/环境与harness分别记录，不追认历史缺失的安装依赖证据为字节等价。上述数据是本轮观测，非未来所有latest版本的时长保证。

Codex gpt-6-astra独立代码审核指出Pi浅checkout问题和过时说明；父会话加fetch-depth0、修正文档，删除无实际旧基线支持的Pi旧步骤名兼容和递归artifact查找。没有要求或新增独立证明平台。最终helper130项及其中基线模块50项通过；取消/意外skipped/缺组/错attempt/不完整或递归基线均有负向。OpenCode实际组失败传播已由41179266423证明；Pi当前交付失败也由41179734333实际阻断。三个临时验收PR65/75/76及本次分支/worktree均已关闭清理。

## 5. 保留职责、限制与下一步

required check名称与strict规则保持，常规CI每个PR/main执行；main索引仍等待整条准确main CI成功并发布该SHA快照，不引用PR旧索引冒充新main。未授权合并，故不提前声称finish或新main索引发布完成。Core只改共享测试政策，无API或业务源码变化，不需要重建adapter dist/provenance。

Release附件一致性不因分流减少：Pi tag完整真实E2E保留；Pi package tarball/checksum下载与解包dist核对仍是发行验收责任，现有自动化回读索引快照不等于已覆盖包附件。OpenCode当前Release没有真实宿主E2E，本轮没有声称已有或另加该门禁。两个Release工作流均未修改。

实际节省取决于命中比例和输入漂移，不能把每次主分支合并或所有版本PR一概按可复用计算；宿主latest、依赖或runner image变化会完整重跑。历史无完整host/dependency证据的运行不能追认。费用账单、队列未来波动与整台VM字节等价未经证明，不给保证。最终性能已按包含probe/plan的9a0530b运行回填，不能用旧串行比较夸大新增分流后的收益。

最终交付状态：三个产品仓库的归档后准确头均已通过所需CI；工作区正式报告提交的最终检查以关联[Workspace #4](https://github.com/rpchen/litellm-provider-workspace/pull/4)的head为准。所有源代码PR保持Draft，不自动合并。
