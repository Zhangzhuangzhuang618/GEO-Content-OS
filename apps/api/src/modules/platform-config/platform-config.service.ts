import type {
  CreatePromptVersionRequest,
  CreateRuleVersionRequest,
  PlatformConfigStatus,
  PromptVersionQuery,
  PromptVersionView,
  RuleVersionQuery,
  RuleVersionView,
} from '@geo-content-os/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { TransactionSql } from 'postgres';

import { canonicalJson, type JsonValue } from '../../common/idempotency/index.js';
import { IdentityAuthDatabase } from '../identity/auth/auth.database.js';
import {
  PlatformConfigConflictError,
  PlatformConfigNotFoundError,
  PlatformConfigStateError,
  PlatformConfigValidationError,
  PlatformConfigVersionError,
} from './platform-config.errors.js';

interface VersionCursor {
  readonly createdAt: string;
  readonly id: string;
}

interface PromptRow {
  readonly changeSummary: string;
  readonly contentHash: string;
  readonly createdAt: Date | string;
  readonly createdBy: string;
  readonly createdByName: string;
  readonly cursorCreatedAt?: string;
  readonly id: string;
  readonly lockVersion: number;
  readonly publishedAt: Date | string | null;
  readonly publishedBy: string | null;
  readonly publishedByName: string | null;
  readonly schemaVersion: string;
  readonly semanticVersion: string;
  readonly skillName: PromptVersionView['skill_name'];
  readonly status: PlatformConfigStatus;
  readonly systemPrompt: string;
  readonly taskTemplate: string;
}

interface RuleRow {
  readonly changeSummary: string;
  readonly contentHash: string;
  readonly createdAt: Date | string;
  readonly createdBy: string;
  readonly createdByName: string;
  readonly cursorCreatedAt?: string;
  readonly id: string;
  readonly lockVersion: number;
  readonly platformCode: RuleVersionView['platform_code'];
  readonly publishedAt: Date | string | null;
  readonly publishedBy: string | null;
  readonly publishedByName: string | null;
  readonly rules: RuleVersionView['rules'];
  readonly semanticVersion: string;
  readonly status: PlatformConfigStatus;
}

export interface PlatformConfigPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface PlatformConfigAuditContext {
  readonly ip?: string;
  readonly requestId: string;
}

@Injectable()
export class PlatformConfigService {
  public constructor(
    @Inject(IdentityAuthDatabase) private readonly database: IdentityAuthDatabase,
  ) {}

  public async listPrompts(
    query: PromptVersionQuery,
  ): Promise<PlatformConfigPage<PromptVersionView>> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.database.client<PromptRow[]>`
      SELECT
        prompt.id,
        prompt.skill_name AS "skillName",
        prompt.version AS "semanticVersion",
        prompt.schema_version AS "schemaVersion",
        prompt.system_prompt AS "systemPrompt",
        prompt.task_template AS "taskTemplate",
        prompt.content_hash AS "contentHash",
        prompt.change_summary AS "changeSummary",
        prompt.status,
        prompt.created_by AS "createdBy",
        creator.display_name AS "createdByName",
        prompt.published_by AS "publishedBy",
        publisher.display_name AS "publishedByName",
        prompt.published_at AS "publishedAt",
        prompt.lock_version AS "lockVersion",
        prompt.created_at AS "createdAt",
        prompt.created_at::text AS "cursorCreatedAt"
      FROM prompt_versions AS prompt
      JOIN users AS creator ON creator.id = prompt.created_by
      LEFT JOIN users AS publisher ON publisher.id = prompt.published_by
      WHERE (${query.skill_name ?? null}::text IS NULL OR prompt.skill_name = ${query.skill_name ?? null})
        AND (${query.status ?? null}::text IS NULL OR prompt.status = ${query.status ?? null})
        AND (
          ${cursor?.createdAt ?? null}::timestamptz IS NULL
          OR (prompt.created_at, prompt.id) < (
            ${cursor?.createdAt ?? null}::timestamptz,
            ${cursor?.id ?? null}::uuid
          )
        )
      ORDER BY prompt.created_at DESC, prompt.id DESC
      LIMIT ${query.limit + 1}
    `;
    return page(rows, query.limit, toPromptView);
  }

  public async listRules(query: RuleVersionQuery): Promise<PlatformConfigPage<RuleVersionView>> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.database.client<RuleRow[]>`
      SELECT
        rule.id,
        rule.platform_code AS "platformCode",
        rule.version AS "semanticVersion",
        rule.rules_json AS rules,
        rule.content_hash AS "contentHash",
        rule.change_summary AS "changeSummary",
        rule.status,
        rule.created_by AS "createdBy",
        creator.display_name AS "createdByName",
        rule.published_by AS "publishedBy",
        publisher.display_name AS "publishedByName",
        rule.published_at AS "publishedAt",
        rule.lock_version AS "lockVersion",
        rule.created_at AS "createdAt",
        rule.created_at::text AS "cursorCreatedAt"
      FROM platform_rule_versions AS rule
      JOIN users AS creator ON creator.id = rule.created_by
      LEFT JOIN users AS publisher ON publisher.id = rule.published_by
      WHERE (${query.platform_code ?? null}::text IS NULL OR rule.platform_code = ${query.platform_code ?? null})
        AND (${query.status ?? null}::text IS NULL OR rule.status = ${query.status ?? null})
        AND (
          ${cursor?.createdAt ?? null}::timestamptz IS NULL
          OR (rule.created_at, rule.id) < (
            ${cursor?.createdAt ?? null}::timestamptz,
            ${cursor?.id ?? null}::uuid
          )
        )
      ORDER BY rule.created_at DESC, rule.id DESC
      LIMIT ${query.limit + 1}
    `;
    return page(rows, query.limit, toRuleView);
  }

  public async createPrompt(
    transaction: TransactionSql,
    actorId: string,
    input: CreatePromptVersionRequest,
    audit: PlatformConfigAuditContext,
  ): Promise<PromptVersionView> {
    try {
      const hash = contentHash({
        schema_version: input.schema_version,
        semantic_version: input.semantic_version,
        skill_name: input.skill_name,
        system_prompt: input.system_prompt,
        task_template: input.task_template,
      });
      const rows = await transaction<PromptRow[]>`
        WITH inserted AS (
          INSERT INTO prompt_versions (
            skill_name, version, schema_version, system_prompt, task_template,
            content_hash, change_summary, created_by
          ) VALUES (
            ${input.skill_name}, ${input.semantic_version}, ${input.schema_version},
            ${input.system_prompt}, ${input.task_template}, ${hash},
            ${input.change_summary}, ${actorId}::uuid
          )
          RETURNING *
        )
        SELECT
          inserted.id,
          inserted.skill_name AS "skillName",
          inserted.version AS "semanticVersion",
          inserted.schema_version AS "schemaVersion",
          inserted.system_prompt AS "systemPrompt",
          inserted.task_template AS "taskTemplate",
          inserted.content_hash AS "contentHash",
          inserted.change_summary AS "changeSummary",
          inserted.status,
          inserted.created_by AS "createdBy",
          creator.display_name AS "createdByName",
          inserted.published_by AS "publishedBy",
          NULL::text AS "publishedByName",
          inserted.published_at AS "publishedAt",
          inserted.lock_version AS "lockVersion",
          inserted.created_at AS "createdAt"
        FROM inserted
        JOIN users AS creator ON creator.id = inserted.created_by
      `;
      const row = required(rows[0]);
      const view = toPromptView(row);
      await insertGlobalAudit(transaction, actorId, 'platform.prompt-version.created', view, audit);
      return view;
    } catch (error) {
      if (isUniqueViolation(error)) throw new PlatformConfigConflictError();
      throw error;
    }
  }

  public async createRule(
    transaction: TransactionSql,
    actorId: string,
    input: CreateRuleVersionRequest,
    audit: PlatformConfigAuditContext,
  ): Promise<RuleVersionView> {
    try {
      const serialized = canonicalJson(input.rules as JsonValue);
      if (Buffer.byteLength(serialized, 'utf8') > 100_000)
        throw new PlatformConfigValidationError();
      const hash = contentHash({
        platform_code: input.platform_code,
        rules: input.rules as JsonValue,
        semantic_version: input.semantic_version,
      });
      const rows = await transaction<RuleRow[]>`
        WITH inserted AS (
          INSERT INTO platform_rule_versions (
            platform_code, version, rules_json, content_hash,
            change_summary, created_by
          ) VALUES (
            ${input.platform_code}, ${input.semantic_version},
            ${serialized}::text::jsonb, ${hash}, ${input.change_summary}, ${actorId}::uuid
          )
          RETURNING *
        )
        SELECT
          inserted.id,
          inserted.platform_code AS "platformCode",
          inserted.version AS "semanticVersion",
          inserted.rules_json AS rules,
          inserted.content_hash AS "contentHash",
          inserted.change_summary AS "changeSummary",
          inserted.status,
          inserted.created_by AS "createdBy",
          creator.display_name AS "createdByName",
          inserted.published_by AS "publishedBy",
          NULL::text AS "publishedByName",
          inserted.published_at AS "publishedAt",
          inserted.lock_version AS "lockVersion",
          inserted.created_at AS "createdAt"
        FROM inserted
        JOIN users AS creator ON creator.id = inserted.created_by
      `;
      const row = required(rows[0]);
      const view = toRuleView(row);
      await insertGlobalAudit(transaction, actorId, 'platform.rule-version.created', view, audit);
      return view;
    } catch (error) {
      if (isUniqueViolation(error)) throw new PlatformConfigConflictError();
      throw error;
    }
  }

  public async publishPrompt(
    actorId: string,
    id: string,
    version: number,
    audit: PlatformConfigAuditContext,
  ): Promise<PromptVersionView> {
    return this.database.client.begin(async (transaction) => {
      const before = await lockPrompt(transaction, id);
      assertTransition(before, version, 'publish');
      await transaction`
        UPDATE prompt_versions
        SET status = 'published', published_at = now(), published_by = ${actorId}::uuid,
            lock_version = lock_version + 1
        WHERE id = ${id}::uuid
      `;
      const after = toPromptView(await lockPrompt(transaction, id));
      await insertGlobalAudit(
        transaction,
        actorId,
        'platform.prompt-version.published',
        after,
        audit,
        toPromptView(before),
      );
      return after;
    });
  }

  public async retirePrompt(
    actorId: string,
    id: string,
    version: number,
    reason: string,
    audit: PlatformConfigAuditContext,
  ): Promise<PromptVersionView> {
    return this.database.client.begin(async (transaction) => {
      const before = await lockPrompt(transaction, id);
      assertTransition(before, version, 'retire');
      await transaction`
        UPDATE prompt_versions
        SET status = 'retired', lock_version = lock_version + 1
        WHERE id = ${id}::uuid
      `;
      const after = toPromptView(await lockPrompt(transaction, id));
      await insertGlobalAudit(
        transaction,
        actorId,
        'platform.prompt-version.retired',
        after,
        audit,
        toPromptView(before),
        { reason },
      );
      return after;
    });
  }

  public async publishRule(
    actorId: string,
    id: string,
    version: number,
    audit: PlatformConfigAuditContext,
  ): Promise<RuleVersionView> {
    return this.database.client.begin(async (transaction) => {
      const before = await lockRule(transaction, id);
      assertTransition(before, version, 'publish');
      await transaction`
        UPDATE platform_rule_versions
        SET status = 'published', published_at = now(), published_by = ${actorId}::uuid,
            lock_version = lock_version + 1
        WHERE id = ${id}::uuid
      `;
      const after = toRuleView(await lockRule(transaction, id));
      await insertGlobalAudit(
        transaction,
        actorId,
        'platform.rule-version.published',
        after,
        audit,
        toRuleView(before),
      );
      return after;
    });
  }

  public async retireRule(
    actorId: string,
    id: string,
    version: number,
    reason: string,
    audit: PlatformConfigAuditContext,
  ): Promise<RuleVersionView> {
    return this.database.client.begin(async (transaction) => {
      const before = await lockRule(transaction, id);
      assertTransition(before, version, 'retire');
      await transaction`
        UPDATE platform_rule_versions
        SET status = 'retired', lock_version = lock_version + 1
        WHERE id = ${id}::uuid
      `;
      const after = toRuleView(await lockRule(transaction, id));
      await insertGlobalAudit(
        transaction,
        actorId,
        'platform.rule-version.retired',
        after,
        audit,
        toRuleView(before),
        { reason },
      );
      return after;
    });
  }
}

async function lockPrompt(transaction: TransactionSql, id: string): Promise<PromptRow> {
  const rows = await transaction<PromptRow[]>`
    SELECT
      prompt.id,
      prompt.skill_name AS "skillName",
      prompt.version AS "semanticVersion",
      prompt.schema_version AS "schemaVersion",
      prompt.system_prompt AS "systemPrompt",
      prompt.task_template AS "taskTemplate",
      prompt.content_hash AS "contentHash",
      prompt.change_summary AS "changeSummary",
      prompt.status,
      prompt.created_by AS "createdBy",
      creator.display_name AS "createdByName",
      prompt.published_by AS "publishedBy",
      publisher.display_name AS "publishedByName",
      prompt.published_at AS "publishedAt",
      prompt.lock_version AS "lockVersion",
      prompt.created_at AS "createdAt"
    FROM prompt_versions AS prompt
    JOIN users AS creator ON creator.id = prompt.created_by
    LEFT JOIN users AS publisher ON publisher.id = prompt.published_by
    WHERE prompt.id = ${id}::uuid
    FOR UPDATE OF prompt
  `;
  if (!rows[0]) throw new PlatformConfigNotFoundError();
  return rows[0];
}

async function lockRule(transaction: TransactionSql, id: string): Promise<RuleRow> {
  const rows = await transaction<RuleRow[]>`
    SELECT
      rule.id,
      rule.platform_code AS "platformCode",
      rule.version AS "semanticVersion",
      rule.rules_json AS rules,
      rule.content_hash AS "contentHash",
      rule.change_summary AS "changeSummary",
      rule.status,
      rule.created_by AS "createdBy",
      creator.display_name AS "createdByName",
      rule.published_by AS "publishedBy",
      publisher.display_name AS "publishedByName",
      rule.published_at AS "publishedAt",
      rule.lock_version AS "lockVersion",
      rule.created_at AS "createdAt"
    FROM platform_rule_versions AS rule
    JOIN users AS creator ON creator.id = rule.created_by
    LEFT JOIN users AS publisher ON publisher.id = rule.published_by
    WHERE rule.id = ${id}::uuid
    FOR UPDATE OF rule
  `;
  if (!rows[0]) throw new PlatformConfigNotFoundError();
  return rows[0];
}

function assertTransition(
  row: { readonly lockVersion: number; readonly status: PlatformConfigStatus },
  version: number,
  action: 'publish' | 'retire',
): void {
  if (row.lockVersion !== version) throw new PlatformConfigVersionError();
  if (action === 'publish' && row.status !== 'draft') throw new PlatformConfigStateError();
  if (action === 'retire' && row.status !== 'published') throw new PlatformConfigStateError();
}

async function insertGlobalAudit(
  transaction: TransactionSql,
  actorId: string,
  action: string,
  after: PromptVersionView | RuleVersionView,
  audit: PlatformConfigAuditContext,
  before?: PromptVersionView | RuleVersionView,
  details?: Record<string, string>,
): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    INSERT INTO audit_events (
      tenant_id, actor_id, action, resource_type, resource_id,
      before_json, after_json, ip, request_id
    ) VALUES (
      NULL, ${actorId}::uuid, ${action}, 'platform_config', ${after.id}::uuid,
      ${before ? JSON.stringify(before) : null}::text::jsonb,
      ${JSON.stringify(details ? { ...details, resource: after } : after)}::text::jsonb,
      ${audit.ip ?? null}, ${audit.requestId}
    )
    RETURNING id
  `;
  if (rows.length !== 1) throw new Error('Required platform configuration audit write failed');
}

function toPromptView(row: PromptRow): PromptVersionView {
  return {
    change_summary: row.changeSummary,
    content_hash: row.contentHash,
    created_at: toIso(row.createdAt),
    created_by: row.createdBy,
    created_by_name: row.createdByName,
    id: row.id,
    published_at: row.publishedAt ? toIso(row.publishedAt) : null,
    published_by: row.publishedBy,
    published_by_name: row.publishedByName,
    schema_version: row.schemaVersion,
    semantic_version: row.semanticVersion,
    skill_name: row.skillName,
    status: row.status,
    system_prompt: row.systemPrompt,
    task_template: row.taskTemplate,
    version: row.lockVersion,
  };
}

function toRuleView(row: RuleRow): RuleVersionView {
  return {
    change_summary: row.changeSummary,
    content_hash: row.contentHash,
    created_at: toIso(row.createdAt),
    created_by: row.createdBy,
    created_by_name: row.createdByName,
    id: row.id,
    platform_code: row.platformCode,
    published_at: row.publishedAt ? toIso(row.publishedAt) : null,
    published_by: row.publishedBy,
    published_by_name: row.publishedByName,
    rules: row.rules,
    semantic_version: row.semanticVersion,
    status: row.status,
    version: row.lockVersion,
  };
}

function page<
  Row extends {
    readonly createdAt: Date | string;
    readonly cursorCreatedAt?: string;
    readonly id: string;
  },
  View,
>(rows: readonly Row[], limit: number, convert: (row: Row) => View): PlatformConfigPage<View> {
  const hasMore = rows.length > limit;
  const selected = hasMore ? rows.slice(0, limit) : rows;
  const last = selected.at(-1);
  return {
    items: selected.map(convert),
    nextCursor:
      hasMore && last
        ? encodeCursor({
            createdAt: last.cursorCreatedAt ?? toIso(last.createdAt),
            id: last.id,
          })
        : null,
  };
}

function contentHash(value: JsonValue): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function encodeCursor(cursor: VersionCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): VersionCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    const id = parsed && typeof parsed === 'object' ? Reflect.get(parsed, 'id') : undefined;
    const createdAt =
      parsed && typeof parsed === 'object' ? Reflect.get(parsed, 'createdAt') : undefined;
    if (
      typeof id !== 'string' ||
      !/^[0-9a-f-]{36}$/iu.test(id) ||
      typeof createdAt !== 'string' ||
      Number.isNaN(Date.parse(createdAt))
    ) {
      throw new Error();
    }
    return { createdAt, id };
  } catch {
    throw new PlatformConfigNotFoundError();
  }
}

function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}

function required<T>(value: T | undefined): T {
  if (!value) throw new Error('Platform configuration insert returned no row');
  return value;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === '23505');
}
