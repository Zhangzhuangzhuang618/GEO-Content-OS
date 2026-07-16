import type { AuditEventView, AuditQuery } from '@geo-content-os/contracts';
import { UuidSchema } from '@geo-content-os/contracts';
import { redactSensitiveData } from '@geo-content-os/security';
import { Inject, Injectable } from '@nestjs/common';
import { Buffer } from 'node:buffer';

import { IdentityAuthDatabase } from '../identity/auth/auth.database.js';

interface AuditCursor {
  readonly createdAt: string;
  readonly id: string;
}

interface AuditRow {
  readonly action: string;
  readonly actorId: string | null;
  readonly actorName: string | null;
  readonly after: unknown;
  readonly before: unknown;
  readonly createdAt: Date | string;
  readonly cursorCreatedAt?: string;
  readonly id: string;
  readonly ip: string | null;
  readonly requestId: string;
  readonly resourceId: string | null;
  readonly resourceType: string;
}

export interface AuditEventPageResult {
  readonly items: readonly AuditEventView[];
  readonly nextCursor: string | null;
}

@Injectable()
export class AuditQueryService {
  public constructor(
    @Inject(IdentityAuthDatabase) private readonly database: IdentityAuthDatabase,
  ) {}

  public async list(tenantId: string, query: AuditQuery): Promise<AuditEventPageResult> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.database.client<AuditRow[]>`
      SELECT
        audit.id,
        audit.actor_id AS "actorId",
        actor.display_name AS "actorName",
        audit.action,
        audit.resource_type AS "resourceType",
        audit.resource_id AS "resourceId",
        audit.before_json AS before,
        audit.after_json AS after,
        audit.request_id AS "requestId",
        audit.ip::text AS ip,
        audit.created_at AS "createdAt",
        audit.created_at::text AS "cursorCreatedAt"
      FROM audit_events AS audit
      LEFT JOIN users AS actor ON actor.id = audit.actor_id
      WHERE audit.tenant_id = ${tenantId}::uuid
        AND (${query.actor_id ?? null}::uuid IS NULL OR audit.actor_id = ${query.actor_id ?? null}::uuid)
        AND (${query.action ?? null}::text IS NULL OR audit.action = ${query.action ?? null})
        AND (${query.resource_type ?? null}::text IS NULL OR audit.resource_type = ${query.resource_type ?? null})
        AND (${query.resource_id ?? null}::uuid IS NULL OR audit.resource_id = ${query.resource_id ?? null}::uuid)
        AND (${query.request_id ?? null}::text IS NULL OR audit.request_id = ${query.request_id ?? null})
        AND (${query.from ?? null}::timestamptz IS NULL OR audit.created_at >= ${query.from ?? null}::timestamptz)
        AND (${query.to ?? null}::timestamptz IS NULL OR audit.created_at <= ${query.to ?? null}::timestamptz)
        AND (
          ${cursor?.createdAt ?? null}::timestamptz IS NULL
          OR (audit.created_at, audit.id) < (
            ${cursor?.createdAt ?? null}::timestamptz,
            ${cursor?.id ?? null}::uuid
          )
        )
      ORDER BY audit.created_at DESC, audit.id DESC
      LIMIT ${query.limit + 1}
    `;
    const hasMore = rows.length > query.limit;
    const selected = hasMore ? rows.slice(0, query.limit) : rows;
    const last = selected.at(-1);
    return {
      items: selected.map(toView),
      nextCursor:
        hasMore && last
          ? encodeCursor({
              createdAt: last.cursorCreatedAt ?? new Date(last.createdAt).toISOString(),
              id: last.id,
            })
          : null,
    };
  }
}

function toView(row: AuditRow): AuditEventView {
  return {
    action: row.action,
    actor_id: row.actorId,
    actor_name: row.actorName,
    after: safeJson(row.after),
    before: safeJson(row.before),
    created_at: new Date(row.createdAt).toISOString(),
    id: row.id,
    ip: row.ip,
    request_id: row.requestId,
    resource_id: row.resourceId,
    resource_type: row.resourceType,
  };
}

function safeJson(value: unknown): AuditEventView['before'] {
  if (value === null || value === undefined) return null;
  return JSON.parse(JSON.stringify(redactSensitiveData(value))) as AuditEventView['before'];
}

function encodeCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): AuditCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    const id = parsed && typeof parsed === 'object' ? Reflect.get(parsed, 'id') : undefined;
    const createdAt =
      parsed && typeof parsed === 'object' ? Reflect.get(parsed, 'createdAt') : undefined;
    if (
      !UuidSchema.safeParse(id).success ||
      typeof createdAt !== 'string' ||
      Number.isNaN(Date.parse(createdAt))
    )
      throw new Error();
    return { createdAt, id: String(id) };
  } catch {
    throw new AuditQueryValidationError();
  }
}

export class AuditQueryValidationError extends Error {
  public constructor() {
    super('Audit query cursor is invalid');
    this.name = 'AuditQueryValidationError';
  }
}
