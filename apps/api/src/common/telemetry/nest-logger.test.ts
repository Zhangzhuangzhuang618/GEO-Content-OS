import type { StructuredLogger } from '@geo-content-os/observability';
import { describe, expect, it, vi } from 'vitest';

import { NestStructuredLogger } from './nest-logger.js';

describe('NestStructuredLogger', () => {
  it('preserves the stack string supplied by the Nest exception handler', () => {
    const error = vi.fn();
    const logger = new NestStructuredLogger(structuredLogger(error));
    const stack = [
      'TypeError: invalid platform account value',
      '    at PlatformAccountService.update (platform-account.service.ts:139:21)',
    ].join('\n');

    logger.error('invalid platform account value', stack, 'ExceptionsHandler');

    expect(error).toHaveBeenCalledWith(
      'invalid platform account value',
      expect.objectContaining({ message: 'invalid platform account value', stack }),
      { nest_context: 'ExceptionsHandler' },
    );
  });

  it('preserves an Error passed as the log message', () => {
    const error = vi.fn();
    const logger = new NestStructuredLogger(structuredLogger(error));
    const cause = new TypeError('invalid platform account value');

    logger.error(cause, 'ExceptionsHandler');

    expect(error).toHaveBeenCalledWith('invalid platform account value', cause, {
      nest_context: 'ExceptionsHandler',
    });
  });
});

function structuredLogger(error: StructuredLogger['error']): StructuredLogger {
  return {
    child: () => structuredLogger(error),
    debug: () => undefined,
    error,
    info: () => undefined,
    warn: () => undefined,
  };
}
