import { EMBEDDING_DIMENSION } from '@geo-content-os/adapter-embedding';
import { DisabledRerankAdapter } from '@geo-content-os/adapter-rerank';
import { InMemoryStorageAdapter } from '@geo-content-os/adapter-storage';
import { SafeWebFetchAdapter, WebFetchBlockedError } from '@geo-content-os/adapter-web-fetch';
import type { PlatformCode } from '@geo-content-os/contracts';
import type { QualityCheckerData, QualityIssue } from '@geo-content-os/contracts/skills';
import {
  ContentGenerationWorker,
  type ContentWriterPort,
  type GeneratedContent,
  PostgresGenerationStore,
} from '@geo-content-os/worker-ai';
import {
  CredentialEnvelopeService,
  LocalCredentialKms,
} from '@geo-content-os/security/credentials';
import {
  startPostgresTestContainer,
  type StartedPostgreSqlContainer,
} from '@geo-content-os/testkit';
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type APIResponse,
} from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import postgres, { type Sql } from 'postgres';

import {
  AnalyticsQueryService,
  calculateGeoTotal,
  CitationSearchService,
  FREEZE_V21_SEED,
  HybridSearchRepository,
  MetricRegistry,
  MetricsImportService,
  migrateDatabase,
  OutboxWriter,
  OutboxRelayStore,
  PasswordHasher,
  PostgresPublisherStore,
  PublishJobService,
  PublisherWorker,
  QualityPipelineRepository,
  QualityPipelineService,
  ReviewDecisionService,
  seedFreezeV21,
  SubmitReviewService,
  SupportAccessNotFoundError,
  SupportAccessService,
  UsageLedgerRepository,
  type MetricsImportScope,
  type PlatformDelivery,
  type PublishJobScope,
  type PublishClaim,
  type PublisherPlatformPort,
  type QualityEvaluatorPort,
  type QualityPipelineRequest,
  type QualityPipelineScope,
  type ReviewDecisionScope,
  type SubmitReviewScope,
} from './runtime.mjs';

const OWNER_ID = '10000000-0000-4000-8000-000000000001';
const TENANT_ID = '20000000-0000-4000-8000-000000000001';
const WORKSPACE_ID = FREEZE_V21_SEED.workspaceId;
const PROJECT_ID = FREEZE_V21_SEED.projectId;
const BRAND_ID = '50000000-0000-4000-8000-000000000143';
const KEYWORD_SET_ID = '60000000-0000-4000-8000-000000000143';
const KEYWORD_ID = '70000000-0000-4000-8000-000000000143';
const SOURCE_ID = '80000000-0000-4000-8000-000000000143';
const CHUNK_ID = '81000000-0000-4000-8000-000000000143';
const QUALITY_PROMPT_ID = '90000000-0000-4000-8000-000000000143';
const FACT_PROMPT_ID = '91000000-0000-4000-8000-000000000143';
const SUPPORT_GRANTOR_ID = 'a0000000-0000-4000-8000-000000000143';
const SUPPORT_USER_ID = 'a1000000-0000-4000-8000-000000000143';
const BACKUP_OWNER_ID = 'a2000000-0000-4000-8000-000000000143';
const OTHER_USER_ID = 'b0000000-0000-4000-8000-000000000143';
const OTHER_TENANT_ID = 'b1000000-0000-4000-8000-000000000143';
const OTHER_WORKSPACE_ID = 'b2000000-0000-4000-8000-000000000143';
const OTHER_PROJECT_ID = 'b3000000-0000-4000-8000-000000000143';
const API_PREFIX = '/api/v1';
const PASSWORD = 'system E2E enterprise passphrase';
const SOURCE_TEXT =
  'Traceable evidence is required for enterprise GEO content and every published claim.';
const SOURCE_HASH = sha256(SOURCE_TEXT);
const PLATFORMS = [
  'official_site',
  'baijiahao',
  'toutiao',
  'zhihu',
  'xiaohongshu',
  'wechat_mp',
  'douyin',
] as const satisfies readonly PlatformCode[];
const GEO_SCORES = Object.freeze({
  answerability: 85,
  entity: 90,
  evidence: 95,
  platform_fit: 88,
  question: 80,
  readability_safety: 92,
  total: calculateGeoTotal({
    answerability: 85,
    entity: 90,
    evidence: 95,
    platform_fit: 88,
    question: 80,
    readability_safety: 92,
  }),
});

let apiOutput = '';
let apiProcess: ChildProcessWithoutNullStreams | undefined;
let baseUrl = '';
let client: Sql | undefined;
let container: StartedPostgreSqlContainer | undefined;
const originalEnvironment = new Map<string, string | undefined>();

test.describe('AC-001..AC-016 system acceptance', () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  test.beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 16 });
    const passwordHash = await new PasswordHasher().hash(PASSWORD);
    await seedSystem(requireClient(client), passwordHash);
    const port = await freePort();
    await configureRuntime(requireClient(client), container.getConnectionUri(), port);
    apiProcess = startApiProcess();
    baseUrl = `http://127.0.0.1:${port}`;
    await waitForApi(apiProcess, baseUrl);
  });

  test.afterAll(async () => {
    await stopApiProcess(apiProcess);
    await client?.end();
    await container?.stop();
    restoreRuntime();
  });

  test('completes a Mock Brief through eight-platform delivery and metrics', async () => {
    const database = requireClient(client);
    const state: JourneyState = {
      accounts: new Map(),
      artifacts: [],
      jobs: [],
      variants: [],
    };
    let actor: AuthenticatedApi | undefined;

    await test.step('AC-001 identity, tenant switch, disablement, and isolation', async () => {
      actor = await login();
      await switchTenant(actor);
      const own = await actor.api.get(`${API_PREFIX}/projects/${PROJECT_ID}`);
      expect(own.status()).toBe(200);
      const foreign = await actor.api.get(`${API_PREFIX}/projects/${OTHER_PROJECT_ID}`);
      expect(foreign.status()).toBe(404);
      expect((await foreign.json()).error.code).toBe('RESOURCE_NOT_FOUND');

      await database`UPDATE memberships SET status='disabled' WHERE tenant_id=${TENANT_ID}::uuid AND user_id=${OWNER_ID}::uuid`;
      const disabled = await actor.api.get(`${API_PREFIX}/projects/${PROJECT_ID}`);
      expect(disabled.status()).toBe(401);
      await database`UPDATE memberships SET status='active' WHERE tenant_id=${TENANT_ID}::uuid AND user_id=${OWNER_ID}::uuid`;
      await actor.api.dispose();
      actor = await login();
      await switchTenant(actor);
    });

    await test.step('AC-002 support access expires, revokes, and audits every read', async () => {
      const support = new SupportAccessService({ client: database } as never);
      const grant = await support.createGrant(
        SUPPORT_GRANTOR_ID,
        {
          expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
          platform_user_id: SUPPORT_USER_ID,
          reason: 'System E2E tenant diagnosis',
          scope: {
            permissions: ['tenant.profile.read'],
            resource_types: ['tenant'],
          },
          tenant_id: TENANT_ID,
        },
        { requestId: 'system-support-create-143' },
      );
      const tenantName = await support.withTenantAccess(
        {
          action: 'support.tenant.read',
          actorUserId: SUPPORT_USER_ID,
          grantId: grant.id,
          permission: 'tenant.profile.read',
          requestId: 'system-support-read-143',
          resourceId: TENANT_ID,
          resourceType: 'tenant',
          tenantId: TENANT_ID,
        },
        async (transaction) =>
          (
            await transaction<{ name: string }[]>`SELECT name FROM tenants WHERE id=${TENANT_ID}`
          ).at(0)?.name,
      );
      expect(tenantName).toBe('示例科技');
      await support.revokeGrant(SUPPORT_GRANTOR_ID, grant.id, {
        requestId: 'system-support-revoke-143',
      });
      await expect(
        support.withTenantAccess(
          {
            action: 'support.tenant.read',
            actorUserId: SUPPORT_USER_ID,
            grantId: grant.id,
            permission: 'tenant.profile.read',
            requestId: 'system-support-revoked-143',
            resourceType: 'tenant',
            tenantId: TENANT_ID,
          },
          async () => true,
        ),
      ).rejects.toBeInstanceOf(SupportAccessNotFoundError);
      const audits = await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM audit_events
        WHERE support_access_grant_id=${grant.id}::uuid
      `;
      expect(audits[0]?.count).toBe(3);
    });

    await test.step('AC-003 material is parsed, chunked, indexed, and SSRF is blocked', async () => {
      const rows = await database<
        { chunks: number; embeddings: number; ingestStatus: string; sourceStatus: string }[]
      >`
        SELECT
          (SELECT count(*)::integer FROM source_chunks WHERE source_document_id=${SOURCE_ID}) AS chunks,
          (SELECT count(*)::integer FROM embeddings WHERE chunk_id=${CHUNK_ID}) AS embeddings,
          (SELECT status FROM ingest_jobs WHERE source_document_id=${SOURCE_ID}) AS "ingestStatus",
          (SELECT status FROM source_documents WHERE id=${SOURCE_ID}) AS "sourceStatus"
      `;
      expect(rows[0]).toEqual({
        chunks: 1,
        embeddings: 1,
        ingestStatus: 'succeeded',
        sourceStatus: 'active',
      });
      const web = new SafeWebFetchAdapter({
        allowedHosts: [],
        allowedPorts: [80, 443],
        deniedHosts: [],
        maxBytes: 1024 * 1024,
        maxRedirects: 3,
        timeoutMs: 1_000,
        userAgent: 'GEO-System-E2E/1.0',
      });
      await expect(web.fetch('http://127.0.0.1/private')).rejects.toBeInstanceOf(
        WebFetchBlockedError,
      );
    });

    await test.step('AC-004 RAG enforces scope and returns a locatable citation', async () => {
      const embedding = unitVector();
      const service = new CitationSearchService(
        new HybridSearchRepository(database),
        new DisabledRerankAdapter('system-disabled-rerank'),
      );
      const context = await service.search({
        embeddingModelKey: 'system-embedding',
        query: 'traceable evidence',
        queryEmbedding: embedding,
        requestId: 'system-rag-request-143',
        scope: {
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
          userId: OWNER_ID,
          workspaceId: WORKSPACE_ID,
        },
        trustLevels: ['verified'],
      });
      expect(context.degraded).toBe(true);
      expect(context.hits[0]).toMatchObject({
        chunkId: CHUNK_ID,
        sourceDocumentId: SOURCE_ID,
        sourceUri: 'https://example.com/system-evidence',
      });
      await expect(
        service.search({
          embeddingModelKey: 'system-embedding',
          query: 'traceable evidence',
          queryEmbedding: embedding,
          requestId: 'system-rag-foreign-143',
          scope: {
            projectId: OTHER_PROJECT_ID,
            tenantId: TENANT_ID,
            userId: OWNER_ID,
            workspaceId: WORKSPACE_ID,
          },
        }),
      ).resolves.toMatchObject({ hits: [] });
    });

    await test.step('AC-005 topic inputs create a Brief with keyword and source links', async () => {
      const response = await requireActor(actor).api.post(`${API_PREFIX}/briefs`, {
        data: {
          audience: '负责企业内容治理与增长的市场团队负责人',
          constraints: {
            additional_instructions: '只使用可追溯资料',
            cta: '申请内容诊断',
            schema_version: 'brief-constraints@1',
          },
          due_at: null,
          keyword_ids: [KEYWORD_ID],
          objective: 'trust',
          platform_codes: PLATFORMS,
          primary_keyword_id: KEYWORD_ID,
          project_id: PROJECT_ID,
          source_ids: [SOURCE_ID],
          title: '企业 GEO 多平台内容生产',
          workspace_id: WORKSPACE_ID,
        },
        headers: writeHeaders(requireActor(actor).csrf, 'system-brief-143'),
      });
      expect(response.status()).toBe(201);
      state.briefId = readData<{ id: string }>(await response.json()).id;
      const links = await database<{ keywords: number; sources: number }[]>`
        SELECT
          (SELECT count(*)::integer FROM brief_keywords WHERE brief_id=${state.briefId}::uuid) AS keywords,
          (SELECT count(*)::integer FROM brief_sources WHERE brief_id=${state.briefId}::uuid) AS sources
      `;
      expect(links[0]).toEqual({ keywords: 1, sources: 1 });
    });

    await test.step('AC-006 generates seven variants, retries one failure, and preserves a lock', async () => {
      const aggregate = await createPackageAndGenerate(
        requireActor(actor),
        requireId(state.briefId),
      );
      state.packageId = aggregate.packageId;
      state.variants = aggregate.variants;
      const firstEvent = await generationEvent(database, aggregate.packageId);
      const firstResult = await new ContentGenerationWorker(
        new PostgresGenerationStore(database),
        new CostWriter(database, firstEvent, new Set<PlatformCode>(['douyin'])),
        3,
      ).run(firstEvent.payload);
      expect(firstResult).toMatchObject({ failed: 1, succeeded: 6 });

      const official = requireVariant(state.variants, 'official_site');
      const beforeLock = await readVariant(requireActor(actor), official.id);
      const bodyBlock = beforeLock.current_content?.blocks.find(
        (block) => block.block_key === 'body',
      );
      if (!bodyBlock) throw new Error('Generated body block is missing');
      const lock = await requireActor(actor).api.post(
        `${API_PREFIX}/content-variants/${official.id}/blocks/${bodyBlock.id}/lock`,
        {
          data: { reason: 'Keep verified evidence wording' },
          headers: {
            ...writeHeaders(requireActor(actor).csrf, 'system-lock-143'),
            'if-match': String(beforeLock.variant.version),
          },
        },
      );
      expect(lock.status()).toBe(201);
      const lockedVersion = readData<{ variant_version: number }>(
        await lock.json(),
      ).variant_version;
      const regenerate = await requireActor(actor).api.post(
        `${API_PREFIX}/content-variants/${official.id}/regenerate`,
        {
          data: { locked_block_keys: ['body'], model_policy: 'balanced' },
          headers: {
            ...writeHeaders(requireActor(actor).csrf, 'system-regenerate-lock-143'),
            'if-match': String(lockedVersion),
          },
        },
      );
      expect(regenerate.status()).toBe(202);
      const lockEvent = await generationEvent(database, aggregate.packageId);
      await new ContentGenerationWorker(
        new PostgresGenerationStore(database),
        new CostWriter(database, lockEvent),
        2,
      ).run(lockEvent.payload);
      const afterLock = await readVariant(requireActor(actor), official.id);
      expect(blockText(afterLock, 'body')).toBe(blockText(beforeLock, 'body'));

      const douyin = requireVariant(state.variants, 'douyin');
      const failed = await readVariant(requireActor(actor), douyin.id);
      expect(failed.variant.status).toBe('generation_failed');
      const retry = await requireActor(actor).api.post(
        `${API_PREFIX}/content-variants/${douyin.id}/regenerate`,
        {
          data: { locked_block_keys: [], model_policy: 'balanced' },
          headers: {
            ...writeHeaders(requireActor(actor).csrf, 'system-regenerate-douyin-143'),
            'if-match': String(failed.variant.version),
          },
        },
      );
      expect(retry.status()).toBe(202);
      const retryEvent = await generationEvent(database, aggregate.packageId);
      await new ContentGenerationWorker(
        new PostgresGenerationStore(database),
        new CostWriter(database, retryEvent),
        2,
      ).run(retryEvent.payload);
      const generated = await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM content_variants
        WHERE package_id=${aggregate.packageId}::uuid AND status='generated'
      `;
      expect(generated[0]?.count).toBe(7);
    });

    await test.step('AC-007 unsupported high-risk claims have no evidence and block quality', async () => {
      const douyin = requireVariant(state.variants, 'douyin');
      const blocked = await runQuality(
        requireActor(actor),
        database,
        requireId(state.packageId),
        douyin,
        true,
      );
      expect(blocked.decision).toBe('block');
      expect(blocked.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rule_id: 'fact.high_risk.unsupported', severity: 'BLOCK' }),
        ]),
      );
      const evidence = await database<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM fact_evidences AS evidence
        JOIN fact_check_results AS result ON result.id=evidence.fact_check_result_id
        WHERE result.variant_id=${douyin.id}::uuid
      `;
      expect(evidence[0]?.count).toBe(0);

      const detail = await readVariant(requireActor(actor), douyin.id);
      const revised = await requireActor(actor).api.patch(
        `${API_PREFIX}/content-variants/${douyin.id}`,
        {
          data: { content: document('douyin', '已删除无证据高风险陈述。') },
          headers: {
            ...writeHeaders(requireActor(actor).csrf, 'system-revise-douyin-143'),
            'if-match': String(detail.variant.version),
          },
        },
      );
      expect(revised.status()).toBe(200);
      const passed = await runQuality(
        requireActor(actor),
        database,
        requireId(state.packageId),
        douyin,
        false,
      );
      expect(passed.decision).toBe('pass');
    });

    await test.step('AC-008 fact, brand, compliance, format, duplicate, and readability checks run', async () => {
      for (const variant of state.variants.filter((item) => item.platformCode !== 'douyin')) {
        const report = await runQuality(
          requireActor(actor),
          database,
          requireId(state.packageId),
          variant,
          false,
        );
        expect(report.decision, variant.platformCode).toBe('pass');
        expect(new Set(report.issues.map((issue) => issue.category))).toEqual(
          new Set(['fact', 'brand', 'compliance', 'format', 'duplicate', 'readability']),
        );
      }
      const passed = await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM content_variants
        WHERE package_id=${requireId(state.packageId)}::uuid AND status='quality_passed'
      `;
      expect(passed[0]?.count).toBe(7);
      const citations = await database<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM content_variants AS variant
        JOIN ai_citations AS citation
          ON citation.content_version_id=variant.current_content_version_id
          AND citation.tenant_id=variant.tenant_id
        WHERE variant.package_id=${requireId(state.packageId)}::uuid
      `;
      expect(citations[0]?.count).toBe(7);
    });

    await test.step('AC-009 review rejects content, prompt, rule, and citation drift', async () => {
      const selected = state.variants.slice(0, 6).map((variant) => variant.id);
      const submitScope = reviewSubmitScope('system-review-submit-143');
      const submitted = await new SubmitReviewService(database).submit(submitScope, {
        packageId: requireId(state.packageId),
        variantIds: selected,
      });
      state.firstSnapshotId = submitted.snapshot.id;
      await expect(
        database`UPDATE content_versions SET content_hash=${'f'.repeat(64)} WHERE id=${submitted.snapshot.variants[0]!.contentVersionId}::uuid`,
      ).rejects.toThrow(/append-only/u);
      await expect(
        database`UPDATE prompt_versions SET change_summary='tampered' WHERE id=${FREEZE_V21_SEED.promptVersionId}::uuid`,
      ).rejects.toThrow(/immutable|append-only/u);
      await expect(
        database`UPDATE platform_rule_versions SET change_summary='tampered' WHERE id=${submitted.snapshot.variants[0]!.platformRuleVersionId}::uuid`,
      ).rejects.toThrow(/immutable|append-only/u);

      const target = submitted.snapshot.variants[0]!;
      const extraCitationId = randomUUID();
      await expect(
        database.begin(async (transaction) => {
          await transaction`
            INSERT INTO ai_citations (
              id, tenant_id, content_version_id, claim_key, claim_text,
              chunk_id, quote_text, quote_hash
            ) VALUES (
              ${extraCitationId}::uuid, ${TENANT_ID}::uuid, ${target.contentVersionId}::uuid,
              'late-citation', 'Late citation drift', ${CHUNK_ID}::uuid, ${SOURCE_TEXT}, ${SOURCE_HASH}
            )
          `;
          await expect(
            new ReviewDecisionService(database).approve(
              reviewDecisionScope('system-review-tamper-143'),
              submitted.snapshot.id,
              { expectedVersion: 1, variantIds: selected },
              transaction,
            ),
          ).rejects.toMatchObject({ code: 'REVIEW_DECISION_VERSION_CONFLICT' });
          throw new Error('rollback citation drift probe');
        }),
      ).rejects.toThrow('rollback citation drift probe');
    });

    await test.step('AC-010 partial review leaves unaffected variants independently reviewable', async () => {
      const firstSix = state.variants.slice(0, 6).map((variant) => variant.id);
      const first = await new ReviewDecisionService(database).approve(
        reviewDecisionScope('system-review-approve-six-143'),
        requireId(state.firstSnapshotId),
        { expectedVersion: 1, variantIds: firstSix },
      );
      expect(first.snapshot.status).toBe('approved');
      const last = state.variants[6]!;
      expect((await readVariant(requireActor(actor), last.id)).variant.status).toBe(
        'quality_passed',
      );
      const second = await new SubmitReviewService(database).submit(
        reviewSubmitScope('system-review-submit-last-143'),
        { packageId: requireId(state.packageId), variantIds: [last.id] },
      );
      await new ReviewDecisionService(database).approve(
        reviewDecisionScope('system-review-approve-last-143'),
        second.snapshot.id,
        { expectedVersion: 1, variantIds: [last.id] },
      );
      const approved = await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM content_variants
        WHERE package_id=${requireId(state.packageId)}::uuid AND status='approved'
      `;
      expect(approved[0]?.count).toBe(7);
    });

    await test.step('AC-011 API publishing is outbox-backed and externally idempotent', async () => {
      const credentials = new CredentialEnvelopeService(
        new LocalCredentialKms('system-v1', { 'system-v1': randomBytes(32) }),
      );
      const encrypted = await credentials.encrypt(JSON.stringify({ access_token: 'system-token' }));
      await seedPlatformAccounts(database, state, encrypted);
      const service = new PublishJobService(database);
      for (const variant of state.variants) {
        const accountId = state.accounts.get(variant.platformCode);
        if (!accountId) throw new Error(`Account ${variant.platformCode} is missing`);
        const job = await service.create(
          publishScope(`system-publish-${variant.platformCode}-143`),
          {
            account_id: accountId,
            scheduled_at: new Date(Date.now() - 1_000).toISOString(),
            variant_id: variant.id,
          },
          `system-publish-${variant.platformCode}-143`,
        );
        state.jobs.push({ id: job.id, platformCode: variant.platformCode });
      }
      const platform = new RecordingPlatform();
      const storage = new InMemoryStorageAdapter('system-publisher-143');
      for (const job of state.jobs) {
        const event = await publishEvent(database, job.id);
        const worker = new PublisherWorker(
          {
            platform,
            storage,
            store: new PostgresPublisherStore(database, 1_000),
          },
          credentials,
        );
        await expect(worker.run(event)).resolves.toMatchObject({
          disposition: 'processed',
          mode: job.platformCode === 'official_site' ? 'api' : 'export',
        });
        await expect(worker.run(event)).resolves.toMatchObject({ disposition: 'completed' });
      }
      expect(platform.apiCalls).toHaveLength(1);
      expect(platform.apiCalls[0]?.idempotencyKey).toBe('system-publish-official_site-143');
    });

    await test.step('AC-012 exports have deterministic manifests and checksums', async () => {
      state.artifacts = await database<
        { contentHash: string; manifest: Record<string, unknown>; objectUri: string }[]
      >`
        SELECT content_hash AS "contentHash", manifest_json AS manifest, object_uri AS "objectUri"
        FROM export_artifacts ORDER BY object_uri
      `;
      expect(state.artifacts).toHaveLength(6);
      for (const artifact of state.artifacts) {
        expect(artifact.contentHash).toMatch(/^[0-9a-f]{64}$/u);
        expect(artifact.manifest).toMatchObject({
          files: expect.any(Array),
          payload_hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
          schema_version: 'export-manifest@1',
        });
        expect(artifact.objectUri).toContain('memory://system-publisher-143/');
      }
    });

    await test.step('AC-013 expired outbox leases are reclaimed after queue interruption', async () => {
      const row = await database<{ id: string }[]>`
        SELECT id FROM outbox_events WHERE status='pending' ORDER BY created_at LIMIT 1
      `;
      const eventId = row[0]?.id;
      if (!eventId) throw new Error('No pending outbox event is available for recovery');
      await database`
        UPDATE outbox_events SET status='processing', locked_by='dead-relay',
          locked_at=now()-interval '10 minutes' WHERE id=${eventId}::uuid
      `;
      expect(await new OutboxRelayStore(database).releaseExpiredLeases(60_000)).toBeGreaterThan(0);
      const recovered = await database<{ lockedBy: string | null; status: string }[]>`
        SELECT status, locked_by AS "lockedBy" FROM outbox_events WHERE id=${eventId}::uuid
      `;
      expect(recovered[0]).toEqual({ lockedBy: null, status: 'pending' });
    });

    await test.step('AC-014 metrics import is idempotent and settled cost matches the ledger', async () => {
      const registry = metricRegistry();
      const metrics = new MetricsImportService(new OutboxWriter(database), registry);
      const rows = state.variants.map((variant, index) => ({
        accountId: requireId(state.accounts.get(variant.platformCode)),
        metricDate: '2026-07-16',
        metricName: 'impressions',
        metricValue: 100 + index,
        platformCode: variant.platformCode,
        variantId: variant.id,
      }));
      const result = await database.begin((transaction) =>
        metrics.importRows(transaction, metricsScope('system-metrics-import-143'), 'manual', [
          ...rows,
          rows[0]!,
        ]),
      );
      expect(result).toMatchObject({ duplicateCount: 1, insertedCount: 7, status: 'succeeded' });
      const analytics = new AnalyticsQueryService(database, registry, undefined, {
        cacheTtlSeconds: 60,
        methodologyVersion: 'system-e2e@1',
      });
      const overview = await analytics.overview(
        { tenantId: TENANT_ID, userId: OWNER_ID, workspaceId: WORKSPACE_ID },
        { from: '2026-07-16', projectId: PROJECT_ID, to: '2026-07-16' },
      );
      expect(overview.metrics.find((metric) => metric.name === 'impressions')?.value).toBe(721);
      const cost = await database<{ settled: number; unsettled: number }[]>`
        SELECT
          COALESCE(sum(cost_cents) FILTER (WHERE status='settled'),0)::integer AS settled,
          count(*) FILTER (WHERE status='estimated')::integer AS unsettled
        FROM usage_ledger WHERE tenant_id=${TENANT_ID}::uuid AND package_id=${requireId(state.packageId)}::uuid
      `;
      expect(cost[0]?.settled).toBeGreaterThan(0);
      expect(cost[0]?.unsettled).toBeGreaterThan(0);
    });

    await test.step('AC-015 empty migration, idempotent seed, and rollback are verified', async () => {
      const tables = await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM pg_tables
        WHERE schemaname='public' AND tablename<>'__drizzle_migrations'
      `;
      expect(tables[0]?.count).toBe(57);
      const before = await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM tenants
      `;
      await expect(
        database.begin(async (transaction) => {
          await transaction`
            INSERT INTO tenants(name,slug,status) VALUES('Rollback Probe','rollback-probe','active')
          `;
          throw new Error('rollback probe');
        }),
      ).rejects.toThrow('rollback probe');
      const after = await database<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM tenants
      `;
      expect(after[0]?.count).toBe(before[0]?.count);
    });

    await test.step('AC-016 the final Brief has seven published variants and imported metrics', async () => {
      const final = await database<
        {
          apiAttempts: number;
          exports: number;
          metrics: number;
          packageStatus: string;
          publishedVariants: number;
        }[]
      >`
        SELECT
          (SELECT status FROM content_packages WHERE id=${requireId(state.packageId)}::uuid) AS "packageStatus",
          (SELECT count(*)::integer FROM content_variants WHERE package_id=${requireId(state.packageId)}::uuid AND status='published') AS "publishedVariants",
          (SELECT count(*)::integer FROM publish_attempts AS attempt JOIN publish_jobs AS job ON job.id=attempt.publish_job_id JOIN content_variants AS variant ON variant.id=job.variant_id WHERE variant.package_id=${requireId(state.packageId)}::uuid AND variant.platform_code='official_site' AND attempt.status='succeeded') AS "apiAttempts",
          (SELECT count(*)::integer FROM export_artifacts AS artifact JOIN content_variants AS variant ON variant.id=artifact.variant_id WHERE variant.package_id=${requireId(state.packageId)}::uuid) AS exports,
          (SELECT count(*)::integer FROM metric_records AS metric JOIN content_variants AS variant ON variant.id=metric.variant_id WHERE variant.package_id=${requireId(state.packageId)}::uuid) AS metrics
      `;
      expect(final[0]).toEqual({
        apiAttempts: 1,
        exports: 6,
        metrics: 7,
        packageStatus: 'published',
        publishedVariants: 7,
      });
      await requireActor(actor).api.dispose();
    });
  });
});

class CostWriter implements ContentWriterPort {
  private readonly usage: UsageLedgerRepository;

  public constructor(
    private readonly database: Sql,
    private readonly event: GenerationEvent,
    private readonly failures = new Set<PlatformCode>(),
  ) {
    this.usage = new UsageLedgerRepository(database);
  }

  public async generateMaster(): Promise<GeneratedContent> {
    await this.record(this.event.masterRunId, null, 'master', true);
    return document('master', undefined, this.event.eventId);
  }

  public async generateVariant(input: {
    readonly platformCode: PlatformCode;
  }): Promise<GeneratedContent> {
    const run = this.event.variantRuns.find(
      (candidate) => candidate.platformCode === input.platformCode,
    );
    if (!run) throw new Error(`Run ${input.platformCode} is missing`);
    const succeeds = !this.failures.has(input.platformCode);
    await this.record(run.runId, run.variantId, input.platformCode, succeeds);
    if (!succeeds) throw new Error('Mock provider rejected this variant');
    return document(input.platformCode, undefined, this.event.eventId);
  }

  private async record(
    generationRunId: string,
    variantId: string | null,
    suffix: string,
    settle: boolean,
  ): Promise<void> {
    const attribution = {
      generationRunId,
      packageId: this.event.packageId,
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      variantId,
      workspaceId: WORKSPACE_ID,
    };
    const measurement = {
      costCategory: 'llm' as const,
      costCents: 9,
      currency: 'CNY',
      inputTokens: 80,
      modelKey: 'deepseek-v4-flash',
      outputTokens: 40,
      provider: 'system-mock',
      quantity: 120,
      requestId: `${this.event.eventId}-${suffix}`.slice(0, 80),
      skillName: 'content-writer',
      unit: 'token' as const,
    };
    await this.database.begin(async (transaction) => {
      await this.usage.estimate(transaction, attribution, measurement);
      if (settle) await this.usage.settle(transaction, attribution, measurement);
    });
  }
}

class WarningQualityEvaluator implements QualityEvaluatorPort {
  public async evaluate(): Promise<QualityCheckerData> {
    const categories = [
      'fact',
      'brand',
      'compliance',
      'format',
      'duplicate',
      'readability',
    ] as const;
    const issues: readonly QualityIssue[] = categories.map((category) => ({
      category,
      citation_ids: [],
      location: null,
      message: `${category} checker executed`,
      rule_id: `system.${category}.executed`,
      severity: 'WARN',
      suggestion: null,
    }));
    return { decision: 'pass', geo_scores: GEO_SCORES, issues, score: 92 };
  }
}

class RecordingPlatform implements PublisherPlatformPort {
  public readonly apiCalls: PublishClaim[] = [];

  public async deliver(claim: PublishClaim): Promise<PlatformDelivery> {
    if (claim.publishMode === 'api') {
      this.apiCalls.push(claim);
      return {
        externalId: `external-${claim.jobId}`,
        mode: 'api',
        payloadHash: claim.payloadHash,
        response: { accepted: true },
        url: `https://example.com/posts/${claim.jobId}`,
      };
    }
    return {
      bundle: {
        files: [{ checksum: claim.payloadHash, name: `${claim.platformCode}.json` }],
        platform_code: claim.platformCode,
        schema_version: `${claim.platformCode}-export@1`,
      },
      mode: 'export',
      payloadHash: claim.payloadHash,
    };
  }
}

async function seedSystem(database: Sql, passwordHash: string): Promise<void> {
  await seedFreezeV21(database);
  await seedFreezeV21(database);
  await database`
    UPDATE users SET password_hash=${passwordHash},status='active' WHERE id=${OWNER_ID}::uuid
  `;
  await database`
    INSERT INTO users(id,email,display_name,status) VALUES
      (${SUPPORT_GRANTOR_ID},'grantor-143@example.com','Grantor','active'),
      (${SUPPORT_USER_ID},'support-143@example.com','Support','active'),
      (${BACKUP_OWNER_ID},'backup-owner-143@example.com','Backup Owner','active'),
      (${OTHER_USER_ID},'other-143@example.com','Other Owner','active')
  `;
  await database`
    INSERT INTO memberships(tenant_id,user_id,role_code,status)
    VALUES(${TENANT_ID},${BACKUP_OWNER_ID},'tenant_owner','active')
  `;
  await database`
    INSERT INTO platform_roles(user_id,role_code,status) VALUES
      (${SUPPORT_GRANTOR_ID},'platform_admin','active'),
      (${SUPPORT_USER_ID},'platform_admin','active')
  `;
  await database`
    INSERT INTO tenants(id,name,slug,status)
    VALUES(${OTHER_TENANT_ID},'Other Tenant 143','other-tenant-143','active')
  `;
  await database`
    INSERT INTO memberships(tenant_id,user_id,role_code,status)
    VALUES(${OTHER_TENANT_ID},${OTHER_USER_ID},'tenant_owner','active')
  `;
  await database`
    INSERT INTO workspaces(id,tenant_id,name,slug,timezone,status)
    VALUES(${OTHER_WORKSPACE_ID},${OTHER_TENANT_ID},'Other Workspace','other-workspace-143','UTC','active')
  `;
  await database`
    INSERT INTO projects(id,tenant_id,workspace_id,name,owner_id,status)
    VALUES(${OTHER_PROJECT_ID},${OTHER_TENANT_ID},${OTHER_WORKSPACE_ID},'Other Project',${OTHER_USER_ID},'active')
  `;
  await database`
    INSERT INTO brand_profiles (
      id,tenant_id,workspace_id,version,status,schema_version,profile_json,created_by,published_at
    ) VALUES (
      ${BRAND_ID},${TENANT_ID},${WORKSPACE_ID},1,'published','brand-profile@1',
      ${database.json({
        audience: ['Enterprise content leaders'],
        banned: ['fabricated guarantee'],
        compliance: ['Every factual claim must be traceable'],
        cta: 'Request an assessment',
        differentiators: ['Traceable evidence'],
        positioning: 'Evidence-led enterprise content',
        tone: 'Professional and direct',
      })},
      ${OWNER_ID},now()
    )
  `;
  await database`
    INSERT INTO keyword_sets(id,tenant_id,project_id,name)
    VALUES(${KEYWORD_SET_ID},${TENANT_ID},${PROJECT_ID},'System GEO keywords')
  `;
  await database`
    INSERT INTO keywords(id,tenant_id,keyword_set_id,term,intent,intents,priority,platform_scope)
    VALUES(${KEYWORD_ID},${TENANT_ID},${KEYWORD_SET_ID},'企业 GEO 内容','commercial',ARRAY['commercial'],100,${PLATFORMS}::varchar[])
  `;
  await database`
    INSERT INTO source_documents (
      id,tenant_id,workspace_id,project_id,title,source_type,mime_type,uri,
      content_hash,trust_level,status,effective_from,created_by
    ) VALUES (
      ${SOURCE_ID},${TENANT_ID},${WORKSPACE_ID},${PROJECT_ID},'System verified evidence',
      'url','text/html','https://example.com/system-evidence',${SOURCE_HASH},
      'verified','active',DATE '2026-01-01',${OWNER_ID}
    )
  `;
  await database`
    INSERT INTO ingest_jobs(
      tenant_id,source_document_id,status,stage,progress,started_at,finished_at
    ) VALUES(
      ${TENANT_ID},${SOURCE_ID},'succeeded','done',100,now(),now()
    )
  `;
  await database`
    INSERT INTO source_chunks(
      id,tenant_id,source_document_id,chunk_no,text,text_hash,metadata_json,token_count,status
    ) VALUES(
      ${CHUNK_ID},${TENANT_ID},${SOURCE_ID},0,${SOURCE_TEXT},${SOURCE_HASH},
      ${database.json({
        char_end: SOURCE_TEXT.length,
        char_start: 0,
        headings: ['Traceability'],
        schema_version: 'chunk-metadata@1',
        url: 'https://example.com/system-evidence#traceability',
      })},
      16,'active'
    )
  `;
  const vector = `[${unitVector().join(',')}]`;
  await database`
    INSERT INTO embeddings(tenant_id,chunk_id,model_key,dimension,embedding)
    VALUES(${TENANT_ID},${CHUNK_ID},'system-embedding',${EMBEDDING_DIMENSION},${vector}::vector)
  `;
  await seedPrompt(database, QUALITY_PROMPT_ID, 'quality-checker');
  await seedPrompt(database, FACT_PROMPT_ID, 'fact-checker');
}

async function seedPrompt(database: Sql, id: string, skillName: string): Promise<void> {
  const system = `${skillName} system prompt`;
  const task = `${skillName} task template`;
  await database`
    INSERT INTO prompt_versions(
      id,skill_name,version,schema_version,system_prompt,task_template,
      content_hash,status,created_by,published_at,published_by
    ) VALUES(
      ${id},${skillName},'1.0.0','prompt@1',${system},${task},${sha256(`${system}\n${task}`)},
      'published',${OWNER_ID},now(),${OWNER_ID}
    )
  `;
}

async function configureRuntime(database: Sql, databaseUrl: string, port: number): Promise<void> {
  const rules = await database<
    {
      contentHash: string;
      platformCode: PlatformCode;
      rules: Record<string, unknown>;
      versionId: string;
    }[]
  >`
    SELECT platform_code AS "platformCode",rules_json AS rules,
      content_hash AS "contentHash",id AS "versionId"
    FROM platform_rule_versions WHERE status='published' ORDER BY platform_code
  `;
  const values: Readonly<Record<string, string>> = {
    API_HOST: '127.0.0.1',
    CORS_ALLOWED_ORIGINS: 'https://app.example.com',
    CONTENT_MODEL_BALANCED_KEY: 'deepseek-v4-flash',
    CONTENT_PLATFORM_RULES_JSON: JSON.stringify(
      Object.fromEntries(
        rules.map((rule) => [
          rule.platformCode,
          {
            rules: rule.rules,
            rules_hash: rule.contentHash,
            version_id: rule.versionId,
          },
        ]),
      ),
    ),
    CONTENT_WRITER_PROMPT_VERSION_ID: FREEZE_V21_SEED.promptVersionId,
    CONTENT_WRITER_SKILL_VERSION: '1.0.0',
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'test',
    PORT: String(port),
    QUALITY_CHECKER_MODEL_KEY: 'deepseek-v4-flash',
    QUALITY_CHECKER_PROMPT_VERSION_ID: QUALITY_PROMPT_ID,
    QUALITY_CHECKER_SKILL_VERSION: '1.0.0',
  };
  for (const [key, value] of Object.entries(values)) {
    originalEnvironment.set(key, process.env[key]);
    process.env[key] = value;
  }
}

async function createPackageAndGenerate(
  actor: AuthenticatedApi,
  briefId: string,
): Promise<Aggregate> {
  const created = await actor.api.post(`${API_PREFIX}/content-packages`, {
    data: { brief_id: briefId, project_id: PROJECT_ID, workspace_id: WORKSPACE_ID },
    headers: writeHeaders(actor.csrf, 'system-package-143'),
  });
  expect(created.status()).toBe(201);
  const packageData = readData<{ id: string; version: number }>(await created.json());
  const generated = await actor.api.post(
    `${API_PREFIX}/content-packages/${packageData.id}/generate`,
    {
      data: { locked_block_keys: [], model_policy: 'balanced', platform_codes: PLATFORMS },
      headers: {
        ...writeHeaders(actor.csrf, 'system-generate-143'),
        'if-match': String(packageData.version),
      },
    },
  );
  expect(generated.status()).toBe(202);
  const variants = await requireClient(client)<VariantRow[]>`
    SELECT id,platform_code AS "platformCode" FROM content_variants
    WHERE package_id=${packageData.id}::uuid ORDER BY platform_code
  `;
  expect(variants).toHaveLength(7);
  return { packageId: packageData.id, variants };
}

async function runQuality(
  actor: AuthenticatedApi,
  database: Sql,
  packageId: string,
  variant: VariantRow,
  unsupported: boolean,
) {
  const response = await actor.api.post(
    `${API_PREFIX}/content-variants/${variant.id}/quality-check`,
    {
      data: { mode: 'full' },
      headers: writeHeaders(actor.csrf, `system-quality-${variant.platformCode}-${randomUUID()}`),
    },
  );
  expect(response.status()).toBe(202);
  const qualityRun = readData<{ id: string }>(await response.json());
  const currentRows = await database<{ contentVersionId: string; version: number }[]>`
    SELECT current_content_version_id AS "contentVersionId",version
    FROM content_variants WHERE id=${variant.id}::uuid
  `;
  const current = currentRows[0];
  if (!current) throw new Error('Quality target is missing');
  const factRunId = randomUUID();
  await database`
    INSERT INTO generation_runs(
      id,tenant_id,workspace_id,project_id,package_id,variant_id,skill_name,
      skill_version,prompt_version_id,model_key,status,input_hash,request_id,started_at,finished_at
    ) VALUES(
      ${factRunId},${TENANT_ID},${WORKSPACE_ID},${PROJECT_ID},${packageId},${variant.id},
      'fact-checker','1.0.0',${FACT_PROMPT_ID},'deepseek-v4-flash','succeeded',
      ${sha256(`${factRunId}:fact`)},${`system-fact-${factRunId}`.slice(0, 80)},now(),now()
    )
  `;
  if (unsupported) {
    const claim = 'This unsupported claim has material financial impact.';
    await database`
      INSERT INTO fact_check_results(
        tenant_id,generation_run_id,variant_id,claim_key,claim_text,claim_hash,
        verdict,risk_level,confidence,reason
      ) VALUES(
        ${TENANT_ID},${factRunId},${variant.id},'unsupported-high-risk',${claim},${sha256(claim)},
        'unsupported','high',0.2,'No supporting evidence was found'
      )
    `;
  }
  await database`
    UPDATE generation_runs SET status='running',started_at=now()
    WHERE id=${qualityRun.id}::uuid AND status='queued'
  `;
  const ruleRows = await database<
    { contentHash: string; rules: Record<string, unknown>; versionId: string }[]
  >`
    SELECT content_hash AS "contentHash",rules_json AS rules,id AS "versionId"
    FROM platform_rule_versions WHERE platform_code=${variant.platformCode} AND status='published'
  `;
  const rule = ruleRows[0];
  if (!rule) throw new Error(`Published rule ${variant.platformCode} is missing`);
  const scope: QualityPipelineScope = {
    generationRunId: qualityRun.id,
    projectId: PROJECT_ID,
    tenantId: TENANT_ID,
    userId: OWNER_ID,
    variantId: variant.id,
    workspaceId: WORKSPACE_ID,
  };
  const request: QualityPipelineRequest = {
    brandProfileId: BRAND_ID,
    checkerVersion: '1.0.0',
    contentVersionId: current.contentVersionId,
    duplicateMatches: [],
    expectedVariantVersion: current.version,
    factCheckGenerationRunId: factRunId,
    geoScores: GEO_SCORES,
    platformRules: {
      platform_code: variant.platformCode,
      rules: rule.rules,
      rules_hash: rule.contentHash,
      version_id: rule.versionId,
    },
    requestId: `system-quality-pipeline-${qualityRun.id}`.slice(0, 80),
    safetyPolicy: {
      block_on_data_leakage: true,
      block_on_injection: true,
      max_warnings_for_pass: 10,
    },
  };
  return new QualityPipelineService(
    new QualityPipelineRepository(database),
    new WarningQualityEvaluator(),
  ).run(scope, request);
}

async function seedPlatformAccounts(
  database: Sql,
  state: JourneyState,
  encrypted: { readonly credentialCiphertext: string; readonly credentialKeyVersion: string },
): Promise<void> {
  for (const platformCode of PLATFORMS) {
    const id = randomUUID();
    const api = platformCode === 'official_site';
    await database`
      INSERT INTO platform_accounts(
        id,tenant_id,workspace_id,platform_code,display_name,credential_ciphertext,
        credential_key_version,scopes,capabilities_json,publish_mode,status,timezone
      ) VALUES(
        ${id},${TENANT_ID},${WORKSPACE_ID},${platformCode},${`System ${platformCode}`},
        ${api ? encrypted.credentialCiphertext : null},
        ${api ? encrypted.credentialKeyVersion : null},
        ARRAY['publish','metrics']::text[],
        ${database.json({ export: !api, publish: api })},
        ${api ? 'api' : 'export'},'active','Asia/Shanghai'
      )
    `;
    state.accounts.set(platformCode, id);
  }
}

async function generationEvent(database: Sql, packageId: string): Promise<GenerationEvent> {
  const rows = await database<{ payload: GenerationPayload }[]>`
    SELECT payload_json AS payload FROM outbox_events
    WHERE event_type='content.package.generation_requested.v1'
      AND aggregate_id=${packageId}::uuid
    ORDER BY created_at DESC,id DESC LIMIT 1
  `;
  const payload = rows[0]?.payload;
  if (!payload) throw new Error('Generation event is missing');
  return {
    eventId: payload.event_id,
    masterRunId: payload.data.master_run_id,
    packageId,
    payload,
    variantRuns: payload.data.variant_runs.map((run) => ({
      platformCode: run.platform_code,
      runId: run.run_id,
      variantId: run.variant_id,
    })),
  };
}

async function publishEvent(database: Sql, jobId: string): Promise<unknown> {
  const rows = await database<{ payload: unknown }[]>`
    SELECT payload_json AS payload FROM outbox_events
    WHERE event_type='publishing.job.execution_requested.v1' AND aggregate_id=${jobId}::uuid
    ORDER BY created_at DESC LIMIT 1
  `;
  if (!rows[0]) throw new Error(`Publish event ${jobId} is missing`);
  return rows[0].payload;
}

function reviewSubmitScope(requestId: string): SubmitReviewScope {
  return {
    projectId: PROJECT_ID,
    requestId,
    tenantId: TENANT_ID,
    userId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
  };
}

function reviewDecisionScope(requestId: string): ReviewDecisionScope {
  return reviewSubmitScope(requestId);
}

function publishScope(requestId: string): PublishJobScope {
  return { requestId, tenantId: TENANT_ID, userId: OWNER_ID };
}

function metricsScope(requestId: string): MetricsImportScope {
  return { requestId, tenantId: TENANT_ID, userId: OWNER_ID, workspaceId: WORKSPACE_ID };
}

function metricRegistry(): MetricRegistry {
  return new MetricRegistry([
    { aggregation: 'sum', allowNegative: false, name: 'impressions', unit: 'count' },
  ]);
}

function document(
  platformCode: PlatformCode | 'master',
  body = 'Content based on traceable evidence.',
  generationMarker = 'manual',
): GeneratedContent {
  return {
    blocks: [
      { block_key: 'intro', block_type: 'heading', text: `GEO ${platformCode}` },
      { block_key: 'body', block_type: 'paragraph', text: body },
    ],
    citation_map: [
      {
        citation_ids: [CHUNK_ID],
        claim_key: 'traceability',
        claim_text: body,
      },
    ],
    cta: null,
    hashtags: [],
    platform_code: platformCode,
    platform_meta: { generation_marker: generationMarker },
    schema_version: 'content-writer-data@1',
    summary: `Summary for ${platformCode}`,
    title: `GEO ${platformCode}`,
  };
}

function unitVector(): number[] {
  return Array.from({ length: EMBEDDING_DIMENSION }, (_, index) => (index === 0 ? 1 : 0));
}

async function readVariant(actor: AuthenticatedApi, id: string): Promise<VariantDetail> {
  const response = await actor.api.get(`${API_PREFIX}/content-variants/${id}`);
  if (response.status() !== 200) {
    throw new Error(`Variant read failed: ${response.status()} ${await response.text()}`);
  }
  return readData<VariantDetail>(await response.json());
}

function blockText(detail: VariantDetail, key: string): string | undefined {
  return detail.current_content?.content_json.blocks.find((block) => block.block_key === key)?.text;
}

async function login(): Promise<AuthenticatedApi> {
  const preAuth = await playwrightRequest.newContext({ baseURL: baseUrl });
  const bootstrap = await preAuth.get(`${API_PREFIX}/auth/session`);
  expect(bootstrap.status()).toBe(401);
  const preAuthCsrf = responseCookie(bootstrap, 'geo_csrf');
  if (!preAuthCsrf) throw new Error('CSRF bootstrap cookie is missing');
  const response = await preAuth.post(`${API_PREFIX}/auth/login`, {
    data: { email: 'owner@example.com', password: PASSWORD, remember_me: false },
    headers: { cookie: `geo_csrf=${preAuthCsrf}`, 'x-csrf-token': preAuthCsrf },
  });
  expect(response.status()).toBe(200);
  const csrf = responseCookie(response, 'geo_csrf');
  const session = responseCookie(response, 'geo_session');
  if (!csrf || !session) throw new Error('Login cookies are missing');
  await preAuth.dispose();
  return {
    api: await playwrightRequest.newContext({
      baseURL: baseUrl,
      extraHTTPHeaders: { cookie: `geo_session=${session}; geo_csrf=${csrf}` },
    }),
    csrf,
  };
}

async function switchTenant(actor: AuthenticatedApi): Promise<void> {
  const response = await actor.api.post(`${API_PREFIX}/auth/switch-tenant`, {
    data: { tenant_id: TENANT_ID },
    headers: writeHeaders(actor.csrf, `system-switch-${randomUUID()}`),
  });
  expect(response.status()).toBe(200);
}

function writeHeaders(csrf: string, idempotencyKey: string) {
  return { 'idempotency-key': idempotencyKey.slice(0, 128), 'x-csrf-token': csrf };
}

function responseCookie(response: APIResponse, name: string): string | undefined {
  for (const header of response.headersArray()) {
    if (header.name.toLowerCase() !== 'set-cookie') continue;
    const [pair] = header.value.split(';', 1);
    if (pair?.startsWith(`${name}=`)) return pair.slice(name.length + 1);
  }
  return undefined;
}

function startApiProcess(): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['apps/api/dist/main.js'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function waitForApi(process: ChildProcessWithoutNullStreams, url: string): Promise<void> {
  process.stdout.on('data', (chunk: Buffer) => {
    apiOutput += chunk.toString();
  });
  process.stderr.on('data', (chunk: Buffer) => {
    apiOutput += chunk.toString();
  });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`System API exited: ${apiOutput}`);
    try {
      const response = await fetch(`${url}${API_PREFIX}/health/live`);
      if (response.ok) return;
    } catch {
      // The API socket is not ready.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`System API did not become ready: ${apiOutput}`);
}

async function stopApiProcess(process: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!process || process.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => process.kill('SIGKILL'), 5_000);
    process.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    process.kill('SIGTERM');
  });
}

async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve an API port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function restoreRuntime(): void {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function readData<T>(value: unknown): T {
  const data = (value as { readonly data?: unknown }).data;
  if (data === undefined) throw new Error('API response does not contain data');
  return data as T;
}

function requireVariant(variants: readonly VariantRow[], platformCode: PlatformCode): VariantRow {
  const variant = variants.find((candidate) => candidate.platformCode === platformCode);
  if (!variant) throw new Error(`Variant ${platformCode} is missing`);
  return variant;
}

function requireActor(actor: AuthenticatedApi | undefined): AuthenticatedApi {
  if (!actor) throw new Error('System actor is not authenticated');
  return actor;
}

function requireId(value: string | undefined): string {
  if (!value) throw new Error('Journey identifier is missing');
  return value;
}

function requireClient(value: Sql | undefined): Sql {
  if (!value) throw new Error('System PostgreSQL client is not initialized');
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface AuthenticatedApi {
  readonly api: APIRequestContext;
  readonly csrf: string;
}

interface VariantRow {
  readonly id: string;
  readonly platformCode: PlatformCode;
}

interface Aggregate {
  readonly packageId: string;
  readonly variants: readonly VariantRow[];
}

interface GenerationPayload {
  readonly data: {
    readonly master_run_id: string;
    readonly variant_runs: readonly {
      readonly platform_code: PlatformCode;
      readonly run_id: string;
      readonly variant_id: string;
    }[];
  };
  readonly event_id: string;
}

interface GenerationEvent {
  readonly eventId: string;
  readonly masterRunId: string;
  readonly packageId: string;
  readonly payload: GenerationPayload;
  readonly variantRuns: readonly {
    readonly platformCode: PlatformCode;
    readonly runId: string;
    readonly variantId: string;
  }[];
}

interface VariantDetail {
  readonly current_content: {
    readonly blocks: readonly { readonly block_key: string; readonly id: string }[];
    readonly content_json: {
      readonly blocks: readonly {
        readonly block_key: string;
        readonly text: string;
      }[];
    };
    readonly id: string;
  } | null;
  readonly variant: { readonly status: string; readonly version: number };
}

interface JourneyState {
  readonly accounts: Map<PlatformCode, string>;
  artifacts: { contentHash: string; manifest: Record<string, unknown>; objectUri: string }[];
  briefId?: string;
  firstSnapshotId?: string;
  readonly jobs: { id: string; platformCode: PlatformCode }[];
  packageId?: string;
  variants: readonly VariantRow[];
}
