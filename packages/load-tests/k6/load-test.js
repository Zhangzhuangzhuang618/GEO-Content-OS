import http from 'k6/http';
import { check, sleep } from 'k6';
import execution from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';

const environment = globalThis.__ENV;
const WORKSPACE_COUNT = integer(environment.WORKSPACE_COUNT, 100);
const BASE_URL = required(environment.BASE_URL).replace(/\/$/, '');
const API_PATH = path(environment.API_PATH, '/load/api');
const RAG_PATH = path(environment.RAG_PATH, '/load/rag');
const QUEUE_PATH = path(environment.QUEUE_PATH, '/load/queue');
const QUEUE_RECOVERY_PATH = path(environment.QUEUE_RECOVERY_PATH, '/load/queue/recovery');
const QUEUE_RECOVERY_ENABLED = environment.QUEUE_RECOVERY_ENABLED === 'true';

const apiLatency = new Trend('api_latency_ms', true);
const ragLatency = new Trend('rag_latency_ms', true);
const queueEnqueueLatency = new Trend('queue_enqueue_latency_ms', true);
const queueRecoveryLatency = new Trend('queue_recovery_latency_ms', true);
const loadFailures = new Rate('load_failures');
const workspaceCoverage = new Counter('workspace_coverage');
const queueRecoveries = new Counter('queue_recoveries');
const expectedTemporaryQueueFailure = http.expectedStatuses(503);

const scenarios = {
  workspace_coverage: {
    executor: 'shared-iterations',
    exec: 'coverWorkspace',
    vus: WORKSPACE_COUNT,
    iterations: WORKSPACE_COUNT,
    maxDuration: '30s',
  },
  api: {
    executor: 'constant-vus',
    exec: 'apiLoad',
    vus: integer(environment.API_VUS, 10),
    duration: duration(environment.LOAD_DURATION, '3s'),
    startTime: '1s',
  },
  rag: {
    executor: 'constant-vus',
    exec: 'ragLoad',
    vus: integer(environment.RAG_VUS, 5),
    duration: duration(environment.LOAD_DURATION, '3s'),
    startTime: '1s',
  },
  queue: {
    executor: 'constant-vus',
    exec: 'queueLoad',
    vus: integer(environment.QUEUE_VUS, 5),
    duration: duration(environment.LOAD_DURATION, '3s'),
    startTime: '1s',
  },
};

if (QUEUE_RECOVERY_ENABLED) {
  scenarios.queue_recovery = {
    executor: 'shared-iterations',
    exec: 'queueRecoveryProbe',
    vus: 1,
    iterations: 1,
    maxDuration: '30s',
    startTime: '1s',
  };
}

const thresholds = {
  api_latency_ms: ['p(95)<800'],
  rag_latency_ms: ['p(95)<800'],
  queue_enqueue_latency_ms: ['p(95)<2000'],
  http_req_failed: ['rate<0.01'],
  load_failures: ['rate<0.01'],
  workspace_coverage: [`count==${WORKSPACE_COUNT}`],
};

if (QUEUE_RECOVERY_ENABLED) {
  thresholds.queue_recoveries = ['count>=1'];
  thresholds.queue_recovery_latency_ms = ['p(95)<5000'];
}

export const options = {
  discardResponseBodies: true,
  scenarios,
  thresholds,
};

export function coverWorkspace() {
  const workspaceId = workspaceForIndex(execution.scenario.iterationInTest);
  const response = http.get(`${BASE_URL}${API_PATH}`, {
    headers: headers(workspaceId),
    tags: { operation: 'workspace_coverage' },
  });
  const passed = check(response, {
    'workspace endpoint accepted': (value) => value.status === 200,
  });
  loadFailures.add(!passed);
  if (passed) workspaceCoverage.add(1);
}

export function apiLoad() {
  const workspaceId = workspaceForVirtualUser();
  const response = http.get(`${BASE_URL}${API_PATH}`, {
    headers: headers(workspaceId),
    tags: { operation: 'api' },
  });
  apiLatency.add(response.timings.duration);
  record(response, 'API returned 200', 200);
  sleep(0.05);
}

export function ragLoad() {
  const workspaceId = workspaceForVirtualUser();
  const response = http.post(
    `${BASE_URL}${RAG_PATH}`,
    JSON.stringify({ query: '企业 GEO 内容策略', workspace_id: workspaceId }),
    { headers: headers(workspaceId), tags: { operation: 'rag' } },
  );
  ragLatency.add(response.timings.duration);
  record(response, 'RAG returned 200', 200);
  sleep(0.05);
}

export function queueLoad() {
  const workspaceId = workspaceForVirtualUser();
  const response = http.post(
    `${BASE_URL}${QUEUE_PATH}`,
    JSON.stringify({ task: 'load-test', workspace_id: workspaceId }),
    {
      headers: headers(workspaceId, idempotencyKey('queue')),
      tags: { operation: 'queue_enqueue' },
    },
  );
  queueEnqueueLatency.add(response.timings.duration);
  record(response, 'queue accepted write', 202);
  sleep(0.05);
}

export function queueRecoveryProbe() {
  const workspaceId = 'workspace-000';
  const key = idempotencyKey('recovery');
  const requestParameters = {
    headers: headers(workspaceId, key),
    responseCallback: expectedTemporaryQueueFailure,
    tags: { operation: 'queue_recovery' },
  };
  const startedAt = Date.now();
  const first = http.post(
    `${BASE_URL}${QUEUE_RECOVERY_PATH}`,
    JSON.stringify({ task: 'recovery-probe', workspace_id: workspaceId }),
    requestParameters,
  );
  const faultObserved = check(first, {
    'queue recovery probe observed temporary failure': (value) => value.status === 503,
  });
  sleep(0.1);
  const recovered = http.post(
    `${BASE_URL}${QUEUE_RECOVERY_PATH}`,
    JSON.stringify({ task: 'recovery-probe', workspace_id: workspaceId }),
    {
      headers: requestParameters.headers,
      tags: requestParameters.tags,
    },
  );
  const recoveryObserved = check(recovered, {
    'queue recovery probe was accepted after retry': (value) => value.status === 202,
  });
  queueRecoveryLatency.add(Date.now() - startedAt);
  loadFailures.add(!faultObserved || !recoveryObserved);
  if (faultObserved && recoveryObserved) queueRecoveries.add(1);
}

export function handleSummary(data) {
  return { [required(environment.SUMMARY_PATH)]: JSON.stringify(data, null, 2) };
}

function record(response, name, expectedStatus) {
  const passed = check(response, { [name]: (value) => value.status === expectedStatus });
  loadFailures.add(!passed);
}

function headers(workspaceId, idempotency) {
  const values = {
    'Content-Type': 'application/json',
    'X-Load-Workspace': workspaceId,
  };
  if (environment.AUTH_TOKEN) values.Authorization = `Bearer ${environment.AUTH_TOKEN}`;
  if (environment.SESSION_COOKIE) values.Cookie = environment.SESSION_COOKIE;
  if (environment.CSRF_TOKEN) values['X-CSRF-Token'] = environment.CSRF_TOKEN;
  if (idempotency) values['Idempotency-Key'] = idempotency;
  return values;
}

function workspaceForVirtualUser() {
  const virtualUser = Number(globalThis.__VU);
  const index = (virtualUser - 1) % WORKSPACE_COUNT;
  return workspaceForIndex(index);
}

function workspaceForIndex(index) {
  return `workspace-${String(index).padStart(3, '0')}`;
}

function idempotencyKey(prefix) {
  return `${prefix}-${globalThis.__VU}-${globalThis.__ITER}`;
}

function integer(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('k6 integer option is invalid');
  return parsed;
}

function duration(value, fallback) {
  const result = value || fallback;
  if (!/^\d+(?:ms|s|m)$/.test(result)) throw new Error('k6 duration option is invalid');
  return result;
}

function path(value, fallback) {
  const result = value || fallback;
  if (!result.startsWith('/') || result.startsWith('//')) throw new Error('k6 path is invalid');
  return result;
}

function required(value) {
  if (!value) throw new Error('required k6 environment value is missing');
  return value;
}
