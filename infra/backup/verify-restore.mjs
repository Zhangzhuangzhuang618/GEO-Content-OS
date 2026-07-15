import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const IMAGE = process.env.RESTORE_DRILL_POSTGRES_IMAGE ?? 'pgvector/pgvector:0.8.1-pg16';
const RPO_LIMIT_SECONDS = 15 * 60;
const RTO_LIMIT_SECONDS = 60 * 60;
const CONFIGURED_ARCHIVE_TIMEOUT_SECONDS = 5 * 60;
const id = randomUUID().replaceAll('-', '').slice(0, 12);
const prefix = `geo-restore-${id}`;
const sourceContainer = `${prefix}-source`;
const restoreContainer = `${prefix}-restore`;
const volumes = {
  archive: `${prefix}-archive`,
  backup: `${prefix}-backup`,
  restore: `${prefix}-restore-data`,
  source: `${prefix}-source-data`,
};
const backupScripts = fileURLToPath(new URL('.', import.meta.url));
const password = randomUUID();
const startedAt = new Date();
let backupDurationSeconds = 0;

try {
  requireDocker();
  run('docker', ['image', 'inspect', IMAGE]);
  for (const volume of Object.values(volumes)) run('docker', ['volume', 'create', volume]);
  for (const volume of [volumes.archive, volumes.backup, volumes.restore]) {
    run('docker', [
      'run',
      '--rm',
      '--user',
      '0',
      '--volume',
      `${volume}:/target`,
      IMAGE,
      'sh',
      '-ceu',
      'chown postgres:postgres /target',
    ]);
  }

  run('docker', [
    'run',
    '--detach',
    '--name',
    sourceContainer,
    '--env',
    `POSTGRES_PASSWORD=${password}`,
    '--volume',
    `${volumes.source}:/var/lib/postgresql/data`,
    '--volume',
    `${volumes.archive}:/var/lib/postgresql/wal-archive`,
    '--volume',
    `${volumes.backup}:/backup`,
    '--volume',
    `${backupScripts}:/opt/geo-backup:ro`,
    IMAGE,
    'postgres',
    '-c',
    'wal_level=replica',
    '-c',
    'archive_mode=on',
    '-c',
    `archive_timeout=${CONFIGURED_ARCHIVE_TIMEOUT_SECONDS}s`,
    '-c',
    'archive_command=test ! -f /var/lib/postgresql/wal-archive/%f && cp %p /var/lib/postgresql/wal-archive/%f',
  ]);
  waitForPostgres(sourceContainer);

  sql(
    sourceContainer,
    "CREATE TABLE restore_drill_markers (marker text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT clock_timestamp()); INSERT INTO restore_drill_markers(marker) VALUES ('baseline');",
  );

  const backupOutput = run('docker', [
    'exec',
    '--user',
    'postgres',
    '--env',
    'BACKUP_ROOT=/backup',
    '--env',
    'BACKUP_ID=base',
    '--env',
    'PGHOST=/var/run/postgresql',
    '--env',
    'PGUSER=postgres',
    '--env',
    'PGDATABASE=postgres',
    sourceContainer,
    '/opt/geo-backup/create-base-backup.sh',
  ]).stdout;
  backupDurationSeconds = numberFromOutput(backupOutput, 'BACKUP_DURATION_SECONDS');
  if (!backupOutput.includes('BACKUP_VERIFIED=true')) {
    throw new Error('Base backup verification marker is missing');
  }

  const archivedBefore = Number(
    sql(sourceContainer, 'SELECT archived_count FROM pg_stat_archiver;'),
  );
  sql(sourceContainer, "INSERT INTO restore_drill_markers(marker) VALUES ('post_backup');");
  sql(sourceContainer, 'SELECT pg_switch_wal();');
  waitForArchivedWal(sourceContainer, archivedBefore);
  const archiveFailures = Number(
    sql(sourceContainer, 'SELECT failed_count FROM pg_stat_archiver;'),
  );
  const archiveModeEnabled = sql(sourceContainer, 'SHOW archive_mode;') === 'on';
  const configuredRpoBoundSeconds = Number(
    sql(sourceContainer, "SELECT setting FROM pg_settings WHERE name = 'archive_timeout';"),
  );

  const restoreStartedAt = Date.now();
  run('docker', ['stop', '--time', '30', sourceContainer]);

  run('docker', [
    'run',
    '--rm',
    '--user',
    'postgres',
    '--env',
    'BACKUP_DIR=/backup/base',
    '--env',
    'RESTORE_DATA_DIR=/restore',
    '--env',
    'WAL_ARCHIVE_DIR=/var/lib/postgresql/wal-archive',
    '--volume',
    `${volumes.backup}:/backup:ro`,
    '--volume',
    `${volumes.restore}:/restore`,
    '--volume',
    `${volumes.archive}:/var/lib/postgresql/wal-archive:ro`,
    '--volume',
    `${backupScripts}:/opt/geo-backup:ro`,
    IMAGE,
    '/opt/geo-backup/prepare-restore.sh',
  ]);

  run('docker', [
    'run',
    '--detach',
    '--name',
    restoreContainer,
    '--volume',
    `${volumes.restore}:/var/lib/postgresql/data`,
    '--volume',
    `${volumes.archive}:/var/lib/postgresql/wal-archive:ro`,
    IMAGE,
    'postgres',
    '-c',
    'archive_mode=off',
  ]);
  waitForPostgres(restoreContainer);

  const recoveredMarkers = waitForRecoveredMarkers(restoreContainer);
  const rtoSeconds = roundSeconds(Date.now() - restoreStartedAt);
  const baselineRecovered = recoveredMarkers.includes('baseline');
  const postBackupRecovered = recoveredMarkers.includes('post_backup');
  const observedDataLossSeconds = postBackupRecovered ? 0 : RPO_LIMIT_SECONDS + 1;
  const completedAt = new Date();

  const evidence = {
    schema_version: 'restore-evidence@1',
    task_id: 'T137',
    mode: 'automated_local_container_drill',
    status: 'passed',
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    configured_rpo_bound_seconds: configuredRpoBoundSeconds,
    observed_data_loss_seconds: observedDataLossSeconds,
    rto_seconds: rtoSeconds,
    backup_duration_seconds: backupDurationSeconds,
    postgres_image: IMAGE,
    thresholds: { rpo_seconds: RPO_LIMIT_SECONDS, rto_seconds: RTO_LIMIT_SECONDS },
    checks: {
      archive_mode_enabled: archiveModeEnabled,
      backup_manifest_verified: true,
      baseline_transaction_recovered: baselineRecovered,
      post_backup_transaction_recovered: postBackupRecovered,
      wal_archived_without_failure: archiveFailures === 0,
    },
  };

  assertEvidence(evidence);
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (process.env.RESTORE_EVIDENCE_PATH) {
    writeFileSync(process.env.RESTORE_EVIDENCE_PATH, serialized, { encoding: 'utf8', mode: 0o600 });
  }
  process.stdout.write(`[RESTORE_DRILL_PASSED]\n${serialized}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[RESTORE_DRILL_FAILED] ${message}\n`);
  process.exitCode = 1;
} finally {
  run('docker', ['rm', '--force', sourceContainer, restoreContainer], { allowFailure: true });
  for (const volume of Object.values(volumes)) {
    run('docker', ['volume', 'rm', '--force', volume], { allowFailure: true });
  }
}

function requireDocker() {
  if (process.platform === 'win32') throw new Error('Restore drill requires a Unix Docker host');
  const result = run('docker', ['info', '--format', '{{.ServerVersion}}'], { allowFailure: true });
  if (result.status !== 0) throw new Error('Docker daemon is required for the restore drill');
}

function waitForPostgres(container) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = run(
      'docker',
      ['exec', '--user', 'postgres', container, 'pg_isready', '--username', 'postgres'],
      { allowFailure: true },
    );
    if (result.status === 0) return;
    pause(500);
  }
  const logs = run('docker', ['logs', container], { allowFailure: true });
  throw new Error(`PostgreSQL did not become ready: ${logs.stderr || logs.stdout}`);
}

function waitForArchivedWal(container, archivedBefore) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const archivedNow = Number(sql(container, 'SELECT archived_count FROM pg_stat_archiver;'));
    if (archivedNow > archivedBefore) return;
    pause(500);
  }
  throw new Error('Timed out waiting for WAL archival');
}

function waitForRecoveredMarkers(container) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = run(
      'docker',
      [
        'exec',
        '--user',
        'postgres',
        container,
        'psql',
        '--username',
        'postgres',
        '--dbname',
        'postgres',
        '--no-psqlrc',
        '--tuples-only',
        '--no-align',
        '--command',
        "SELECT string_agg(marker, ',' ORDER BY marker) FROM restore_drill_markers;",
      ],
      { allowFailure: true },
    );
    const markers = result.stdout.trim().split(',');
    if (markers.includes('baseline') && markers.includes('post_backup')) return markers;
    pause(500);
  }
  throw new Error('Timed out waiting for the restored WAL transaction');
}

function sql(container, statement) {
  return run('docker', [
    'exec',
    '--user',
    'postgres',
    container,
    'psql',
    '--username',
    'postgres',
    '--dbname',
    'postgres',
    '--no-psqlrc',
    '--tuples-only',
    '--no-align',
    '--command',
    statement,
  ]).stdout.trim();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: process.env });
  if (result.error && !options.allowFailure) throw result.error;
  const status = result.status ?? 1;
  if (status !== 0 && !options.allowFailure) {
    throw new Error(`${command} exited ${status}: ${(result.stderr || result.stdout).trim()}`);
  }
  return { status, stderr: result.stderr ?? '', stdout: result.stdout ?? '' };
}

function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function numberFromOutput(output, name) {
  const match = new RegExp(`^${name}=(\\d+)$`, 'mu').exec(output);
  if (!match) throw new Error(`${name} is missing from backup output`);
  return Number(match[1]);
}

function roundSeconds(milliseconds) {
  return Math.round((milliseconds / 1000) * 1000) / 1000;
}

function assertEvidence(evidence) {
  const checksPassed = Object.values(evidence.checks).every(Boolean);
  if (!checksPassed) throw new Error(`Restore checks failed: ${JSON.stringify(evidence.checks)}`);
  if (
    !Number.isFinite(evidence.configured_rpo_bound_seconds) ||
    evidence.configured_rpo_bound_seconds > RPO_LIMIT_SECONDS
  ) {
    throw new Error('Configured WAL archive timeout exceeds the RPO threshold');
  }
  if (evidence.observed_data_loss_seconds > RPO_LIMIT_SECONDS) {
    throw new Error('Observed data loss exceeds the RPO threshold');
  }
  if (evidence.rto_seconds > RTO_LIMIT_SECONDS) {
    throw new Error('Restore duration exceeds the RTO threshold');
  }
}
