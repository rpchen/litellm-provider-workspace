---
name: project-retrospective
description: Close a significant task or session in the LiteLLM Provider workspace by checking for overfitting, drift, leftovers, and knowledge capture.
---

# project-retrospective：任务/会话收尾检查

在一个重要任务或会话结束前执行。目的：发现"规范已写但实现只覆盖特例"的缺口、各类漂移与残留，并把长期经验沉淀进正确的权威文件——而不是依赖 AI 会话记忆。

## 检查清单

1. **特例过拟合**：本次修的 bug 是否被错误地只做成"某个模型 / 某个 endpoint / 某个 UI"的特例（硬编码名称、只针对具体模型的测试）？
2. **是否应抽象为通用不变量**：同类问题是否应该变成通用规则/不变量（如"limit ≤ 0 的模型不得注册给宿主"），放在正确层（通常是 core 语义 + adapter 通用门禁测试），而不是散落特判。
3. **规范 vs 实现**：是否存在"规范已写（各子仓库的 OpenSpec spec / testing-standard / AGENTS.md），代码却只覆盖特例"的缺口？有则补通用测试或修正文档，不得宣称已完成。
4. **README 漂移**：涉及用户可见行为变更的仓库，README 当前版本/安装示例是否已同步？无变化时 PR 是否声明了 `No README change`？
5. **OpenSpec 漂移（各子仓库）**：已完成的 change 是否已 archive 并同步 canonical specs？是否执行过 `openspec validate --all --strict --no-interactive`（在对应子仓库内）？tasks 状态与实际证据是否一致（没有谎报的 checkbox）？
6. **`dist/core-provenance.json` 漂移**：两个插件编入的 core SHA 是否等于本次 change 最终合入的 core SHA？是否与 core `main` HEAD 一致？不一致且非本次范围时，记录为待办。
7. **version / tag / Release 漂移**：合入 `feat:`/`fix:` 的子仓库，`package.json` 版本、tag、GitHub Release 是否落后于 `main`？（落后则提醒发版；不自行打 tag。）
8. **残留物**：是否残留临时 workflow / 分支 / generated 文件 / `.tmp` 外的草稿 / 未清理的临时自动化？该删的删（仅限本次会话自己创建的），该保留的移到正确位置。
9. **知识沉淀**：本次新获得的长期有效经验是否已写入正确的权威文件？
   - 子仓库实现/测试经验 → 该子仓库的 `docs/`、`AGENTS.md` 或 testing-standard（core）；
   - 跨仓库流程/结构经验 → workspace 总仓库的 `docs/`（如 `docs/decisions.md`、`docs/architecture.md`）、根 `AGENTS.md` 或 `.agents/skills/`；
   - 没写进文件的结论视为会丢失，不得只留在聊天记录里。

## 输出格式

- 逐项检查结果（通过 / 发现问题 + 所在仓库）；
- 发现的漂移与缺口清单：本次修复了哪些、哪些记录为后续治理事项（不顺手修改超范围内容）；
- 本次任务各仓库的完成状态：整体是否闭环；未闭环项逐条列出。

## 边界

- 本 skill 不修改子仓库的产品代码；发现的问题超出本次任务范围时只记录。
- 不自行合并 PR、打 tag、创建 Release、推送 main；发版前向用户确认。
- 完成标准以各仓库自己的 `AGENTS.md` 与 `litellm-discovery-core/docs/testing-standard.md` 为准。