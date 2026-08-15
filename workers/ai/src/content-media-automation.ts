import { DomainEventEnvelopeSchema } from '@geo-content-os/contracts';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';

import type { ContentMediaAutomationConfig } from './config.js';
import type { QualityAutomationGate, QualityAutomationPolicy } from './quality-automation.js';
import type { ValidatedQualityEvent } from './quality.event.js';

export interface ContentMediaProviderInfo {
  readonly generationModel: string | null;
  readonly inspectionModel: string | null;
  readonly provider: 'cloudflare' | null;
}

export class ContentMediaAutomation {
  public constructor(
    private readonly config: ContentMediaAutomationConfig,
    private readonly provider: ContentMediaProviderInfo,
  ) {}

  public shouldEnqueue(gate: QualityAutomationGate): boolean {
    return this.config.enabled && gate.passed;
  }

  public async enqueue(
    transaction: postgres.TransactionSql,
    event: ValidatedQualityEvent,
    policy: QualityAutomationPolicy,
    reportId: string,
  ): Promise<void> {
    const runs = await transaction<{ id: string; status: string }[]>`
      INSERT INTO content_media_runs (
        tenant_id,workspace_id,project_id,package_id,variant_id,content_version_id,
        quality_report_id,platform_code,planner_model_key,provider,generation_model,
        inspection_model,created_by
      ) VALUES (
        ${event.tenantId}::uuid,${event.data.workspaceId}::uuid,
        ${event.data.projectId}::uuid,${event.data.packageId}::uuid,
        ${event.data.variantId}::uuid,${event.data.contentVersionId}::uuid,
        ${reportId}::uuid,${policy.kind === 'browser_platform' ? policy.value.platformCode : policy.kind},${this.config.plannerModelKey},
        ${this.provider.provider},${this.provider.generationModel},
        ${this.provider.inspectionModel},${event.data.actorUserId}::uuid
      )
      ON CONFLICT (tenant_id,quality_report_id) DO UPDATE
        SET quality_report_id=EXCLUDED.quality_report_id
      RETURNING id,status
    `;
    const mediaRun = runs[0];
    if (!mediaRun) throw new Error('Content media run was not persisted');
    if (mediaRun.status !== 'queued') return;

    if (policy.kind === 'official_site') {
      const changed = await transaction<{ id: string }[]>`
        UPDATE official_site_automation_runs SET
          status='media_pending',last_quality_report_id=${reportId}::uuid,
          last_error_json=NULL,version=version+1
        WHERE tenant_id=${event.tenantId}::uuid AND policy_id=${policy.value.id}::uuid
          AND variant_id=${event.data.variantId}::uuid
          AND content_version_id=${event.data.contentVersionId}::uuid
          AND status='quality_pending'
        RETURNING id
      `;
      if (changed.length !== 1) {
        await cancelUnclaimedMediaRun(transaction, event.tenantId, mediaRun.id);
        return;
      }
      await transaction`
        UPDATE official_site_daily_batch_items SET status='media_pending',last_error_json=NULL
        WHERE tenant_id=${event.tenantId}::uuid AND variant_id=${event.data.variantId}::uuid
          AND content_version_id=${event.data.contentVersionId}::uuid
          AND status='quality_check'
      `;
    } else if (policy.kind === 'baijiahao') {
      const changed = await transaction<{ id: string }[]>`
        UPDATE baijiahao_automation_runs SET
          status='media_pending',last_quality_report_id=${reportId}::uuid,
          last_error_json=NULL,version=version+1
        WHERE tenant_id=${event.tenantId}::uuid AND policy_id=${policy.value.id}::uuid
          AND variant_id=${event.data.variantId}::uuid
          AND content_version_id=${event.data.contentVersionId}::uuid
          AND status='quality_pending'
        RETURNING id
      `;
      if (changed.length !== 1) {
        await cancelUnclaimedMediaRun(transaction, event.tenantId, mediaRun.id);
        return;
      }
      const automationRunId = changed[0]?.id;
      if (!automationRunId) throw new Error('Baijiahao automation run was not updated');
      await transaction`
        UPDATE baijiahao_daily_batch_items SET status='media_pending',last_error_json=NULL
        WHERE tenant_id=${event.tenantId}::uuid AND automation_run_id=${automationRunId}::uuid
          AND content_version_id=${event.data.contentVersionId}::uuid
          AND status='quality_check'
      `;
    } else {
      const changed = await transaction<{ id: string }[]>`
        UPDATE browser_platform_automation_runs SET
          status='media_pending',last_quality_report_id=${reportId}::uuid,
          last_error_json=NULL,version=version+1
        WHERE tenant_id=${event.tenantId}::uuid AND policy_id=${policy.value.id}::uuid
          AND variant_id=${event.data.variantId}::uuid
          AND content_version_id=${event.data.contentVersionId}::uuid
          AND status='quality_pending'
        RETURNING id
      `;
      const automationRunId = changed[0]?.id;
      if (!automationRunId) {
        await cancelUnclaimedMediaRun(transaction, event.tenantId, mediaRun.id);
        return;
      }
      await transaction`
        UPDATE browser_platform_daily_batch_items SET status='media_pending',last_error_json=NULL
        WHERE tenant_id=${event.tenantId}::uuid AND automation_run_id=${automationRunId}::uuid
          AND content_version_id=${event.data.contentVersionId}::uuid
          AND status='quality_check'
      `;
    }

    const queued = DomainEventEnvelopeSchema.parse({
      aggregate: { id: mediaRun.id, type: 'content_media_run' },
      data: {
        actor_user_id: event.data.actorUserId,
        content_hash: event.data.contentHash,
        content_version_id: event.data.contentVersionId,
        media_run_id: mediaRun.id,
        package_id: event.data.packageId,
        platform_code: policy.kind === 'browser_platform' ? policy.value.platformCode : policy.kind,
        project_id: event.data.projectId,
        quality_report_id: reportId,
        request_id: boundedRequestId(`media-${mediaRun.id}`),
        variant_id: event.data.variantId,
        workspace_id: event.data.workspaceId,
      },
      event_id: randomUUID(),
      event_type: 'content.variant.media_generation_requested.v1',
      occurred_at: new Date().toISOString(),
      tenant: { id: event.tenantId },
    });
    await transaction`
      INSERT INTO outbox_events (
        id,tenant_id,event_type,aggregate_type,aggregate_id,payload_json
      ) VALUES (
        ${queued.event_id}::uuid,${queued.tenant.id}::uuid,${queued.event_type},
        ${queued.aggregate.type},${queued.aggregate.id}::uuid,
        ${JSON.stringify(queued)}::text::jsonb
      )
    `;
  }
}

async function cancelUnclaimedMediaRun(
  transaction: postgres.TransactionSql,
  tenantId: string,
  mediaRunId: string,
): Promise<void> {
  await transaction`
    UPDATE content_media_runs SET
      status='cancelled',finished_at=now(),version=version+1,
      last_error_json='{"code":"AUTOMATION_STATE_CHANGED"}'::jsonb
    WHERE id=${mediaRunId}::uuid AND tenant_id=${tenantId}::uuid AND status='queued'
  `;
}

function boundedRequestId(value: string): string {
  return value.slice(0, 80);
}
