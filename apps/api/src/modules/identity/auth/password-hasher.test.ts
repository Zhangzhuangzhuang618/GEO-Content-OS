import { argon2i, hash } from 'argon2';
import { describe, expect, it } from 'vitest';

import { PasswordHasher } from './password-hasher.js';

describe('PasswordHasher', () => {
  it('creates and verifies Argon2id hashes without exposing a boolean shortcut', async () => {
    const hasher = new PasswordHasher();
    const passwordHash = await hasher.hash('correct horse battery staple');

    expect(passwordHash).toMatch(/^\$argon2id\$/u);
    await expect(hasher.verify(passwordHash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(hasher.verify(passwordHash, 'incorrect')).resolves.toBe(false);
  });

  it('rejects missing, malformed, and non-Argon2id hashes', async () => {
    const hasher = new PasswordHasher();
    const argon2iHash = await hash('correct horse battery staple', { type: argon2i });

    await expect(hasher.verify(null, 'correct horse battery staple')).resolves.toBe(false);
    await expect(
      hasher.verify('not-a-password-hash', 'correct horse battery staple'),
    ).resolves.toBe(false);
    await expect(hasher.verify(argon2iHash, 'correct horse battery staple')).resolves.toBe(false);
  });
});
