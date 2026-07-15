import { createHash } from 'node:crypto';

import { FactCheckError } from './fact-check.errors.js';
import type { FactClaimInput, NormalizedFactClaim } from './fact-check.types.js';

const RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);

export function normalizeFactClaim(input: FactClaimInput): NormalizedFactClaim {
  const claimKey = input.claimKey.trim();
  const claimText = input.claimText.trim();
  const normalizedClaimText = claimText
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('und');

  if (claimKey.length === 0 || claimKey.length > 80)
    invalid('claimKey must contain 1..80 characters');
  if (claimText.length === 0 || claimText.length > 10_000) {
    invalid('claimText must contain 1..10000 characters');
  }
  if (!RISK_LEVELS.has(input.riskLevel)) invalid('riskLevel is invalid');

  return Object.freeze({
    claimHash: sha256(normalizedClaimText),
    claimKey,
    claimText,
    normalizedClaimText,
    riskLevel: input.riskLevel,
  });
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function invalid(message: string): never {
  throw new FactCheckError('FACT_CHECK_INPUT_INVALID', message);
}
