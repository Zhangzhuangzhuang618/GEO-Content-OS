import {
  assertContentVariantTransition,
  type ContentPackageStatus,
  type ContentVariantStatus,
  type DomainEventEnvelope,
  type PlatformCode,
} from '@geo-content-os/contracts';
import { createHash } from 'node:crypto';
import type { TransactionSql } from 'postgres';

import type { OutboxWriter } from '../../outbox/index.js';
import {
  generationInputInvalid,
  generationNotFound,
  generationStateInvalid,
  generationVersionConflict,
} from './generation-orchestration.errors.js';
import type {
  GenerationRequestContext,
  GenerationRequestResult,
  GenerationVariantRunView,
  JsonObject,
  RequestGenerationInput,
} from './generation-orchestration.types.js';

interface PackageRow {
  readonly status: ContentPackageStatus;
  readonly version: number;
}

interface VariantRow {
  readonly currentContentVersionId: string | null;
  readonly id: string;
  readonly isRequired: boolean;
  readonly platformCode: PlatformCode;
  readonly status: ContentVariantStatus;
  readonly version: number;
}

interface TargetAccountRow {
  readonly id: string;
  readonly platformCode: PlatformCode;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MODEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;

export class GenerationRequestService {
  public constructor(private readonly outbox: OutboxWriter) {}

  public async request(
    transaction: TransactionSql,
    context: GenerationRequestContext,
    input: RequestGenerationInput,
  ): Promise<GenerationRequestResult> {
    validateInput(input);
    await assertContentProducer(transaction, context.scope.tenantId, context.scope.userId);
    const packageRow = await lockPackage(transaction, context, input.packageId);
    if (!packageRow) throw generationNotFound();
    if (packageRow.version !== input.expectedPackageVersion) throw generationVersionConflict();
    if (packageRow.status === 'archived' || packageRow.status === 'cancelled') {
      throw generationStateInvalid('Archived or cancelled content cannot be generated');
    }
    await assertNoActiveRun(transaction, context.scope.tenantId, input.packageId);
    const variants = await lockVariants(transaction, context.scope.tenantId, input.packageId);
    const required = variants.filter((variant) => variant.isRequired);
    if (required.length < 1 || required.length > 7) {
      throw generationStateInvalid('Generation requires between one and seven required variants');
    }
    for (const variant of required) {
      try {
        assertContentVariantTransition({ from: variant.status, to: 'generating' });
      } catch {
        throw generationStateInvalid(`Variant ${variant.id} cannot enter generation`);
      }
    }
    const accountTargetsRequired = requiresPlatformAccounts();
    const targetAccounts = accountTargetsRequired
      ? await lockTargetAccounts(transaction, context, required)
      : new Map<PlatformCode, string>();

    const inputHash = sha256(
      canonicalJson({
        model_key: input.modelKey,
        model_policy: input.modelPolicy,
        package_id: input.packageId,
        package_version: packageRow.version,
        prompt_version_id: input.promptVersionId,
        skill_version: input.skillVersion,
        variants: required.map((variant) => ({
          current_content_version_id: variant.currentContentVersionId,
          platform_code: variant.platformCode,
          platform_account_id: targetAccounts.get(variant.platformCode) ?? null,
          status: variant.status,
          variant_id: variant.id,
          version: variant.version,
        })),
        writer_input: input.writerInput,
      }),
    );
    const masterRunId = await insertRun(transaction, context, input, inputHash, null);
    const variantRuns: GenerationVariantRunView[] = [];
    for (const variant of required) {
      variantRuns.push({
        platformCode: variant.platformCode,
        runId: await insertRun(transaction, context, input, inputHash, variant.id),
        variantId: variant.id,
      });
    }
    for (const variant of required) {
      const rows = await transaction<{ id: string }[]>`
        UPDATE content_variants
        SET
          status = 'generating',
          platform_account_id = CASE
            WHEN ${accountTargetsRequired}
            THEN ${targetAccounts.get(variant.platformCode) ?? null}::uuid
            ELSE platform_account_id
          END,
          version = version + 1
        WHERE
          id = ${variant.id}::uuid
          AND tenant_id = ${context.scope.tenantId}::uuid
          AND package_id = ${input.packageId}::uuid
          AND version = ${variant.version}
          AND status = ${variant.status}
          AND is_required
        RETURNING id
      `;
      if (rows.length !== 1) throw generationVersionConflict();
    }
    const packages = await transaction<{ id: string }[]>`
      UPDATE content_packages
      SET status = 'generating', version = version + 1
      WHERE
        id = ${input.packageId}::uuid
        AND tenant_id = ${context.scope.tenantId}::uuid
        AND version = ${packageRow.version}
      RETURNING id
    `;
    if (packages.length !== 1) throw generationVersionConflict();

    const event = await this.outbox.enqueue(
      {
        aggregateId: input.packageId,
        aggregateType: 'content_package',
        data: {
          actor_user_id: context.scope.userId,
          input_hash: inputHash,
          master_run_id: masterRunId,
          model_key: input.modelKey,
          model_policy: input.modelPolicy,
          package_id: input.packageId,
          project_id: context.scope.projectId,
          prompt_version_id: input.promptVersionId,
          request_id: context.audit.requestId,
          skill_version: input.skillVersion,
          variant_runs: variantRuns.map((run) => ({
            platform_code: run.platformCode,
            run_id: run.runId,
            variant_id: run.variantId,
          })),
          workspace_id: context.scope.workspaceId,
          writer_input: input.writerInput,
        } as DomainEventEnvelope['data'],
        eventType: 'content.package.generation_requested.v1',
        tenantId: context.scope.tenantId,
      },
      transaction,
    );
    await insertAudit(transaction, context, input.packageId, {
      input_hash: inputHash,
      master_run_id: masterRunId,
      variant_run_ids: variantRuns.map((run) => run.runId),
    });
    return Object.freeze({
      event,
      inputHash,
      masterRunId,
      variantRuns: Object.freeze(variantRuns),
    });
  }
}

async function lockTargetAccounts(
  transaction: TransactionSql,
  context: GenerationRequestContext,
  variants: readonly VariantRow[],
): Promise<ReadonlyMap<PlatformCode, string>> {
  const platforms = variants.map((variant) => variant.platformCode);
  const rows = await transaction<TargetAccountRow[]>`
    SELECT account.id, account.platform_code AS "platformCode"
    FROM platform_accounts AS account
    WHERE
      account.tenant_id = ${context.scope.tenantId}::uuid
      AND account.workspace_id = ${context.scope.workspaceId}::uuid
      AND account.platform_code = ANY(${platforms}::varchar[])
      AND account.status = 'active'
      AND account.deleted_at IS NULL
    ORDER BY account.platform_code, account.id
    FOR SHARE
  `;
  const grouped = new Map<PlatformCode, string[]>();
  for (const row of rows) {
    const ids = grouped.get(row.platformCode) ?? [];
    ids.push(row.id);
    grouped.set(row.platformCode, ids);
  }
  const targets = new Map<PlatformCode, string>();
  for (const platform of platforms) {
    const ids = grouped.get(platform) ?? [];
    if (ids.length !== 1) {
      throw generationStateInvalid(
        `Platform ${platform} requires exactly one active account before generation`,
      );
    }
    targets.set(platform, ids[0]!);
  }
  return targets;
}

function requiresPlatformAccounts(): boolean {
  return process.env['CONTENT_REQUIRE_PLATFORM_ACCOUNTS'] === 'true';
}

async function lockPackage(
  transaction: TransactionSql,
  context: GenerationRequestContext,
  packageId: string,
): Promise<PackageRow | undefined> {
  const scope = context.scope;
  const rows = await transaction<PackageRow[]>`
    SELECT package.status, package.version
    FROM content_packages AS package
    JOIN projects AS project
      ON project.id = package.project_id
      AND project.tenant_id = package.tenant_id
      AND project.workspace_id = package.workspace_id
      AND project.status = 'active'
      AND project.deleted_at IS NULL
    JOIN workspaces AS workspace
      ON workspace.id = package.workspace_id
      AND workspace.tenant_id = package.tenant_id
      AND workspace.status = 'active'
      AND workspace.deleted_at IS NULL
    WHERE
      package.id = ${packageId}::uuid
      AND package.tenant_id = ${scope.tenantId}::uuid
      AND package.workspace_id = ${scope.workspaceId}::uuid
      AND package.project_id = ${scope.projectId}::uuid
      AND package.deleted_at IS NULL
      AND has_project_scope_access(
        package.tenant_id,
        package.workspace_id,
        package.project_id,
        ${scope.userId}::uuid
      )
    FOR UPDATE OF package
  `;
  return rows[0];
}

function lockVariants(
  transaction: TransactionSql,
  tenantId: string,
  packageId: string,
): Promise<VariantRow[]> {
  return transaction<VariantRow[]>`
    SELECT
      current_content_version_id AS "currentContentVersionId",
      id,
      is_required AS "isRequired",
      platform_code AS "platformCode",
      status,
      version
    FROM content_variants
    WHERE tenant_id = ${tenantId}::uuid AND package_id = ${packageId}::uuid
    ORDER BY id
    FOR UPDATE
  `;
}

async function assertNoActiveRun(
  transaction: TransactionSql,
  tenantId: string,
  packageId: string,
): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    SELECT id
    FROM generation_runs
    WHERE
      tenant_id = ${tenantId}::uuid
      AND package_id = ${packageId}::uuid
      AND status IN ('queued', 'running')
    LIMIT 1
    FOR SHARE
  `;
  if (rows.length > 0) throw generationStateInvalid('An active generation already exists');
}

async function assertContentProducer(
  transaction: TransactionSql,
  tenantId: string,
  userId: string,
): Promise<void> {
  const rows = await transaction<{ valid: boolean }[]>`
    SELECT true AS valid
    FROM memberships AS membership
    JOIN users AS identity_user ON identity_user.id = membership.user_id
    JOIN tenants AS tenant ON tenant.id = membership.tenant_id
    WHERE
      membership.tenant_id = ${tenantId}::uuid
      AND membership.user_id = ${userId}::uuid
      AND membership.status = 'active'
      AND membership.role_code IN ('tenant_owner', 'tenant_admin', 'content_editor')
      AND identity_user.status = 'active'
      AND identity_user.deleted_at IS NULL
      AND tenant.status = 'active'
      AND tenant.deleted_at IS NULL
    LIMIT 1
    FOR SHARE OF membership, identity_user, tenant
  `;
  if (rows.length !== 1) throw generationNotFound();
}

async function insertRun(
  transaction: TransactionSql,
  context: GenerationRequestContext,
  input: RequestGenerationInput,
  inputHash: string,
  variantId: string | null,
): Promise<string> {
  const rows = await transaction<{ id: string }[]>`
    INSERT INTO generation_runs (
      tenant_id,
      workspace_id,
      project_id,
      package_id,
      variant_id,
      skill_name,
      skill_version,
      prompt_version_id,
      model_key,
      input_hash,
      request_id
    ) VALUES (
      ${context.scope.tenantId}::uuid,
      ${context.scope.workspaceId}::uuid,
      ${context.scope.projectId}::uuid,
      ${input.packageId}::uuid,
      ${variantId}::uuid,
      'content-writer',
      ${input.skillVersion},
      ${input.promptVersionId}::uuid,
      ${input.modelKey},
      ${inputHash},
      ${context.audit.requestId}
    )
    RETURNING id
  `;
  const row = rows[0];
  if (!row) throw new Error('Generation run insert failed');
  return row.id;
}

async function insertAudit(
  transaction: TransactionSql,
  context: GenerationRequestContext,
  packageId: string,
  after: unknown,
): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    INSERT INTO audit_events (
      tenant_id, actor_id, action, resource_type, resource_id, after_json, ip, request_id
    ) VALUES (
      ${context.scope.tenantId}::uuid,
      ${context.scope.userId}::uuid,
      'content_generation.requested',
      'content_package',
      ${packageId}::uuid,
      ${JSON.stringify(after)}::text::jsonb,
      ${context.audit.ip ?? null},
      ${context.audit.requestId}
    )
    RETURNING id
  `;
  if (rows.length !== 1) throw new Error('Generation audit insert failed');
}

function validateInput(input: RequestGenerationInput): void {
  if (!UUID.test(input.packageId) || !UUID.test(input.promptVersionId)) {
    throw generationInputInvalid('Package and prompt version IDs must be UUIDs');
  }
  if (!Number.isSafeInteger(input.expectedPackageVersion) || input.expectedPackageVersion < 1) {
    throw generationInputInvalid('Expected package version must be a positive integer');
  }
  if (!MODEL_KEY.test(input.modelKey)) throw generationInputInvalid('Model key is invalid');
  if (!['fast', 'balanced', 'quality'].includes(input.modelPolicy)) {
    throw generationInputInvalid('Model policy is invalid');
  }
  if (!SEMVER.test(input.skillVersion) || input.skillVersion.length > 32) {
    throw generationInputInvalid('Skill version is invalid');
  }
  if (containsTenantId(input.writerInput)) {
    throw generationInputInvalid('writerInput must not contain tenant_id');
  }
  canonicalJson(input.writerInput);
}

function containsTenantId(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsTenantId);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(
    ([key, child]) => key === 'tenant_id' || containsTenantId(child),
  );
}

function canonicalJson(value: unknown, path = '$'): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw generationInputInvalid(`${path} contains a non-finite number`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalJson(item, `${path}[${index}]`)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as JsonObject;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], `${path}.${key}`)}`)
      .join(',')}}`;
  }
  throw generationInputInvalid(`${path} contains a non-JSON value`);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
