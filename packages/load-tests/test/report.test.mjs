import assert from 'node:assert/strict';
import test from 'node:test';

import { assertLoadReport, createLoadReport, LOAD_REPORT_SCHEMA } from '../src/report.mjs';

test('builds a passing report for all frozen load gates', () => {
  const report = createLoadReport(summary(), {
    duration: '3s',
    fixtureMode: true,
    generatedAt: '2026-07-16T00:00:00.000Z',
    queueRecoveryEnabled: true,
    target: 'http://127.0.0.1:3000/private?token=secret',
  });
  assert.equal(report.schema_version, LOAD_REPORT_SCHEMA);
  assert.equal(report.target, 'http://127.0.0.1:3000');
  assert.equal(report.capacity_claim, 'none: fixture-validation only');
  assert.equal(report.passed, true);
  assert.doesNotThrow(() => assertLoadReport(report));
});

test('fails when API P95 exceeds the frozen 800ms threshold', () => {
  const input = summary();
  input.metrics.api_latency_ms.values['p(95)'] = 801;
  const report = createLoadReport(input, {
    duration: '30s',
    fixtureMode: false,
    generatedAt: '2026-07-16T00:00:00.000Z',
    queueRecoveryEnabled: false,
    target: 'https://staging.example.test',
  });
  assert.equal(report.passed, false);
  assert.throws(() => assertLoadReport(report), /api_p95/);
});

test('requires exactly 100 active workspaces', () => {
  const input = summary();
  input.metrics.workspace_coverage.values.count = 99;
  const report = createLoadReport(input, {
    duration: '3s',
    fixtureMode: true,
    generatedAt: '2026-07-16T00:00:00.000Z',
    queueRecoveryEnabled: true,
    target: 'http://127.0.0.1:3000',
  });
  assert.throws(() => assertLoadReport(report), /active_workspaces/);
});

function summary() {
  return {
    metrics: {
      api_latency_ms: { values: { 'p(95)': 100 } },
      http_req_failed: { values: { rate: 0 } },
      http_reqs: { values: { rate: 250 } },
      queue_enqueue_latency_ms: { values: { 'p(95)': 200 } },
      queue_recoveries: { values: { count: 1 } },
      queue_recovery_latency_ms: { values: { 'p(95)': 120 } },
      rag_latency_ms: { values: { 'p(95)': 300 } },
      workspace_coverage: { values: { count: 100 } },
    },
  };
}
