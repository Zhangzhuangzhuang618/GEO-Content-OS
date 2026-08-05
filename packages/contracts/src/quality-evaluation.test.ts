import { describe, expect, it } from 'vitest';

import {
  QUALITY_EVALUATION_POLICY_VERSION,
  qualityEvaluationFingerprintSource,
} from './quality-evaluation.js';

describe('quality evaluation fingerprint', () => {
  it('binds a report to its content and complete checker runtime', () => {
    const source = qualityEvaluationFingerprintSource({
      contentHash: 'a'.repeat(64),
      modelKey: 'deepseek-v4-flash',
      promptVersionId: '25000000-0000-4000-8000-000000000007',
      skillVersion: '1.0.0',
    });

    expect(source).toBe(
      [
        QUALITY_EVALUATION_POLICY_VERSION,
        'a'.repeat(64),
        'deepseek-v4-flash',
        '25000000-0000-4000-8000-000000000007',
        '1.0.0',
      ].join('\n'),
    );
  });
});
