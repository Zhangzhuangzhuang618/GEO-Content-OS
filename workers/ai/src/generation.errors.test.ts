import { SkillRuntimeError } from '@geo-content-os/skills/runtime';
import { describe, expect, it } from 'vitest';

import { asGenerationFailure, GenerationWorkerError } from './generation.errors.js';

describe('asGenerationFailure', () => {
  it('preserves safe worker errors', () => {
    expect(
      asGenerationFailure(new GenerationWorkerError('MASTER_FAILED', 'Master failed')),
    ).toEqual({ code: 'MASTER_FAILED', message: 'Master failed' });
  });

  it('preserves safe Skill runtime errors', () => {
    expect(
      asGenerationFailure(
        new SkillRuntimeError('SKILL_OUTPUT_INVALID', 'Skill output failed schema validation'),
      ),
    ).toEqual({
      code: 'SKILL_OUTPUT_INVALID',
      message: 'Skill output failed schema validation',
    });
  });

  it('does not expose unknown provider errors', () => {
    expect(asGenerationFailure(new Error('secret provider response'))).toEqual({
      code: 'GENERATION_FAILED',
      message: 'Content generation failed',
    });
  });
});
