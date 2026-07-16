import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = readJson(join(root, 'docs/release/release-manifest.json'));
const commands = [
  ['feature_flags', ['feature-flags:check']],
  ['openapi', ['verify:openapi']],
  ['database', ['db:verify:fresh']],
  ['ai_evaluations', ['eval:all']],
  ['cost_regression', ['--filter', '@geo-content-os/api', 'test', '--', 'brief-cost-estimator']],
  ['security', ['test:security']],
  ['outbox_recovery', ['test:chaos', '--', 'outbox']],
  ['accessibility', ['test:a11y']],
  ['load', ['test:load']],
  ['restore', ['verify:restore']],
  ['system_e2e', ['test:e2e', '--', 'system']],
  ['observability', ['verify:observability']],
];

assertStaticFreeze(manifest, commands);
for (const [id, arguments_] of commands) runGate(id, arguments_);
process.stdout.write(`[RELEASE_CHECK_PASSED] ${commands.length} release gates passed for v2.1.\n`);

function assertStaticFreeze(value, expectedCommands) {
  if (
    !record(value) ||
    value.schema_version !== 'release-manifest@1' ||
    value.release !== 'v2.1' ||
    value.baseline_date !== '2026-07-15' ||
    value.development_freeze !== 'automated_gate_required' ||
    value.production_release !== 'not_authorized' ||
    !record(value.task_range) ||
    value.task_range.first !== 'T001' ||
    value.task_range.last !== 'T144' ||
    value.task_range.count !== 144 ||
    value.rollout_manifest !== 'infra/feature-flags/platform-rollout.v1.json'
  ) {
    fail('release manifest metadata is invalid');
  }

  if (!record(value.frozen_documents) || Object.keys(value.frozen_documents).length !== 5) {
    fail('release manifest must bind all five frozen documents');
  }
  for (const [name, expectedHash] of Object.entries(value.frozen_documents)) {
    if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedHash)) {
      fail(`invalid frozen document hash for ${name}`);
    }
    const actualHash = sha256(readFileSync(join(root, 'docs/freeze-v2.1', name)));
    if (actualHash !== expectedHash) fail(`frozen document drift detected: ${name}`);
  }

  const gates = Array.isArray(value.gates) ? value.gates : [];
  if (gates.length !== expectedCommands.length) fail('release gate count is incomplete');
  for (const [id, arguments_] of expectedCommands) {
    const gate = gates.find((candidate) => record(candidate) && candidate.id === id);
    const expected = `pnpm ${arguments_.join(' ')}`;
    if (!record(gate) || gate.command !== expected || typeof gate.category !== 'string') {
      fail(`release gate ${id} is missing or changed`);
    }
  }

  const context = readFileSync(join(root, 'PROJECT_CONTEXT.md'), 'utf8');
  for (const invariant of [
    '冻结表数：57',
    '冻结页面数：32',
    '当前可执行端点数为 121',
    '任务固定 T001-T144，共 144 个',
    'material-parser',
    'content-writer',
    'fact-checker',
    'topic-planner',
    'geo-optimizer',
    'quality-checker',
  ]) {
    if (!context.includes(invariant)) fail(`PROJECT_CONTEXT invariant missing: ${invariant}`);
  }
  process.stdout.write('[RELEASE_STATIC_VALID] Frozen hashes, scope and gate manifest match.\n');
}

function runGate(id, arguments_) {
  process.stdout.write(`\n[RELEASE_GATE_START] ${id}: pnpm ${arguments_.join(' ')}\n`);
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = spawnSync(command, arguments_, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.signal) fail(`release gate ${id} terminated by ${result.signal}`);
  if (result.status !== 0) fail(`release gate ${id} failed with code ${result.status ?? 1}`);
  process.stdout.write(`[RELEASE_GATE_PASSED] ${id}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message) {
  process.stderr.write(`[RELEASE_CHECK_FAILED] ${message}\n`);
  process.exit(1);
}
