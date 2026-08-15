import { DomainEventEnvelopeSchema } from '@geo-content-os/contracts';
import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';

import type { OfficialSiteAutomationConfig } from './config.js';
import type { JsonObject } from './generation.types.js';

type Platform = 'lieju' | 'sohu';

interface BatchRow {
  readonly accountId: string;
  readonly businessDate: string;
  readonly candidateLimit: number;
  readonly createdBy: string;
  readonly id: string;
  readonly platformCode: Platform;
  readonly policyId: string;
  readonly projectId: string;
  readonly targetCount: number;
  readonly tenantId: string;
  readonly version: number;
  readonly workspaceId: string;
}

interface Seed {
  readonly account: {
    readonly capabilities: JsonObject;
    readonly displayName: string;
    readonly id: string;
    readonly providerAccountId: string | null;
    readonly timezone: string;
  };
  readonly brand: { readonly id: string; readonly profile: JsonObject; readonly version: number };
  readonly citations: readonly {
    readonly chunkId: string;
    readonly quoteText: string;
    readonly sourceId: string;
  }[];
  readonly keywords: readonly { readonly id: string; readonly term: string }[];
  readonly rule: { readonly hash: string; readonly id: string; readonly rules: JsonObject };
}

export class BrowserPlatformDailyScheduler {
  private currentTick: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  public constructor(
    private readonly client: postgres.Sql,
    private readonly config: OfficialSiteAutomationConfig,
    private readonly options: {
      readonly onError?: (error: Error) => void;
      readonly tickMs: number;
    },
  ) {}

  public start() {
    if (this.timer) return;
    this.runTick();
    this.timer = setInterval(() => this.runTick(), this.options.tickMs);
    this.timer.unref();
  }

  public async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.currentTick;
  }

  public async tick() {
    await this.ensureBatches();
    await this.expireBatches();
    const rows = await this.client<{ id: string }[]>`
      SELECT batch.id FROM browser_platform_daily_batches AS batch
      JOIN browser_platform_automation_policies AS policy
        ON policy.id=batch.policy_id AND policy.tenant_id=batch.tenant_id
        AND policy.enabled AND policy.daily_enabled
      WHERE batch.status='running'
      ORDER BY batch.business_date,batch.id
    `;
    for (const row of rows) await this.processBatch(row.id);
  }

  private runTick() {
    if (this.currentTick) return;
    const promise = this.tick()
      .catch((error: unknown) =>
        this.options.onError?.(
          error instanceof Error ? error : new Error('Browser platform scheduler failed'),
        ),
      )
      .finally(() => {
        if (this.currentTick === promise) this.currentTick = null;
      });
    this.currentTick = promise;
  }

  private async ensureBatches() {
    await this.client`
      INSERT INTO browser_platform_daily_batches (tenant_id,policy_id,business_date)
      SELECT policy.tenant_id,policy.id,(now() AT TIME ZONE policy.daily_timezone)::date
      FROM browser_platform_automation_policies AS policy
      JOIN platform_accounts AS account
        ON account.id=policy.account_id AND account.tenant_id=policy.tenant_id
        AND account.workspace_id=policy.workspace_id AND account.platform_code=policy.platform_code
        AND account.status='active' AND account.publish_mode='api' AND account.deleted_at IS NULL
      JOIN projects AS project
        ON project.id=policy.project_id AND project.tenant_id=policy.tenant_id
        AND project.workspace_id=policy.workspace_id AND project.status='active'
        AND project.deleted_at IS NULL
      WHERE policy.enabled AND policy.daily_enabled
        AND (now() AT TIME ZONE policy.daily_timezone)::time >= policy.daily_generation_time
      ON CONFLICT DO NOTHING
    `;
  }

  private async expireBatches() {
    await this.client`
      UPDATE browser_platform_daily_batches AS batch SET status='attention_required',
        last_error_json=jsonb_build_object(
          'code','DAILY_BATCH_DAY_ENDED','message','当天未完成目标内容，批次已停止。',
          'schema_version','browser-platform-daily-error@1'
        ),version=batch.version+1
      FROM browser_platform_automation_policies AS policy
      WHERE policy.id=batch.policy_id AND policy.tenant_id=batch.tenant_id
        AND batch.status='running'
        AND batch.business_date < (now() AT TIME ZONE policy.daily_timezone)::date
    `;
  }

  private processBatch(batchId: string) {
    return this.client.begin(async (transaction) => {
      const rows = await transaction<BatchRow[]>`
        SELECT batch.id,batch.tenant_id AS "tenantId",batch.business_date::text AS "businessDate",
          batch.version,policy.id AS "policyId",policy.workspace_id AS "workspaceId",
          policy.project_id AS "projectId",policy.account_id AS "accountId",
          policy.platform_code AS "platformCode",policy.created_by AS "createdBy",
          policy.daily_target_count AS "targetCount",
          policy.daily_candidate_limit AS "candidateLimit"
        FROM browser_platform_daily_batches AS batch
        JOIN browser_platform_automation_policies AS policy
          ON policy.id=batch.policy_id AND policy.tenant_id=batch.tenant_id
          AND policy.enabled AND policy.daily_enabled
        WHERE batch.id=${batchId}::uuid AND batch.status='running'
        FOR UPDATE OF batch,policy
      `;
      const batch = rows[0];
      if (!batch) return;
      await retireFailed(transaction, batch);
      const counts = await transaction<
        { attempted: number; inProgress: number; qualified: number }[]
      >`
        SELECT count(*)::integer AS attempted,
          count(*) FILTER (WHERE status IN (
            'generating','quality_check','rewriting','media_pending'
          ))::integer AS "inProgress",
          count(*) FILTER (WHERE status IN ('scheduled','processing','published'))::integer AS qualified
        FROM browser_platform_daily_batch_items
        WHERE tenant_id=${batch.tenantId}::uuid AND batch_id=${batch.id}::uuid
      `;
      const count = counts[0] ?? { attempted: 0, inProgress: 0, qualified: 0 };
      if (count.qualified >= batch.targetCount) return;
      if (count.attempted >= batch.candidateLimit && count.inProgress === 0) {
        await attention(
          transaction,
          batch,
          'DAILY_CANDIDATE_LIMIT_REACHED',
          `当天已尝试 ${batch.candidateLimit} 篇，仍未获得 ${batch.targetCount} 篇合格内容。`,
        );
        return;
      }
      const requiredCount = Math.min(
        batch.targetCount - count.qualified - count.inProgress,
        batch.candidateLimit - count.attempted,
        2 - count.inProgress,
      );
      if (requiredCount <= 0) return;
      let seed: Seed;
      try {
        seed = await loadSeed(transaction, batch);
      } catch (error) {
        await attention(
          transaction,
          batch,
          'AUTOMATION_PREREQUISITE_MISSING',
          error instanceof Error ? error.message : '自动化前置资料缺失。',
        );
        return;
      }
      for (let offset = 1; offset <= requiredCount; offset += 1) {
        await createCandidate(transaction, batch, seed, count.attempted + offset, this.config);
      }
    });
  }
}

async function retireFailed(transaction: postgres.TransactionSql, batch: BatchRow) {
  const failure = JSON.stringify({
    code: 'GENERATION_FAILED_RETIRED',
    schema_version: 'browser-platform-automation-error@1',
  });
  await transaction`
    UPDATE browser_platform_daily_batch_items AS item SET status='retired',
      last_error_json=${failure}::text::jsonb
    FROM content_variants AS variant
    WHERE item.tenant_id=${batch.tenantId}::uuid AND item.batch_id=${batch.id}::uuid
      AND variant.id=item.variant_id AND variant.tenant_id=item.tenant_id
      AND item.status='generating' AND variant.status='generation_failed'
  `;
  await transaction`
    UPDATE browser_platform_automation_runs AS automation SET status='manual_required',
      last_error_json=${failure}::text::jsonb,finished_at=now(),version=version+1
    FROM browser_platform_daily_batch_items AS item
    WHERE item.tenant_id=${batch.tenantId}::uuid AND item.batch_id=${batch.id}::uuid
      AND item.automation_run_id=automation.id AND automation.tenant_id=item.tenant_id
      AND item.status='retired' AND automation.status IN ('generation_pending','generating')
  `;
}

async function loadSeed(transaction: postgres.TransactionSql, batch: BatchRow): Promise<Seed> {
  const [brands, rules, keywords, citations, accounts] = await Promise.all([
    transaction<Seed['brand'][]>`
      SELECT id,profile_json AS profile,version FROM brand_profiles
      WHERE tenant_id=${batch.tenantId}::uuid AND workspace_id=${batch.workspaceId}::uuid
        AND status='published' ORDER BY version DESC LIMIT 1
    `,
    transaction<Seed['rule'][]>`
      SELECT id,content_hash AS hash,rules_json AS rules FROM platform_rule_versions
      WHERE platform_code=${batch.platformCode} AND status='published'
      ORDER BY published_at DESC NULLS LAST,created_at DESC,id DESC LIMIT 1
    `,
    transaction<Seed['keywords'][number][]>`
      SELECT keyword.id,keyword.term::text AS term FROM keywords AS keyword
      JOIN keyword_sets AS set
        ON set.id=keyword.keyword_set_id AND set.tenant_id=keyword.tenant_id
        AND set.project_id=${batch.projectId}::uuid AND set.status='active' AND set.deleted_at IS NULL
      WHERE keyword.tenant_id=${batch.tenantId}::uuid AND keyword.status='active'
        AND ${batch.platformCode}=ANY(keyword.platform_scope)
      ORDER BY keyword.priority DESC,keyword.id
    `,
    transaction<Seed['citations'][number][]>`
      SELECT chunk.id AS "chunkId",left(chunk.text,1200) AS "quoteText",source.id AS "sourceId"
      FROM source_chunks AS chunk
      JOIN source_documents AS source
        ON source.id=chunk.source_document_id AND source.tenant_id=chunk.tenant_id
      WHERE source.tenant_id=${batch.tenantId}::uuid
        AND source.workspace_id=${batch.workspaceId}::uuid
        AND (source.project_id=${batch.projectId}::uuid OR source.project_id IS NULL)
        AND source.status='active' AND source.deleted_at IS NULL
        AND source.trust_level IN ('verified','normal')
        AND (source.effective_from IS NULL OR source.effective_from<=CURRENT_DATE)
        AND (source.effective_to IS NULL OR source.effective_to>=CURRENT_DATE)
        AND chunk.status='active'
      ORDER BY CASE source.trust_level WHEN 'verified' THEN 0 ELSE 1 END,
        source.updated_at DESC,chunk.chunk_no,chunk.id LIMIT 12
    `,
    transaction<Seed['account'][]>`
      SELECT id,display_name AS "displayName",provider_account_id AS "providerAccountId",
        timezone,capabilities_json AS capabilities FROM platform_accounts
      WHERE id=${batch.accountId}::uuid AND tenant_id=${batch.tenantId}::uuid
        AND workspace_id=${batch.workspaceId}::uuid AND platform_code=${batch.platformCode}
        AND status='active' AND publish_mode='api' AND deleted_at IS NULL LIMIT 1
    `,
  ]);
  const brand = brands[0];
  const rule = rules[0];
  const account = accounts[0];
  if (!brand) throw new Error('请先发布企业品牌资料。');
  if (!rule) throw new Error(`${batch.platformCode} 平台规则尚未发布。`);
  if (!account) throw new Error(`${batch.platformCode} 托管浏览器账号不可用。`);
  if (!keywords.length) throw new Error(`项目没有适用于 ${batch.platformCode} 的关键词。`);
  if (!citations.length) throw new Error('项目没有可用的已解析知识资料。');
  return {
    account,
    brand,
    citations: Object.freeze(citations),
    keywords: Object.freeze(keywords),
    rule,
  };
}

async function createCandidate(
  transaction: postgres.TransactionSql,
  batch: BatchRow,
  seed: Seed,
  candidateNo: number,
  config: OfficialSiteAutomationConfig,
) {
  const keyword = seed.keywords[(candidateNo - 1) % seed.keywords.length]!;
  const angle = ANGLES[(candidateNo - 1) % ANGLES.length]!;
  const maxTitle = batch.platformCode === 'lieju' ? 30 : 72;
  const title = truncate(angle.title(keyword.term), maxTitle);
  const objective = (['education', 'trust', 'awareness'] as const)[(candidateNo - 1) % 3]!;
  const platformInstruction =
    batch.platformCode === 'lieju'
      ? '允许明确介绍本企业服务范围、流程、可核验能力和适用场景，并自然提示通过页面联系方式咨询；正文不得出现电话、微信、QQ、网址、极限词、排名、竞品贬损、虚假价格、虚假资质、虚构案例、客户评价或结果保证。'
      : '不得声明原创，不得伪造热点、排行、亲历或用户评价；发布器会如实勾选 AI 创作标识。';
  const constraints = {
    additional_instructions: [
      `这是 ${batch.businessDate} ${batch.platformCode} 自动批次的第 ${candidateNo} 个候选。`,
      `围绕“${keyword.term}”的“${angle.label}”展开。`,
      '只使用给定品牌资料和引用证据，不得编造价格、规模、资质、排名或承诺。',
      platformInstruction,
    ].join(''),
    cta: batch.platformCode === 'lieju' ? '通过页面联系方式咨询具体需求' : null,
    schema_version: 'brief-constraints@1',
    target_accounts_by_code: {
      [batch.platformCode]: {
        account_id: seed.account.id,
        capabilities: seed.account.capabilities,
        display_name: seed.account.displayName,
        provider_account_id: seed.account.providerAccountId,
        timezone: seed.account.timezone,
      },
    },
  };
  const briefs = await transaction<{ id: string }[]>`
    INSERT INTO briefs (
      tenant_id,workspace_id,project_id,title,objective,audience,platform_codes,
      constraints_json,generation_mode,due_at,created_by
    ) VALUES (
      ${batch.tenantId}::uuid,${batch.workspaceId}::uuid,${batch.projectId}::uuid,${title},
      ${objective},${`正在搜索“${keyword.term}”并需要服务决策信息的用户`},
      ARRAY[${batch.platformCode}]::varchar[],${JSON.stringify(constraints)}::text::jsonb,'draft',
      (${batch.businessDate}::date+interval '1 day'-interval '1 second'),${batch.createdBy}::uuid
    ) RETURNING id
  `;
  const briefId = required(briefs[0]?.id, 'Brief insert failed');
  await transaction`
    INSERT INTO brief_keywords (tenant_id,brief_id,keyword_id,is_primary)
    VALUES (${batch.tenantId}::uuid,${briefId}::uuid,${keyword.id}::uuid,true)
  `;
  const sourceIds = [...new Set(seed.citations.map((citation) => citation.sourceId))];
  await transaction`
    INSERT INTO brief_sources (tenant_id,brief_id,source_document_id,required)
    SELECT ${batch.tenantId}::uuid,${briefId}::uuid,source_id,true
    FROM unnest(${sourceIds}::uuid[]) AS source_id
  `;
  const packages = await transaction<{ id: string }[]>`
    INSERT INTO content_packages (tenant_id,workspace_id,project_id,brief_id,status,created_by)
    VALUES (${batch.tenantId}::uuid,${batch.workspaceId}::uuid,${batch.projectId}::uuid,
      ${briefId}::uuid,'generating',${batch.createdBy}::uuid) RETURNING id
  `;
  const packageId = required(packages[0]?.id, 'Package insert failed');
  const variants = await transaction<{ id: string }[]>`
    INSERT INTO content_variants (
      tenant_id,package_id,platform_code,status,is_required,platform_account_id
    ) VALUES (
      ${batch.tenantId}::uuid,${packageId}::uuid,${batch.platformCode},'generating',true,
      ${batch.accountId}::uuid
    ) RETURNING id
  `;
  const variantId = required(variants[0]?.id, 'Variant insert failed');
  const writerInput: JsonObject = {
    brief: {
      audience: `正在搜索“${keyword.term}”并需要服务决策信息的用户`,
      brief_id: briefId,
      constraints,
      objective,
      platform_codes: [batch.platformCode],
      title,
    },
    citations: seed.citations.map((citation) => ({
      chunk_id: citation.chunkId,
      citation_id: citation.chunkId,
      quote_text: citation.quoteText,
      source_id: citation.sourceId,
    })),
    generation_mode: 'draft',
    locked_blocks: [],
    platform_rules_by_code: {
      [batch.platformCode]: {
        rules: seed.rule.rules,
        rules_hash: seed.rule.hash,
        version_id: seed.rule.id,
      },
    },
    strategy: {
      brand_profile_id: seed.brand.id,
      profile: seed.brand.profile,
      version: seed.brand.version,
    },
  };
  const inputHash = sha256(JSON.stringify(writerInput));
  const requestId = `${batch.platformCode}-daily-${batch.id.slice(0, 8)}-${candidateNo}`;
  const masterRuns = await transaction<{ id: string }[]>`
    INSERT INTO generation_runs (
      tenant_id,workspace_id,project_id,package_id,variant_id,skill_name,skill_version,
      prompt_version_id,model_key,input_hash,request_id
    ) VALUES (
      ${batch.tenantId}::uuid,${batch.workspaceId}::uuid,${batch.projectId}::uuid,
      ${packageId}::uuid,NULL,'content-writer',${config.writerSkillVersion},
      ${config.writerPromptVersionId}::uuid,${config.rewriteModelKey},${inputHash},${requestId}
    ) RETURNING id
  `;
  const variantRuns = await transaction<{ id: string }[]>`
    INSERT INTO generation_runs (
      tenant_id,workspace_id,project_id,package_id,variant_id,skill_name,skill_version,
      prompt_version_id,model_key,input_hash,request_id
    ) VALUES (
      ${batch.tenantId}::uuid,${batch.workspaceId}::uuid,${batch.projectId}::uuid,
      ${packageId}::uuid,${variantId}::uuid,'content-writer',${config.writerSkillVersion},
      ${config.writerPromptVersionId}::uuid,${config.rewriteModelKey},${inputHash},${requestId}
    ) RETURNING id
  `;
  const masterRunId = required(masterRuns[0]?.id, 'Master run insert failed');
  const variantRunId = required(variantRuns[0]?.id, 'Variant run insert failed');
  const automations = await transaction<{ id: string }[]>`
    INSERT INTO browser_platform_automation_runs (
      tenant_id,policy_id,platform_code,variant_id,status
    ) VALUES (
      ${batch.tenantId}::uuid,${batch.policyId}::uuid,${batch.platformCode},
      ${variantId}::uuid,'generation_pending'
    ) RETURNING id
  `;
  const automationRunId = required(automations[0]?.id, 'Automation run insert failed');
  await transaction`
    INSERT INTO browser_platform_daily_batch_items (
      tenant_id,batch_id,candidate_no,automation_run_id,brief_id,package_id,variant_id,status
    ) VALUES (
      ${batch.tenantId}::uuid,${batch.id}::uuid,${candidateNo},${automationRunId}::uuid,
      ${briefId}::uuid,${packageId}::uuid,${variantId}::uuid,'generating'
    )
  `;
  const event = DomainEventEnvelopeSchema.parse({
    aggregate: { id: packageId, type: 'content_package' },
    data: {
      actor_user_id: batch.createdBy,
      input_hash: inputHash,
      master_run_id: masterRunId,
      model_key: config.rewriteModelKey,
      model_policy: 'quality',
      package_id: packageId,
      project_id: batch.projectId,
      prompt_version_id: config.writerPromptVersionId,
      request_id: requestId,
      skill_version: config.writerSkillVersion,
      variant_runs: [
        { platform_code: batch.platformCode, run_id: variantRunId, variant_id: variantId },
      ],
      workspace_id: batch.workspaceId,
      writer_input: writerInput,
    },
    event_id: randomUUID(),
    event_type: 'content.package.generation_requested.v1',
    occurred_at: new Date().toISOString(),
    tenant: { id: batch.tenantId },
  });
  await transaction`
    INSERT INTO outbox_events (id,tenant_id,event_type,aggregate_type,aggregate_id,payload_json)
    VALUES (${event.event_id}::uuid,${batch.tenantId}::uuid,${event.event_type},
      ${event.aggregate.type},${event.aggregate.id}::uuid,${JSON.stringify(event)}::text::jsonb)
  `;
  await transaction`
    INSERT INTO audit_events (
      tenant_id,actor_id,action,resource_type,resource_id,after_json,request_id
    ) VALUES (
      ${batch.tenantId}::uuid,${batch.createdBy}::uuid,
      'browser_platform.daily_candidate.created','content_package',${packageId}::uuid,
      ${JSON.stringify({
        automation_run_id: automationRunId,
        batch_id: batch.id,
        candidate_no: candidateNo,
        platform_code: batch.platformCode,
        title,
      })}::text::jsonb,${requestId}
    )
  `;
}

async function attention(
  transaction: postgres.TransactionSql,
  batch: BatchRow,
  code: string,
  message: string,
) {
  await transaction`
    UPDATE browser_platform_daily_batches SET status='attention_required',
      last_error_json=${JSON.stringify({
        code,
        message,
        schema_version: 'browser-platform-daily-error@1',
      })}::text::jsonb,version=version+1
    WHERE id=${batch.id}::uuid AND tenant_id=${batch.tenantId}::uuid
      AND status='running' AND version=${batch.version}
  `;
}

const ANGLES = Object.freeze([
  { label: '服务选择', title: (keyword: string) => `${keyword}怎么选服务` },
  { label: '准备清单', title: (keyword: string) => `${keyword}前需要准备什么` },
  { label: '流程说明', title: (keyword: string) => `${keyword}服务流程与注意事项` },
  { label: '费用因素', title: (keyword: string) => `${keyword}费用受哪些因素影响` },
  { label: '风险边界', title: (keyword: string) => `${keyword}常见问题与避坑要点` },
  { label: '验收检查', title: (keyword: string) => `${keyword}完成后如何验收` },
]);

function truncate(value: string, maximum: number) {
  return [...value.normalize('NFC').replace(/\s+/gu, ' ').trim()].slice(0, maximum).join('');
}

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function required(value: string | undefined, message: string) {
  if (!value) throw new Error(message);
  return value;
}
