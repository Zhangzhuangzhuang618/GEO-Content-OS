import {
  DomainEventEnvelopeSchema,
  findPublishedOwnerCompanyNames,
} from '@geo-content-os/contracts';
import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';

import type { OfficialSiteAutomationConfig } from './config.js';
import type { DailyCitationPort } from './daily-citation-retriever.js';
import type { JsonObject } from './generation.types.js';

type Platform = 'douyin' | 'lieju' | 'sohu';

export interface DouyinDailyDecisionAngle {
  readonly focus: string;
  readonly key: string;
  readonly label: string;
  readonly title: string;
}

type CandidateAngle = DouyinDailyDecisionAngle;

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
  readonly authoritySourceIds: readonly string[];
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
    private readonly dailyCitations: DailyCitationPort,
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
        SELECT
          (
            SELECT count(*)::integer FROM browser_platform_daily_batch_items AS current_item
            WHERE current_item.tenant_id=${batch.tenantId}::uuid
              AND current_item.batch_id=${batch.id}::uuid
          ) AS attempted,
          (
            SELECT count(*)::integer FROM browser_platform_daily_batch_items AS current_item
            WHERE current_item.tenant_id=${batch.tenantId}::uuid
              AND current_item.batch_id=${batch.id}::uuid
              AND current_item.status IN (
                'generating','quality_check','rewriting','media_pending'
              )
          ) AS "inProgress",
          count(*) FILTER (WHERE item.status IN (
            'scheduled','processing','published','publish_failed'
          ))::integer AS qualified
        FROM browser_platform_daily_batches AS day_batch
        JOIN browser_platform_daily_batch_items AS item
          ON item.batch_id=day_batch.id AND item.tenant_id=day_batch.tenant_id
        WHERE day_batch.tenant_id=${batch.tenantId}::uuid
          AND day_batch.policy_id=${batch.policyId}::uuid
          AND day_batch.business_date=${batch.businessDate}::date
      `;
      const count = counts[0] ?? { attempted: 0, inProgress: 0, qualified: 0 };
      if (count.qualified >= batch.targetCount) return;
      if (count.attempted >= batch.candidateLimit && count.inProgress === 0) {
        await attention(
          transaction,
          batch,
          'DAILY_CANDIDATE_LIMIT_REACHED',
          candidateLimitAttentionMessage(batch, count.qualified),
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
        try {
          await createCandidate(
            transaction,
            batch,
            seed,
            count.attempted + offset,
            this.config,
            this.dailyCitations,
          );
        } catch (error) {
          if (!(error instanceof DailyEvidenceMissingError)) throw error;
          await attention(transaction, batch, 'AUTOMATION_PREREQUISITE_MISSING', error.message);
          return;
        }
      }
    });
  }
}

async function retireFailed(transaction: postgres.TransactionSql, batch: BatchRow) {
  await transaction`
    UPDATE browser_platform_daily_batch_items AS item SET status='retired',
      last_error_json=jsonb_strip_nulls(jsonb_build_object(
        'code','GENERATION_FAILED_RETIRED',
        'generation_error',(
          SELECT run.error_json FROM generation_runs AS run
          WHERE run.tenant_id=item.tenant_id AND run.package_id=item.package_id
            AND run.variant_id=item.variant_id AND run.status='failed'
          ORDER BY run.created_at DESC,run.id DESC LIMIT 1
        ),
        'message','内容生成失败，候选已退出后台执行，调度器将按上限创建新候选补位。',
        'schema_version','browser-platform-automation-error@1'
      ))
    FROM content_variants AS variant
    WHERE item.tenant_id=${batch.tenantId}::uuid AND item.batch_id=${batch.id}::uuid
      AND variant.id=item.variant_id AND variant.tenant_id=item.tenant_id
      AND item.status='generating' AND variant.status='generation_failed'
  `;
  await transaction`
    UPDATE browser_platform_automation_runs AS automation SET status='manual_required',
      last_error_json=item.last_error_json,finished_at=now(),version=version+1
    FROM browser_platform_daily_batch_items AS item
    WHERE item.tenant_id=${batch.tenantId}::uuid AND item.batch_id=${batch.id}::uuid
      AND item.automation_run_id=automation.id AND automation.tenant_id=item.tenant_id
      AND item.status='retired' AND automation.status IN ('generation_pending','generating')
  `;
}

async function loadSeed(transaction: postgres.TransactionSql, batch: BatchRow): Promise<Seed> {
  const [brands, rules, keywords, knowledge, accounts, authoritySources] = await Promise.all([
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
    transaction<Seed['account'][]>`
      SELECT id,display_name AS "displayName",provider_account_id AS "providerAccountId",
        timezone,capabilities_json AS capabilities FROM platform_accounts
      WHERE id=${batch.accountId}::uuid AND tenant_id=${batch.tenantId}::uuid
        AND workspace_id=${batch.workspaceId}::uuid AND platform_code=${batch.platformCode}
        AND status='active' AND publish_mode='api' AND deleted_at IS NULL LIMIT 1
    `,
    transaction<{ holderName: string; id: string }[]>`
      SELECT id,metadata_json->>'holder_name' AS "holderName"
      FROM source_documents
      WHERE tenant_id=${batch.tenantId}::uuid AND workspace_id=${batch.workspaceId}::uuid
        AND (project_id=${batch.projectId}::uuid OR project_id IS NULL)
        AND source_type='image' AND status='active' AND deleted_at IS NULL
        AND trust_level IN ('verified','normal')
        AND metadata_json->>'schema_version'='source-certificate@1'
        AND metadata_json @> '{"article_use_allowed":true,"public_display_confirmed":true}'::jsonb
        AND (effective_from IS NULL OR effective_from<=${batch.businessDate}::date)
        AND (effective_to IS NULL OR effective_to>=${batch.businessDate}::date)
      ORDER BY created_at DESC,id
    `,
  ]);
  const brand = brands[0];
  const rule = rules[0];
  const account = accounts[0];
  if (!brand) throw new Error('请先发布企业品牌资料。');
  if (!rule) throw new Error(`${batch.platformCode} 平台规则尚未发布。`);
  if (!account) throw new Error(`${batch.platformCode} 托管浏览器账号不可用。`);
  if (!keywords.length) throw new Error(`项目没有适用于 ${batch.platformCode} 的关键词。`);
  if (!knowledge.length) throw new Error('项目没有可用的已解析知识资料。');
  const ownerCompanyNames = findPublishedOwnerCompanyNames(brand.profile);
  return {
    account,
    authoritySourceIds: Object.freeze(
      authoritySources
        .filter((source) => ownerCompanyNames.includes(source.holderName))
        .map((source) => source.id),
    ),
    brand,
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
  dailyCitations: DailyCitationPort,
) {
  const keyword = seed.keywords[(candidateNo - 1) % seed.keywords.length]!;
  const angle = candidateAngle(batch, keyword.term, candidateNo);
  const title = angle.title;
  const objective = (['education', 'trust', 'awareness'] as const)[(candidateNo - 1) % 3]!;
  const audience = `正在搜索“${keyword.term}”并需要服务决策信息的用户`;
  const evidence = await dailyCitations.retrieve({
    angle: angle.focus,
    authoritySourceIds: seed.authoritySourceIds,
    audience,
    businessDate: batch.businessDate,
    candidateNo,
    keyword: keyword.term,
    objective,
    platformCode: batch.platformCode,
    projectId: batch.projectId,
    tenantId: batch.tenantId,
    title,
    userId: batch.createdBy,
    workspaceId: batch.workspaceId,
  });
  if (evidence.citations.length === 0) {
    throw new DailyEvidenceMissingError(`企业资料索引中没有找到与候选“${title}”相关的可用证据。`);
  }
  const platformInstruction =
    batch.platformCode === 'lieju'
      ? '标题保持5-30字并以用户问题或解决方法为中心，自然使用“如何、怎么、指南、方法、哪些”等问法之一。允许明确介绍本企业服务范围、流程、可核验能力和适用场景，自然提示通过页面联系方式咨询，并保留与正文相关的外部网址或官方核验链接；品牌、事实和资质表述必须与当前企业资料及引用证据一致。正文不得出现具体电话或手机号、微信/QQ账号、极限词、排名、竞品贬损、虚假价格、虚假资质、虚构案例、客户评价或结果保证。'
      : batch.platformCode === 'douyin'
        ? '输出抖音图文笔记：标题先回答本候选指定的搜索决策意图，不得退回泛化的流程或准备知识题；在输入有依据时组合“地域＋具体场景＋决策问题”，缺少地域或场景证据时不得补造。platform_meta.content_kind 必须是 image_note；生成6-9张图文卡片，顺序为封面、正文、总结。现场、报价、防护、工期和清单是安全技术槽位，必须全部围绕本篇唯一主意图提供不同的判断或动作，不能写成每篇相同的七段模板；正文每页控制在24-88字，禁止长段拆页、模板标题和同义重复。同时提供420-900字、5-8个自然段的独立发布主文案，连同换行和全部#topics不得超过1000字：首段两句完成点题和痛点，第二至第三段给解决方案并在资料支持时自然提及一次本企业全称，随后讲清费用边界、防护风险和工期安排，倒数第二段至少3条编号避坑点，最后给选择依据；不得复制摘要、正文块或卡片，不得使用模板钩子和助手过渡语。“真实场景、真实案例、收费对比、资质核验、合同条款解读、口碑参考”等证据承诺，只有在对应资料直接支持且正文通过 citation_map 映射时才能写进标题；否则改写为核对方法、选择标准或比较维度。topics 使用3-8个紧贴地域、场景和服务对象的话题。不得声明原创、不得伪造热点、排行、亲历、用户评价或无证据资质；发布器会如实勾选 AI 创作标识。'
        : '不得声明原创，不得伪造热点、排行、亲历或用户评价；发布器会如实勾选 AI 创作标识。';
  const constraints = {
    additional_instructions: [
      `这是 ${batch.businessDate} ${batch.platformCode} 自动批次的第 ${candidateNo} 个候选。`,
      `围绕“${keyword.term}”的“${angle.label}”展开。`,
      ...(batch.platformCode === 'douyin'
        ? [
            `本篇唯一搜索决策意图为“${angle.key}”，主题焦点为：${angle.focus}`,
            '标题、主文案和全部卡片必须共同回答该焦点；其他必备安全模块只解释它的条件和边界，不得抢成另一篇泛化流程文。',
          ]
        : []),
      '只使用给定品牌资料和引用证据，不得编造价格、规模、资质、排名或承诺。',
      platformInstruction,
    ].join(batch.platformCode === 'douyin' ? '\n' : ''),
    authorized_certificate_source_ids: seed.authoritySourceIds,
    cta: batch.platformCode === 'lieju' ? '通过页面联系方式咨询具体需求' : null,
    schema_version: 'brief-constraints@1',
    ...(batch.platformCode === 'douyin'
      ? {
          douyin_daily_direct: true,
          douyin_search_intent: angle.key,
          douyin_topic_focus: angle.focus,
          server_bound_generation_context: true,
        }
      : {}),
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
      ${objective},${audience},
      ARRAY[${batch.platformCode}]::varchar[],${JSON.stringify(constraints)}::text::jsonb,'draft',
      (${batch.businessDate}::date+interval '1 day'-interval '1 second'),${batch.createdBy}::uuid
    ) RETURNING id
  `;
  const briefId = required(briefs[0]?.id, 'Brief insert failed');
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
      audience,
      brief_id: briefId,
      constraints,
      objective,
      platform_codes: [batch.platformCode],
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
  const generationModelKey = browserPlatformGenerationModelKey(batch.platformCode, config);
  const masterRuns = await transaction<{ id: string }[]>`
    INSERT INTO generation_runs (
      tenant_id,workspace_id,project_id,package_id,variant_id,skill_name,skill_version,
      prompt_version_id,model_key,input_hash,request_id
    ) VALUES (
      ${batch.tenantId}::uuid,${batch.workspaceId}::uuid,${batch.projectId}::uuid,
      ${packageId}::uuid,NULL,'content-writer',${config.writerSkillVersion},
      ${config.writerPromptVersionId}::uuid,${generationModelKey},${inputHash},${requestId}
    ) RETURNING id
  `;
  const variantRuns = await transaction<{ id: string }[]>`
    INSERT INTO generation_runs (
      tenant_id,workspace_id,project_id,package_id,variant_id,skill_name,skill_version,
      prompt_version_id,model_key,input_hash,request_id
    ) VALUES (
      ${batch.tenantId}::uuid,${batch.workspaceId}::uuid,${batch.projectId}::uuid,
      ${packageId}::uuid,${variantId}::uuid,'content-writer',${config.writerSkillVersion},
      ${config.writerPromptVersionId}::uuid,${generationModelKey},${inputHash},${requestId}
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
      model_key: generationModelKey,
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
        ...(batch.platformCode === 'douyin' ? { angle_key: angle.key } : {}),
        evidence_context_hash: evidence.contextHash,
        evidence_query_hash: evidence.queryHash,
        evidence_retrieval_degraded: evidence.degraded,
        evidence_source_count: sourceIds.length,
        platform_code: batch.platformCode,
        title,
      })}::text::jsonb,${requestId}
    )
  `;
}

export function browserPlatformGenerationModelKey(
  platformCode: Platform,
  config: Pick<OfficialSiteAutomationConfig, 'draftModelKey' | 'rewriteModelKey'>,
): string {
  return platformCode === 'douyin'
    ? (config.draftModelKey ?? config.rewriteModelKey)
    : config.rewriteModelKey;
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

export function candidateLimitAttentionMessage(
  batch: Pick<BatchRow, 'candidateLimit' | 'targetCount'>,
  scheduledCount: number,
): string {
  return `当天已尝试 ${batch.candidateLimit} 篇；已有 ${scheduledCount} 篇完成排期（含发布中或已发布），仍缺 ${Math.max(batch.targetCount - scheduledCount, 0)} 篇，批次已转为需要处理。`;
}

class DailyEvidenceMissingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DailyEvidenceMissingError';
  }
}

const ANGLES = Object.freeze([
  { label: '服务选择', title: (keyword: string) => `${keyword}怎么选服务` },
  { label: '准备清单', title: (keyword: string) => `${keyword}前需要准备什么` },
  { label: '流程说明', title: (keyword: string) => `${keyword}服务流程怎么安排` },
  { label: '费用因素', title: (keyword: string) => `${keyword}费用受哪些因素影响` },
  { label: '风险边界', title: (keyword: string) => `${keyword}常见问题怎么避坑` },
  { label: '验收检查', title: (keyword: string) => `${keyword}完成后如何验收` },
]);

const DOUYIN_ROTATION_EPOCH_DAY = Math.floor(Date.UTC(2026, 7, 30) / 86_400_000);

const DOUYIN_DECISION_ANGLES = Object.freeze([
  {
    focus:
      '回答用户应按哪些可核验条件选择合适服务，给出推荐标准；不得输出无证据公司榜单、名次或“最好”。',
    key: 'recommendation',
    label: '推荐决策',
    suffix: '怎么选更靠谱',
  },
  {
    focus: '按服务范围、现场条件、费用口径、责任和时效做同维度方案比较；不得点名竞品或伪造测评。',
    key: 'comparison',
    label: '方案比较',
    suffix: '方案怎么比较',
  },
  {
    focus:
      '拆解运输、人工、拆装、包装、楼层、等待等资料支持的收费项目和变化条件；无报价证据不得写具体价格。',
    key: 'pricing',
    label: '收费核对',
    suffix: '收费怎么核对',
  },
  {
    focus: '说明如何核对经营主体、可用证照、合同和可验证服务信息；缺少对应证据时只能写核验动作。',
    key: 'legitimacy',
    label: '正规性核验',
    suffix: '正规性怎么核验',
  },
  {
    focus: '围绕服务范围、增项条件、取消变更、责任边界和验收记录说明合同应核对的内容。',
    key: 'contract',
    label: '合同条款',
    suffix: '合同重点看什么',
  },
  {
    focus: '围绕物品清单、异常记录、责任划分和赔付约定给出事前核对方法，不承诺结果。',
    key: 'liability',
    label: '赔付责任',
    suffix: '损坏赔付怎么约定',
  },
  {
    focus: '根据物品、道路、限高、装卸距离和停车条件说明车型选择依据，不编造车辆能力。',
    key: 'vehicle',
    label: '车型选择',
    suffix: '车型怎么选合适',
  },
  {
    focus: '说明人工计费可能涉及的人数、工时、拆装、搬运距离和等待边界，避免只看总价。',
    key: 'labor',
    label: '人工费用',
    suffix: '人工费怎么核对',
  },
  {
    focus: '围绕楼层、电梯预约、门洞通道、停车和园区登记等进场条件说明核对方法。',
    key: 'access',
    label: '楼层与进场',
    suffix: '进场条件怎么核对',
  },
  {
    focus: '集中回答常见临时增项、信息遗漏和服务边界风险，形成具体避坑判断。',
    key: 'risk_avoidance',
    label: '风险避坑',
    suffix: '服务怎么避坑',
  },
  {
    focus: '围绕预约窗口、车辆人员调度、进出场限制和计划变更说明时间安排依据。',
    key: 'scheduling',
    label: '工期调度',
    suffix: '时间安排怎么确认',
  },
  {
    focus: '围绕交接清单、数量和外观记录、异常处理及完成标准说明验收方法。',
    key: 'acceptance',
    label: '交接验收',
    suffix: '交接验收怎么做',
  },
] as const);

function candidateAngle(batch: BatchRow, keyword: string, candidateNo: number): CandidateAngle {
  if (batch.platformCode === 'douyin') {
    return douyinDailyDecisionAngle({
      businessDate: batch.businessDate,
      candidateNo,
      keyword,
      targetCount: batch.targetCount,
    });
  }
  const angleIndex = (candidateNo - 1) % ANGLES.length;
  const selected = ANGLES[angleIndex]!;
  const maximum = batch.platformCode === 'lieju' ? 30 : 72;
  return Object.freeze({
    focus: selected.label,
    key: `general-${angleIndex + 1}`,
    label: selected.label,
    title: truncate(selected.title(keyword), maximum),
  });
}

export function douyinDailyDecisionAngle(input: {
  readonly businessDate: string;
  readonly candidateNo: number;
  readonly keyword: string;
  readonly targetCount: number;
}): DouyinDailyDecisionAngle {
  const businessDay = Math.floor(Date.parse(`${input.businessDate}T00:00:00Z`) / 86_400_000);
  const dayOffset = Number.isFinite(businessDay) ? businessDay - DOUYIN_ROTATION_EPOCH_DAY : 0;
  const rawIndex = dayOffset * Math.max(1, input.targetCount) + Math.max(1, input.candidateNo) - 1;
  const index =
    ((rawIndex % DOUYIN_DECISION_ANGLES.length) + DOUYIN_DECISION_ANGLES.length) %
    DOUYIN_DECISION_ANGLES.length;
  const selected = DOUYIN_DECISION_ANGLES[index]!;
  return Object.freeze({
    focus: selected.focus,
    key: selected.key,
    label: selected.label,
    title: douyinDecisionTitle(input.keyword, selected.suffix),
  });
}

function douyinDecisionTitle(keyword: string, suffix: string): string {
  const normalizedKeyword = keyword.normalize('NFC').replace(/\s+/gu, ' ').trim();
  const suffixLength = [...suffix].length;
  const keywordLimit = Math.max(1, 26 - suffixLength);
  return `${[...normalizedKeyword].slice(0, keywordLimit).join('')}${suffix}`;
}

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
