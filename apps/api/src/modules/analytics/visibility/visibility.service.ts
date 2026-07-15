import type { ObjectStorageAdapter } from '@geo-content-os/adapter-storage';
import { createHash, randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';

import type { DatabaseClient } from '../../../database/index.js';

const PLATFORM_CODES = new Set([
  'official_site',
  'baijiahao',
  'toutiao',
  'zhihu',
  'xiaohongshu',
  'wechat_mp',
  'douyin',
]);
const HASH = /^[0-9a-f]{64}$/u;
const IMAGE_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

export interface VisibilityScope {
  readonly requestId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly workspaceId: string;
}

export interface VisibilityObservationInput {
  readonly evidenceAssetId?: string | null;
  readonly isCited: boolean;
  readonly notes?: string | null;
  readonly observedAt: string;
  readonly platformCode: string;
  readonly queryText: string;
  readonly rankPosition?: number | null;
}

export interface VisibilityScreenshot {
  readonly body: Uint8Array;
  readonly mimeType: string;
}

export interface VisibilityObservationView {
  readonly createdAt: Date;
  readonly evidenceAssetId: string | null;
  readonly id: string;
  readonly isCited: boolean;
  readonly notes: string | null;
  readonly observedAt: Date;
  readonly platformCode: string;
  readonly queryHash: string;
  readonly queryText: string;
  readonly rankPosition: number | null;
  readonly tenantId: string;
  readonly workspaceId: string;
}

export interface VisibilityTrendQuery {
  readonly from: string;
  readonly platformCode?: string;
  readonly queryHash?: string;
  readonly to: string;
}

export interface VisibilityTrendPoint {
  readonly averageRank: number | null;
  readonly bestRank: number | null;
  readonly citationCount: number;
  readonly citationRate: number;
  readonly day: string;
  readonly observationCount: number;
  readonly platformCode: string;
  readonly queryHash: string;
  readonly queryText: string;
}

interface NormalizedObservation {
  readonly evidenceAssetId: string | null;
  readonly isCited: boolean;
  readonly notes: string | null;
  readonly observedAt: Date;
  readonly platformCode: string;
  readonly queryHash: string;
  readonly queryText: string;
  readonly rankPosition: number | null;
}

interface TrendRow {
  readonly averageRank: string | null;
  readonly bestRank: number | null;
  readonly citationCount: number;
  readonly day: string;
  readonly observationCount: number;
  readonly platformCode: string;
  readonly queryHash: string;
  readonly queryText: string;
}

interface VisibilityDatabaseProvider {
  readonly client: DatabaseClient;
}

export class VisibilityService {
  public constructor(
    private readonly client: DatabaseClient | VisibilityDatabaseProvider,
    private readonly storage: ObjectStorageAdapter,
  ) {}

  public async record(
    scope: VisibilityScope,
    input: VisibilityObservationInput,
    screenshot?: VisibilityScreenshot,
  ): Promise<VisibilityObservationView> {
    if (screenshot && input.evidenceAssetId) throw new VisibilityValidationError();
    const normalized = normalizeObservation(input);
    const observationId = randomUUID();
    const assetId = screenshot ? randomUUID() : null;
    const objectKey = screenshot
      ? screenshotKey(scope, assetId as string, screenshot.mimeType)
      : null;
    let objectStored = false;

    try {
      return await resolveClient(this.client).begin(async (transaction) => {
        await assertVisibilityAccess(transaction, scope);
        if (screenshot && assetId && objectKey) {
          const contentHash = validateScreenshot(screenshot);
          const stored = await this.storage.putObject({
            body: screenshot.body,
            contentHash,
            contentType: screenshot.mimeType,
            key: objectKey,
            metadata: {
              asset_id: assetId,
              tenant_id: scope.tenantId,
              workspace_id: scope.workspaceId,
            },
          });
          objectStored = true;
          await transaction`
            INSERT INTO media_assets (
              id, tenant_id, workspace_id, asset_type, object_uri, content_hash,
              mime_type, size_bytes, metadata_json, created_by
            ) VALUES (
              ${assetId}::uuid, ${scope.tenantId}::uuid, ${scope.workspaceId}::uuid,
              'screenshot', ${stored.uri}, ${contentHash}, ${screenshot.mimeType},
              ${screenshot.body.byteLength},
              ${JSON.stringify({ purpose: 'visibility_evidence', schema_version: 'media-metadata@1' })}::text::jsonb,
              ${scope.userId}::uuid
            )
          `;
        }
        return insertObservation(
          transaction,
          scope,
          observationId,
          assetId ?? normalized.evidenceAssetId,
          normalized,
        );
      });
    } catch (error) {
      if (objectStored && objectKey) {
        await this.storage.deleteObject(objectKey).catch(() => undefined);
      }
      if (isEvidenceConstraint(error)) throw new VisibilityStateError();
      throw error;
    }
  }

  public async importRows(
    scope: VisibilityScope,
    rows: readonly VisibilityObservationInput[],
  ): Promise<readonly VisibilityObservationView[]> {
    if (rows.length === 0 || rows.length > 1_000) throw new VisibilityValidationError();
    const normalized = rows.map(normalizeObservation);
    try {
      return await resolveClient(this.client).begin(async (transaction) => {
        await assertVisibilityAccess(transaction, scope);
        const created: VisibilityObservationView[] = [];
        for (const row of normalized) {
          created.push(
            await insertObservation(transaction, scope, randomUUID(), row.evidenceAssetId, row),
          );
        }
        return Object.freeze(created);
      });
    } catch (error) {
      if (isEvidenceConstraint(error)) throw new VisibilityStateError();
      throw error;
    }
  }

  public async trend(
    scope: VisibilityScope,
    query: VisibilityTrendQuery,
  ): Promise<readonly VisibilityTrendPoint[]> {
    if (
      !validDate(query.from) ||
      !validDate(query.to) ||
      query.from > query.to ||
      (query.queryHash !== undefined && !HASH.test(query.queryHash)) ||
      (query.platformCode !== undefined && !PLATFORM_CODES.has(query.platformCode))
    ) {
      throw new VisibilityValidationError();
    }
    return resolveClient(this.client).begin(async (transaction) => {
      await assertVisibilityAccess(transaction, scope);
      const rows = await transaction<TrendRow[]>`
        SELECT
          (observation.observed_at AT TIME ZONE 'UTC')::date::text AS day,
          observation.platform_code AS "platformCode",
          observation.query_hash AS "queryHash",
          min(observation.query_text) AS "queryText",
          count(*)::integer AS "observationCount",
          count(*) FILTER (WHERE observation.is_cited)::integer AS "citationCount",
          min(observation.rank_position) AS "bestRank",
          round(avg(observation.rank_position), 2)::text AS "averageRank"
        FROM visibility_observations AS observation
        WHERE observation.tenant_id = ${scope.tenantId}::uuid
          AND observation.workspace_id = ${scope.workspaceId}::uuid
          AND observation.observed_at >= ${query.from}::date
          AND observation.observed_at < (${query.to}::date + INTERVAL '1 day')
          AND (${query.queryHash ?? null}::char(64) IS NULL OR observation.query_hash = ${query.queryHash ?? null})
          AND (${query.platformCode ?? null}::varchar IS NULL OR observation.platform_code = ${query.platformCode ?? null})
          AND has_project_scope_access(
            observation.tenant_id, observation.workspace_id, NULL, ${scope.userId}::uuid
          )
        GROUP BY
          (observation.observed_at AT TIME ZONE 'UTC')::date,
          observation.platform_code,
          observation.query_hash
        ORDER BY day, observation.platform_code, observation.query_hash
      `;
      return Object.freeze(
        rows.map((row) =>
          Object.freeze({
            averageRank: row.averageRank === null ? null : Number(row.averageRank),
            bestRank: row.bestRank,
            citationCount: row.citationCount,
            citationRate: row.observationCount === 0 ? 0 : row.citationCount / row.observationCount,
            day: row.day,
            observationCount: row.observationCount,
            platformCode: row.platformCode,
            queryHash: row.queryHash,
            queryText: row.queryText,
          }),
        ),
      );
    });
  }
}

export class VisibilityValidationError extends Error {}
export class VisibilityStateError extends Error {}

function normalizeObservation(input: VisibilityObservationInput): NormalizedObservation {
  const queryText = normalizeDisplayQuery(input.queryText);
  const observedAt = new Date(input.observedAt);
  const evidenceAssetId = input.evidenceAssetId?.trim() || null;
  const notes = input.notes?.trim() || null;
  const rankPosition = input.rankPosition ?? null;
  if (
    !queryText ||
    !PLATFORM_CODES.has(input.platformCode) ||
    !validTimestamp(input.observedAt) ||
    typeof input.isCited !== 'boolean' ||
    (rankPosition !== null && (!Number.isInteger(rankPosition) || rankPosition < 1)) ||
    (evidenceAssetId !== null && !isUuid(evidenceAssetId)) ||
    (input.notes !== undefined && input.notes !== null && notes === null)
  ) {
    throw new VisibilityValidationError();
  }
  const canonicalQuery = queryText.normalize('NFKC').toLocaleLowerCase('en-US');
  return Object.freeze({
    evidenceAssetId,
    isCited: input.isCited,
    notes,
    observedAt,
    platformCode: input.platformCode,
    queryHash: createHash('sha256').update(canonicalQuery).digest('hex'),
    queryText,
    rankPosition,
  });
}

async function insertObservation(
  transaction: TransactionSql,
  scope: VisibilityScope,
  id: string,
  evidenceAssetId: string | null,
  row: NormalizedObservation,
): Promise<VisibilityObservationView> {
  const rows = await transaction<VisibilityObservationView[]>`
    INSERT INTO visibility_observations (
      id, tenant_id, workspace_id, platform_code, query_text, query_hash,
      observed_at, rank_position, is_cited, evidence_asset_id, notes
    ) VALUES (
      ${id}::uuid, ${scope.tenantId}::uuid, ${scope.workspaceId}::uuid,
      ${row.platformCode}, ${row.queryText}, ${row.queryHash}, ${row.observedAt},
      ${row.rankPosition}, ${row.isCited}, ${evidenceAssetId}::uuid, ${row.notes}
    )
    RETURNING
      id,
      tenant_id AS "tenantId",
      workspace_id AS "workspaceId",
      platform_code AS "platformCode",
      query_text AS "queryText",
      query_hash AS "queryHash",
      observed_at AS "observedAt",
      rank_position AS "rankPosition",
      is_cited AS "isCited",
      evidence_asset_id AS "evidenceAssetId",
      notes,
      created_at AS "createdAt"
  `;
  const created = rows[0];
  if (!created) throw new VisibilityStateError();
  await transaction`
    INSERT INTO audit_events (
      tenant_id, actor_id, action, resource_type, resource_id, after_json, request_id
    ) VALUES (
      ${scope.tenantId}::uuid, ${scope.userId}::uuid, 'visibility_observation.created',
      'visibility_observation', ${id}::uuid,
      ${JSON.stringify({
        evidence_asset_id: evidenceAssetId,
        platform_code: row.platformCode,
        query_hash: row.queryHash,
      })}::text::jsonb,
      ${scope.requestId}
    )
  `;
  return Object.freeze(created);
}

async function assertVisibilityAccess(
  transaction: TransactionSql,
  scope: VisibilityScope,
): Promise<void> {
  const rows = await transaction<{ allowed: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM workspaces AS workspace
      JOIN memberships AS membership ON membership.tenant_id = workspace.tenant_id
      WHERE workspace.id = ${scope.workspaceId}::uuid
        AND workspace.tenant_id = ${scope.tenantId}::uuid
        AND workspace.status = 'active'
        AND workspace.deleted_at IS NULL
        AND membership.user_id = ${scope.userId}::uuid
        AND membership.status = 'active'
        AND membership.role_code IN ('tenant_owner', 'tenant_admin', 'analyst')
        AND has_project_scope_access(
          workspace.tenant_id, workspace.id, NULL, membership.user_id
        )
    ) AS allowed
  `;
  if (!rows[0]?.allowed) throw new VisibilityStateError();
}

function validateScreenshot(screenshot: VisibilityScreenshot): string {
  if (!IMAGE_TYPES.has(screenshot.mimeType) || !hasImageSignature(screenshot)) {
    throw new VisibilityValidationError();
  }
  return createHash('sha256').update(screenshot.body).digest('hex');
}

function hasImageSignature(screenshot: VisibilityScreenshot): boolean {
  const bytes = screenshot.body;
  if (screenshot.mimeType === 'image/png') {
    return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  }
  if (screenshot.mimeType === 'image/jpeg') {
    return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  }
  return (
    screenshot.mimeType === 'image/webp' &&
    new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' &&
    new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP'
  );
}

function screenshotKey(scope: VisibilityScope, assetId: string, mimeType: string): string {
  const extension = IMAGE_TYPES.get(mimeType);
  if (!extension) throw new VisibilityValidationError();
  return `tenants/${scope.tenantId}/workspaces/${scope.workspaceId}/visibility/${assetId}.${extension}`;
}

function normalizeDisplayQuery(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    validDate(value.slice(0, 10)) &&
    !Number.isNaN(new Date(value).getTime())
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isEvidenceConstraint(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === '23503' || code === 'P0001';
}

function resolveClient(database: DatabaseClient | VisibilityDatabaseProvider): DatabaseClient {
  return typeof database === 'function' ? database : database.client;
}
