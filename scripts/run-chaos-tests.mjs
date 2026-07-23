import { spawnSync } from 'node:child_process';

const selectors = process.argv.slice(2).filter((value) => value !== '--');
if (selectors.length > 1 || (selectors.length === 1 && selectors[0] !== 'outbox')) {
  console.error('Usage: pnpm test:chaos -- outbox');
  process.exit(1);
}

const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const result = spawnSync(command, ['--filter', 'worker-outbox-relay', 'test:chaos'], {
  env: process.env,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
