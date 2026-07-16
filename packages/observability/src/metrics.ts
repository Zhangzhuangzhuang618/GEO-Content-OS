import type { IncomingMessage, ServerResponse } from 'node:http';

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8' as const;

export const OBSERVABILITY_METRIC_NAMES = Object.freeze({
  aiCost: 'geo_ai_cost_cents_total',
  aiSchemaResults: 'geo_ai_schema_results_total',
  apiDuration: 'geo_api_request_duration_seconds',
  apiRequests: 'geo_api_requests_total',
  auditWriteFailures: 'geo_audit_write_failures_total',
  outboxTerminalFailures: 'geo_outbox_terminal_failures_total',
  publishAttempts: 'geo_publish_attempts_total',
  queueActive: 'geo_queue_active_jobs',
  queueFailed: 'geo_queue_failed_jobs',
  queueLag: 'geo_queue_lag_jobs',
  queueLeaseRecoveries: 'geo_queue_lease_recoveries_total',
  queueOldestAge: 'geo_queue_oldest_job_age_seconds',
  queueRetries: 'geo_queue_retries_total',
} as const);

export type AiSchemaResult = 'success' | 'repaired' | 'failed';
export type PublishMetricStatus = 'success' | 'failed' | 'unknown';

export interface ApiRequestMetric {
  readonly latencyMs: number;
  readonly method: string;
  readonly route: string;
  readonly statusCode: number;
}

export interface QueueSnapshotMetric {
  readonly activeJobs: number;
  readonly failedJobs: number;
  readonly lagJobs: number;
  readonly oldestJobAgeSeconds: number;
  readonly queue: string;
}

export interface AiUsageMetric {
  readonly costCents: number;
  readonly model: string;
  readonly provider: string;
  readonly schemaResult: AiSchemaResult;
  readonly skill: string;
}

export interface PublishAttemptMetric {
  readonly platform: string;
  readonly status: PublishMetricStatus;
}

type Labels = Readonly<Record<string, string>>;

interface NumericSeries {
  readonly labels: Labels;
  value: number;
}

interface HistogramSeries {
  readonly labels: Labels;
  readonly buckets: number[];
  count: number;
  sum: number;
}

const API_DURATION_BUCKETS = Object.freeze([0.05, 0.1, 0.25, 0.5, 0.8, 1, 2, 5]);

export class GeoMetricsRegistry {
  private readonly aiCost = new Map<string, NumericSeries>();
  private readonly aiSchemaResults = new Map<string, NumericSeries>();
  private readonly apiDurations = new Map<string, HistogramSeries>();
  private readonly apiRequests = new Map<string, NumericSeries>();
  private readonly auditWriteFailures = new Map<string, NumericSeries>();
  private readonly outboxTerminalFailures = new Map<string, NumericSeries>();
  private readonly publishAttempts = new Map<string, NumericSeries>();
  private readonly queueActive = new Map<string, NumericSeries>();
  private readonly queueFailed = new Map<string, NumericSeries>();
  private readonly queueLag = new Map<string, NumericSeries>();
  private readonly queueLeaseRecoveries = new Map<string, NumericSeries>();
  private readonly queueOldestAge = new Map<string, NumericSeries>();
  private readonly queueRetries = new Map<string, NumericSeries>();

  public recordApiRequest(input: ApiRequestMetric): void {
    const latencySeconds = nonNegativeNumber(input.latencyMs, 'latencyMs') / 1_000;
    if (!Number.isInteger(input.statusCode) || input.statusCode < 100 || input.statusCode > 599) {
      throw new Error('statusCode must be an integer between 100 and 599');
    }
    const method = metricLabel(input.method.toUpperCase(), 'method');
    if (!/^[A-Z]+$/u.test(method)) throw new Error('method must contain only letters');
    const labels = {
      method,
      route: metricLabel(input.route, 'route'),
      status_class: `${Math.floor(input.statusCode / 100)}xx`,
      status_code: String(input.statusCode),
    };
    increment(this.apiRequests, labels, 1);
    observe(this.apiDurations, labels, latencySeconds, API_DURATION_BUCKETS);
  }

  public setQueueSnapshot(input: QueueSnapshotMetric): void {
    const labels = { queue: metricLabel(input.queue, 'queue') };
    setGauge(this.queueActive, labels, nonNegativeInteger(input.activeJobs, 'activeJobs'));
    setGauge(this.queueFailed, labels, nonNegativeInteger(input.failedJobs, 'failedJobs'));
    setGauge(this.queueLag, labels, nonNegativeInteger(input.lagJobs, 'lagJobs'));
    setGauge(
      this.queueOldestAge,
      labels,
      nonNegativeNumber(input.oldestJobAgeSeconds, 'oldestJobAgeSeconds'),
    );
  }

  public recordQueueRetry(queue: string, count = 1): void {
    increment(this.queueRetries, { queue: metricLabel(queue, 'queue') }, positiveInteger(count));
  }

  public recordQueueLeaseRecovery(queue: string, count = 1): void {
    increment(
      this.queueLeaseRecoveries,
      { queue: metricLabel(queue, 'queue') },
      positiveInteger(count),
    );
  }

  public recordAiUsage(input: AiUsageMetric): void {
    const labels = {
      model: metricLabel(input.model, 'model'),
      provider: metricLabel(input.provider, 'provider'),
      skill: metricLabel(input.skill, 'skill'),
    };
    increment(this.aiCost, labels, nonNegativeInteger(input.costCents, 'costCents'));
    increment(this.aiSchemaResults, { ...labels, result: input.schemaResult }, 1);
  }

  public recordPublishAttempt(input: PublishAttemptMetric): void {
    increment(
      this.publishAttempts,
      {
        platform: metricLabel(input.platform, 'platform'),
        status: input.status,
      },
      1,
    );
  }

  public recordAuditWriteFailure(risk: 'high' | 'normal'): void {
    increment(this.auditWriteFailures, { risk }, 1);
  }

  public recordOutboxTerminalFailure(eventType: string): void {
    increment(this.outboxTerminalFailures, { event_type: metricLabel(eventType, 'eventType') }, 1);
  }

  public render(): string {
    const lines = [
      ...renderCounter(
        OBSERVABILITY_METRIC_NAMES.apiRequests,
        'Completed API requests.',
        this.apiRequests,
      ),
      ...renderHistogram(
        OBSERVABILITY_METRIC_NAMES.apiDuration,
        'API request latency in seconds.',
        this.apiDurations,
        API_DURATION_BUCKETS,
      ),
      ...renderGauge(
        OBSERVABILITY_METRIC_NAMES.queueLag,
        'Jobs waiting in a queue.',
        this.queueLag,
      ),
      ...renderGauge(
        OBSERVABILITY_METRIC_NAMES.queueOldestAge,
        'Age of the oldest waiting job in seconds.',
        this.queueOldestAge,
      ),
      ...renderGauge(
        OBSERVABILITY_METRIC_NAMES.queueActive,
        'Jobs currently active in a queue.',
        this.queueActive,
      ),
      ...renderGauge(
        OBSERVABILITY_METRIC_NAMES.queueFailed,
        'Jobs currently in a failed queue state.',
        this.queueFailed,
      ),
      ...renderCounter(
        OBSERVABILITY_METRIC_NAMES.queueRetries,
        'Queue retries.',
        this.queueRetries,
      ),
      ...renderCounter(
        OBSERVABILITY_METRIC_NAMES.queueLeaseRecoveries,
        'Recovered queue processing leases.',
        this.queueLeaseRecoveries,
      ),
      ...renderCounter(OBSERVABILITY_METRIC_NAMES.aiCost, 'Settled AI cost in cents.', this.aiCost),
      ...renderCounter(
        OBSERVABILITY_METRIC_NAMES.aiSchemaResults,
        'AI structured output schema results.',
        this.aiSchemaResults,
      ),
      ...renderCounter(
        OBSERVABILITY_METRIC_NAMES.publishAttempts,
        'Platform publish attempts by terminal result.',
        this.publishAttempts,
      ),
      ...renderCounter(
        OBSERVABILITY_METRIC_NAMES.auditWriteFailures,
        'Audit event write failures.',
        this.auditWriteFailures,
      ),
      ...renderCounter(
        OBSERVABILITY_METRIC_NAMES.outboxTerminalFailures,
        'Outbox events that exhausted publish attempts.',
        this.outboxTerminalFailures,
      ),
    ];
    return `${lines.join('\n')}\n`;
  }
}

export const geoMetrics = new GeoMetricsRegistry();

export function createPrometheusMetricsHandler(registry: GeoMetricsRegistry = geoMetrics) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    if (request.method !== 'GET' || request.url?.split('?', 1)[0] !== '/metrics') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"not_found"}');
      return;
    }
    response.writeHead(200, { 'content-type': PROMETHEUS_CONTENT_TYPE });
    response.end(registry.render());
  };
}

function increment(store: Map<string, NumericSeries>, labels: Labels, value: number): void {
  const key = seriesKey(labels);
  const existing = store.get(key);
  if (existing) existing.value += value;
  else store.set(key, { labels, value });
}

function setGauge(store: Map<string, NumericSeries>, labels: Labels, value: number): void {
  store.set(seriesKey(labels), { labels, value });
}

function observe(
  store: Map<string, HistogramSeries>,
  labels: Labels,
  value: number,
  boundaries: readonly number[],
): void {
  const key = seriesKey(labels);
  let series = store.get(key);
  if (!series) {
    series = { buckets: boundaries.map(() => 0), count: 0, labels, sum: 0 };
    store.set(key, series);
  }
  series.count += 1;
  series.sum += value;
  boundaries.forEach((boundary, index) => {
    if (value <= boundary) series!.buckets[index]! += 1;
  });
}

function renderCounter(
  name: string,
  help: string,
  store: ReadonlyMap<string, NumericSeries>,
): string[] {
  return renderNumeric(name, help, 'counter', store);
}

function renderGauge(
  name: string,
  help: string,
  store: ReadonlyMap<string, NumericSeries>,
): string[] {
  return renderNumeric(name, help, 'gauge', store);
}

function renderNumeric(
  name: string,
  help: string,
  type: 'counter' | 'gauge',
  store: ReadonlyMap<string, NumericSeries>,
): string[] {
  return [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} ${type}`,
    ...sortedSeries(store).map((series) => `${name}${renderLabels(series.labels)} ${series.value}`),
  ];
}

function renderHistogram(
  name: string,
  help: string,
  store: ReadonlyMap<string, HistogramSeries>,
  boundaries: readonly number[],
): string[] {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} histogram`];
  for (const series of sortedSeries(store)) {
    boundaries.forEach((boundary, index) => {
      lines.push(
        `${name}_bucket${renderLabels({ ...series.labels, le: String(boundary) })} ${series.buckets[index]}`,
      );
    });
    lines.push(`${name}_bucket${renderLabels({ ...series.labels, le: '+Inf' })} ${series.count}`);
    lines.push(`${name}_sum${renderLabels(series.labels)} ${series.sum}`);
    lines.push(`${name}_count${renderLabels(series.labels)} ${series.count}`);
  }
  return lines;
}

function sortedSeries<T extends { readonly labels: Labels }>(store: ReadonlyMap<string, T>): T[] {
  return [...store.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

function seriesKey(labels: Labels): string {
  return JSON.stringify(
    Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function renderLabels(labels: Labels): string {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return '';
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}`;
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}

function metricLabel(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200) {
    throw new Error(`${name} must contain between 1 and 200 characters`);
  }
  return normalized;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('count must be a positive safe integer');
  }
  return value;
}

function nonNegativeNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
  return value;
}
