const FIXED_WORKSPACE_COUNT = 100;

export const K6_IMAGE = 'grafana/k6:2.0.0';

export function loadConfig(environment = {}) {
  const targetBaseUrl = optionalText(environment.LOAD_BASE_URL);
  const fixtureMode = targetBaseUrl === undefined;
  const runtime = optionalText(environment.K6_RUNTIME) ?? 'docker';

  if (runtime !== 'docker' && runtime !== 'native') {
    throw new Error('K6_RUNTIME must be docker or native');
  }

  return Object.freeze({
    apiPath: pathValue(environment.LOAD_API_PATH, '/load/api'),
    apiVus: positiveInteger(environment.LOAD_API_VUS, fixtureMode ? 10 : 20, 'LOAD_API_VUS'),
    authToken: optionalText(environment.LOAD_AUTH_TOKEN),
    csrfToken: optionalText(environment.LOAD_CSRF_TOKEN),
    duration: durationValue(environment.LOAD_DURATION, fixtureMode ? '3s' : '30s'),
    fixtureMode,
    queuePath: pathValue(environment.LOAD_QUEUE_PATH, '/load/queue'),
    queueRecoveryEnabled: booleanValue(
      environment.LOAD_QUEUE_RECOVERY_ENABLED,
      fixtureMode,
      'LOAD_QUEUE_RECOVERY_ENABLED',
    ),
    queueRecoveryPath: pathValue(environment.LOAD_QUEUE_RECOVERY_PATH, '/load/queue/recovery'),
    queueVus: positiveInteger(environment.LOAD_QUEUE_VUS, fixtureMode ? 5 : 10, 'LOAD_QUEUE_VUS'),
    ragPath: pathValue(environment.LOAD_RAG_PATH, '/load/rag'),
    ragVus: positiveInteger(environment.LOAD_RAG_VUS, fixtureMode ? 5 : 10, 'LOAD_RAG_VUS'),
    runtime,
    sessionCookie: optionalText(environment.LOAD_SESSION_COOKIE),
    targetBaseUrl,
    workspaceCount: FIXED_WORKSPACE_COUNT,
  });
}

export function k6Environment(config, baseUrl, summaryPath) {
  return compactEntries({
    API_PATH: config.apiPath,
    API_VUS: String(config.apiVus),
    AUTH_TOKEN: config.authToken,
    BASE_URL: baseUrl,
    CSRF_TOKEN: config.csrfToken,
    LOAD_DURATION: config.duration,
    LOAD_MODE: config.fixtureMode ? 'fixture-validation' : 'target',
    QUEUE_PATH: config.queuePath,
    QUEUE_RECOVERY_ENABLED: String(config.queueRecoveryEnabled),
    QUEUE_RECOVERY_PATH: config.queueRecoveryPath,
    QUEUE_VUS: String(config.queueVus),
    RAG_PATH: config.ragPath,
    RAG_VUS: String(config.ragVus),
    SESSION_COOKIE: config.sessionCookie,
    SUMMARY_PATH: summaryPath,
    WORKSPACE_COUNT: String(config.workspaceCount),
  });
}

function optionalText(value) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function pathValue(value, fallback) {
  const normalized = optionalText(value) ?? fallback;
  if (!normalized.startsWith('/') || normalized.startsWith('//')) {
    throw new Error('load test paths must start with one slash');
  }
  return normalized;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function durationValue(value, fallback) {
  const normalized = optionalText(value) ?? fallback;
  if (!/^\d+(?:ms|s|m)$/.test(normalized)) {
    throw new Error('LOAD_DURATION must be a positive k6 duration such as 30s or 2m');
  }
  return normalized;
}

function booleanValue(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function compactEntries(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}
