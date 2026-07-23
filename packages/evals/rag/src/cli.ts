import { compareBaseline } from './baseline.js';
import { evaluateRag } from './evaluator.js';
import { loadBaseline, loadDataset, loadPredictions } from './io.js';

interface CliArguments {
  readonly baseline: string;
  readonly dataset: string;
  readonly predictions: string;
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  const [{ dataset, sha256 }, predictions, baseline] = await Promise.all([
    loadDataset(arguments_.dataset),
    loadPredictions(arguments_.predictions),
    loadBaseline(arguments_.baseline),
  ]);
  const report = evaluateRag(dataset, predictions, { datasetSha256: sha256 });
  const comparison = compareBaseline(report, baseline);
  process.stdout.write(`${JSON.stringify({ baseline: comparison, report }, null, 2)}\n`);
  if (!report.passed || !comparison.passed) process.exitCode = 1;
}

function parseArguments(values: readonly string[]): CliArguments {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new TypeError('Usage: --dataset FILE --predictions FILE --baseline FILE');
    }
    if (parsed.has(key)) throw new TypeError(`Duplicate CLI argument: ${key}`);
    parsed.set(key, value);
  }
  const allowed = new Set(['--baseline', '--dataset', '--predictions']);
  if (parsed.size !== allowed.size || [...parsed.keys()].some((key) => !allowed.has(key))) {
    throw new TypeError('Usage: --dataset FILE --predictions FILE --baseline FILE');
  }
  return Object.freeze({
    baseline: parsed.get('--baseline')!,
    dataset: parsed.get('--dataset')!,
    predictions: parsed.get('--predictions')!,
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown evaluation failure';
  process.stderr.write(`RAG evaluation failed: ${message}\n`);
  process.exitCode = 1;
});
