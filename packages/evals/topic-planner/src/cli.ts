import { TOPIC_PLANNER_CONTRACT_V1 } from '@geo-content-os/skills/topic-planner';

import { evaluateTopicPlanner } from './evaluator.js';
import { loadManifest } from './manifest.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--manifest' || !args[1]) {
    throw new TypeError('Usage: --manifest FILE');
  }
  const report = evaluateTopicPlanner(
    await loadManifest(args[1]),
    TOPIC_PLANNER_CONTRACT_V1.fewShots,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Topic Planner evaluation failed: ${error instanceof Error ? error.message : 'Unknown error'}\n`,
  );
  process.exitCode = 1;
});
