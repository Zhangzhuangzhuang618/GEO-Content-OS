import { spawnSync } from 'node:child_process';

const aliases = new Map([
  ['identity', ['apps/api/test/e2e/identity']],
  ['system', ['apps/api/test/e2e/system', 'apps/web/test/e2e/system']],
  ['workspace', ['apps/api/test/e2e/workspace']],
]);
const selectors = process.argv
  .slice(2)
  .filter((argument) => argument !== '--')
  .flatMap((argument) => aliases.get(argument) ?? [argument]);
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const result = spawnSync(pnpm, ['exec', 'playwright', 'test', ...selectors], {
  stdio: 'inherit',
});

if (result.error) {
  console.error(`[E2E_RUNNER_FAILED] ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
