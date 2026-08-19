import { DomainEventEnvelopeSchema } from '@geo-content-os/contracts';
import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';

import type { OfficialSiteAutomationConfig } from './config.js';
import type { DailyCitationPort } from './daily-citation-retriever.js';
import type { JsonObject } from './generation.types.js';

const DAILY_TARGET = 10;
const MAX_ACTIVE_CANDIDATES = 3;
const SHANGHAI_OFFSET = '+08:00';
const ACTIVE_ITEM_STATUSES = ['generating', 'quality_check', 'rewriting', 'media_pending'] as const;
const DAILY_QUALIFIED_ITEM_STATUSES = [
  'qualified',
  'scheduled',
  'published',
  'publish_failed',
  'reserve',
] as const;
const DAILY_COMMITTED_ITEM_STATUSES = ['scheduled', 'published', 'publish_failed'] as const;
const SCHEDULE_TIMES = Object.freeze([
  '08:00:00',
  '09:30:00',
  '11:00:00',
  '12:30:00',
  '14:00:00',
  '15:30:00',
  '17:00:00',
  '18:30:00',
  '20:00:00',
  '21:30:00',
] as const);
const RECOVERABLE_PREREQUISITE_CODES = Object.freeze([
  'OFFICIAL_ACCOUNT_REQUIRED',
  'OFFICIAL_KEYWORD_REQUIRED',
  'PARSED_KNOWLEDGE_REQUIRED',
  'PUBLISHED_BRAND_PROFILE_REQUIRED',
  'PUBLISHED_OFFICIAL_RULE_REQUIRED',
] as const);

interface BatchRow {
  readonly accountId: string;
  readonly businessDate: string;
  readonly candidateLimit: 30;
  readonly createdBy: string;
  readonly id: string;
  readonly attemptNo: number;
  readonly policyId: string;
  readonly projectId: string;
  readonly scheduleTimes: readonly string[];
  readonly status: 'attention_required' | 'cancelled' | 'completed' | 'running' | 'scheduled';
  readonly targetCount: 10;
  readonly tenantId: string;
  readonly version: number;
  readonly workspaceId: string;
}

interface BatchCounts {
  readonly attempted: number;
  readonly inProgress: number;
}

interface DailyCounts {
  readonly committed: number;
  readonly publishFailed: number;
  readonly published: number;
  readonly qualified: number;
}

interface AngleUsage {
  readonly attempted: Set<string>;
  readonly protected: Set<string>;
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
  readonly keywords: readonly {
    readonly id: string;
    readonly intent: 'commercial' | 'informational' | 'navigational' | 'transactional';
    readonly term: string;
  }[];
  readonly rule: {
    readonly hash: string;
    readonly id: string;
    readonly rules: JsonObject;
  };
}

interface QualifiedItem {
  readonly automationRunId: string;
  readonly automationVersion: number;
  readonly contentHash: string;
  readonly contentVersionId: string;
  readonly id: string;
  readonly variantId: string;
  readonly variantVersion: number;
}

export interface OfficialSiteDailySchedulerOptions {
  readonly onError?: (error: Error) => void;
  readonly tickMs: number;
}

export class OfficialSiteDailyScheduler {
  private currentTick: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  public constructor(
    private readonly client: postgres.Sql,
    private readonly automationConfig: OfficialSiteAutomationConfig,
    private readonly options: OfficialSiteDailySchedulerOptions,
    private readonly dailyCitations: DailyCitationPort,
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

  public async tick(now = new Date()): Promise<void> {
    await this.ensureTodayBatches();
    await this.expirePastBatches();
    const rows = await this.client<{ id: string }[]>`
      SELECT batch.id
      FROM official_site_daily_batches AS batch
      JOIN official_site_automation_policies AS policy
        ON policy.id=batch.policy_id AND policy.tenant_id=batch.tenant_id
        AND policy.enabled AND policy.daily_enabled
      WHERE batch.status='running'
        OR (
          batch.status='attention_required'
          AND batch.business_date=(now() AT TIME ZONE policy.daily_timezone)::date
          AND batch.last_error_json->>'code'=ANY(${[...RECOVERABLE_PREREQUISITE_CODES]}::text[])
        )
      ORDER BY batch.business_date,batch.id
    `;
    for (const row of rows) {
      try {
        await this.processBatch(row.id, now);
      } catch (error) {
        if (error instanceof DailyBatchPrerequisiteError) {
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
      .catch((error: unknown) => {
        this.options.onError?.(
          error instanceof Error ? error : new Error('Daily scheduler failed'),
        );
      })
      .finally(() => {
        if (this.currentTick === promise) this.currentTick = null;
      });
    this.currentTick = promise;
  }

  private async ensureTodayBatches(): Promise<void> {
    await this.client`
      INSERT INTO official_site_daily_batches (tenant_id,policy_id,business_date)
      SELECT
        policy.tenant_id,
        policy.id,
        (now() AT TIME ZONE policy.daily_timezone)::date
      FROM official_site_automation_policies AS policy
      JOIN platform_accounts AS account
        ON account.id=policy.account_id AND account.tenant_id=policy.tenant_id
        AND account.workspace_id=policy.workspace_id
        AND account.platform_code='official_site'
        AND account.status='active' AND account.publish_mode='api'
        AND account.deleted_at IS NULL
      JOIN projects AS project
        ON project.id=policy.project_id AND project.tenant_id=policy.tenant_id
        AND project.workspace_id=policy.workspace_id
        AND project.status='active' AND project.deleted_at IS NULL
      WHERE policy.enabled AND policy.daily_enabled
        AND (now() AT TIME ZONE policy.daily_timezone)::time >= policy.daily_generation_time
        AND NOT EXISTS (
          SELECT 1 FROM official_site_daily_batches AS existing
          WHERE existing.tenant_id=policy.tenant_id
            AND existing.policy_id=policy.id
            AND existing.business_date=(now() AT TIME ZONE policy.daily_timezone)::date
        )
      ON CONFLICT DO NOTHING
    `;
  }

  private async expirePastBatches(): Promise<void> {
    await this.client`
      UPDATE official_site_daily_batches AS batch SET
        status='attention_required',
        last_error_json=jsonb_build_object(
          'code','DAILY_BATCH_DAY_ENDED',
          'message','当天未能完成 10 篇合格内容，批次已停止，请检查失败原因。',
          'schema_version','official-site-daily-error@1'
        ),
        version=batch.version+1
      FROM official_site_automation_policies AS policy
      WHERE policy.id=batch.policy_id AND policy.tenant_id=batch.tenant_id
        AND batch.status='running'
        AND batch.business_date < (now() AT TIME ZONE policy.daily_timezone)::date
    `;
  }

  private processBatch(batchId: string, now: Date): Promise<void> {
    return this.client.begin(async (transaction) => {
      let batch = await lockBatch(transaction, batchId);
      if (!batch) return;
      if (batch.status === 'attention_required') {
        const revived = await transaction<{ version: number }[]>`
          UPDATE official_site_daily_batches SET
            status='running',last_error_json=NULL,version=version+1
          WHERE id=${batch.id}::uuid AND tenant_id=${batch.tenantId}::uuid
            AND status='attention_required' AND version=${batch.version}
          RETURNING version
        `;
        const version = revived[0]?.version;
        if (!version) return;
        batch = { ...batch, status: 'running', version };
      }
      if (batch.status !== 'running') return;
      await retireGenerationFailures(transaction, batch);
      await retireQualityExecutionFailures(transaction, batch);
      if (batch.attemptNo > 1) {
        await scheduleAvailableItems(transaction, batch, now, true);
      }
      const counts = await loadCounts(transaction, batch);
      let dailyCounts = await loadDailyCounts(transaction, batch);
      if (dailyCounts.qualified >= batch.targetCount) {
        await scheduleAvailableItems(transaction, batch, now, false);
        dailyCounts = await loadDailyCounts(transaction, batch);
        if (dailyCounts.committed < batch.targetCount) {
          await setAttentionRequired(
            transaction,
            batch,
            'DAILY_SCHEDULING_FAILED',
            `当天已有 ${dailyCounts.qualified} 篇合格内容，但仅成功排期 ${dailyCounts.committed} 篇，请检查排期状态。`,
          );
          return;
        }
        await finalizeDailyPlan(transaction, batch, dailyCounts);
        return;
      }
      if (counts.attempted >= batch.candidateLimit && counts.inProgress === 0) {
        await scheduleAvailableItems(transaction, batch, now, false);
        dailyCounts = await loadDailyCounts(transaction, batch);
        await setAttentionRequired(
          transaction,
          batch,
          'DAILY_CANDIDATE_LIMIT_REACHED',
          `本次已尝试 ${batch.candidateLimit} 篇；当天已保留 ${dailyCounts.qualified} 篇合格内容并排期 ${dailyCounts.committed} 篇，仍缺 ${batch.targetCount - dailyCounts.qualified} 篇。`,
        );
        return;
      }
      const required = Math.min(
        batch.targetCount - dailyCounts.qualified - counts.inProgress,
        batch.candidateLimit - counts.attempted,
        MAX_ACTIVE_CANDIDATES - counts.inProgress,
      );
      if (required <= 0) return;
      const seed = await loadCandidateSeed(transaction, batch);
      const angleUsage = await loadAngleUsage(transaction, batch);
      for (let offset = 1; offset <= required; offset += 1) {
        const candidateNo = counts.attempted + offset;
        await createCandidate(
          transaction,
          batch,
          seed,
          candidateNo,
          selectAngle(angleUsage, candidateNo),
          this.automationConfig,
          this.dailyCitations,
        );
      }
    });
  }

  private async markAttentionRequired(
    batchId: string,
    error: DailyBatchPrerequisiteError,
  ): Promise<void> {
    await this.client`
      UPDATE official_site_daily_batches SET
        status='attention_required',
        last_error_json=${JSON.stringify({
          code: error.code,
          message: error.message,
          schema_version: 'official-site-daily-error@1',
        })}::text::jsonb,
        version=version+1
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
      batch.id, batch.tenant_id AS "tenantId", batch.policy_id AS "policyId",
      batch.attempt_no AS "attemptNo", batch.business_date::text AS "businessDate",
      batch.status, batch.version,
      policy.workspace_id AS "workspaceId", policy.project_id AS "projectId",
      policy.account_id AS "accountId", policy.created_by AS "createdBy",
      policy.daily_target_count AS "targetCount",
      policy.daily_candidate_limit AS "candidateLimit",
      policy.daily_schedule_times::text[] AS "scheduleTimes"
    FROM official_site_daily_batches AS batch
    JOIN official_site_automation_policies AS policy
      ON policy.id=batch.policy_id AND policy.tenant_id=batch.tenant_id
      AND policy.enabled AND policy.daily_enabled
    JOIN platform_accounts AS account
      ON account.id=policy.account_id AND account.tenant_id=policy.tenant_id
      AND account.status='active' AND account.publish_mode='api'
      AND account.deleted_at IS NULL
    WHERE batch.id=${batchId}::uuid
    FOR UPDATE OF batch,policy
  `;
  return rows[0] ?? null;
}

async function retireGenerationFailures(
  transaction: postgres.TransactionSql,
  batch: BatchRow,
): Promise<void> {
  await transaction`
    UPDATE official_site_daily_batch_items AS item SET
      status='retired',
      last_error_json=jsonb_build_object(
        'code','CONTENT_GENERATION_FAILED',
        'message','内容生成失败，系统将创建新候选补位。',
        'schema_version','official-site-daily-error@1'
      )
    FROM content_variants AS variant
    WHERE item.batch_id=${batch.id}::uuid AND item.tenant_id=${batch.tenantId}::uuid
      AND item.status='generating'
      AND variant.id=item.variant_id AND variant.tenant_id=item.tenant_id
      AND variant.status='generation_failed'
  `;
}

async function retireQualityExecutionFailures(
  transaction: postgres.TransactionSql,
  batch: BatchRow,
): Promise<void> {
  await transaction`
    UPDATE official_site_automation_runs AS automation SET
      status='manual_required',
      last_error_json=jsonb_build_object(
        'code','QUALITY_CHECK_EXECUTION_FAILED',
        'message','机器质检执行失败，当前候选已停止。',
        'schema_version','official-site-automation-error@1'
      ),
      finished_at=now(),
      version=automation.version+1
    WHERE automation.tenant_id=${batch.tenantId}::uuid
      AND automation.status='quality_pending'
      AND EXISTS (
        SELECT 1
        FROM official_site_daily_batch_items AS item
        WHERE item.batch_id=${batch.id}::uuid
          AND item.tenant_id=automation.tenant_id
          AND item.variant_id=automation.variant_id
          AND item.content_version_id=automation.content_version_id
          AND item.status='quality_check'
          AND (
            SELECT run.status
            FROM generation_runs AS run
            WHERE run.tenant_id=item.tenant_id
              AND run.variant_id=item.variant_id
              AND run.skill_name='quality-checker'
            ORDER BY run.created_at DESC,run.id DESC
            LIMIT 1
          )='failed'
      )
  `;
  await transaction`
    UPDATE official_site_daily_batch_items AS item SET
      status='retired',
      last_error_json=jsonb_build_object(
        'code','QUALITY_CHECK_EXECUTION_FAILED',
        'message','机器质检连续执行失败，系统将创建新候选补位。',
        'schema_version','official-site-daily-error@1'
      )
    FROM official_site_automation_runs AS automation
    WHERE item.batch_id=${batch.id}::uuid
      AND item.tenant_id=${batch.tenantId}::uuid
      AND item.status='quality_check'
      AND automation.tenant_id=item.tenant_id
      AND automation.variant_id=item.variant_id
      AND automation.content_version_id=item.content_version_id
      AND automation.status='manual_required'
      AND automation.last_error_json->>'code'='QUALITY_CHECK_EXECUTION_FAILED'
  `;
}

async function loadCounts(
  transaction: postgres.TransactionSql,
  batch: BatchRow,
): Promise<BatchCounts> {
  const rows = await transaction<BatchCounts[]>`
    SELECT
      count(*)::integer AS attempted,
      count(*) FILTER (WHERE status=ANY(${[...ACTIVE_ITEM_STATUSES]}::varchar[]))::integer
        AS "inProgress"
    FROM official_site_daily_batch_items
    WHERE tenant_id=${batch.tenantId}::uuid AND batch_id=${batch.id}::uuid
  `;
  return rows[0] ?? { attempted: 0, inProgress: 0 };
}

async function loadDailyCounts(
  transaction: postgres.TransactionSql,
  batch: BatchRow,
): Promise<DailyCounts> {
  const rows = await transaction<DailyCounts[]>`
    SELECT
      count(item.id) FILTER (
        WHERE item.status=ANY(${[...DAILY_QUALIFIED_ITEM_STATUSES]}::varchar[])
      )::integer AS qualified,
      count(item.id) FILTER (
        WHERE item.status=ANY(${[...DAILY_COMMITTED_ITEM_STATUSES]}::varchar[])
      )::integer AS committed,
      count(item.id) FILTER (WHERE item.status='published')::integer AS published,
      count(item.id) FILTER (WHERE item.status='publish_failed')::integer AS "publishFailed"
    FROM official_site_daily_batches AS source
    LEFT JOIN official_site_daily_batch_items AS item
      ON item.batch_id=source.id AND item.tenant_id=source.tenant_id
    WHERE source.tenant_id=${batch.tenantId}::uuid
      AND source.policy_id=${batch.policyId}::uuid
      AND source.business_date=${batch.businessDate}::date
  `;
  return rows[0] ?? { committed: 0, publishFailed: 0, published: 0, qualified: 0 };
}

async function loadAngleUsage(
  transaction: postgres.TransactionSql,
  batch: BatchRow,
): Promise<AngleUsage> {
  const rows = await transaction<{ angleKey: string; isProtected: boolean }[]>`
    SELECT item.angle_key AS "angleKey",bool_or(item.status<>'retired') AS "isProtected"
    FROM official_site_daily_batches AS source
    JOIN official_site_daily_batch_items AS item
      ON item.batch_id=source.id AND item.tenant_id=source.tenant_id
    WHERE source.tenant_id=${batch.tenantId}::uuid
      AND source.policy_id=${batch.policyId}::uuid
      AND source.business_date=${batch.businessDate}::date
    GROUP BY item.angle_key
  `;
  return {
    attempted: new Set(rows.map((row) => row.angleKey)),
    protected: new Set(rows.filter((row) => row.isProtected).map((row) => row.angleKey)),
  };
}

async function loadCandidateSeed(
  transaction: postgres.TransactionSql,
  batch: BatchRow,
): Promise<CandidateSeed> {
  const [brands, rules, keywords, knowledge, accounts] = await Promise.all([
    transaction<{ id: string; profile: JsonObject; version: number }[]>`
      SELECT id,profile_json AS profile,version
      FROM brand_profiles
      WHERE tenant_id=${batch.tenantId}::uuid AND workspace_id=${batch.workspaceId}::uuid
        AND status='published'
      ORDER BY version DESC LIMIT 1
    `,
    transaction<{ hash: string; id: string; rules: JsonObject }[]>`
      SELECT id,content_hash AS hash,rules_json AS rules
      FROM platform_rule_versions
      WHERE platform_code='official_site' AND status='published'
      ORDER BY published_at DESC NULLS LAST,created_at DESC,id DESC
      LIMIT 1
    `,
    transaction<
      {
        id: string;
        intent: CandidateSeed['keywords'][number]['intent'];
        term: string;
      }[]
    >`
      SELECT keyword.id,keyword.intent,keyword.term::text AS term
      FROM keywords AS keyword
      JOIN keyword_sets AS set
        ON set.id=keyword.keyword_set_id AND set.tenant_id=keyword.tenant_id
        AND set.project_id=${batch.projectId}::uuid
        AND set.status='active' AND set.deleted_at IS NULL
      WHERE keyword.tenant_id=${batch.tenantId}::uuid
        AND keyword.status='active' AND 'official_site'=ANY(keyword.platform_scope)
      ORDER BY keyword.priority DESC,keyword.id
    `,
    transaction<{ id: string }[]>`
      SELECT chunk.id
      FROM source_chunks AS chunk
      JOIN source_documents AS source
        ON source.id=chunk.source_document_id AND source.tenant_id=chunk.tenant_id
      WHERE source.tenant_id=${batch.tenantId}::uuid
        AND source.workspace_id=${batch.workspaceId}::uuid
        AND (source.project_id=${batch.projectId}::uuid OR source.project_id IS NULL)
        AND source.status='active' AND source.deleted_at IS NULL
        AND source.trust_level IN ('verified','normal')
        AND (source.effective_from IS NULL OR source.effective_from<=${batch.businessDate}::date)
        AND (source.effective_to IS NULL OR source.effective_to>=${batch.businessDate}::date)
        AND chunk.status='active'
      LIMIT 1
    `,
    transaction<
      {
        capabilities: JsonObject;
        displayName: string;
        id: string;
        providerAccountId: string | null;
        timezone: string;
      }[]
    >`
      SELECT
        id,display_name AS "displayName",provider_account_id AS "providerAccountId",
        timezone,capabilities_json AS capabilities
      FROM platform_accounts
      WHERE id=${batch.accountId}::uuid AND tenant_id=${batch.tenantId}::uuid
        AND workspace_id=${batch.workspaceId}::uuid
        AND platform_code='official_site' AND status='active' AND publish_mode='api'
        AND deleted_at IS NULL
      LIMIT 1
    `,
  ]);
  const brand = brands[0];
  const rule = rules[0];
  const account = accounts[0];
  if (!brand) throw prerequisite('PUBLISHED_BRAND_PROFILE_REQUIRED', '请先发布企业品牌资料。');
  if (!rule) throw prerequisite('PUBLISHED_OFFICIAL_RULE_REQUIRED', '官网内容规则尚未发布。');
  if (!account) throw prerequisite('OFFICIAL_ACCOUNT_REQUIRED', '官网 API 账号不可用。');
  if (keywords.length === 0) {
    throw prerequisite('OFFICIAL_KEYWORD_REQUIRED', '请先为项目维护至少一个适用于官网的关键词。');
  }
  if (knowledge.length === 0) {
    throw prerequisite('PARSED_KNOWLEDGE_REQUIRED', '请先完成至少一份企业资料的解析。');
  }
  return {
    account,
    brand,
    keywords: Object.freeze(keywords),
    rule,
  };
}

async function createCandidate(
  transaction: postgres.TransactionSql,
  batch: BatchRow,
  seed: CandidateSeed,
  candidateNo: number,
  angle: ContentAngle,
  config: OfficialSiteAutomationConfig,
  dailyCitations: DailyCitationPort,
): Promise<void> {
  const keyword = seed.keywords[(candidateNo - 1) % seed.keywords.length]!;
  const title = truncateTitle(angle.title(keyword.term), 80);
  const objective = objectiveFor(candidateNo);
  const audience = `正在搜索“${keyword.term}”相关信息并准备做出决策的目标用户`;
  const evidence = await dailyCitations.retrieve({
    angle: angle.label,
    audience,
    businessDate: batch.businessDate,
    candidateNo,
    keyword: keyword.term,
    objective,
    platformCode: 'official_site',
    projectId: batch.projectId,
    tenantId: batch.tenantId,
    title,
    userId: batch.createdBy,
    workspaceId: batch.workspaceId,
  });
  if (evidence.citations.length === 0) {
    throw prerequisite(
      'PARSED_KNOWLEDGE_REQUIRED',
      `企业资料索引中没有找到与候选“${title}”相关的可用证据。`,
    );
  }
  const constraints = {
    additional_instructions: [
      `这是 ${batch.businessDate} 官网每日内容批次的第 ${candidateNo} 个候选。`,
      `本篇必须围绕“${keyword.term}”的“${angle.label}”展开，与同日其他文章保持不同角度。`,
      '优先使用企业第一方资料；涉及外部事实时必须使用所提供证据。',
      '不得编造价格、地址、电话、资质、客户数量、行业排名或无法核验的承诺。',
    ].join(''),
    cta: null,
    official_site_direct: true,
    schema_version: 'brief-constraints@1',
    target_accounts_by_code: {
      official_site: {
        account_id: seed.account.id,
        capabilities: seed.account.capabilities,
        display_name: seed.account.displayName,
        provider_account_id: seed.account.providerAccountId,
        timezone: seed.account.timezone,
      },
    },
  };
  const briefRows = await transaction<{ id: string }[]>`
    INSERT INTO briefs (
      tenant_id,workspace_id,project_id,title,objective,audience,
      platform_codes,constraints_json,generation_mode,due_at,created_by
    ) VALUES (
      ${batch.tenantId}::uuid,${batch.workspaceId}::uuid,${batch.projectId}::uuid,
      ${title},${objective},
      ${audience},
      ARRAY['official_site']::varchar[],
      ${JSON.stringify(constraints)}::text::jsonb,'draft',
      (${batch.businessDate}::date + interval '1 day' - interval '1 second'),
      ${batch.createdBy}::uuid
    )
    RETURNING id
  `;
  const briefId = requiredId(briefRows[0]?.id, 'Daily Brief insert failed');
  await transaction`
    INSERT INTO brief_keywords (tenant_id,brief_id,keyword_id,is_primary)
    VALUES (${batch.tenantId}::uuid,${briefId}::uuid,${keyword.id}::uuid,true)
  `;
  const sourceIds = [...new Set(evidence.citations.map((citation) => citation.sourceId))];
  await transaction`
    INSERT INTO brief_sources (tenant_id,brief_id,source_document_id,required)
    SELECT ${batch.tenantId}::uuid,${briefId}::uuid,source_id,true
    FROM unnest(${sourceIds}::uuid[]) AS source_id
  `;
  const packageRows = await transaction<{ id: string }[]>`
    INSERT INTO content_packages (
      tenant_id,workspace_id,project_id,brief_id,status,created_by
    ) VALUES (
      ${batch.tenantId}::uuid,${batch.workspaceId}::uuid,${batch.projectId}::uuid,
      ${briefId}::uuid,'generating',${batch.createdBy}::uuid
    )
    RETURNING id
  `;
  const packageId = requiredId(packageRows[0]?.id, 'Daily Content Package insert failed');
  const variantRows = await transaction<{ id: string }[]>`
    INSERT INTO content_variants (
      tenant_id,package_id,platform_code,status,is_required,platform_account_id
    ) VALUES (
      ${batch.tenantId}::uuid,${packageId}::uuid,'official_site','generating',true,
      ${batch.accountId}::uuid
    )
    RETURNING id
  `;
  const variantId = requiredId(variantRows[0]?.id, 'Daily content variant insert failed');
  const writerInput: JsonObject = {
    brief: {
      audience,
      brief_id: briefId,
      constraints,
      objective,
      platform_codes: ['official_site'],
      title,
    },
    citations: evidence.citations.map((citation) => ({
      chunk_id: citation.chunkId,
      citation_id: citation.chunkId,
      quote_text: citation.quoteText,
      source_id: citation.sourceId,
    })),
    generation_mode: 'draft',
    locked_blocks: [],
    platform_rules_by_code: {
      official_site: {
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
  const requestId = `daily-${batch.id.slice(0, 8)}-${candidateNo}`;
  const masterRuns = await transaction<{ id: string }[]>`
    INSERT INTO generation_runs (
      tenant_id,workspace_id,project_id,package_id,variant_id,
      skill_name,skill_version,prompt_version_id,model_key,input_hash,request_id
    ) VALUES (
      ${batch.tenantId}::uuid,${batch.workspaceId}::uuid,${batch.projectId}::uuid,
      ${packageId}::uuid,NULL,'content-writer',${config.writerSkillVersion},
      ${config.writerPromptVersionId}::uuid,${config.rewriteModelKey},${inputHash},${requestId}
    )
    RETURNING id
  `;
  const masterRunId = requiredId(masterRuns[0]?.id, 'Daily master run insert failed');
  const variantRuns = await transaction<{ id: string }[]>`
    INSERT INTO generation_runs (
      tenant_id,workspace_id,project_id,package_id,variant_id,
      skill_name,skill_version,prompt_version_id,model_key,input_hash,request_id
    ) VALUES (
      ${batch.tenantId}::uuid,${batch.workspaceId}::uuid,${batch.projectId}::uuid,
      ${packageId}::uuid,${variantId}::uuid,'content-writer',${config.writerSkillVersion},
      ${config.writerPromptVersionId}::uuid,${config.rewriteModelKey},${inputHash},${requestId}
    )
    RETURNING id
  `;
  const variantRunId = requiredId(variantRuns[0]?.id, 'Daily variant run insert failed');
  await transaction`
    INSERT INTO official_site_daily_batch_items (
      tenant_id,batch_id,candidate_no,angle_key,title,brief_id,package_id,variant_id,status
    ) VALUES (
      ${batch.tenantId}::uuid,${batch.id}::uuid,${candidateNo},${angle.key},${title},
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
        { platform_code: 'official_site', run_id: variantRunId, variant_id: variantId },
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
      'official_site.daily_candidate.created','content_package',${packageId}::uuid,
      ${JSON.stringify({
        batch_id: batch.id,
        candidate_no: candidateNo,
        angle: angle.label,
        evidence_context_hash: evidence.contextHash,
        evidence_query_hash: evidence.queryHash,
        evidence_retrieval_degraded: evidence.degraded,
        evidence_source_count: sourceIds.length,
        title,
      })}::text::jsonb,
      ${requestId}
    )
  `;
}

async function scheduleAvailableItems(
  transaction: postgres.TransactionSql,
  batch: BatchRow,
  now: Date,
  previousAttemptsOnly: boolean,
): Promise<void> {
  const before = await loadDailyCounts(transaction, batch);
  const remaining = batch.targetCount - before.committed;
  if (remaining <= 0) return;
  const items = await transaction<QualifiedItem[]>`
    SELECT
      item.id, item.variant_id AS "variantId",
      item.content_version_id AS "contentVersionId",
      version.content_hash AS "contentHash",
      variant.version AS "variantVersion",
      automation.id AS "automationRunId",
      automation.version AS "automationVersion"
    FROM official_site_daily_batch_items AS item
    JOIN content_variants AS variant
      ON variant.id=item.variant_id AND variant.tenant_id=item.tenant_id
      AND variant.current_content_version_id=item.content_version_id
      AND variant.status='quality_passed'
    JOIN content_versions AS version
      ON version.id=item.content_version_id AND version.tenant_id=item.tenant_id
    JOIN official_site_automation_runs AS automation
      ON automation.variant_id=item.variant_id AND automation.tenant_id=item.tenant_id
      AND automation.content_version_id=item.content_version_id
      AND automation.status='publish_pending'
    JOIN official_site_daily_batches AS source
      ON source.id=item.batch_id AND source.tenant_id=item.tenant_id
    WHERE item.tenant_id=${batch.tenantId}::uuid
      AND source.policy_id=${batch.policyId}::uuid
      AND source.business_date=${batch.businessDate}::date
      AND item.status IN ('qualified','reserve')
      AND (${previousAttemptsOnly}=false OR source.attempt_no<${batch.attemptNo})
    ORDER BY source.attempt_no,item.qualified_at,item.candidate_no,item.id
    LIMIT ${remaining}
    FOR UPDATE OF item,variant,automation
  `;
  if (items.length === 0) return;
  const allTimes = resolveScheduleTimes(
    batch.businessDate,
    batch.scheduleTimes.length === DAILY_TARGET ? batch.scheduleTimes : SCHEDULE_TIMES,
    now,
  );
  for (const [index, item] of items.entries()) {
    const slot = before.committed + index;
    const scheduledAt = allTimes[slot]!;
    const idempotencyKey = `official-site-daily:${item.id}`;
    const jobs = await transaction<{ id: string; version: number }[]>`
      INSERT INTO publish_jobs (
        tenant_id,variant_id,content_version_id,account_id,scheduled_at,
        idempotency_key,payload_hash,status,created_by,origin
      ) VALUES (
        ${batch.tenantId}::uuid,${item.variantId}::uuid,${item.contentVersionId}::uuid,
        ${batch.accountId}::uuid,${scheduledAt.toISOString()}::timestamptz,
        ${idempotencyKey},${item.contentHash},'scheduled',
        ${batch.createdBy}::uuid,'official_site_automation'
      )
      ON CONFLICT (tenant_id,idempotency_key) DO UPDATE SET
        idempotency_key=EXCLUDED.idempotency_key
      RETURNING id,version
    `;
    const job = jobs[0];
    if (!job) throw new Error('Daily publish job insert failed');
    const variants = await transaction<{ id: string }[]>`
      UPDATE content_variants SET status='scheduled',version=version+1
      WHERE id=${item.variantId}::uuid AND tenant_id=${batch.tenantId}::uuid
        AND status='quality_passed' AND version=${item.variantVersion}
      RETURNING id
    `;
    if (variants.length !== 1) throw new Error('Daily variant is not ready to schedule');
    const runs = await transaction<{ id: string }[]>`
      UPDATE official_site_automation_runs SET
        status='publishing',publish_job_id=${job.id}::uuid,version=version+1
      WHERE id=${item.automationRunId}::uuid AND tenant_id=${batch.tenantId}::uuid
        AND status='publish_pending' AND version=${item.automationVersion}
      RETURNING id
    `;
    if (runs.length !== 1) throw new Error('Daily automation run lease was lost');
    const batchItems = await transaction<{ id: string }[]>`
      UPDATE official_site_daily_batch_items SET
        status='scheduled',publish_job_id=${job.id}::uuid,
        scheduled_at=${scheduledAt.toISOString()}::timestamptz
      WHERE id=${item.id}::uuid AND tenant_id=${batch.tenantId}::uuid
        AND status IN ('qualified','reserve')
      RETURNING id
    `;
    if (batchItems.length !== 1) throw new Error('Daily batch item lease was lost');
    const event = DomainEventEnvelopeSchema.parse({
      aggregate: { id: job.id, type: 'publish_job' },
      data: {
        job_id: job.id,
        job_version: job.version,
        request_id: `daily-publish-${item.id.slice(0, 8)}`,
        scheduled_at: scheduledAt.toISOString(),
      },
      event_id: randomUUID(),
      event_type: 'publishing.job.execution_requested.v1',
      occurred_at: new Date().toISOString(),
      tenant: { id: batch.tenantId },
    });
    await transaction`
      INSERT INTO outbox_events (
        id,tenant_id,event_type,aggregate_type,aggregate_id,payload_json,next_attempt_at
      ) VALUES (
        ${event.event_id}::uuid,${batch.tenantId}::uuid,${event.event_type},
        ${event.aggregate.type},${event.aggregate.id}::uuid,
        ${JSON.stringify(event)}::text::jsonb,
        GREATEST(${scheduledAt.toISOString()}::timestamptz,now())
      )
    `;
  }
}

async function finalizeDailyPlan(
  transaction: postgres.TransactionSql,
  batch: BatchRow,
  counts: DailyCounts,
): Promise<void> {
  await transaction`
    UPDATE official_site_daily_batch_items AS item SET status='reserve'
    FROM official_site_daily_batches AS source
    WHERE source.id=item.batch_id AND source.tenant_id=item.tenant_id
      AND source.tenant_id=${batch.tenantId}::uuid
      AND source.policy_id=${batch.policyId}::uuid
      AND source.business_date=${batch.businessDate}::date
      AND item.status='qualified'
  `;
  const status =
    counts.published >= batch.targetCount
      ? 'completed'
      : counts.publishFailed > 0
        ? 'attention_required'
        : 'scheduled';
  const error =
    status === 'attention_required'
      ? {
          code: 'DAILY_PUBLISH_FAILED',
          message: '官网发布重试 3 次后仍失败，请重试原发布任务，不要重新生成内容。',
          schema_version: 'official-site-daily-error@1',
        }
      : null;
  await transaction`
    UPDATE official_site_daily_batches SET
      status=${status},scheduled_at=COALESCE(scheduled_at,now()),
      completed_at=CASE WHEN ${status}='completed' THEN COALESCE(completed_at,now()) ELSE completed_at END,
      last_error_json=${error ? JSON.stringify(error) : null}::text::jsonb,
      version=version+1
    WHERE id=${batch.id}::uuid AND tenant_id=${batch.tenantId}::uuid
      AND status='running' AND version=${batch.version}
  `;
}

async function setAttentionRequired(
  transaction: postgres.TransactionSql,
  batch: BatchRow,
  code: string,
  message: string,
): Promise<void> {
  await transaction`
    UPDATE official_site_daily_batches SET
      status='attention_required',
      last_error_json=${JSON.stringify({
        code,
        message,
        schema_version: 'official-site-daily-error@1',
      })}::text::jsonb,
      version=version+1
    WHERE id=${batch.id}::uuid AND tenant_id=${batch.tenantId}::uuid
      AND status='running' AND version=${batch.version}
  `;
}

export function resolveScheduleTimes(
  businessDate: string,
  scheduleTimes: readonly string[],
  now: Date,
): readonly Date[] {
  const planned = scheduleTimes.map(
    (time) => new Date(`${businessDate}T${time}${SHANGHAI_OFFSET}`),
  );
  const dayEnd = new Date(`${businessDate}T23:59:00${SHANGHAI_OFFSET}`);
  let cursor = new Date(now.getTime() + 60_000);
  const resolved = planned.map((time) => {
    const next = time > cursor ? time : cursor;
    cursor = new Date(next.getTime() + 60_000);
    return next;
  });
  if (resolved.at(-1)! <= dayEnd) return Object.freeze(resolved);
  const start = new Date(now.getTime() + 5_000);
  const availableMilliseconds = dayEnd.getTime() - start.getTime();
  if (availableMilliseconds < scheduleTimes.length - 1) {
    throw prerequisite(
      'DAILY_SCHEDULE_WINDOW_ENDED',
      '当天已没有足够时间完成排期，请检查内容为何未能及时通过质量门禁。',
    );
  }
  const interval = Math.floor(availableMilliseconds / (scheduleTimes.length - 1));
  return Object.freeze(
    scheduleTimes.map((_, index) => new Date(start.getTime() + index * interval)),
  );
}

const CONTENT_ANGLES = Object.freeze([
  angle('selection-guide', '选择指南', (keyword) => `${keyword}怎么选：一份实用判断指南`),
  angle('service-process', '服务流程', (keyword) => `${keyword}服务流程：从准备到完成要做什么`),
  angle('common-questions', '常见问题', (keyword) => `${keyword}常见问题一次讲清`),
  angle('preparation-list', '准备清单', (keyword) => `${keyword}前的准备清单与注意事项`),
  angle('risk-avoidance', '风险避坑', (keyword) => `${keyword}容易踩哪些坑：实用避坑建议`),
  angle('plan-comparison', '方案比较', (keyword) => `${keyword}不同方案如何比较`),
  angle('scenario-solution', '场景方案', (keyword) => `${keyword}常见场景与对应解决方案`),
  angle('time-arrangement', '时间安排', (keyword) => `${keyword}如何安排时间更稳妥`),
  angle('cost-structure', '费用构成', (keyword) => `${keyword}费用通常由哪些部分构成`),
  angle('service-standard', '服务标准', (keyword) => `${keyword}服务是否规范，可以看哪些细节`),
  angle('enterprise-case', '企业场景', (keyword) => `企业需要${keyword}时应重点确认什么`),
  angle('family-case', '家庭场景', (keyword) => `家庭办理${keyword}的完整行动建议`),
  angle('decision-checklist', '决策清单', (keyword) => `${keyword}决策前必须确认的事项`),
  angle('contract-points', '合同要点', (keyword) => `${keyword}相关约定应重点看什么`),
  angle('safety-guide', '安全指南', (keyword) => `${keyword}过程中的安全注意事项`),
  angle('efficiency-guide', '效率建议', (keyword) => `怎样提高${keyword}的整体效率`),
  angle('communication-guide', '沟通要点', (keyword) => `${keyword}前后如何沟通更清楚`),
  angle('acceptance-guide', '验收方法', (keyword) => `${keyword}完成后如何检查和验收`),
  angle('materials-guide', '资料准备', (keyword) => `${keyword}需要提前准备哪些信息和资料`),
  angle('special-situation', '特殊情况', (keyword) => `${keyword}遇到特殊情况时怎么处理`),
  angle('provider-evaluation', '服务商评估', (keyword) => `${keyword}服务商可以从哪些方面评估`),
  angle('quality-signals', '质量信号', (keyword) => `${keyword}质量好不好，可以观察哪些信号`),
  angle('before-during-after', '全流程提醒', (keyword) => `${keyword}前中后各阶段注意事项`),
  angle('misunderstandings', '常见误区', (keyword) => `${keyword}常见误区与正确处理方式`),
  angle('responsibility-boundary', '责任边界', (keyword) => `${keyword}过程中双方责任如何明确`),
  angle('information-check', '信息核对', (keyword) => `${keyword}前需要核对哪些关键信息`),
  angle('service-preparation', '服务准备', (keyword) => `做好哪些准备能让${keyword}更顺利`),
  angle('aftercare', '后续处理', (keyword) => `${keyword}完成后的后续事项清单`),
  angle('professionalism', '专业判断', (keyword) => `如何判断${keyword}服务是否专业`),
  angle('complete-guide', '完整指南', (keyword) => `${keyword}完整指南：从需求到落地`),
]);

type ContentAngle = (typeof CONTENT_ANGLES)[number];

function selectAngle(usage: AngleUsage, candidateNo: number): ContentAngle {
  const selected =
    CONTENT_ANGLES.find((item) => !usage.attempted.has(item.key)) ??
    CONTENT_ANGLES.find((item) => !usage.protected.has(item.key)) ??
    CONTENT_ANGLES[(candidateNo - 1) % CONTENT_ANGLES.length]!;
  usage.attempted.add(selected.key);
  usage.protected.add(selected.key);
  return selected;
}

function angle(key: string, label: string, title: (keyword: string) => string) {
  return Object.freeze({ key, label, title });
}

function objectiveFor(candidateNo: number): 'awareness' | 'conversion' | 'education' | 'trust' {
  return (['education', 'trust', 'awareness', 'conversion'] as const)[(candidateNo - 1) % 4]!;
}

function truncateTitle(value: string, max: number): string {
  const normalized = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requiredId(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function prerequisite(code: string, message: string): DailyBatchPrerequisiteError {
  return new DailyBatchPrerequisiteError(code, message);
}

class DailyBatchPrerequisiteError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DailyBatchPrerequisiteError';
  }
}
