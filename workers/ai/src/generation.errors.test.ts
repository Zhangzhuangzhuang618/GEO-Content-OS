import { DeepSeekAdapterError } from '@geo-content-os/adapter-model-deepseek';
import { SkillRuntimeError } from '@geo-content-os/skills/runtime';
import { describe, expect, it } from 'vitest';

import { asGenerationFailure, GenerationWorkerError } from './generation.errors.js';

describe('asGenerationFailure', () => {
  it('preserves safe worker errors', () => {
    expect(
      asGenerationFailure(new GenerationWorkerError('MASTER_FAILED', 'Master failed')),
    ).toEqual({ code: 'MASTER_FAILED', message: 'Master failed', retryable: false });
  });

  it('preserves safe Skill runtime errors', () => {
    expect(
      asGenerationFailure(
        new SkillRuntimeError('SKILL_OUTPUT_INVALID', 'Skill output failed schema validation'),
      ),
    ).toEqual({
      code: 'SKILL_OUTPUT_INVALID',
      message: 'Skill output failed schema validation',
      retryable: false,
    });
  });

  it('does not expose unknown provider errors', () => {
    expect(asGenerationFailure(new Error('secret provider response'))).toEqual({
      code: 'GENERATION_FAILED',
      message: 'Content generation failed',
      retryable: false,
    });
  });

  it('preserves retryable typed provider errors from the DeepSeek adapter', () => {
    const error = new DeepSeekAdapterError('DEEPSEEK_TIMEOUT', 'Provider timed out', true);
    expect(asGenerationFailure(error)).toEqual({
      code: 'DEEPSEEK_TIMEOUT',
      message: 'Provider timed out',
      retryable: true,
    });
  });
});
