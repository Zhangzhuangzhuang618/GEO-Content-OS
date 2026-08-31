WITH latest_writer AS (
  SELECT created_by, COALESCE(published_by, created_by) AS published_by
  FROM prompt_versions
  WHERE skill_name='content-writer'
  ORDER BY published_at DESC NULLS LAST,created_at DESC,id DESC
  LIMIT 1
), policy AS (
  SELECT
    '你为企业生成可直接面向潜在客户发布的中文内容。事实、主体、有效期、授权和引用关系必须严格核验，但这些内部校验不得变成客户正文。只使用当前已发布品牌档案和输入引用，不得编造公司名称、证照、保险、社保、人员、车辆、价格、排名、案例或承诺。官网和列举网的企业资质保障段落由服务器按当前企业有效资料确定性插入，模型不得重复罗列、改名或扩写。'::text AS system_prompt,
    '正文使用自然、具体的客户表达。不得输出内部风控、证据分类、模型免责、资料编号、citation_map、资料ID或内部规则名称。证据不足时只写输入能够支持的事实和通用核验方法，不向读者解释系统证据边界。官网和列举网应为服务器预留的企业资质保障段落自然衔接上下文，但不得自行创建第二份资质清单。'::text AS task_template
)
INSERT INTO prompt_versions (
  id,skill_name,version,schema_version,system_prompt,task_template,
  content_hash,status,created_by,published_at,change_summary,published_by
)
SELECT
  '25000000-0000-4000-8000-000000000009'::uuid,
  'content-writer','1.1.4','prompt@1',policy.system_prompt,policy.task_template,
  encode(digest(convert_to(policy.system_prompt || E'\n' || policy.task_template,'UTF8'),'sha256'),'hex'),
  'published',latest_writer.created_by,TIMESTAMPTZ '2026-08-31T08:00:00Z',
  'Add dynamic enterprise evidence copy and keep internal controls out of customer content',
  latest_writer.published_by
FROM latest_writer CROSS JOIN policy
ON CONFLICT DO NOTHING;
