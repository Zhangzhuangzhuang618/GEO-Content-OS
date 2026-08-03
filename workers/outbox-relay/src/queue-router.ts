import type { EventType } from '@geo-content-os/contracts';

export const OUTBOX_QUEUE_NAMES = Object.freeze([
  'geo-knowledge',
  'geo-ai',
  'geo-publisher',
  'geo-analytics',
  'geo-lifecycle',
] as const);

export type OutboxQueueName = (typeof OUTBOX_QUEUE_NAMES)[number];

const EVENT_QUEUE: Readonly<Record<EventType, OutboxQueueName>> = Object.freeze({
  'knowledge.source.ingest_requested.v1': 'geo-knowledge',
  'knowledge.source.reindex_requested.v1': 'geo-knowledge',
  'strategy.topic_plan.generation_requested.v1': 'geo-ai',
  'strategy.keyword_import.requested.v1': 'geo-knowledge',
  'content.package.generation_requested.v1': 'geo-ai',
  'content.variant.quality_check_requested.v1': 'geo-ai',
  'content.variant.official_site_rewrite_requested.v1': 'geo-ai',
  'content.variant.baijiahao_adaptation_requested.v1': 'geo-ai',
  'publishing.job.execution_requested.v1': 'geo-publisher',
  'publishing.job.published.v1': 'geo-ai',
  'baijiahao.publication.reconcile_requested.v1': 'geo-publisher',
  'analytics.metrics.import_requested.v1': 'geo-analytics',
  'analytics.visibility.probe_requested.v1': 'geo-ai',
  'analytics.export.requested.v1': 'geo-analytics',
  'lifecycle.tenant.export_requested.v1': 'geo-lifecycle',
});

export function queueNameFor(eventType: EventType): OutboxQueueName {
  return EVENT_QUEUE[eventType];
}
