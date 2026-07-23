import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(directory, '../..');
const files = {
  alerts: join(directory, 'prometheus/alerts.yml'),
  compose: join(directory, 'compose.yaml'),
  dashboard: join(directory, 'grafana/dashboards/geo-content-os-overview.json'),
  dashboardProvider: join(directory, 'grafana/provisioning/dashboards/dashboards.yaml'),
  dataSources: join(directory, 'grafana/provisioning/datasources/datasources.yaml'),
  loki: join(directory, 'loki/config.yaml'),
  metrics: join(repository, 'packages/observability/src/metrics.ts'),
  otel: join(directory, 'otel-collector.yaml'),
  prometheus: join(directory, 'prometheus/prometheus.yml'),
};
const contents = Object.fromEntries(
  Object.entries(files).map(([name, path]) => [name, readFileSync(path, 'utf8')]),
);
const dashboard = JSON.parse(contents.dashboard);

assert(!contents.compose.includes(':latest'), 'observability images must be pinned');
for (const image of [
  'otel/opentelemetry-collector-contrib:0.153.0',
  'prom/prometheus:v3.11.0',
  'grafana/loki:3.7.2',
  'grafana/grafana:13.1.0',
]) {
  assert(contents.compose.includes(image), `missing pinned image ${image}`);
}

const metricNames = [
  'geo_api_requests_total',
  'geo_api_request_duration_seconds',
  'geo_queue_lag_jobs',
  'geo_queue_oldest_job_age_seconds',
  'geo_queue_active_jobs',
  'geo_queue_failed_jobs',
  'geo_queue_retries_total',
  'geo_queue_lease_recoveries_total',
  'geo_ai_cost_cents_total',
  'geo_ai_schema_results_total',
  'geo_publish_attempts_total',
  'geo_audit_write_failures_total',
  'geo_outbox_terminal_failures_total',
];
for (const metric of metricNames) {
  assert(contents.metrics.includes(metric), `metrics package is missing ${metric}`);
}
for (const forbiddenLabel of [
  'tenant_id',
  'user_id',
  'account_id',
  'request_id',
  'job_id',
  'run_id',
]) {
  assert(
    !contents.metrics.includes(`${forbiddenLabel}: metricLabel`),
    `high-cardinality label ${forbiddenLabel} must not be used`,
  );
}

const alertNames = [
  'GeoApiErrorRateHigh',
  'GeoApiLatencyP95High',
  'GeoQueueLagHigh',
  'GeoAiCostSpike',
  'GeoAiSchemaFailureRateHigh',
  'GeoPublishSuccessRateLow',
  'GeoPublishUnknown',
  'GeoAuditWriteFailure',
  'GeoOutboxTerminalFailure',
];
for (const alert of alertNames) {
  assert(contents.alerts.includes(`alert: ${alert}`), `missing alert ${alert}`);
}
for (const threshold of ['> 0.02', '> 0.8', '> 1000', '> 300', '1.15', '> 0.01', '< 0.95']) {
  assert(contents.alerts.includes(threshold), `missing frozen threshold ${threshold}`);
}

const expressions = dashboard.panels.flatMap((panel) =>
  (panel.targets ?? []).map((target) => target.expr ?? ''),
);
assert(dashboard.uid === 'geo-content-os-overview', 'dashboard UID is not stable');
assert(dashboard.panels.length >= 7, 'dashboard must cover the primary and alert signals');
for (const metric of [
  'geo_api_request_duration_seconds_bucket',
  'geo_queue_lag_jobs',
  'geo_ai_cost_cents_total',
  'geo_publish_attempts_total',
]) {
  assert(
    expressions.some((expression) => expression.includes(metric)),
    `dashboard missing ${metric}`,
  );
}

assert(
  contents.prometheus.includes('/etc/prometheus/alerts.yml'),
  'Prometheus rules are not loaded',
);
assert(
  contents.prometheus.includes('otel-collector:8889'),
  'Prometheus does not scrape OTLP metrics',
);
assert(contents.otel.includes('exporters: [prometheus]'), 'OTel metrics are not exported');
assert(contents.otel.includes('exporters: [otlphttp/loki]'), 'OTel logs are not exported to Loki');
assert(
  contents.dataSources.includes('uid: prometheus'),
  'Grafana Prometheus datasource is missing',
);
assert(contents.dataSources.includes('uid: loki'), 'Grafana Loki datasource is missing');
assert(
  contents.dashboardProvider.includes('/var/lib/grafana/dashboards'),
  'dashboard provider is missing',
);
assert(contents.loki.includes('schema: v13'), 'Loki TSDB schema is not pinned');

stdout.write(
  `Observability verification passed: ${metricNames.length} metrics, ${alertNames.length} alerts, ${dashboard.panels.length} panels.\n`,
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
