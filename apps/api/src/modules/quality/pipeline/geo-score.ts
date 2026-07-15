import type { QualityGeoScores } from '@geo-content-os/contracts/skills';

import { QualityPipelineError } from './quality-pipeline.errors.js';

export function calculateGeoTotal(scores: Omit<QualityGeoScores, 'total'>): number {
  return roundScore(
    0.2 * (scores.entity + scores.question + scores.answerability + scores.evidence) +
      0.1 * (scores.platform_fit + scores.readability_safety),
  );
}

export function validateGeoScores(scores: QualityGeoScores): QualityGeoScores {
  for (const [name, value] of Object.entries(scores)) {
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new QualityPipelineError('QUALITY_INPUT_INVALID', `GEO score ${name} is invalid`);
    }
  }
  const expected = calculateGeoTotal(scores);
  if (Math.abs(scores.total - expected) > 0.01) {
    throw new QualityPipelineError(
      'QUALITY_INPUT_INVALID',
      `GEO total must use frozen 20/20/20/20/10/10 weights; expected ${expected}`,
    );
  }
  return Object.freeze({ ...scores, total: expected });
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}
