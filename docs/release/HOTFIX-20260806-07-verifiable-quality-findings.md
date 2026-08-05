# HOTFIX-20260806-07 可验证的质检问题

## 生产证据

- 部署 `f55c9f3` 后，两次百家号质量重写都把质量报告 `f72b517f-c4d1-4db7-adc1-d43ba414d4e2` 的同一组问题传给模型，模型均原样返回并被内容哈希守卫拒绝。
- `brand.other_company_name` 指向 `blocks[0].text`，但该位置没有公司名；全文唯一企业名称“广州志远搬家服务有限公司”属于允许名称。
- `fact.high_risk.unsupported` 同样指向 `blocks[0].text`，但该次质检输入的六个 `fact_results` 全部为 `supported`；唯一高风险事实也是 `supported`，不存在可对应的 `unsupported` 或 `conflicted` claim。
- 两个问题缺少可执行目标，导致 Content Writer 无法按报告完成实质修改。

## 根因

- Quality Checker 的输出断言只确保必须阻断的问题不会漏报，没有拒绝模型额外生成的无依据阻断问题。
- 公司名称问题未写出具体名称时，确定性合并逻辑仍会保留该问题，错误位置和通用描述因此进入不可变质量报告。
- 高风险无支持事实问题没有强制关联 `fact_results` 中的 `claim:<claim_key>`，模型可以虚构普通正文块位置。

## 修复

- `brand.other_company_name` 必须为 `brand/BLOCK`，消息必须引用具体禁止名称，且名称必须真实出现在所声明的标题、摘要或正文块位置。
- `fact.high_risk.unsupported` 和 `fact.high_risk.unsupported_or_conflicted` 必须为 `fact/BLOCK`，并且只能关联输入中真实存在的 high/critical、unsupported/conflicted `claim:<claim_key>`。
- 不可验证的模型输出以 `SKILL_OUTPUT_INVALID` 拒绝，沿用现有 Quality Checker 语义重试；重试提示明确要求真实名称、真实位置和真实 claim。
- 确定性风险合并不再保留没有具体名称的模型公司问题；真实禁止名称仍由现有确定性扫描和可验证模型问题阻断。

## 安全边界

- 服务端不把无依据问题静默改写成通过结论，也不伪造新的模型质量结论；模型必须重新返回完整且可验证的质检结果。
- 第二次模型质检仍不可验证时继续失败，不落库虚假问题，也不自动放行。
- 冻结 GEO 分数、警告阈值、百家号质量门禁、确定性风险规则和最多重写次数均不变。
- 旧质量报告保持不可变，不会自动重新评估；部署后需要对当前内容版本重新发起质检。

## 部署与验收

- 重新构建并部署 AI Worker；无需数据库迁移、API 或 Web 变更。
- 以无公司名且全部事实均受支持的内容回归时，Quality Checker 不得持久化通用公司名阻断或虚构的高风险事实阻断。
- 以正文真实包含禁止名称的内容回归时，具体名称和准确位置仍必须产生阻断。
- 以真实 high/critical 且 unsupported/conflicted 的 `fact_results` 回归时，对应 `claim:<claim_key>` 仍必须产生阻断。
