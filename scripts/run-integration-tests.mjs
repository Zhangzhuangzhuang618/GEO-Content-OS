import { spawnSync } from 'node:child_process';

const selectors = process.argv.slice(2).filter((value) => value !== '--');
if (selectors.length === 1 && selectors[0] === 'deepseek-adapter') {
  run(['--filter', '@geo-content-os/adapter-model-deepseek', 'test:integration']);
  process.exit(0);
}

run(['--filter', 'api', 'test:integration', '--', ...selectors]);

function run(arguments_) {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = spawnSync(command, arguments_, { env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
