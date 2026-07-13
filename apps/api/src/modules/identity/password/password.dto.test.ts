import { describe, expect, it } from 'vitest';

import { ChangePasswordRequestSchema, ResetPasswordRequestSchema } from './password.dto.js';

describe('password DTO policy', () => {
  it('accepts long passphrases and rejects short or control-character passwords', () => {
    const token = 'a'.repeat(43);
    expect(
      ResetPasswordRequestSchema.safeParse({
        new_password: 'correct horse battery staple',
        token,
      }).success,
    ).toBe(true);
    expect(ResetPasswordRequestSchema.safeParse({ new_password: 'too-short', token }).success).toBe(
      false,
    );
    expect(
      ResetPasswordRequestSchema.safeParse({ new_password: 'contains-control\n', token }).success,
    ).toBe(false);
  });

  it('rejects reusing the current password', () => {
    expect(
      ChangePasswordRequestSchema.safeParse({
        current_password: 'correct horse battery staple',
        new_password: 'correct horse battery staple',
      }).success,
    ).toBe(false);
  });
});
