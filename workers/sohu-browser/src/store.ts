import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';

import type {
  BrowserPublishInput,
  BrowserSession,
  BrowserSessionStatus,
  PublicationClaim,
  RemotePublication,
  StoredImageAsset,
} from './types.js';

interface AccountRow {
  readonly id: string;
  readonly status: 'active' | 'disabled' | 'reauth';
  readonly tenantId: string;
}

interface PublicationRow extends PublicationClaim {
  readonly contentFingerprint: string;
  readonly externalId: string | null;
  readonly externalUrl: string | null;
  readonly reviewReason: string | null;
  readonly submittedAt: Date | null;
  readonly title: string;
}

export class BrowserStoreError extends Error {
  public constructor(
    public readonly code: 'CONFLICT' | 'NOT_FOUND' | 'STATE_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'BrowserStoreError';
  }
}

export class PostgresSohuBrowserStore {
  public constructor(private readonly client: postgres.Sql) {}

  public async getOrCreateSession(accountId: string): Promise<BrowserSession> {
    return this.client.begin(async (transaction) => {
      const account = await requireAccount(transaction, accountId, true);
      const profileKey = `sohu/${account.tenantId}/${account.id}`;
      await transaction`
        INSERT INTO sohu_browser_sessions (
          tenant_id, account_id, status, profile_key
        ) VALUES (
          ${account.tenantId}::uuid, ${account.id}::uuid,
          ${account.status === 'active' ? 'login_required' : account.status}, ${profileKey}
        )
        ON CONFLICT (tenant_id, account_id) DO NOTHING
      `;
      const rows = await selectSession(transaction, account.id, true);
      const session = rows[0];
      if (!session) throw invalid('Browser session was not created');
      return Object.freeze(session);
    });
  }

  public async getSession(accountId: string): Promise<BrowserSession> {
    await requireAccount(this.client, accountId, false);
    const rows = await selectSession(this.client, accountId, false);
    const session = rows[0];
    if (!session) throw notFound('Browser session does not exist');
    return Object.freeze(session);
  }

  public async markSession(
    session: BrowserSession,
    input: {
      readonly authenticatedAt?: Date | null;
      readonly error?: Readonly<Record<string, unknown>> | null;
      readonly lastVerifiedAt?: Date | null;
      readonly qrExpiresAt?: Date | null;
      readonly status: BrowserSessionStatus;
      readonly storageStateCiphertext?: string | null;
      readonly storageStateKeyVersion?: string | null;
    },
  ): Promise<BrowserSession> {
    const errorJson =
      input.error === undefined || input.error === null ? null : JSON.stringify(input.error);
    const rows = await this.client<BrowserSession[]>`
      UPDATE sohu_browser_sessions SET
        status=${input.status},
        qr_expires_at=${input.qrExpiresAt === undefined ? session.qrExpiresAt : input.qrExpiresAt},
        authenticated_at=${
          input.authenticatedAt === undefined ? session.authenticatedAt : input.authenticatedAt
        },
        last_verified_at=${
          input.lastVerifiedAt === undefined ? session.lastVerifiedAt : input.lastVerifiedAt
        },
        storage_state_ciphertext=${
          input.storageStateCiphertext === undefined
            ? session.storageStateCiphertext
            : input.storageStateCiphertext
        },
        storage_state_key_version=${
          input.storageStateKeyVersion === undefined
            ? session.storageStateKeyVersion
            : input.storageStateKeyVersion
        },
        last_error_json=${errorJson}::text::jsonb,
        version=version+1
      WHERE id=${session.id}::uuid AND tenant_id=${session.tenantId}::uuid
        AND version=${session.version}
      RETURNING id, tenant_id AS "tenantId", account_id AS "accountId", status,
        profile_key AS "profileKey", storage_state_ciphertext AS "storageStateCiphertext",
        storage_state_key_version AS "storageStateKeyVersion",
        qr_expires_at AS "qrExpiresAt", authenticated_at AS "authenticatedAt",
        last_verified_at AS "lastVerifiedAt", version
    `;
    const updated = rows[0];
    if (!updated) throw new BrowserStoreError('CONFLICT', 'Browser session changed concurrently');
    return Object.freeze(updated);
  }

  public async markAccountReauth(accountId: string, tenantId: string): Promise<void> {
    await this.client`
      UPDATE platform_accounts SET status='reauth', version=version+1
      WHERE id=${accountId}::uuid AND tenant_id=${tenantId}::uuid
        AND platform_code='sohu' AND status='active' AND deleted_at IS NULL
    `;
  }

  public async markAccountActive(accountId: string, tenantId: string): Promise<void> {
    await this.client`
      UPDATE platform_accounts SET status='active', version=version+1
      WHERE id=${accountId}::uuid AND tenant_id=${tenantId}::uuid
        AND platform_code='sohu' AND status='reauth' AND deleted_at IS NULL
    `;
  }

  public async preparePublication(
    accountId: string,
    input: BrowserPublishInput,
    contentFingerprint: string,
  ): Promise<PublicationRow> {
    return this.client.begin(async (transaction) => {
      const account = await requireAccount(transaction, accountId, true);
      if (account.status !== 'active') throw invalid('Sohu account requires authentication');
      const sessions = await selectSession(transaction, accountId, true);
      const session = sessions[0];
      if (!session || session.status !== 'authenticated') {
        throw invalid('Sohu browser session is not authenticated');
      }
      const jobs = await transaction<{ id: string }[]>`
        SELECT id FROM publish_jobs
        WHERE tenant_id=${account.tenantId}::uuid AND account_id=${accountId}::uuid
          AND content_version_id=${input.contentVersionId}::uuid
          AND idempotency_key=${input.idempotencyKey}
          AND origin IN ('manual','sohu_automation') AND status='publishing'
        FOR UPDATE
      `;
      const job = jobs[0];
      if (!job) throw invalid('No matching Sohu publish job is currently publishing');
      const fieldSummary = Object.freeze({
        abstract_characters: Array.from(input.payload.abstract).length,
        body_characters: Array.from(input.payload.body_text).length,
        content_type: input.payload.content_type,
        ai_generated: input.payload.ai_generated,
        original: input.payload.original,
        title_characters: Array.from(input.payload.title).length,
      });
      await transaction`
        INSERT INTO sohu_browser_publications (
          tenant_id, session_id, account_id, publish_job_id, content_version_id,
          idempotency_key, payload_hash, content_fingerprint, title, field_summary_json
        ) VALUES (
          ${account.tenantId}::uuid, ${session.id}::uuid, ${accountId}::uuid,
          ${job.id}::uuid, ${input.contentVersionId}::uuid, ${input.idempotencyKey},
          ${input.payloadHash}, ${contentFingerprint}, ${input.payload.title},
          ${JSON.stringify(fieldSummary)}::text::jsonb
        )
        ON CONFLICT (tenant_id, account_id, idempotency_key) DO NOTHING
      `;
      const rows = await selectPublication(
        transaction,
        account.tenantId,
        accountId,
        input.idempotencyKey,
      );
      const publication = rows[0];
      if (!publication) throw invalid('Browser publication was not created');
      const hashes = await transaction<{ payloadHash: string; contentVersionId: string }[]>`
        SELECT payload_hash AS "payloadHash", content_version_id AS "contentVersionId"
        FROM sohu_browser_publications
        WHERE id=${publication.id}::uuid AND tenant_id=${account.tenantId}::uuid
      `;
      const frozen = hashes[0];
      if (
        !frozen ||
        frozen.payloadHash !== input.payloadHash ||
        frozen.contentVersionId !== input.contentVersionId
      ) {
        throw new BrowserStoreError('CONFLICT', 'Idempotency key has different frozen content');
      }
      return Object.freeze(publication);
    });
  }

  public async updatePublication(
    claim: PublicationClaim,
    input: {
      readonly remote?: RemotePublication;
      readonly status: PublicationClaim['status'];
      readonly submittedAt?: Date | null;
    },
  ): Promise<PublicationRow> {
    const rows = await this.client<PublicationRow[]>`
      UPDATE sohu_browser_publications SET
        status=${input.status},
        external_post_id=${input.remote ? input.remote.externalId : this.client`external_post_id`},
        external_url=${input.remote ? input.remote.url : this.client`external_url`},
        review_reason=${input.remote ? input.remote.reviewReason : this.client`review_reason`},
        submitted_at=${
          input.submittedAt === undefined ? this.client`submitted_at` : input.submittedAt
        },
        last_reconciled_at=${input.remote ? new Date() : this.client`last_reconciled_at`},
        version=version+1
      WHERE id=${claim.id}::uuid AND tenant_id=${claim.tenantId}::uuid
        AND version=${claim.version}
      RETURNING id, tenant_id AS "tenantId", session_id AS "sessionId",
        account_id AS "accountId", publish_job_id AS "publishJobId",
        content_version_id AS "contentVersionId", idempotency_key AS "idempotencyKey",
        content_fingerprint AS "contentFingerprint", title, status,
        external_post_id AS "externalId", external_url AS "externalUrl", review_reason AS "reviewReason",
        submitted_at AS "submittedAt", version
    `;
    const updated = rows[0];
    if (!updated)
      throw new BrowserStoreError('CONFLICT', 'Browser publication changed concurrently');
    return Object.freeze(updated);
  }

  public async findPublication(accountId: string, externalId: string): Promise<PublicationRow> {
    const account = await requireAccount(this.client, accountId, false);
    const rows = await this.client<PublicationRow[]>`
      SELECT id, tenant_id AS "tenantId", session_id AS "sessionId",
        account_id AS "accountId", publish_job_id AS "publishJobId",
        content_version_id AS "contentVersionId", idempotency_key AS "idempotencyKey",
        content_fingerprint AS "contentFingerprint", title, status,
        external_post_id AS "externalId", external_url AS "externalUrl", review_reason AS "reviewReason",
        submitted_at AS "submittedAt", version
      FROM sohu_browser_publications
      WHERE tenant_id=${account.tenantId}::uuid AND account_id=${accountId}::uuid
        AND (external_post_id=${externalId} OR id::text=${externalId})
    `;
    const publication = rows[0];
    if (!publication) throw notFound('Browser publication does not exist');
    return Object.freeze(publication);
  }

  public async loadImageAssets(
    publication: PublicationClaim,
    coverAssetId: string | null,
    bodyAssetIds: readonly string[],
  ): Promise<readonly StoredImageAsset[]> {
    const references = [
      ...(coverAssetId ? [{ assetId: coverAssetId, role: 'cover' as const }] : []),
      ...bodyAssetIds.map((assetId) => ({ assetId, role: 'body' as const })),
    ];
    if (references.length === 0) return Object.freeze([]);
    if (new Set(references.map(({ assetId }) => assetId)).size !== references.length) {
      throw invalid('A Sohu image asset cannot be used more than once');
    }
    const ids = this.client.array(
      references.map(({ assetId }) => assetId),
      2950,
    );
    const rows = await this.client<
      {
        assetId: string;
        contentHash: string;
        mimeType: StoredImageAsset['mimeType'];
        objectUri: string;
        sizeBytes: string;
      }[]
    >`
      SELECT
        asset.id AS "assetId",asset.object_uri AS "objectUri",
        asset.content_hash AS "contentHash",asset.mime_type AS "mimeType",
        asset.size_bytes::text AS "sizeBytes"
      FROM sohu_browser_publications AS publication
      JOIN content_versions AS version
        ON version.id=publication.content_version_id AND version.tenant_id=publication.tenant_id
      JOIN content_packages AS package
        ON package.id=version.package_id AND package.tenant_id=version.tenant_id
      JOIN media_assets AS asset
        ON asset.tenant_id=publication.tenant_id AND asset.workspace_id=package.workspace_id
        AND (asset.project_id IS NULL OR asset.project_id=package.project_id)
        AND asset.id=ANY(${ids}::uuid[]) AND asset.asset_type='image'
        AND asset.mime_type IN ('image/gif','image/jpeg','image/png','image/webp')
        AND asset.deleted_at IS NULL
        AND asset.metadata_json->>'content_version_id'=publication.content_version_id::text
        AND asset.metadata_json->>'promotional_watermark'='false'
      WHERE publication.id=${publication.id}::uuid
        AND publication.tenant_id=${publication.tenantId}::uuid
    `;
    const byId = new Map(rows.map((row) => [row.assetId, row]));
    if (byId.size !== references.length) {
      throw invalid(
        'Sohu images must belong to this content version and have a verified no-watermark result',
      );
    }
    return Object.freeze(
      references.map(({ assetId, role }) => {
        const row = byId.get(assetId);
        if (!row) throw invalid('Sohu image asset scope is invalid');
        return Object.freeze({
          assetId,
          contentHash: row.contentHash,
          mimeType: row.mimeType,
          objectUri: row.objectUri,
          role,
          sizeBytes: Number(row.sizeBytes),
        });
      }),
    );
  }

  public async insertArtifact(
    publication: PublicationClaim,
    artifact: { readonly contentHash: string; readonly kind: string; readonly objectUri: string },
  ): Promise<void> {
    await this.client`
      INSERT INTO sohu_browser_artifacts (
        id, tenant_id, publication_id, kind, object_uri, content_hash, metadata_json
      ) VALUES (
        ${randomUUID()}::uuid, ${publication.tenantId}::uuid, ${publication.id}::uuid,
        ${artifact.kind}, ${artifact.objectUri}, ${artifact.contentHash},
        ${JSON.stringify({ account_id: publication.accountId })}::text::jsonb
      ) ON CONFLICT (tenant_id, object_uri) DO NOTHING
    `;
  }
}

function selectSession(
  sql: postgres.Sql | postgres.TransactionSql,
  accountId: string,
  lock: boolean,
): Promise<BrowserSession[]> {
  return sql<BrowserSession[]>`
    SELECT id, tenant_id AS "tenantId", account_id AS "accountId", status,
      profile_key AS "profileKey", storage_state_ciphertext AS "storageStateCiphertext",
      storage_state_key_version AS "storageStateKeyVersion", qr_expires_at AS "qrExpiresAt",
      authenticated_at AS "authenticatedAt", last_verified_at AS "lastVerifiedAt", version
    FROM sohu_browser_sessions WHERE account_id=${accountId}::uuid
    ${lock ? sql`FOR UPDATE` : sql``}
  `;
}

function selectPublication(
  sql: postgres.TransactionSql,
  tenantId: string,
  accountId: string,
  idempotencyKey: string,
): Promise<PublicationRow[]> {
  return sql<PublicationRow[]>`
    SELECT id, tenant_id AS "tenantId", session_id AS "sessionId",
      account_id AS "accountId", publish_job_id AS "publishJobId",
      content_version_id AS "contentVersionId", idempotency_key AS "idempotencyKey",
      content_fingerprint AS "contentFingerprint", title, status,
      external_post_id AS "externalId", external_url AS "externalUrl", review_reason AS "reviewReason",
      submitted_at AS "submittedAt", version
    FROM sohu_browser_publications
    WHERE tenant_id=${tenantId}::uuid AND account_id=${accountId}::uuid
      AND idempotency_key=${idempotencyKey}
    FOR UPDATE
  `;
}

async function requireAccount(
  sql: postgres.Sql | postgres.TransactionSql,
  accountId: string,
  lock: boolean,
): Promise<AccountRow> {
  const rows = await sql<AccountRow[]>`
    SELECT id, tenant_id AS "tenantId", status
    FROM platform_accounts
    WHERE id=${accountId}::uuid AND platform_code='sohu' AND deleted_at IS NULL
    ${lock ? sql`FOR UPDATE` : sql``}
  `;
  const account = rows[0];
  if (!account) throw notFound('Sohu account does not exist');
  return account;
}

function invalid(message: string): BrowserStoreError {
  return new BrowserStoreError('STATE_INVALID', message);
}

function notFound(message: string): BrowserStoreError {
  return new BrowserStoreError('NOT_FOUND', message);
}
