import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { redactSensitiveData } from '../redaction.js';
import { CredentialEnvelopeError, CredentialEnvelopeService } from './credential-envelope.js';
import { LocalCredentialKms } from './local-kms.js';

const SECRET = JSON.stringify({ access_token: 'platform-secret-token', refresh_token: 'refresh' });

describe('credential envelope encryption', () => {
  it('round-trips credentials with a random data key and never stores plaintext', async () => {
    const kms = localKms();
    const service = new CredentialEnvelopeService(kms);
    const first = await service.encrypt(SECRET);
    const second = await service.encrypt(SECRET);

    expect(first.credentialKeyVersion).toBe('local-v1');
    expect(first.credentialCiphertext).toMatch(/^credential-envelope\.v1\./u);
    expect(first.credentialCiphertext).not.toContain('platform-secret-token');
    expect(second.credentialCiphertext).not.toBe(first.credentialCiphertext);
    await expect(service.decrypt(first)).resolves.toBe(SECRET);
    await expect(service.decrypt(second)).resolves.toBe(SECRET);
    kms.destroy();
  });

  it('rotates only the wrapped data key to the current KMS key version', async () => {
    const kms = localKms();
    const service = new CredentialEnvelopeService(kms);
    const original = await service.encrypt(SECRET);
    kms.rotateTo('local-v2', randomBytes(32));

    const rotated = await service.rotate(original);
    expect(rotated.credentialKeyVersion).toBe('local-v2');
    expect(rotated.credentialCiphertext).not.toBe(original.credentialCiphertext);
    await expect(service.decrypt(rotated)).resolves.toBe(SECRET);
    await expect(service.decrypt(original)).resolves.toBe(SECRET);
    await expect(service.rotate(rotated)).resolves.toEqual(rotated);
    kms.destroy();
  });

  it('fails closed with generic errors for tampering, wrong versions, and destroyed keys', async () => {
    const kms = localKms();
    const service = new CredentialEnvelopeService(kms);
    const stored = await service.encrypt(SECRET);
    const tampered = {
      ...stored,
      credentialCiphertext: `${stored.credentialCiphertext.slice(0, -1)}A`,
    };

    await expect(service.decrypt(tampered)).rejects.toMatchObject({
      code: 'CREDENTIAL_DECRYPTION_FAILED',
      message: 'Credential decryption failed',
    });
    await expect(
      service.decrypt({ ...stored, credentialKeyVersion: 'missing-v9' }),
    ).rejects.toBeInstanceOf(CredentialEnvelopeError);
    kms.destroy();
    await expect(service.decrypt(stored)).rejects.toMatchObject({
      code: 'CREDENTIAL_DECRYPTION_FAILED',
    });
  });

  it('keeps ciphertext and key versions redacted in structured logs', async () => {
    const kms = localKms();
    const stored = await new CredentialEnvelopeService(kms).encrypt(SECRET);
    expect(redactSensitiveData(stored)).toEqual({
      credentialCiphertext: '[REDACTED]',
      credentialKeyVersion: '[REDACTED]',
    });
    expect(
      JSON.stringify(
        redactSensitiveData({ error: new Error('access_token=platform-secret-token') }),
      ),
    ).not.toContain('platform-secret-token');
    kms.destroy();
  });

  it('rejects invalid local wrapping keys without exposing supplied key material', () => {
    expect(() => new LocalCredentialKms('local-v1', { 'local-v1': randomBytes(16) })).toThrow(
      'Credential decryption failed',
    );
    expect(() => new LocalCredentialKms('missing-v2', { 'local-v1': randomBytes(32) })).toThrow(
      'Credential decryption failed',
    );
  });
});

function localKms(): LocalCredentialKms {
  return new LocalCredentialKms('local-v1', { 'local-v1': randomBytes(32) });
}
