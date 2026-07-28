import type { PlatformCode } from '@geo-content-os/contracts';
import type { QualityCheckerData, QualityIssue } from '@geo-content-os/contracts/skills';
import {
  ContentGenerationWorker,
  type ContentWriterPort,
  type GeneratedContent,
  PostgresGenerationStore,
} from '@geo-content-os/worker-ai';
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
import { createServer } from 'node:net';
import postgres, { type Sql } from 'postgres';

import {
  calculateGeoTotal,
  migrateDatabase,
  PasswordHasher,
  QualityPipelineRepository,
  QualityPipelineService,
  type QualityEvaluatorPort,
  type QualityPipelineRequest,
  type QualityPipelineScope,
  UsageLedgerRepository,
} from './runtime.mjs';

const USER_ID = '10000000-0000-4000-8000-000000000058';
const TENANT_ID = '20000000-0000-4000-8000-000000000058';
const WORKSPACE_ID = '30000000-0000-4000-8000-000000000058';
const PROJECT_ID = '40000000-0000-4000-8000-000000000058';
const BRAND_PROFILE_ID = '50000000-0000-4000-8000-000000000058';
const KEYWORD_SET_ID = '60000000-0000-4000-8000-000000000058';
const KEYWORD_ID = '70000000-0000-4000-8000-000000000058';
const SOURCE_ID = '80000000-0000-4000-8000-000000000058';
const CONTENT_PROMPT_ID = '90000000-0000-4000-8000-000000000058';
const QUALITY_PROMPT_ID = 'a0000000-0000-4000-8000-000000000058';
const FACT_PROMPT_ID = 'b0000000-0000-4000-8000-000000000058';
const RULE_VERSION_IDS: Readonly<Record<SelectedPlatform, string>> = {
  official_site: 'c0000000-0000-4000-8000-000000000058',
  wechat_mp: 'd0000000-0000-4000-8000-000000000058',
  zhihu: 'e0000000-0000-4000-8000-000000000058',
};
const PLATFORMS = ['official_site', 'wechat_mp', 'zhihu'] as const;
type SelectedPlatform = (typeof PLATFORMS)[number];
const PASSWORD = 'content E2E enterprise passphrase';
const API_PREFIX = '/api/v1';
const GEO_SCORES = Object.freeze({
  answerability: 85,
  entity: 90,
  evidence: 95,
  platform_fit: 80,
  question: 75,
  readability_safety: 90,
  total: calculateGeoTotal({
    answerability: 85,
    entity: 90,
    evidence: 95,
    platform_fit: 80,
    question: 75,
    readability_safety: 90,
  }),
});

let apiProcess: ChildProcessWithoutNullStreams | undefined;
let apiOutput = '';
let baseUrl = '';
let client: Sql | undefined;
let container: StartedPostgreSqlContainer | undefined;
let passwordHash = '';
const originalEnvironment = new Map<string, string | undefined>();

test.describe('content production lifecycle', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test.beforeAll(async () => {
    container = await startPostgresTestContainer();
    await migrateDatabase(container.getConnectionUri());
    client = postgres(container.getConnectionUri(), { max: 12 });
    passwordHash = await new PasswordHasher().hash(PASSWORD);
    const port = await freePort();
    configureRuntime(container.getConnectionUri(), port);
    apiProcess = startApiProcess();
    baseUrl = `http://127.0.0.1:${port}`;
    await waitForApi(apiProcess, baseUrl);
  });

  test.beforeEach(async () => {
    await resetDatabase(requireClient(client), passwordHash);
  });

  test.afterAll(async () => {
    await stopApiProcess(apiProcess);
    await client?.end();
    await container?.stop();
    restoreRuntime();
  });

  test('creates a Brief, generates usable partial output, and attributes settled cost', async () => {
    const database = requireClient(client);
    const actor = await login();
    await switchTenant(actor);
    const aggregate = await requestGeneration(actor, 'partial');
    const event = await generationEvent(database, aggregate.packageId);
    const writer = new CostRecordingWriter(database, event, new Set(['zhihu']));
    const result = await new ContentGenerationWorker(
      new PostgresGenerationStore(database),
      writer,
      3,
    ).run(event.payload);

    expect(result).toMatchObject({ failed: 1, packageStatus: 'generated', succeeded: 2 });
    const response = await actor.api.get(`${API_PREFIX}/content-packages/${aggregate.packageId}`);
    expect(response.status()).toBe(200);
    const detail = readData<PackageDetail>(await response.json());
    expect(detail.package.status).toBe('generated');
    expect(detail.master_content?.content_json.platform_code).toBe('master');
    expect(detail.variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ platform_code: 'official_site', status: 'generated' }),
        expect.objectContaining({ platform_code: 'wechat_mp', status: 'generated' }),
        expect.objectContaining({ platform_code: 'zhihu', status: 'generation_failed' }),
      ]),
    );

    const costs = await database<UsageRow[]>`
      SELECT status, request_id AS "requestId", package_id AS "packageId",
        variant_id AS "variantId", generation_run_id AS "generationRunId",
        workspace_id AS "workspaceId", project_id AS "projectId", cost_cents AS "costCents"
      FROM usage_ledger WHERE tenant_id = ${TENANT_ID}::uuid ORDER BY request_id, status
    `;
    expect(costs).toHaveLength(7);
    expect(costs.every((row) => row.packageId === aggregate.packageId)).toBe(true);
    expect(
      costs.every((row) => row.workspaceId === WORKSPACE_ID && row.projectId === PROJECT_ID),
    ).toBe(true);
    expect(costs.filter((row) => row.status === 'settled')).toHaveLength(3);
    expect(costs.filter((row) => row.status === 'estimated')).toHaveLength(4);
    const failedVariant = aggregate.variants.find((variant) => variant.platformCode === 'zhihu');
    expect(
      costs.filter((row) => row.variantId === failedVariant?.id).map((row) => row.status),
    ).toEqual(['estimated']);
    expect(new Set(costs.map((row) => row.generationRunId))).toEqual(
      new Set([event.masterRunId, ...event.variantRuns.map((run) => run.runId)]),
    );
    await actor.api.dispose();
  });

  test('persists current-version quality pass and blocking decisions through the API flow', async () => {
    const database = requireClient(client);
    const actor = await login();
    await switchTenant(actor);
    const aggregate = await requestGeneration(actor, 'quality');
    const event = await generationEvent(database, aggregate.packageId);
    await new ContentGenerationWorker(
      new PostgresGenerationStore(database),
      new CostRecordingWriter(database, event),
      3,
    ).run(event.payload);

    const passing = requireVariant(aggregate.variants, 'official_site');
    const blocked = requireVariant(aggregate.variants, 'wechat_mp');
    await runQuality(actor, database, aggregate.packageId, passing, false);
    await runQuality(actor, database, aggregate.packageId, blocked, true);

    const passedDetail = await readVariant(actor, passing.id);
    expect(passedDetail.variant).toMatchObject({ quality_score: 92, status: 'quality_passed' });
    expect(passedDetail.quality_report).toMatchObject({
      content_version_id: passedDetail.current_content?.id,
      decision: 'pass',
      score: 92,
    });
    expect(passedDetail.quality_reports).toEqual([
      expect.objectContaining({
        content_version_id: passedDetail.current_content?.id,
        decision: 'pass',
        score: 92,
      }),
    ]);
    const blockedDetail = await readVariant(actor, blocked.id);
    expect(blockedDetail.variant).toMatchObject({ quality_score: 40, status: 'quality_failed' });
    expect(blockedDetail.quality_report).toMatchObject({
      content_version_id: blockedDetail.current_content?.id,
      decision: 'block',
      issues: expect.arrayContaining([
        expect.objectContaining({ rule_id: 'security.e2e.block', severity: 'BLOCK' }),
      ]),
      score: 40,
    });
    expect(blockedDetail.quality_reports).toEqual([
      expect.objectContaining({
        content_version_id: blockedDetail.current_content?.id,
        decision: 'block',
        score: 40,
      }),
    ]);
    await actor.api.dispose();
  });
});

class CostRecordingWriter implements ContentWriterPort {
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
    return document('master');
  }

  public async generateVariant(input: {
    readonly platformCode: PlatformCode;
  }): Promise<GeneratedContent> {
    const run = this.event.variantRuns.find(
      (candidate) => candidate.platformCode === input.platformCode,
    );
    if (!run) throw new Error(`Missing generation run for ${input.platformCode}`);
    const succeeds = !this.failures.has(input.platformCode);
    await this.record(run.runId, run.variantId, input.platformCode, succeeds);
    if (!succeeds) throw new Error('Provider rejected variant');
    return document(input.platformCode);
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
      costCents: 12,
      currency: 'CNY',
      inputTokens: 80,
      modelKey: 'e2e-content-balanced',
      outputTokens: 40,
      provider: 'e2e-provider',
      quantity: 120,
      requestId: `content-e2e-${suffix}`,
      skillName: 'content-writer',
      unit: 'token' as const,
    };
    await this.database.begin(async (transaction) => {
      await this.usage.estimate(transaction, attribution, measurement);
      if (settle) await this.usage.settle(transaction, attribution, measurement);
    });
  }
}

class FixedQualityEvaluator implements QualityEvaluatorPort {
  public constructor(private readonly blocked: boolean) {}

  public async evaluate(): Promise<QualityCheckerData> {
    const issues: readonly QualityIssue[] = this.blocked
      ? [
          {
            category: 'security',
            citation_ids: [],
            location: null,
            message: 'E2E blocking policy matched',
            rule_id: 'security.e2e.block',
            severity: 'BLOCK',
            suggestion: null,
          },
        ]
      : [];
    return {
      decision: this.blocked ? 'block' : 'pass',
      geo_scores: GEO_SCORES,
      issues,
      score: this.blocked ? 40 : 92,
    };
  }
}

async function requestGeneration(actor: AuthenticatedApi, suffix: string): Promise<Aggregate> {
  const briefResponse = await actor.api.post(`${API_PREFIX}/briefs`, {
    data: {
      audience: '负责企业内容治理与增长的市场团队负责人',
      constraints: {
        additional_instructions: '仅使用可追溯事实',
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
      title: '企业 GEO 内容生产',
      workspace_id: WORKSPACE_ID,
    },
    headers: writeHeaders(actor.csrf, `content-e2e-brief-${suffix}`),
  });
  expect(briefResponse.status()).toBe(201);
  const briefId = readData<{ id: string }>(await briefResponse.json()).id;
  const packageResponse = await actor.api.post(`${API_PREFIX}/content-packages`, {
    data: { brief_id: briefId, project_id: PROJECT_ID, workspace_id: WORKSPACE_ID },
    headers: writeHeaders(actor.csrf, `content-e2e-package-${suffix}`),
  });
  expect(packageResponse.status()).toBe(201);
  const packageData = readData<{ id: string; version: number }>(await packageResponse.json());
  const generateResponse = await actor.api.post(
    `${API_PREFIX}/content-packages/${packageData.id}/generate`,
    {
      data: { locked_block_keys: [], model_policy: 'balanced', platform_codes: PLATFORMS },
      headers: {
        ...writeHeaders(actor.csrf, `content-e2e-generate-${suffix}`),
        'if-match': String(packageData.version),
      },
    },
  );
  expect(generateResponse.status()).toBe(202);
  const rows = await requireClient(client)<VariantRow[]>`
    SELECT id, platform_code AS "platformCode" FROM content_variants
    WHERE package_id = ${packageData.id}::uuid ORDER BY platform_code
  `;
  return { packageId: packageData.id, variants: rows };
}

async function runQuality(
  actor: AuthenticatedApi,
  database: Sql,
  packageId: string,
  variant: VariantRow,
  blocked: boolean,
): Promise<void> {
  const response = await actor.api.post(
    `${API_PREFIX}/content-variants/${variant.id}/quality-check`,
    {
      data: { mode: 'full' },
      headers: writeHeaders(actor.csrf, `content-e2e-quality-${variant.platformCode}`),
    },
  );
  expect(response.status()).toBe(202);
  const run = readData<{ id: string }>(await response.json());
  const currentRows = await database<{ contentVersionId: string; version: number }[]>`
    SELECT current_content_version_id AS "contentVersionId", version
    FROM content_variants WHERE id = ${variant.id}::uuid
  `;
  const current = currentRows[0];
  if (!current) throw new Error('Quality target Variant was not found');
  const factRunId = factRunIdFor(variant.platformCode);
  await database`
    INSERT INTO generation_runs (
      id, tenant_id, workspace_id, project_id, package_id, variant_id, skill_name,
      skill_version, prompt_version_id, model_key, status, input_hash, request_id,
      started_at, finished_at
    ) VALUES (
      ${factRunId}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, ${packageId}, ${variant.id},
      'fact-checker', '1.0.0', ${FACT_PROMPT_ID}, 'e2e-fact', 'succeeded', ${'3'.repeat(64)},
      ${`content-e2e-fact-${variant.platformCode}`}, now(), now()
    )
  `;
  await database`
    UPDATE generation_runs SET status = 'running', started_at = now()
    WHERE id = ${run.id}::uuid AND status = 'queued'
  `;
  const scope: QualityPipelineScope = {
    generationRunId: run.id,
    projectId: PROJECT_ID,
    tenantId: TENANT_ID,
    userId: USER_ID,
    variantId: variant.id,
    workspaceId: WORKSPACE_ID,
  };
  const request: QualityPipelineRequest = {
    brandProfileId: BRAND_PROFILE_ID,
    checkerVersion: '1.0.0',
    contentVersionId: current.contentVersionId,
    duplicateMatches: [],
    expectedVariantVersion: current.version,
    factCheckGenerationRunId: factRunId,
    geoScores: GEO_SCORES,
    platformRules: {
      platform_code: variant.platformCode,
      rules: {},
      rules_hash: '4'.repeat(64),
      version_id: RULE_VERSION_IDS[variant.platformCode],
    },
    requestId: `content-e2e-pipeline-${variant.platformCode}`,
    safetyPolicy: {
      block_on_data_leakage: true,
      block_on_injection: true,
      max_warnings_for_pass: 5,
    },
  };
  await new QualityPipelineService(
    new QualityPipelineRepository(database),
    new FixedQualityEvaluator(blocked),
  ).run(scope, request);
}

async function readVariant(actor: AuthenticatedApi, id: string): Promise<VariantDetail> {
  const response = await actor.api.get(`${API_PREFIX}/content-variants/${id}`);
  if (response.status() !== 200) {
    throw new Error(
      `Variant read failed: ${response.status()} ${await response.text()}\n${apiOutput}`,
    );
  }
  return readData<VariantDetail>(await response.json());
}

async function generationEvent(database: Sql, packageId: string): Promise<GenerationEvent> {
  const rows = await database<{ payload: unknown }[]>`
    SELECT payload_json AS payload FROM outbox_events
    WHERE event_type = 'content.package.generation_requested.v1'
      AND aggregate_id = ${packageId}::uuid ORDER BY created_at DESC LIMIT 1
  `;
  const payload = rows[0]?.payload as GenerationPayload | undefined;
  if (!payload) throw new Error('Generation outbox event was not found');
  return {
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

function document(platformCode: PlatformCode | 'master'): GeneratedContent {
  return {
    blocks: [
      { block_key: 'intro', block_type: 'heading', text: `GEO content for ${platformCode}` },
      { block_key: 'body', block_type: 'paragraph', text: 'Content based on traceable evidence.' },
    ],
    citation_map: [],
    cta: null,
    hashtags: [],
    platform_code: platformCode,
    platform_meta: {},
    schema_version: 'content-writer-data@1',
    summary: `Summary for ${platformCode}`,
    title: `GEO guide for ${platformCode}`,
  };
}

async function login(): Promise<AuthenticatedApi> {
  const preAuth = await playwrightRequest.newContext({ baseURL: baseUrl });
  const bootstrap = await preAuth.get(`${API_PREFIX}/auth/session`);
  expect(bootstrap.status()).toBe(401);
  const preAuthCsrf = responseCookie(bootstrap, 'geo_csrf');
  if (!preAuthCsrf) throw new Error('CSRF bootstrap did not issue a cookie');
  const response = await preAuth.post(`${API_PREFIX}/auth/login`, {
    data: { email: 'content-e2e@example.com', password: PASSWORD, remember_me: false },
    headers: { cookie: `geo_csrf=${preAuthCsrf}`, 'x-csrf-token': preAuthCsrf },
  });
  expect(response.status()).toBe(200);
  const csrf = responseCookie(response, 'geo_csrf');
  const session = responseCookie(response, 'geo_session');
  if (!csrf || !session) throw new Error('Login did not issue session cookies');
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
    headers: writeHeaders(actor.csrf, 'content-e2e-switch-tenant'),
  });
  expect(response.status()).toBe(200);
}

function responseCookie(response: APIResponse, name: string): string | undefined {
  for (const header of response.headersArray()) {
    if (header.name.toLowerCase() !== 'set-cookie') continue;
    const [pair] = header.value.split(';', 1);
    if (pair?.startsWith(`${name}=`)) return pair.slice(name.length + 1);
  }
  return undefined;
}

function writeHeaders(csrf: string, idempotencyKey: string) {
  return { 'idempotency-key': idempotencyKey, 'x-csrf-token': csrf };
}

async function resetDatabase(database: Sql, hash: string): Promise<void> {
  await database`TRUNCATE usage_ledger, quality_reports, fact_evidences, fact_check_results, ai_citations, content_block_locks, content_blocks, content_versions, content_variants, content_packages, fact_sources, facts, embeddings, source_chunks, ingest_jobs, brief_sources, brief_keywords, briefs, source_documents, topic_candidates, generation_runs, keywords, keyword_sets, brand_profiles, workspace_memberships, projects, workspaces, audit_events, outbox_events, support_access_grants, idempotency_records, password_reset_tokens, invitations, sessions, platform_roles, memberships, tenants, users CASCADE`;
  await database`
    INSERT INTO users (id, email, password_hash, display_name, status)
    VALUES (${USER_ID}, 'content-e2e@example.com', ${hash}, 'Content E2E Editor', 'active')
  `;
  await database`
    INSERT INTO tenants (id, name, slug, status)
    VALUES (${TENANT_ID}, 'Content E2E Tenant', 'content-e2e', 'active')
  `;
  await database`
    INSERT INTO memberships (tenant_id, user_id, role_code, status)
    VALUES (${TENANT_ID}, ${USER_ID}, 'content_editor', 'active')
  `;
  await database`
    INSERT INTO workspaces (id, tenant_id, name, slug, timezone)
    VALUES (${WORKSPACE_ID}, ${TENANT_ID}, 'Content Workspace', 'content-workspace', 'UTC')
  `;
  await database`
    INSERT INTO projects (id, tenant_id, workspace_id, name, owner_id)
    VALUES (${PROJECT_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, 'Content Project', ${USER_ID})
  `;
  await database`
    INSERT INTO brand_profiles (
      id, tenant_id, workspace_id, version, status, schema_version,
      profile_json, created_by, published_at
    ) VALUES (
      ${BRAND_PROFILE_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, 1, 'published', 'brand-profile@1',
      ${JSON.stringify({
        audience: ['Enterprise marketing leaders'],
        banned: [],
        compliance: ['Cite verified sources'],
        cta: 'Request an assessment',
        differentiators: ['Traceable evidence'],
        positioning: 'Evidence-led content',
        tone: 'Professional and direct',
      })}::text::jsonb,
      ${USER_ID}, now()
    )
  `;
  await database`
    INSERT INTO keyword_sets (id, tenant_id, project_id, name)
    VALUES (${KEYWORD_SET_ID}, ${TENANT_ID}, ${PROJECT_ID}, 'GEO keywords')
  `;
  await database`
    INSERT INTO keywords (
      id, tenant_id, keyword_set_id, term, intent, priority, platform_scope
    ) VALUES (
      ${KEYWORD_ID}, ${TENANT_ID}, ${KEYWORD_SET_ID}, '企业 GEO 内容', 'commercial', 90,
      ${PLATFORMS}::varchar[]
    )
  `;
  await database`
    INSERT INTO source_documents (
      id, tenant_id, workspace_id, project_id, title, source_type, mime_type,
      uri, content_hash, trust_level, status, created_by
    ) VALUES (
      ${SOURCE_ID}, ${TENANT_ID}, ${WORKSPACE_ID}, ${PROJECT_ID}, 'Verified GEO source',
      'url', 'text/html', 'https://example.com/geo-source', ${'5'.repeat(64)},
      'verified', 'active', ${USER_ID}
    )
  `;
}

function configureRuntime(databaseUrl: string, port: number): void {
  const values: Readonly<Record<string, string>> = {
    API_HOST: '127.0.0.1',
    CORS_ALLOWED_ORIGINS: 'https://app.example.com',
    CONTENT_MODEL_BALANCED_KEY: 'e2e-content-balanced',
    CONTENT_PLATFORM_RULES_JSON: JSON.stringify(
      Object.fromEntries(
        PLATFORMS.map((platform) => [
          platform,
          { rules: {}, rules_hash: '4'.repeat(64), version_id: RULE_VERSION_IDS[platform] },
        ]),
      ),
    ),
    CONTENT_WRITER_PROMPT_VERSION_ID: CONTENT_PROMPT_ID,
    CONTENT_WRITER_SKILL_VERSION: '1.0.0',
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'test',
    PORT: String(port),
    QUALITY_CHECKER_MODEL_KEY: 'e2e-quality',
    QUALITY_CHECKER_PROMPT_VERSION_ID: QUALITY_PROMPT_ID,
    QUALITY_CHECKER_SKILL_VERSION: '1.0.0',
  };
  for (const [key, value] of Object.entries(values)) {
    originalEnvironment.set(key, process.env[key]);
    process.env[key] = value;
  }
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.exitCode !== null) {
      throw new Error(`Content E2E API exited during startup: ${apiOutput}`);
    }
    try {
      const response = await fetch(`${url}${API_PREFIX}/health/live`);
      if (response.ok) return;
    } catch {
      // The API socket is not ready yet.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Content E2E API did not become ready: ${apiOutput}`);
}

async function stopApiProcess(process: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!process || process.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      process.kill('SIGKILL');
    }, 5_000);
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
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
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

function requireVariant(
  variants: readonly VariantRow[],
  platformCode: SelectedPlatform,
): VariantRow {
  const variant = variants.find((candidate) => candidate.platformCode === platformCode);
  if (!variant) throw new Error(`Variant ${platformCode} was not found`);
  return variant;
}

function factRunIdFor(platformCode: SelectedPlatform): string {
  return platformCode === 'official_site'
    ? 'f0000000-0000-4000-8000-000000000058'
    : 'f1000000-0000-4000-8000-000000000058';
}

function requireClient(value: Sql | undefined): Sql {
  if (!value) throw new Error('Content E2E PostgreSQL client was not initialized');
  return value;
}

interface AuthenticatedApi {
  readonly api: APIRequestContext;
  readonly csrf: string;
}

interface VariantRow {
  readonly id: string;
  readonly platformCode: SelectedPlatform;
}

interface Aggregate {
  readonly packageId: string;
  readonly variants: readonly VariantRow[];
}

interface GenerationPayload {
  readonly data: {
    readonly master_run_id: string;
    readonly variant_runs: readonly {
      readonly platform_code: SelectedPlatform;
      readonly run_id: string;
      readonly variant_id: string;
    }[];
  };
}

interface GenerationEvent {
  readonly masterRunId: string;
  readonly packageId: string;
  readonly payload: GenerationPayload;
  readonly variantRuns: readonly {
    readonly platformCode: SelectedPlatform;
    readonly runId: string;
    readonly variantId: string;
  }[];
}

interface UsageRow {
  readonly costCents: number;
  readonly generationRunId: string;
  readonly packageId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly status: 'estimated' | 'settled';
  readonly variantId: string | null;
  readonly workspaceId: string;
}

interface PackageDetail {
  readonly master_content: { readonly content_json: { readonly platform_code: string } } | null;
  readonly package: { readonly status: string };
  readonly variants: readonly { readonly platform_code: string; readonly status: string }[];
}

interface VariantDetail {
  readonly current_content: { readonly id: string } | null;
  readonly quality_report: {
    readonly content_version_id: string;
    readonly decision: string;
    readonly issues: readonly unknown[];
    readonly score: number;
  } | null;
  readonly quality_reports: readonly {
    readonly content_version_id: string;
    readonly decision: string;
    readonly issues: readonly unknown[];
    readonly score: number;
  }[];
  readonly variant: { readonly quality_score: number | null; readonly status: string };
}
