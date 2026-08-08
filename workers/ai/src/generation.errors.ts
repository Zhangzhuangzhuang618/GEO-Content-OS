import { DeepSeekAdapterError } from '@geo-content-os/adapter-model-deepseek';
import { SkillRuntimeError } from '@geo-content-os/skills/runtime';

import type { GenerationFailure } from './generation.types.js';

export class GenerationWorkerError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    options?: { readonly cause?: unknown; readonly retryable?: boolean },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'GenerationWorkerError';
    this.retryable = options?.retryable ?? false;
  }

  public readonly retryable: boolean;
}

export function asGenerationFailure(error: unknown): GenerationFailure {
  if (error instanceof GenerationWorkerError) {
    return { code: error.code, message: error.message.slice(0, 500), retryable: error.retryable };
  }
  if (error instanceof SkillRuntimeError) {
    return { code: error.code, message: error.message.slice(0, 500), retryable: false };
  }
  if (error instanceof DeepSeekAdapterError) {
    return {
      code: error.code,
      message: error.message.slice(0, 500),
      retryable: error.retryable,
    };
  }
  return { code: 'GENERATION_FAILED', message: 'Content generation failed', retryable: false };
}
