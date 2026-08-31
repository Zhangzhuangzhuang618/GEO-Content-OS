import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const staticOnly = process.argv.includes('--static-only');
const executableBaseline = Object.freeze({
  currentTableCount: 92,
  frozenPageCount: 32,
  frozenTableCount: 57,
  latestMigration: '0054_enterprise_evidence_customer_copy',
  previousMigration: '0053_douyin_image_note_automation',
  publicEndpointCount: 170,
  skills: Object.freeze([
    'material-parser',
    'content-writer',
    'fact-checker',
    'topic-planner',
    'geo-optimizer',
    'quality-checker',
  ]),
});
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
if (staticOnly) {
  process.stdout.write('[RELEASE_CHECK_PASSED] Static release gate passed for v2.1/T161.\n');
} else {
  for (const [id, arguments_] of commands) runGate(id, arguments_);
  process.stdout.write(
    `[RELEASE_CHECK_PASSED] ${commands.length} release gates passed for v2.1.\n`,
  );
}

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

  assertMigrationBaseline();
  assertApiBaseline();
  assertPageBaseline();
  assertSkillBaseline();
  process.stdout.write(
    '[RELEASE_STATIC_VALID] Frozen hashes, scope, executable baselines and gate manifest match.\n',
  );
}

function assertMigrationBaseline() {
  const migrationsDirectory = join(root, 'apps/api/src/database/migrations');
  const migrationFiles = readdirSync(migrationsDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
  const journal = readJson(join(migrationsDirectory, 'meta/_journal.json'));
  const entries = Array.isArray(journal.entries) ? journal.entries : [];
  const journalTags = entries.map((entry, index) => {
    if (!record(entry) || entry.idx !== index || typeof entry.tag !== 'string') {
      fail('migration journal order or index is invalid');
    }
    return entry.tag;
  });
  const fileTags = migrationFiles.map((name) => name.replace(/\.sql$/u, ''));
  if (JSON.stringify(journalTags) !== JSON.stringify(fileTags)) {
    fail('migration files and journal are out of sync');
  }

  const latestTags = journalTags.slice(-2);
  if (
    latestTags[0] !== executableBaseline.previousMigration ||
    latestTags[1] !== executableBaseline.latestMigration
  ) {
    fail('current migration baseline must end with 0053 followed by 0054');
  }

  const frozenMigrationIndex = migrationFiles.indexOf('0030_freeze_v21.sql');
  if (frozenMigrationIndex < 0) fail('frozen v2.1 migration 0030 is missing');
  const frozenTableCount = countCreatedTables(
    migrationsDirectory,
    migrationFiles.slice(0, frozenMigrationIndex + 1),
  );
  const currentTableCount = countCreatedTables(migrationsDirectory, migrationFiles);
  if (frozenTableCount !== executableBaseline.frozenTableCount) {
    fail(`frozen database baseline must create ${executableBaseline.frozenTableCount} tables`);
  }
  if (currentTableCount !== executableBaseline.currentTableCount) {
    fail(`current database baseline must create ${executableBaseline.currentTableCount} tables`);
  }
}

function countCreatedTables(directory, migrationFiles) {
  return migrationFiles.reduce((count, name) => {
    const migration = readFileSync(join(directory, name), 'utf8');
    const createTableStatements =
      migration.match(/^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/gimu) ?? [];
    return count + createTableStatements.length;
  }, 0);
}

function assertApiBaseline() {
  const openapi = readJson(join(root, 'apps/api/openapi/openapi.json'));
  const paths = record(openapi.paths) ? openapi.paths : {};
  const methods = new Set(['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'trace']);
  let operationCount = 0;
  for (const pathItem of Object.values(paths)) {
    if (!record(pathItem)) continue;
    operationCount += Object.keys(pathItem).filter((key) => methods.has(key)).length;
  }
  if (operationCount !== executableBaseline.publicEndpointCount) {
    fail(
      `current OpenAPI baseline must expose ${executableBaseline.publicEndpointCount} endpoints`,
    );
  }
}

function assertPageBaseline() {
  const source = readFileSync(join(root, 'apps/web/test/a11y/core-pages.ts'), 'utf8');
  const pageCodes = [...source.matchAll(/\bcode:\s*'([A-Z]+-\d{2})'/gu)].map((match) => match[1]);
  if (
    pageCodes.length !== executableBaseline.frozenPageCount ||
    new Set(pageCodes).size !== executableBaseline.frozenPageCount
  ) {
    fail(`frozen page baseline must contain ${executableBaseline.frozenPageCount} unique pages`);
  }
}

function assertSkillBaseline() {
  for (const skill of executableBaseline.skills) {
    if (
      !existsSync(join(root, 'packages/contracts/src/skills', skill)) ||
      !existsSync(join(root, 'packages/skills', skill))
    ) {
      fail(`frozen skill baseline is missing: ${skill}`);
    }
  }
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
