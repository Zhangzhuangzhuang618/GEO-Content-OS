import { DomainEventEnvelopeSchema } from '@geo-content-os/contracts';
import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';

import type { OfficialSiteAutomationConfig } from './config.js';
import type { JsonObject } from './generation.types.js';

const ACTIVE_STATUSES = [
  'pending',
  'adapting',
  'generating',
  'quality_check',
  'rewriting',
  'media_pending',
] as const;
const QUALIFIED_STATUSES = [
  'qualified',
  'scheduled',
  'processing',
  'published',
  'publish_failed',
  'reserve',
] as const;
const MAX_ACTIVE_CANDIDATES = 2;

interface BatchRow {
  readonly accountId: string;
  readonly businessDate: string;
  readonly candidateLimit: number;
  readonly createdBy: string;
  readonly id: string;
  readonly policyId: string;
  readonly projectId: string;
  readonly targetCount: number;
  readonly tenantId: string;
  readonly version: number;
  readonly workspaceId: string;
}

interface BatchCounts {
  readonly attempted: number;
  readonly inProgress: number;
  readonly qualified: number;
}

interface CandidateSeed {
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

export interface BaijiahaoDailySchedulerOptions {
  readonly onError?: (error: Error) => void;
  readonly tickMs: number;
}

export class BaijiahaoDailyScheduler {
  private currentTick: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  public constructor(
    private readonly client: postgres.Sql,
    private readonly automationConfig: OfficialSiteAutomationConfig,
    private readonly options: BaijiahaoDailySchedulerOptions,
  ) {}

  public start(): void {
    if (this.timer) return;
    this.runTick();
    this.timer = setInterval(() => this.runTick(), this.options.tickMs);
    this.timer.unref();
  }

  public async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.currentTick;
  }

  public async tick(): Promise<void> {
    await terminalizeRetiredAutomationRuns(this.client);
    await this.ensureTodayBatches();
    await this.expirePastBatches();
    const rows = await this.client<{ id: string }[]>`
      SELECT batch.id
      FROM baijiahao_daily_batches AS batch
      JOIN baijiahao_automation_policies AS policy
        ON policy.id=batch.policy_id AND policy.tenant_id=batch.tenant_id
        AND policy.enabled AND policy.daily_enabled
        AND (
          policy.source_mode='independent'
          OR (
            policy.source_mode='official_site_derived'
            AND policy.independent_fallback_enabled
            AND (now() AT TIME ZONE policy.daily_timezone)::time >= GREATEST(
              (SELECT min(slot) FROM unnest(policy.daily_schedule_times) AS slot)
                - interval '1 hour',
              TIME '00:00'
            )
          )
        )
      WHERE batch.status='running'
      ORDER BY batch.business_date,batch.id
    `;
    for (const row of rows) {
      try {
        await this.processBatch(row.id);
      } catch (error) {
        if (error instanceof BaijiahaoDailyPrerequisiteError) {
          await this.markAttentionRequired(row.id, error);
          continue;
        }
        throw error;
      }
    }
  }

  private runTick(): void {
    if (this.currentTick) return;
    const promise = this.tick()
      .catch((error: unknown) =>
        this.options.onError?.(
          error instanceof Error ? error : new Error('Baijiahao daily scheduler failed'),
        ),
      )
      .finally(() => {
        if (this.currentTick === promise) this.currentTick = null;
      });
    this.currentTick = promise;
  }

  private async ensureTodayBatches(): Promise<void> {
    await this.client`
      INSERT INTO baijiahao_daily_batches (tenant_id,policy_id,business_date)
      SELECT
        policy.tenant_id,policy.id,(now() AT TIME ZONE policy.daily_timezone)::date
      FROM baijiahao_automation_policies AS policy
      JOIN platform_accounts AS account
        ON account.id=policy.account_id AND account.tenant_id=policy.tenant_id
        AND account.workspace_id=policy.workspace_id AND account.platform_code='baijiahao'
        AND account.status='active' AND account.publish_mode='api' AND account.deleted_at IS NULL
      JOIN projects AS project
        ON project.id=policy.project_id AND project.tenant_id=policy.tenant_id
        AND project.workspace_id=policy.workspace_id
        AND project.status='active' AND project.deleted_at IS NULL
      WHERE policy.enabled AND policy.daily_enabled
        AND (
          (
            policy.source_mode='independent'
            AND (now() AT TIME ZONE policy.daily_timezone)::time >= policy.daily_generation_time
          ) OR (
            policy.source_mode='official_site_derived'
            AND policy.independent_fallback_enabled
            AND (now() AT TIME ZONE policy.daily_timezone)::time >= GREATEST(
              (SELECT min(slot) FROM unnest(policy.daily_schedule_times) AS slot)
                - interval '1 hour',
              TIME '00:00'
            )
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM baijiahao_daily_batches AS existing
          WHERE existing.tenant_id=policy.tenant_id AND existing.policy_id=policy.id
            AND existing.business_date=(now() AT TIME ZONE policy.daily_timezone)::date
        )
      ON CONFLICT DO NOTHING
    `;
  }

  private async expirePastBatches(): Promise<void> {
    await this.client`
      UPDATE baijiahao_daily_batches AS batch SET
        status='attention_required',
        last_error_json=jsonb_build_object(
          'code','DAILY_BATCH_DAY_ENDED',
          'message','当天未能完成百家号目标内容，批次已停止。',
          'schema_version','baijiahao-daily-error@1'
        ),version=batch.version+1
      FROM baijiahao_automation_policies AS policy
      WHERE policy.id=batch.policy_id AND policy.tenant_id=batch.tenant_id
        AND batch.status='running'
        AND batch.business_date < (now() AT TIME ZONE policy.daily_timezone)::date
    `;
  }

  private processBatch(batchId: string): Promise<void> {
    return this.client.begin(async (transaction) => {
      const batch = await lockBatch(transaction, batchId);
      if (!batch) return;
      await retireFailedCandidates(transaction, batch);
      await terminalizeRetiredAutomationRuns(transaction, batch.id);
      const counts = await loadCounts(transaction, batch);
      if (counts.qualified >= batch.targetCount) return;
      if (counts.attempted >= batch.candidateLimit && counts.inProgress === 0) {
        await setAttentionRequired(
          transaction,
          batch,
          'DAILY_CANDIDATE_LIMIT_REACHED',
          `当天已尝试 ${batch.candidateLimit} 篇，仍未获得 ${batch.targetCount} 篇合格内容。`,
        );
        return;
      }
      const required = Math.min(
        batch.targetCount - counts.qualified - counts.inProgress,
        batch.candidateLimit - counts.attempted,
        MAX_ACTIVE_CANDIDATES - counts.inProgress,
      );
      if (required <= 0) return;
      let seed: CandidateSeed;
      try {
        seed = await loadCandidateSeed(transaction, batch);
      } catch (error) {
        if (error instanceof BaijiahaoDailyPrerequisiteError) {
          await setAttentionRequired(transaction, batch, error.code, error.message);
          return;
        }
        throw error;
      }
      for (let offset = 1; offset <= required; offset += 1) {
        await createCandidate(
          transaction,
          batch,
          seed,
          counts.attempted + offset,
          this.automationConfig,
        );
      }
    });
  }

  private async markAttentionRequired(
    batchId: string,
    error: BaijiahaoDailyPrerequisiteError,
  ): Promise<void> {
    await this.client`
      UPDATE baijiahao_daily_batches SET
        status='attention_required',
        last_error_json=${JSON.stringify({
          code: error.code,
          message: error.message,
          schema_version: 'baijiahao-daily-error@1',
        })}::text::jsonb,version=version+1
      WHERE id=${batchId}::uuid AND status='running'
    `;
  }
}

async function lockBatch(
  transaction: postgres.TransactionSql,
  batchId: string,
): Promise<BatchRow | null> {
  const rows = await transaction<BatchRow[]>`
    SELECT
      batch.id,batch.tenant_id AS "tenantId",batch.policy_id AS "policyId",
      batch.business_date::text AS "businessDate",batch.version,
      policy.workspace_id AS "workspaceId",policy.project_id AS "projectId",
      policy.account_id AS "accountId",policy.created_by AS "createdBy",
      policy.daily_target_count AS "targetCount",
      policy.daily_candidate_limit AS "candidateLimit"
    FROM baijiahao_daily_batches AS batch
    JOIN baijiahao_automation_policies AS policy
      ON policy.id=batch.policy_id AND policy.tenant_id=batch.tenant_id
      AND policy.enabled AND policy.daily_enabled
      AND (
        policy.source_mode='independent'
        OR (
          policy.source_mode='official_site_derived'
          AND policy.independent_fallback_enabled
          AND (now() AT TIME ZONE policy.daily_timezone)::time >= GREATEST(
            (SELECT min(slot) FROM unnest(policy.daily_schedule_times) AS slot)
              - interval '1 hour',
            TIME '00:00'
          )
        )
      )
    JOIN platform_accounts AS account
      ON account.id=policy.account_id AND account.tenant_id=policy.tenant_id
      AND account.status='active' AND account.publish_mode='api' AND account.deleted_at IS NULL
    WHERE batch.id=${batchId}::uuid AND batch.status='running'
    FOR UPDATE OF batch,policy
  `;
  return rows[0] ?? null;
}

async function loadCounts(
  transaction: postgres.TransactionSql,
  batch: BatchRow,
): Promise<BatchCounts> {
  const rows = await transaction<BatchCounts[]>`
    SELECT
      (
        SELECT count(*)::integer FROM baijiahao_daily_batch_items AS current_item
        WHERE current_item.tenant_id=${batch.tenantId}::uuid
          AND current_item.batch_id=${batch.id}::uuid
      ) AS attempted,
      (
        SELECT count(*)::integer FROM baijiahao_daily_batch_items AS current_item
        WHERE current_item.tenant_id=${batch.tenantId}::uuid
          AND current_item.batch_id=${batch.id}::uuid
          AND current_item.status=ANY(${[...ACTIVE_STATUSES]}::varchar[])
      ) AS "inProgress",
      count(*) FILTER (WHERE item.status=ANY(${[...QUALIFIED_STATUSES]}::varchar[]))::integer
        AS qualified
    FROM baijiahao_daily_batches AS day_batch
    JOIN baijiahao_daily_batch_items AS item
      ON item.batch_id=day_batch.id AND item.tenant_id=day_batch.tenant_id
    WHERE day_batch.tenant_id=${batch.tenantId}::uuid
      AND day_batch.policy_id=${batch.policyId}::uuid
      AND day_batch.business_date=${batch.businessDate}::date
  `;
  return rows[0] ?? { attempted: 0, inProgress: 0, qualified: 0 };
}

async function retireFailedCandidates(
  transaction: postgres.TransactionSql,
  batch: BatchRow,
): Promise<void> {
  await transaction`
    UPDATE baijiahao_daily_batch_items AS item SET
      status='retired',last_error_json=jsonb_build_object(
        'code','CONTENT_GENERATION_FAILED',
        'message','内容生成失败，系统将创建新候选补位。',
        'schema_version','baijiahao-daily-error@1'
      )
    FROM content_variants AS variant
    WHERE item.batch_id=${batch.id}::uuid AND item.tenant_id=${batch.tenantId}::uuid
      AND item.status='generating' AND variant.id=item.variant_id
      AND variant.tenant_id=item.tenant_id AND variant.status='generation_failed'
  `;
}

async function terminalizeRetiredAutomationRuns(
  client: postgres.Sql | postgres.TransactionSql,
  batchId?: string,
): Promise<void> {
  await client`
    UPDATE baijiahao_automation_runs AS automation SET
      status='disabled',
      last_error_json=jsonb_strip_nulls(
        jsonb_build_object(
          'code','CONTENT_GENERATION_FAILED_RETIRED',
          'generation_error',automation.last_error_json,
          'message','内容生成失败，候选已退出后台执行，调度器将按上限创建新候选补位。',
          'schema_version','baijiahao-automation-error@1'
        )
      ),
      finished_at=COALESCE(automation.finished_at,now()),
      version=automation.version+1
    FROM baijiahao_daily_batch_items AS item
    WHERE item.tenant_id=automation.tenant_id AND item.automation_run_id=automation.id
      AND item.status='retired'
      AND automation.status IN ('generation_pending','generating')
      AND (${batchId ?? null}::uuid IS NULL OR item.batch_id=${batchId ?? null}::uuid)
  `;
}

async function loadCandidateSeed(
  transaction: postgres.TransactionSql,
  batch: BatchRow,
): Promise<CandidateSeed> {
  const [brands, rules, keywords, citations, accounts] = await Promise.all([
    transaction<{ id: string; profile: JsonObject; version: number }[]>`
      SELECT id,profile_json AS profile,version FROM brand_profiles
      WHERE tenant_id=${batch.tenantId}::uuid AND workspace_id=${batch.workspaceId}::uuid
        AND status='published'
      ORDER BY version DESC LIMIT 1
    `,
    transaction<{ hash: string; id: string; rules: JsonObject }[]>`
      SELECT id,content_hash AS hash,rules_json AS rules FROM platform_rule_versions
      WHERE platform_code='baijiahao' AND status='published'
      ORDER BY published_at DESC NULLS LAST,created_at DESC,id DESC LIMIT 1
    `,
    transaction<{ id: string; term: string }[]>`
      SELECT keyword.id,keyword.term::text AS term
      FROM keywords AS keyword
      JOIN keyword_sets AS set
        ON set.id=keyword.keyword_set_id AND set.tenant_id=keyword.tenant_id
        AND set.project_id=${batch.projectId}::uuid
        AND set.status='active' AND set.deleted_at IS NULL
      WHERE keyword.tenant_id=${batch.tenantId}::uuid AND keyword.status='active'
        AND 'baijiahao'=ANY(keyword.platform_scope)
      ORDER BY keyword.priority DESC,keyword.id
    `,
    transaction<CandidateSeed['citations'][number][]>`
      SELECT
        chunk.id AS "chunkId",left(chunk.text,1200) AS "quoteText",
        source.id AS "sourceId"
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
        source.updated_at DESC,chunk.chunk_no,chunk.id
      LIMIT 12
    `,
    transaction<CandidateSeed['account'][]>`
      SELECT
        id,display_name AS "displayName",provider_account_id AS "providerAccountId",
        timezone,capabilities_json AS capabilities
      FROM platform_accounts
      WHERE id=${batch.accountId}::uuid AND tenant_id=${batch.tenantId}::uuid
        AND workspace_id=${batch.workspaceId}::uuid AND platform_code='baijiahao'
        AND status='active' AND publish_mode='api' AND deleted_at IS NULL
      LIMIT 1
    `,
  ]);
  const brand = brands[0];
  const rule = rules[0];
  const account = accounts[0];
  if (!brand) throw prerequisite('PUBLISHED_BRAND_PROFILE_REQUIRED', '请先发布企业品牌资料。');
  if (!rule) throw prerequisite('PUBLISHED_BAIJIAHAO_RULE_REQUIRED', '百家号规则尚未发布。');
  if (!account) throw prerequisite('BAIJIAHAO_ACCOUNT_REQUIRED', '百家号浏览器账号不可用。');
  if (keywords.length === 0) {
    throw prerequisite('BAIJIAHAO_KEYWORD_REQUIRED', '项目没有适用于百家号的关键词。');
  }
  if (citations.length === 0) {
    throw prerequisite('PARSED_KNOWLEDGE_REQUIRED', '项目没有可用的已解析知识资料。');
  }
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
  seed: CandidateSeed,
  candidateNo: number,
  config: OfficialSiteAutomationConfig,
): Promise<void> {
  const angle = CONTENT_ANGLES[(candidateNo - 1) % CONTENT_ANGLES.length]!;
  const keyword = seed.keywords[(candidateNo - 1) % seed.keywords.length]!;
  const title = truncateUnicode(angle.title(keyword.term), 40);
  const objective = (['education', 'trust', 'awareness'] as const)[(candidateNo - 1) % 3]!;
  const constraints = {
    additional_instructions: [
      `这是 ${batch.businessDate} 百家号独立内容批次的第 ${candidateNo} 个候选。`,
      `围绕“${keyword.term}”的“${angle.label}”展开。`,
      '只使用给定品牌资料和引用证据，不得编造价格、规模、资质、排名或承诺。',
      '不得包含其他企业名称、电话、二维码、外部账号、第三方网址或导流 CTA。',
    ].join(''),
    cta: null,
    schema_version: 'brief-constraints@1',
    target_accounts_by_code: {
      baijiahao: {
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
      tenant_id,workspace_id,project_id,title,objective,audience,
      platform_codes,constraints_json,generation_mode,due_at,created_by
    ) VALUES (
      ${batch.tenantId}::uuid,${batch.workspaceId}::uuid,${batch.projectId}::uuid,
      ${title},${objective},${`正在搜索“${keyword.term}”并需要实用决策信息的用户`},
      ARRAY['baijiahao']::varchar[],${JSON.stringify(constraints)}::text::jsonb,
      'draft',(${batch.businessDate}::date+interval '1 day'-interval '1 second'),
      ${batch.createdBy}::uuid
    ) RETURNING id
  `;
  const briefId = requiredId(briefs[0]?.id, 'Baijiahao daily Brief insert failed');
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
    INSERT INTO content_packages (
      tenant_id,workspace_id,project_id,brief_id,status,created_by
    ) VALUES (
      ${batch.tenantId}::uuid,${batch.workspaceId}::uuid,${batch.projectId}::uuid,
      ${briefId}::uuid,'generating',${batch.createdBy}::uuid
    ) RETURNING id
  `;
  const packageId = requiredId(packages[0]?.id, 'Baijiahao daily package insert failed');
  const variants = await transaction<{ id: string }[]>`
    INSERT INTO content_variants (
      tenant_id,package_id,platform_code,status,is_required,platform_account_id
    ) VALUES (
      ${batch.tenantId}::uuid,${packageId}::uuid,'baijiahao','generating',true,
      ${batch.accountId}::uuid
    ) RETURNING id
  `;
  const variantId = requiredId(variants[0]?.id, 'Baijiahao daily variant insert failed');
  const writerInput: JsonObject = {
    brief: {
      audience: `正在搜索“${keyword.term}”并需要实用决策信息的用户`,
      brief_id: briefId,
      constraints,
      objective,
      platform_codes: ['baijiahao'],
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
      baijiahao: {
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
  const requestId = `baidu-daily-${batch.id.slice(0, 8)}-${candidateNo}`;
  const masterRuns = await transaction<{ id: string }[]>`
    INSERT INTO generation_runs (
      tenant_id,workspace_id,project_id,package_id,variant_id,
      skill_name,skill_version,prompt_version_id,model_key,input_hash,request_id
    ) VALUES (
      ${batch.tenantId}::uuid,${batch.workspaceId}::uuid,${batch.projectId}::uuid,
      ${packageId}::uuid,NULL,'content-writer',${config.writerSkillVersion},
      ${config.writerPromptVersionId}::uuid,${config.rewriteModelKey},${inputHash},${requestId}
    ) RETURNING id
  `;
  const masterRunId = requiredId(masterRuns[0]?.id, 'Baijiahao master run insert failed');
  const variantRuns = await transaction<{ id: string }[]>`
    INSERT INTO generation_runs (
      tenant_id,workspace_id,project_id,package_id,variant_id,
      skill_name,skill_version,prompt_version_id,model_key,input_hash,request_id
    ) VALUES (
      ${batch.tenantId}::uuid,${batch.workspaceId}::uuid,${batch.projectId}::uuid,
      ${packageId}::uuid,${variantId}::uuid,'content-writer',${config.writerSkillVersion},
      ${config.writerPromptVersionId}::uuid,${config.rewriteModelKey},${inputHash},${requestId}
    ) RETURNING id
  `;
  const variantRunId = requiredId(variantRuns[0]?.id, 'Baijiahao variant run insert failed');
  const automations = await transaction<{ id: string }[]>`
    INSERT INTO baijiahao_automation_runs (
      tenant_id,policy_id,source_mode,variant_id,status
    ) VALUES (
      ${batch.tenantId}::uuid,${batch.policyId}::uuid,'independent',
      ${variantId}::uuid,'generation_pending'
    ) RETURNING id
  `;
  const automationRunId = requiredId(
    automations[0]?.id,
    'Baijiahao independent automation run insert failed',
  );
  await transaction`
    INSERT INTO baijiahao_daily_batch_items (
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
      variant_runs: [{ platform_code: 'baijiahao', run_id: variantRunId, variant_id: variantId }],
      workspace_id: batch.workspaceId,
      writer_input: writerInput,
    },
    event_id: randomUUID(),
    event_type: 'content.package.generation_requested.v1',
    occurred_at: new Date().toISOString(),
    tenant: { id: batch.tenantId },
  });
  await transaction`
    INSERT INTO outbox_events (
      id,tenant_id,event_type,aggregate_type,aggregate_id,payload_json
    ) VALUES (
      ${event.event_id}::uuid,${batch.tenantId}::uuid,${event.event_type},
      ${event.aggregate.type},${event.aggregate.id}::uuid,
      ${JSON.stringify(event)}::text::jsonb
    )
  `;
  await transaction`
    INSERT INTO audit_events (
      tenant_id,actor_id,action,resource_type,resource_id,after_json,request_id
    ) VALUES (
      ${batch.tenantId}::uuid,${batch.createdBy}::uuid,
      'baijiahao.daily_candidate.created','content_package',${packageId}::uuid,
      ${JSON.stringify({
        automation_run_id: automationRunId,
        batch_id: batch.id,
        candidate_no: candidateNo,
        title,
      })}::text::jsonb,${requestId}
    )
  `;
}

async function setAttentionRequired(
  transaction: postgres.TransactionSql,
  batch: BatchRow,
  code: string,
  message: string,
): Promise<void> {
  await transaction`
    UPDATE baijiahao_daily_batches SET
      status='attention_required',
      last_error_json=${JSON.stringify({
        code,
        message,
        schema_version: 'baijiahao-daily-error@1',
      })}::text::jsonb,version=version+1
    WHERE id=${batch.id}::uuid AND tenant_id=${batch.tenantId}::uuid
      AND status='running' AND version=${batch.version}
  `;
}

const CONTENT_ANGLES = Object.freeze([
  angle('selection', '选择指南', (keyword) => `${keyword}怎么选：一份实用判断指南`),
  angle('preparation', '准备清单', (keyword) => `${keyword}前要准备哪些事项`),
  angle('risk', '风险避坑', (keyword) => `${keyword}容易遇到哪些问题`),
  angle('process', '服务流程', (keyword) => `${keyword}从准备到完成的流程`),
  angle('comparison', '方案比较', (keyword) => `${keyword}不同方案如何比较`),
  angle('acceptance', '验收方法', (keyword) => `${keyword}完成后如何检查验收`),
]);

function angle(key: string, label: string, title: (keyword: string) => string) {
  return Object.freeze({ key, label, title });
}

function truncateUnicode(value: string, maximum: number): string {
  return [...value.normalize('NFC').replace(/\s+/gu, ' ').trim()].slice(0, maximum).join('');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requiredId(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function prerequisite(code: string, message: string): BaijiahaoDailyPrerequisiteError {
  return new BaijiahaoDailyPrerequisiteError(code, message);
}

class BaijiahaoDailyPrerequisiteError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BaijiahaoDailyPrerequisiteError';
  }
}
