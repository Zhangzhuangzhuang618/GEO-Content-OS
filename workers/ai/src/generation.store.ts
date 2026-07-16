import type { ContentVariantStatus, PlatformCode } from '@geo-content-os/contracts';
import type postgres from 'postgres';

import {
  contentBlocks,
  contentHash,
  textHash,
  validateGeneratedContent,
} from './generation.content.js';
import { GenerationWorkerError } from './generation.errors.js';
import type {
  GeneratedContent,
  GenerationClaimResult,
  GenerationFailure,
  GenerationStorePort,
  ValidatedGenerationEvent,
  VariantClaim,
  VariantClaimResult,
  VariantGenerationRun,
} from './generation.types.js';

interface RunRow {
  readonly inputHash: string;
  readonly modelKey: string;
  readonly packageId: string;
  readonly projectId: string;
  readonly promptVersionId: string;
  readonly requestId: string;
  readonly skillName: string;
  readonly skillVersion: string;
  readonly status: string;
  readonly updatedAt: Date;
  readonly variantId: string | null;
  readonly version: number;
  readonly workspaceId: string;
}

interface VariantRunRow extends RunRow {
  readonly isRequired: boolean;
  readonly platformCode: PlatformCode;
  readonly runId: string;
  readonly variantStatus: ContentVariantStatus;
}

interface VariantStateRow {
  readonly isRequired: boolean;
  readonly status: ContentVariantStatus;
}

const TERMINAL_RUN_STATUSES = new Set(['cancelled', 'failed', 'succeeded']);
const EDITABLE_VARIANT_STATUSES = new Set<ContentVariantStatus>([
  'generated',
  'published',
  'quality_failed',
  'quality_passed',
  'review_approved',
]);

export class PostgresGenerationStore implements GenerationStorePort {
  public constructor(
    private readonly client: postgres.Sql,
    private readonly staleAfterMs = 60_000,
  ) {
    if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1_000 || staleAfterMs > 900_000) {
      throw new TypeError('Generation stale lease duration is invalid');
    }
  }

  public claim(event: ValidatedGenerationEvent): Promise<GenerationClaimResult> {
    return this.client.begin(async (transaction) => {
      const masterRows = await transaction<RunRow[]>`
        SELECT
          run.input_hash AS "inputHash",
          run.model_key AS "modelKey",
          run.package_id AS "packageId",
          run.project_id AS "projectId",
          run.prompt_version_id AS "promptVersionId",
          run.request_id AS "requestId",
          run.skill_name AS "skillName",
          run.skill_version AS "skillVersion",
          run.status,
          run.updated_at AS "updatedAt",
          run.variant_id AS "variantId",
          run.version,
          run.workspace_id AS "workspaceId"
        FROM generation_runs AS run
        JOIN content_packages AS package
          ON package.id = run.package_id
          AND package.tenant_id = run.tenant_id
          AND package.workspace_id = run.workspace_id
          AND package.project_id = run.project_id
        WHERE
          run.id = ${event.data.masterRunId}::uuid
          AND run.tenant_id = ${event.tenantId}::uuid
          AND run.package_id = ${event.data.packageId}::uuid
          AND package.deleted_at IS NULL
        FOR UPDATE OF run, package
      `;
      const master = masterRows[0];
      if (!master || !runMatches(master, event, null)) throw scopeInvalid();
      const variants = await lockVariantRuns(transaction, event);
      assertVariantRunsMatch(variants, event);

      if (master.status === 'failed' || master.status === 'cancelled') {
        return { kind: 'completed' } as const;
      }
      if (
        master.status === 'succeeded' &&
        variants.every((run) => TERMINAL_RUN_STATUSES.has(run.status))
      ) {
        return { kind: 'completed' } as const;
      }
      if (master.status === 'running' && !isStale(master.updatedAt, this.staleAfterMs)) {
        return { kind: 'busy' } as const;
      }
      if (master.status === 'succeeded') {
        return {
          kind: 'claimed',
          value: { leaseVersion: null, masterAlreadySucceeded: true },
        } as const;
      }
      if (master.status !== 'queued' && master.status !== 'running') throw stateInvalid();
      const updated = await transaction<{ version: number }[]>`
        UPDATE generation_runs
        SET
          status = 'running',
          started_at = COALESCE(started_at, now()),
          finished_at = NULL,
          error_json = NULL,
          version = version + 1
        WHERE
          id = ${event.data.masterRunId}::uuid
          AND tenant_id = ${event.tenantId}::uuid
          AND version = ${master.version}
        RETURNING version
      `;
      const lease = updated[0];
      if (!lease) throw leaseLost();
      return {
        kind: 'claimed',
        value: { leaseVersion: lease.version, masterAlreadySucceeded: false },
      } as const;
    });
  }

  public claimVariant(
    event: ValidatedGenerationEvent,
    run: VariantGenerationRun,
  ): Promise<VariantClaimResult> {
    return this.client.begin(async (transaction) => {
      const rows = await selectVariantRun(transaction, event, run, true);
      const row = rows[0];
      if (!row || !variantRunMatches(row, event, run)) throw scopeInvalid();
      if (TERMINAL_RUN_STATUSES.has(row.status)) return { kind: 'completed' } as const;
      if (row.variantStatus !== 'generating') throw stateInvalid();
      if (row.status === 'running' && !isStale(row.updatedAt, this.staleAfterMs)) {
        return { kind: 'busy' } as const;
      }
      if (row.status !== 'queued' && row.status !== 'running') throw stateInvalid();
      const updated = await transaction<{ version: number }[]>`
        UPDATE generation_runs
        SET
          status = 'running',
          started_at = COALESCE(started_at, now()),
          finished_at = NULL,
          error_json = NULL,
          version = version + 1
        WHERE
          id = ${run.runId}::uuid
          AND tenant_id = ${event.tenantId}::uuid
          AND version = ${row.version}
        RETURNING version
      `;
      const lease = updated[0];
      if (!lease) throw leaseLost();
      return {
        kind: 'claimed',
        value: { leaseVersion: lease.version, run },
      } as const;
    });
  }

  public async heartbeat(
    event: ValidatedGenerationEvent,
    runId: string,
    leaseVersion: number,
  ): Promise<void> {
    const rows = await this.client<{ id: string }[]>`
      UPDATE generation_runs
      SET updated_at = now()
      WHERE
        id = ${runId}::uuid
        AND tenant_id = ${event.tenantId}::uuid
        AND package_id = ${event.data.packageId}::uuid
        AND status = 'running'
        AND version = ${leaseVersion}
      RETURNING id
    `;
    if (rows.length !== 1) throw leaseLost();
  }

  public async loadMaster(event: ValidatedGenerationEvent): Promise<GeneratedContent> {
    const rows = await this.client<{ content: unknown }[]>`
      SELECT version.content_json AS content
      FROM content_versions AS version
      WHERE
        version.tenant_id = ${event.tenantId}::uuid
        AND version.package_id = ${event.data.packageId}::uuid
        AND version.variant_id IS NULL
        AND version.source_run_id = ${event.data.masterRunId}::uuid
      LIMIT 1
    `;
    const row = rows[0];
    if (!row)
      throw new GenerationWorkerError('MASTER_CONTENT_MISSING', 'Master content is missing');
    return validateGeneratedContent(row.content, 'master');
  }

  public async saveMaster(
    event: ValidatedGenerationEvent,
    leaseVersion: number,
    rawContent: GeneratedContent,
  ): Promise<void> {
    const content = validateGeneratedContent(rawContent, 'master');
    await this.client.begin(async (transaction) => {
      await requireRunLease(transaction, event, event.data.masterRunId, leaseVersion);
      const packages = await transaction<{ id: string }[]>`
        SELECT id
        FROM content_packages
        WHERE
          id = ${event.data.packageId}::uuid
          AND tenant_id = ${event.tenantId}::uuid
          AND workspace_id = ${event.data.workspaceId}::uuid
          AND project_id = ${event.data.projectId}::uuid
          AND status = 'generating'
          AND deleted_at IS NULL
        FOR UPDATE
      `;
      if (packages.length !== 1) throw stateInvalid();
      const versionId = await insertVersion(
        transaction,
        event,
        null,
        event.data.masterRunId,
        content,
      );
      const pointed = await transaction<{ id: string }[]>`
        UPDATE content_packages
        SET master_content_version_id = ${versionId}::uuid, version = version + 1
        WHERE
          id = ${event.data.packageId}::uuid
          AND tenant_id = ${event.tenantId}::uuid
          AND status = 'generating'
        RETURNING id
      `;
      if (pointed.length !== 1) throw stateInvalid();
      await succeedRun(transaction, event, event.data.masterRunId, leaseVersion);
      await insertAudit(transaction, event, versionId, 'master');
    });
  }

  public async saveVariant(
    event: ValidatedGenerationEvent,
    claim: VariantClaim,
    rawContent: GeneratedContent,
  ): Promise<void> {
    const content = validateGeneratedContent(rawContent, claim.run.platformCode);
    await this.client.begin(async (transaction) => {
      await requireRunLease(transaction, event, claim.run.runId, claim.leaseVersion);
      const rows = await selectVariantRun(transaction, event, claim.run, true);
      const row = rows[0];
      if (!row || !variantRunMatches(row, event, claim.run) || row.variantStatus !== 'generating') {
        throw stateInvalid();
      }
      await assertLocks(transaction, event.tenantId, claim.run.variantId, content);
      const versionId = await insertVersion(
        transaction,
        event,
        claim.run.variantId,
        claim.run.runId,
        content,
      );
      const pointed = await transaction<{ id: string }[]>`
        UPDATE content_variants
        SET
          current_content_version_id = ${versionId}::uuid,
          status = 'generated',
          version = version + 1
        WHERE
          id = ${claim.run.variantId}::uuid
          AND tenant_id = ${event.tenantId}::uuid
          AND package_id = ${event.data.packageId}::uuid
          AND status = 'generating'
        RETURNING id
      `;
      if (pointed.length !== 1) throw stateInvalid();
      await succeedRun(transaction, event, claim.run.runId, claim.leaseVersion);
      await insertAudit(transaction, event, versionId, claim.run.platformCode);
    });
  }

  public async failMaster(
    event: ValidatedGenerationEvent,
    leaseVersion: number,
    failure: GenerationFailure,
  ): Promise<void> {
    await this.client.begin(async (transaction) => {
      await failRun(transaction, event, event.data.masterRunId, leaseVersion, failure);
      const runIds = event.data.variantRuns.map((run) => run.runId);
      await transaction`
        UPDATE generation_runs
        SET
          status = 'failed',
          error_json = ${JSON.stringify(failure)}::text::jsonb,
          started_at = COALESCE(started_at, now()),
          finished_at = now(),
          version = version + 1
        WHERE
          tenant_id = ${event.tenantId}::uuid
          AND id = ANY(${runIds}::uuid[])
          AND status IN ('queued', 'running')
      `;
      await transaction`
        UPDATE content_variants
        SET status = 'generation_failed', version = version + 1
        WHERE
          tenant_id = ${event.tenantId}::uuid
          AND package_id = ${event.data.packageId}::uuid
          AND is_required
          AND status = 'generating'
      `;
    });
  }

  public async failVariant(
    event: ValidatedGenerationEvent,
    claim: VariantClaim,
    failure: GenerationFailure,
  ): Promise<void> {
    await this.client.begin(async (transaction) => {
      await failRun(transaction, event, claim.run.runId, claim.leaseVersion, failure);
      const rows = await transaction<{ id: string }[]>`
        UPDATE content_variants
        SET status = 'generation_failed', version = version + 1
        WHERE
          id = ${claim.run.variantId}::uuid
          AND tenant_id = ${event.tenantId}::uuid
          AND package_id = ${event.data.packageId}::uuid
          AND status = 'generating'
        RETURNING id
      `;
      if (rows.length !== 1) throw stateInvalid();
    });
  }

  public async finalize(
    event: ValidatedGenerationEvent,
  ): Promise<'all_failed' | 'generated' | 'generating'> {
    return this.client.begin(async (transaction) => {
      const variants = await transaction<VariantStateRow[]>`
        SELECT is_required AS "isRequired", status
        FROM content_variants
        WHERE tenant_id = ${event.tenantId}::uuid AND package_id = ${event.data.packageId}::uuid
        ORDER BY id
        FOR UPDATE
      `;
      const required = variants.filter((variant) => variant.isRequired);
      if (required.length < 1 || required.length > 7) throw stateInvalid();
      const status = required.some((variant) => variant.status === 'generating')
        ? 'generating'
        : required.some((variant) => EDITABLE_VARIANT_STATUSES.has(variant.status))
          ? 'generated'
          : required.every((variant) => variant.status === 'generation_failed')
            ? 'all_failed'
            : 'generating';
      await transaction`
        UPDATE content_packages
        SET status = ${status}, version = version + 1
        WHERE
          id = ${event.data.packageId}::uuid
          AND tenant_id = ${event.tenantId}::uuid
          AND status IS DISTINCT FROM ${status}
      `;
      return status;
    });
  }
}

async function lockVariantRuns(
  transaction: postgres.TransactionSql,
  event: ValidatedGenerationEvent,
): Promise<VariantRunRow[]> {
  const runIds = event.data.variantRuns.map((run) => run.runId);
  return transaction<VariantRunRow[]>`
    SELECT
      variant.is_required AS "isRequired",
      run.input_hash AS "inputHash",
      run.model_key AS "modelKey",
      run.package_id AS "packageId",
      variant.platform_code AS "platformCode",
      run.project_id AS "projectId",
      run.prompt_version_id AS "promptVersionId",
      run.request_id AS "requestId",
      run.id AS "runId",
      run.skill_name AS "skillName",
      run.skill_version AS "skillVersion",
      run.status,
      run.updated_at AS "updatedAt",
      run.variant_id AS "variantId",
      variant.status AS "variantStatus",
      run.version,
      run.workspace_id AS "workspaceId"
    FROM generation_runs AS run
    JOIN content_variants AS variant
      ON variant.id = run.variant_id
      AND variant.tenant_id = run.tenant_id
      AND variant.package_id = run.package_id
    WHERE
      run.tenant_id = ${event.tenantId}::uuid
      AND run.package_id = ${event.data.packageId}::uuid
      AND run.id = ANY(${runIds}::uuid[])
    ORDER BY run.id
    FOR UPDATE OF run, variant
  `;
}

function selectVariantRun(
  transaction: postgres.TransactionSql,
  event: ValidatedGenerationEvent,
  run: VariantGenerationRun,
  forUpdate: boolean,
): Promise<VariantRunRow[]> {
  const query = transaction<VariantRunRow[]>`
    SELECT
      variant.is_required AS "isRequired",
      generation.input_hash AS "inputHash",
      generation.model_key AS "modelKey",
      generation.package_id AS "packageId",
      variant.platform_code AS "platformCode",
      generation.project_id AS "projectId",
      generation.prompt_version_id AS "promptVersionId",
      generation.request_id AS "requestId",
      generation.id AS "runId",
      generation.skill_name AS "skillName",
      generation.skill_version AS "skillVersion",
      generation.status,
      generation.updated_at AS "updatedAt",
      generation.variant_id AS "variantId",
      variant.status AS "variantStatus",
      generation.version,
      generation.workspace_id AS "workspaceId"
    FROM generation_runs AS generation
    JOIN content_variants AS variant
      ON variant.id = generation.variant_id
      AND variant.tenant_id = generation.tenant_id
      AND variant.package_id = generation.package_id
    WHERE
      generation.id = ${run.runId}::uuid
      AND generation.tenant_id = ${event.tenantId}::uuid
      AND generation.package_id = ${event.data.packageId}::uuid
      AND variant.id = ${run.variantId}::uuid
    ${forUpdate ? transaction`FOR UPDATE OF generation, variant` : transaction``}
  `;
  return query;
}

function assertVariantRunsMatch(
  rows: readonly VariantRunRow[],
  event: ValidatedGenerationEvent,
): void {
  if (rows.length !== event.data.variantRuns.length) throw scopeInvalid();
  const byId = new Map(rows.map((row) => [row.runId, row]));
  for (const run of event.data.variantRuns) {
    const row = byId.get(run.runId);
    if (!row || !variantRunMatches(row, event, run)) throw scopeInvalid();
  }
}

function runMatches(
  row: RunRow,
  event: ValidatedGenerationEvent,
  variantId: string | null,
): boolean {
  return (
    row.packageId === event.data.packageId &&
    row.workspaceId === event.data.workspaceId &&
    row.projectId === event.data.projectId &&
    row.variantId === variantId &&
    row.skillName === 'content-writer' &&
    row.skillVersion === event.data.skillVersion &&
    row.promptVersionId === event.data.promptVersionId &&
    row.modelKey === event.data.modelKey &&
    row.inputHash === event.data.inputHash &&
    row.requestId === event.data.requestId
  );
}

function variantRunMatches(
  row: VariantRunRow,
  event: ValidatedGenerationEvent,
  run: VariantGenerationRun,
): boolean {
  return (
    row.runId === run.runId &&
    row.variantId === run.variantId &&
    row.platformCode === run.platformCode &&
    row.isRequired &&
    runMatches(row, event, run.variantId)
  );
}

async function requireRunLease(
  transaction: postgres.TransactionSql,
  event: ValidatedGenerationEvent,
  runId: string,
  leaseVersion: number,
): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    SELECT id
    FROM generation_runs
    WHERE
      id = ${runId}::uuid
      AND tenant_id = ${event.tenantId}::uuid
      AND package_id = ${event.data.packageId}::uuid
      AND status = 'running'
      AND version = ${leaseVersion}
    FOR UPDATE
  `;
  if (rows.length !== 1) throw leaseLost();
}

async function succeedRun(
  transaction: postgres.TransactionSql,
  event: ValidatedGenerationEvent,
  runId: string,
  leaseVersion: number,
): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    UPDATE generation_runs
    SET status = 'succeeded', finished_at = now(), error_json = NULL, version = version + 1
    WHERE
      id = ${runId}::uuid
      AND tenant_id = ${event.tenantId}::uuid
      AND status = 'running'
      AND version = ${leaseVersion}
    RETURNING id
  `;
  if (rows.length !== 1) throw leaseLost();
}

async function failRun(
  transaction: postgres.TransactionSql,
  event: ValidatedGenerationEvent,
  runId: string,
  leaseVersion: number,
  failure: GenerationFailure,
): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    UPDATE generation_runs
    SET
      status = 'failed',
      error_json = ${JSON.stringify(failure)}::text::jsonb,
      finished_at = now(),
      version = version + 1
    WHERE
      id = ${runId}::uuid
      AND tenant_id = ${event.tenantId}::uuid
      AND package_id = ${event.data.packageId}::uuid
      AND status = 'running'
      AND version = ${leaseVersion}
    RETURNING id
  `;
  if (rows.length !== 1) throw leaseLost();
}

async function insertVersion(
  transaction: postgres.TransactionSql,
  event: ValidatedGenerationEvent,
  variantId: string | null,
  sourceRunId: string,
  content: GeneratedContent,
): Promise<string> {
  const versions = await transaction<{ versionNo: number }[]>`
    SELECT COALESCE(max(version_no), 0)::integer + 1 AS "versionNo"
    FROM content_versions
    WHERE
      tenant_id = ${event.tenantId}::uuid
      AND package_id = ${event.data.packageId}::uuid
      AND variant_id IS NOT DISTINCT FROM ${variantId}::uuid
  `;
  const versionNo = versions[0]?.versionNo;
  if (!versionNo) throw new Error('Could not allocate a content version');
  const inserted = await transaction<{ id: string }[]>`
    INSERT INTO content_versions (
      tenant_id,
      package_id,
      variant_id,
      version_no,
      schema_version,
      content_json,
      content_hash,
      source_run_id,
      created_by
    ) VALUES (
      ${event.tenantId}::uuid,
      ${event.data.packageId}::uuid,
      ${variantId}::uuid,
      ${versionNo},
      ${content.schema_version},
      ${JSON.stringify(content)}::text::jsonb,
      ${contentHash(content)},
      ${sourceRunId}::uuid,
      ${event.data.actorUserId}::uuid
    )
    RETURNING id
  `;
  const row = inserted[0];
  if (!row) throw new Error('Content version insert failed');
  for (const [position, block] of contentBlocks(content).entries()) {
    await transaction`
      INSERT INTO content_blocks (
        tenant_id, content_version_id, block_key, block_type, position, text_hash
      ) VALUES (
        ${event.tenantId}::uuid,
        ${row.id}::uuid,
        ${block.block_key},
        ${block.block_type},
        ${position},
        ${textHash(block.text)}
      )
    `;
  }
  await insertCitations(transaction, event, row.id, content);
  return row.id;
}

async function insertCitations(
  transaction: postgres.TransactionSql,
  event: ValidatedGenerationEvent,
  contentVersionId: string,
  content: GeneratedContent,
): Promise<void> {
  const available = parseEvidenceCitations(event.data.writerInput);
  const mappings = parseCitationMappings(content);
  const inserted = new Set<string>();
  for (const mapping of mappings) {
    for (const citationId of mapping.citationIds) {
      const citation = available.get(citationId);
      if (!citation) {
        throw new GenerationWorkerError(
          'GENERATED_CONTENT_INVALID',
          `Generated citation ${citationId} was not supplied to the writer`,
        );
      }
      const key = `${mapping.claimKey}:${citation.chunkId}:${textHash(citation.quoteText)}`;
      if (inserted.has(key)) continue;
      inserted.add(key);
      const rows = await transaction<{ id: string }[]>`
        INSERT INTO ai_citations (
          tenant_id, content_version_id, claim_key, claim_text,
          chunk_id, quote_text, quote_hash
        )
        SELECT
          ${event.tenantId}::uuid, ${contentVersionId}::uuid, ${mapping.claimKey},
          ${mapping.claimText}, chunk.id, ${citation.quoteText}, ${textHash(citation.quoteText)}
        FROM source_chunks AS chunk
        WHERE chunk.id = ${citation.chunkId}::uuid
          AND chunk.tenant_id = ${event.tenantId}::uuid
          AND chunk.status = 'active'
        RETURNING id
      `;
      if (rows.length !== 1) throw scopeInvalid();
    }
  }
}

function parseEvidenceCitations(
  writerInput: ValidatedGenerationEvent['data']['writerInput'],
): ReadonlyMap<string, { readonly chunkId: string; readonly quoteText: string }> {
  const raw = writerInput['citations'];
  if (raw === undefined) return new Map();
  if (!Array.isArray(raw)) throw generatedContentInvalid('Writer citations must be an array');
  const citations = new Map<string, { readonly chunkId: string; readonly quoteText: string }>();
  for (const value of raw) {
    if (!isRecord(value)) throw generatedContentInvalid('Writer citation must be an object');
    const citationId = value['citation_id'];
    const chunkId = value['chunk_id'];
    const quoteText = value['quote_text'];
    if (
      typeof citationId !== 'string' ||
      typeof chunkId !== 'string' ||
      typeof quoteText !== 'string' ||
      quoteText.trim().length === 0 ||
      citations.has(citationId)
    ) {
      throw generatedContentInvalid('Writer citation is invalid or duplicated');
    }
    citations.set(citationId, { chunkId, quoteText });
  }
  return citations;
}

function parseCitationMappings(content: GeneratedContent): readonly {
  readonly citationIds: readonly string[];
  readonly claimKey: string;
  readonly claimText: string;
}[] {
  const raw = content['citation_map'];
  if (!Array.isArray(raw)) throw generatedContentInvalid('Generated citation_map is required');
  return raw.map((value) => {
    if (!isRecord(value)) throw generatedContentInvalid('Generated citation mapping is invalid');
    const citationIds = value['citation_ids'];
    const claimKey = value['claim_key'];
    const claimText = value['claim_text'];
    if (
      !Array.isArray(citationIds) ||
      citationIds.length === 0 ||
      citationIds.some((id) => typeof id !== 'string') ||
      new Set(citationIds).size !== citationIds.length ||
      typeof claimKey !== 'string' ||
      claimKey.trim().length < 1 ||
      claimKey.length > 80 ||
      typeof claimText !== 'string' ||
      claimText.trim().length < 1
    ) {
      throw generatedContentInvalid('Generated citation mapping is invalid');
    }
    return {
      citationIds: citationIds as readonly string[],
      claimKey,
      claimText,
    };
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function generatedContentInvalid(message: string): GenerationWorkerError {
  return new GenerationWorkerError('GENERATED_CONTENT_INVALID', message);
}

async function assertLocks(
  transaction: postgres.TransactionSql,
  tenantId: string,
  variantId: string,
  content: GeneratedContent,
): Promise<void> {
  const locks = await transaction<{ blockKey: string; lockedContentHash: string }[]>`
    SELECT block_key AS "blockKey", locked_content_hash AS "lockedContentHash"
    FROM content_block_locks
    WHERE tenant_id = ${tenantId}::uuid AND variant_id = ${variantId}::uuid
    ORDER BY block_key
    FOR SHARE
  `;
  if (locks.length === 0) return;
  const proposed = new Map(
    contentBlocks(content).map((block) => [block.block_key, textHash(block.text)]),
  );
  for (const lock of locks) {
    if (proposed.get(lock.blockKey) !== lock.lockedContentHash) {
      throw new GenerationWorkerError(
        'LOCK_VIOLATION',
        `Locked block ${lock.blockKey} was changed`,
      );
    }
  }
}

async function insertAudit(
  transaction: postgres.TransactionSql,
  event: ValidatedGenerationEvent,
  versionId: string,
  platform: PlatformCode | 'master',
): Promise<void> {
  await transaction`
    INSERT INTO audit_events (
      tenant_id, actor_id, action, resource_type, resource_id, after_json, request_id
    ) VALUES (
      ${event.tenantId}::uuid,
      ${event.data.actorUserId}::uuid,
      'content_version.generated',
      'content_version',
      ${versionId}::uuid,
      ${JSON.stringify({ platform_code: platform, source_run_id: platform === 'master' ? event.data.masterRunId : event.data.variantRuns.find((run) => run.platformCode === platform)?.runId })}::text::jsonb,
      ${event.data.requestId}
    )
  `;
}

function isStale(updatedAt: Date, staleAfterMs: number): boolean {
  return Date.now() - new Date(updatedAt).getTime() >= staleAfterMs;
}

function scopeInvalid(): GenerationWorkerError {
  return new GenerationWorkerError('GENERATION_SCOPE_INVALID', 'Generation scope is invalid');
}

function stateInvalid(): GenerationWorkerError {
  return new GenerationWorkerError('GENERATION_STATE_INVALID', 'Generation state is invalid');
}

function leaseLost(): GenerationWorkerError {
  return new GenerationWorkerError('GENERATION_LEASE_LOST', 'Generation lease was lost', {
    retryable: true,
  });
}
