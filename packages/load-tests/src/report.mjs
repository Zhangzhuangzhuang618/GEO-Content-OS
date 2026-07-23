import { URL } from 'node:url';

export const LOAD_REPORT_SCHEMA = 'geo-load-report@1';

const THRESHOLDS = Object.freeze({
  apiP95Ms: 800,
  queueEnqueueP95Ms: 2_000,
  ragP95Ms: 800,
  workspaceCount: 100,
});

export function createLoadReport(summary, input) {
  const apiP95Ms = metricValue(summary, 'api_latency_ms', 'p(95)');
  const ragP95Ms = metricValue(summary, 'rag_latency_ms', 'p(95)');
  const queueEnqueueP95Ms = metricValue(summary, 'queue_enqueue_latency_ms', 'p(95)');
  const activeWorkspaceCount = metricValue(summary, 'workspace_coverage', 'count');
  const queueRecoveryCount = optionalMetricValue(summary, 'queue_recoveries', 'count') ?? 0;
  const queueRecoveryP95Ms = optionalMetricValue(summary, 'queue_recovery_latency_ms', 'p(95)');
  const requestsPerSecond = metricValue(summary, 'http_reqs', 'rate');
  const failedRequestRate = metricValue(summary, 'http_req_failed', 'rate');

  const gates = [
    gate('api_p95', apiP95Ms, THRESHOLDS.apiP95Ms, 'maximum'),
    gate('rag_p95', ragP95Ms, THRESHOLDS.ragP95Ms, 'maximum'),
    gate('queue_enqueue_p95', queueEnqueueP95Ms, THRESHOLDS.queueEnqueueP95Ms, 'maximum'),
    gate('active_workspaces', activeWorkspaceCount, THRESHOLDS.workspaceCount, 'exact'),
    gate('failed_request_rate', failedRequestRate, 0.01, 'maximum-exclusive'),
  ];

  if (input.queueRecoveryEnabled) {
    gates.push(gate('queue_recovery', queueRecoveryCount, 1, 'minimum'));
  }

  return Object.freeze({
    schema_version: LOAD_REPORT_SCHEMA,
    generated_at: input.generatedAt,
    mode: input.fixtureMode ? 'fixture-validation' : 'target',
    target: sanitizeTarget(input.target),
    workload: {
      active_workspace_count: activeWorkspaceCount,
      configured_workspace_count: THRESHOLDS.workspaceCount,
      duration: input.duration,
    },
    metrics: {
      api_p95_ms: apiP95Ms,
      failed_request_rate: failedRequestRate,
      queue_enqueue_p95_ms: queueEnqueueP95Ms,
      queue_recovery_count: queueRecoveryCount,
      queue_recovery_p95_ms: queueRecoveryP95Ms,
      rag_p95_ms: ragP95Ms,
      requests_per_second: requestsPerSecond,
    },
    gates,
    passed: gates.every((item) => item.passed),
    capacity_claim: input.fixtureMode
      ? 'none: fixture-validation only'
      : 'test-target only; production capacity requires production-like infrastructure',
  });
}

export function assertLoadReport(report) {
  if (report.schema_version !== LOAD_REPORT_SCHEMA)
    throw new Error('unsupported load report schema');
  const failed = report.gates.filter((gateResult) => !gateResult.passed);
  if (failed.length > 0) {
    throw new Error(`load gates failed: ${failed.map((item) => item.name).join(', ')}`);
  }
}

function metricValue(summary, metricName, valueName) {
  const value = optionalMetricValue(summary, metricName, valueName);
  if (value === undefined) throw new Error(`k6 summary is missing ${metricName}.${valueName}`);
  return value;
}

function optionalMetricValue(summary, metricName, valueName) {
  const value = summary?.metrics?.[metricName]?.values?.[valueName];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`k6 summary contains an invalid ${metricName}.${valueName}`);
  }
  return value;
}

function gate(name, actual, threshold, comparison) {
  let passed;
  if (comparison === 'maximum') passed = actual <= threshold;
  else if (comparison === 'maximum-exclusive') passed = actual < threshold;
  else if (comparison === 'minimum') passed = actual >= threshold;
  else passed = actual === threshold;
  return Object.freeze({ actual, comparison, name, passed, threshold });
}

function sanitizeTarget(target) {
  const url = new URL(target);
  return `${url.protocol}//${url.host}`;
}
