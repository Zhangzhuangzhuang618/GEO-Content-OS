import { spawnSync } from 'node:child_process';

const selectors = process.argv.slice(2).filter((value) => value !== '--');
if (selectors.length === 0) {
  run(['test:unit']);
  run(['test:integration']);
  run(['test:e2e']);
  process.exit(0);
}

if (selectors.length === 1 && selectors[0] === 'parsers') {
  run(['--filter', '@geo-content-os/parsers', 'test']);
  process.exit(0);
}

if (selectors.length === 1 && selectors[0] === 'ocr-adapter') {
  run(['--filter', '@geo-content-os/adapter-ocr', 'test']);
  process.exit(0);
}

if (selectors.length === 1 && selectors[0] === 'rerank') {
  run(['--filter', '@geo-content-os/adapter-rerank', 'test']);
  run(['--filter', '@geo-content-os/api', 'test:rerank']);
  process.exit(0);
}

process.stderr.write(`Unknown test selector: ${selectors.join(' ')}\n`);
process.exit(2);

function run(arguments_) {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = spawnSync(command, arguments_, {
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
