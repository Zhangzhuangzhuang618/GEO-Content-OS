import { UuidSchema } from '@geo-content-os/contracts';
import type { StructuredLogger } from '@geo-content-os/observability';
import { redactSensitiveData } from '@geo-content-os/security';
import { isIP } from 'node:net';
import type { TransactionSql } from 'postgres';

import { getApiLogger } from '../../common/telemetry/index.js';
import { RequiredAuditWriteError } from './required-audit.errors.js';
import type { AuditEventRecord, RequiredAuditInput } from './required-audit.types.js';

interface AuditEventRow {
  readonly action: string;
  readonly actorId: string | null;
  readonly after: unknown;
  readonly before: unknown;
  readonly createdAt: Date;
  readonly id: string;
  readonly ip: string | null;
  readonly requestId: string;
  readonly resourceId: string | null;
  readonly resourceType: string;
  readonly supportAccessGrantId: string | null;
  readonly tenantId: string;
}

interface NormalizedAuditInput {
  readonly action: string;
  readonly actorId: string | null;
  readonly afterJson: string | null;
  readonly beforeJson: string | null;
  readonly ip: string | null;
  readonly requestId: string;
  readonly resourceId: string | null;
  readonly resourceType: string;
  readonly supportAccessGrantId: string | null;
  readonly tenantId: string;
}

export class RequiredAuditWriter {
  public constructor(private readonly logger: StructuredLogger = getApiLogger()) {}

  public async record(
    transaction: TransactionSql,
    input: RequiredAuditInput,
  ): Promise<AuditEventRecord> {
    try {
      const normalized = normalizeInput(input);
      const rows = await transaction<AuditEventRow[]>`
        INSERT INTO audit_events (
          tenant_id, actor_id, support_access_grant_id, action, resource_type,
          resource_id, before_json, after_json, ip, request_id
        ) VALUES (
          ${normalized.tenantId}::uuid,
          ${normalized.actorId}::uuid,
          ${normalized.supportAccessGrantId}::uuid,
          ${normalized.action},
          ${normalized.resourceType},
          ${normalized.resourceId}::uuid,
          ${normalized.beforeJson}::text::jsonb,
          ${normalized.afterJson}::text::jsonb,
          ${normalized.ip}::inet,
          ${normalized.requestId}
        )
        RETURNING
          id,
          tenant_id AS "tenantId",
          actor_id AS "actorId",
          support_access_grant_id AS "supportAccessGrantId",
          action,
          resource_type AS "resourceType",
          resource_id AS "resourceId",
          before_json AS before,
          after_json AS after,
          ip::text AS ip,
          request_id AS "requestId",
          created_at AS "createdAt"
      `;
      const row = rows[0];
      if (!row) throw new Error('Audit event insert returned no row');
      return Object.freeze(row);
    } catch (error) {
      this.logger.error('Required audit write failed; aborting business transaction', error, {
        action: safeLabel(input.action, 80),
        audit_required: true,
        request_id: safeLabel(input.requestId, 80),
        resource_type: safeLabel(input.resourceType, 64),
        tenant_id: safeUuid(input.tenantId),
      });
      throw new RequiredAuditWriteError(error);
    }
  }
}

function normalizeInput(input: RequiredAuditInput): NormalizedAuditInput {
  return Object.freeze({
    action: normalizeLabel(input.action, 80),
    actorId: optionalUuid(input.actorId),
    afterJson: serializeRedacted(input.after),
    beforeJson: serializeRedacted(input.before),
    ip: normalizeIp(input.ip),
    requestId: normalizeLabel(input.requestId, 80),
    resourceId: optionalUuid(input.resourceId),
    resourceType: normalizeLabel(input.resourceType, 64),
    supportAccessGrantId: optionalUuid(input.supportAccessGrantId),
    tenantId: normalizeUuid(input.tenantId),
  });
}

function normalizeUuid(value: string): string {
  const parsed = UuidSchema.safeParse(value);
  if (!parsed.success) throw new Error('Audit UUID is invalid');
  return parsed.data;
}

function optionalUuid(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : normalizeUuid(value);
}

function normalizeLabel(value: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum) {
    throw new Error('Audit label is invalid');
  }
  return normalized;
}

function normalizeIp(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  if (isIP(normalized) === 0) throw new Error('Audit IP address is invalid');
  return normalized;
}

function serializeRedacted(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const serialized = JSON.stringify(redactSensitiveData(value));
  if (serialized === undefined) throw new Error('Audit payload is not serializable');
  return serialized;
}

function safeLabel(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function safeUuid(value: unknown): string | null {
  return typeof value === 'string' && UuidSchema.safeParse(value).success ? value : null;
}
