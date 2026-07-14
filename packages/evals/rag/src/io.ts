import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { RagEvalBaseline, RagEvalDataset, RagEvalPredictions } from './types.js';
import { parseBaseline, parseDataset, parsePredictions } from './validation.js';

const MAX_FILE_BYTES = 25 * 1_024 * 1_024;

export async function loadDataset(path: string): Promise<{
  readonly dataset: RagEvalDataset;
  readonly sha256: string;
}> {
  const body = await boundedRead(path);
  return Object.freeze({ dataset: parseDataset(parseJson(body, path)), sha256: sha256(body) });
}

export async function loadPredictions(path: string): Promise<RagEvalPredictions> {
  const body = await boundedRead(path);
  return parsePredictions(parseJson(body, path));
}

export async function loadBaseline(path: string): Promise<RagEvalBaseline> {
  const body = await boundedRead(path);
  return parseBaseline(parseJson(body, path));
}

async function boundedRead(path: string): Promise<Buffer> {
  const body = await readFile(path);
  if (body.byteLength < 1 || body.byteLength > MAX_FILE_BYTES) {
    throw new TypeError('Evaluation input file is empty or exceeds 25 MiB');
  }
  return body;
}

function parseJson(body: Buffer, path: string): unknown {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (error) {
    throw new TypeError(`Evaluation input is not valid JSON: ${path}`, { cause: error });
  }
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
