import assert from 'node:assert/strict';
import test from 'node:test';

import { K6_IMAGE, k6Environment, loadConfig } from '../src/config.mjs';

test('defaults to a short fixture validation with 100 workspaces', () => {
  const config = loadConfig({});
  assert.equal(config.fixtureMode, true);
  assert.equal(config.workspaceCount, 100);
  assert.equal(config.queueRecoveryEnabled, true);
  assert.equal(config.runtime, 'docker');
  assert.equal(K6_IMAGE, 'grafana/k6:2.0.0');
});

test('target mode keeps credentials out of configuration errors and disables synthetic recovery', () => {
  const config = loadConfig({
    LOAD_AUTH_TOKEN: 'secret-token',
    LOAD_BASE_URL: 'https://staging.example.test',
    LOAD_DURATION: '45s',
  });
  assert.equal(config.fixtureMode, false);
  assert.equal(config.queueRecoveryEnabled, false);
  assert.equal(config.duration, '45s');
  const environment = k6Environment(config, config.targetBaseUrl, '/tmp/summary.json');
  assert.equal(environment.AUTH_TOKEN, 'secret-token');
  assert.equal(environment.WORKSPACE_COUNT, '100');
});

test('rejects invalid runtime, paths, durations, and VU counts', () => {
  assert.throws(() => loadConfig({ K6_RUNTIME: 'remote' }), /docker or native/);
  assert.throws(() => loadConfig({ LOAD_API_PATH: 'api' }), /start with one slash/);
  assert.throws(() => loadConfig({ LOAD_DURATION: 'forever' }), /k6 duration/);
  assert.throws(() => loadConfig({ LOAD_RAG_VUS: '0' }), /positive integer/);
});
