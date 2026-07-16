import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { K6_IMAGE, k6Environment, loadConfig } from './config.mjs';
import { startFixtureServer } from './fixture-server.mjs';
import { assertLoadReport, createLoadReport } from './report.mjs';

const process = globalThis.process;
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

await main();

async function main() {
  const config = loadConfig(process.env);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'geo-load-tests-'));
  const hostSummaryPath = join(temporaryDirectory, 'k6-summary.json');
  let fixture;

  try {
    fixture = config.fixtureMode ? await startFixtureServer() : undefined;
    const targetBaseUrl = config.targetBaseUrl ?? `http://127.0.0.1:${fixture.port}`;
    const k6TargetBaseUrl =
      config.fixtureMode && config.runtime === 'docker'
        ? `http://host.docker.internal:${fixture.port}`
        : targetBaseUrl;
    const execution = await runK6(config, k6TargetBaseUrl, hostSummaryPath, temporaryDirectory);
    const summary = JSON.parse(await readFile(hostSummaryPath, 'utf8'));
    const report = createLoadReport(summary, {
      duration: config.duration,
      fixtureMode: config.fixtureMode,
      generatedAt: new Date().toISOString(),
      queueRecoveryEnabled: config.queueRecoveryEnabled,
      target: targetBaseUrl,
    });

    if (fixture && fixture.seenWorkspaceCount() !== config.workspaceCount) {
      throw new Error(
        `fixture observed ${fixture.seenWorkspaceCount()} workspaces, expected ${config.workspaceCount}`,
      );
    }

    const reportDirectory = join(packageRoot, 'reports');
    const reportPath = join(reportDirectory, 'load-report.json');
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    if (execution.exitCode !== 0) {
      throw new Error(`k6 exited with code ${execution.exitCode}; report: ${reportPath}`);
    }
    assertLoadReport(report);
    process.stdout.write(
      `Load test passed (${report.mode}): ${report.metrics.requests_per_second.toFixed(2)} req/s, report ${reportPath}\n`,
    );
  } finally {
    await fixture?.close();
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

async function runK6(config, baseUrl, hostSummaryPath, temporaryDirectory) {
  if (config.runtime === 'native') {
    return runCommand('k6', ['run', join(packageRoot, 'k6/load-test.js')], {
      ...process.env,
      ...k6Environment(config, baseUrl, hostSummaryPath),
    });
  }

  const containerSummaryPath = '/results/k6-summary.json';
  const environment = k6Environment(config, baseUrl, containerSummaryPath);
  const argumentsList = [
    'run',
    '--rm',
    '--add-host=host.docker.internal:host-gateway',
    '--volume',
    `${join(packageRoot, 'k6')}:/scripts:ro`,
    '--volume',
    `${temporaryDirectory}:/results`,
  ];
  for (const [name, value] of Object.entries(environment)) {
    argumentsList.push('--env', `${name}=${value}`);
  }
  argumentsList.push(K6_IMAGE, 'run', '/scripts/load-test.js');
  return runCommand('docker', argumentsList, process.env);
}

function runCommand(command, argumentsList, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, { env: environment, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => {
      if (signal) {
        reject(new Error(`${command} terminated by ${signal}`));
        return;
      }
      resolve({ exitCode: exitCode ?? 1 });
    });
  });
}
