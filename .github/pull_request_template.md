## 变更说明

<!-- 说明变更目的、行为差异和必要的迁移步骤。 -->

## 涉及的仓库

- [ ] litellm-discovery-core：<!-- PR 链接，或写"不涉及" -->
- [ ] opencode-litellm-provider：<!-- PR 链接，或写"不涉及" -->
- [ ] pi-litellm-provider：<!-- PR 链接，或写"不涉及" -->

合入顺序：<!-- 例如：core → opencode → pi -->

## 验证清单

- [ ] 受影响子仓库的相关 OpenSpec change 已在对应子仓库内更新并通过 `openspec validate --all --strict --no-interactive`，或本变更不影响任何子仓库规格
- [ ] `workspace.json` 中的校验命令与各子仓库 AGENTS.md 保持一致（如适用）
- [ ] 未提交真实 LiteLLM 地址、API Key、PAT、npm token 或其他秘密
- [ ] 没有把子仓库文件提交进总仓库
