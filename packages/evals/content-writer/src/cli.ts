import { CONTENT_WRITER_CONTRACT_V1 } from '@geo-content-os/skills/content-writer';

import { evaluateContentWriter } from './evaluator.js';
import { loadManifest } from './manifest.js';

async function main(): Promise<void> {
  const path = manifestPath(process.argv.slice(2));
  const report = evaluateContentWriter(
    await loadManifest(path),
    CONTENT_WRITER_CONTRACT_V1.fewShots,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

function manifestPath(arguments_: readonly string[]): string {
  if (arguments_.length !== 2 || arguments_[0] !== '--manifest' || !arguments_[1]) {
    throw new TypeError('Usage: --manifest FILE');
  }
  return arguments_[1];
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Content Writer evaluation failed: ${error instanceof Error ? error.message : 'Unknown error'}\n`,
  );
  process.exitCode = 1;
});
