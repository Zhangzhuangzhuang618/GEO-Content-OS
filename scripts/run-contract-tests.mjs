import { spawnSync } from 'node:child_process';

const selectors = process.argv.slice(2).filter((value) => value !== '--');

if (selectors.length === 1 && selectors[0] === 'publishing') {
  run([
    '--filter',
    '@geo-content-os/contracts',
    'exec',
    'vitest',
    'run',
    'src/api/publishing/publishing.contract.test.ts',
  ]);
  run(['--filter', '@geo-content-os/api', 'build:test-dependencies']);
  run([
    '--filter',
    '@geo-content-os/api',
    'exec',
    'vitest',
    'run',
    '--config',
    'vitest.config.ts',
    'src/modules/publishing/publishing.contract.test.ts',
    'src/modules/publishing/api/publishing-api.mock.e2e.test.ts',
  ]);
  process.exit(0);
}

run(['--filter', '@geo-content-os/contracts', 'test:contract']);
run(['--filter', '@geo-content-os/api', 'test:contract']);
run(['--filter', '@geo-content-os/adapter-platforms', 'test:contract']);

function run(arguments_) {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = spawnSync(command, arguments_, { env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
