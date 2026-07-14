import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const ENVELOPE_PREFIX = 'credential-envelope.v1.';
const ENVELOPE_AAD = Buffer.from('geo-content-os:credential-envelope:v1', 'utf8');
const DATA_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

interface SerializedEnvelope {
  readonly algorithm: 'A256GCM';
  readonly ciphertext: string;
  readonly encrypted_data_key: string;
  readonly iv: string;
  readonly tag: string;
  readonly version: 1;
}

export interface WrappedDataKey {
  readonly ciphertext: Uint8Array;
  readonly keyVersion: string;
}

/** Provider-neutral boundary for a production KMS and the deterministic local boundary. */
export interface CredentialKeyManagementService {
  currentKeyVersion(): Promise<string>;
  unwrapDataKey(ciphertext: Uint8Array, keyVersion: string): Promise<Uint8Array>;
  wrapDataKey(dataKey: Uint8Array): Promise<WrappedDataKey>;
}

export interface StoredCredential {
  readonly credentialCiphertext: string;
  readonly credentialKeyVersion: string;
}

export class CredentialEnvelopeError extends Error {
  public constructor(
    public readonly code: 'CREDENTIAL_DECRYPTION_FAILED' | 'CREDENTIAL_ENVELOPE_INVALID',
  ) {
    super(
      code === 'CREDENTIAL_ENVELOPE_INVALID'
        ? 'Credential envelope is invalid'
        : 'Credential decryption failed',
    );
    this.name = 'CredentialEnvelopeError';
  }
}

export class CredentialEnvelopeService {
  public constructor(private readonly kms: CredentialKeyManagementService) {}

  public async encrypt(plaintext: string): Promise<StoredCredential> {
    if (plaintext.length === 0) throw invalidEnvelope();
    const dataKey = randomBytes(DATA_KEY_BYTES);
    const plaintextBytes = Buffer.from(plaintext, 'utf8');

    try {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, dataKey, iv);
      cipher.setAAD(ENVELOPE_AAD);
      const ciphertext = Buffer.concat([cipher.update(plaintextBytes), cipher.final()]);
      const tag = cipher.getAuthTag();
      const wrapped = await this.kms.wrapDataKey(dataKey);
      assertKeyVersion(wrapped.keyVersion);
      return Object.freeze({
        credentialCiphertext: serializeEnvelope({
          algorithm: 'A256GCM',
          ciphertext: ciphertext.toString('base64url'),
          encrypted_data_key: Buffer.from(wrapped.ciphertext).toString('base64url'),
          iv: iv.toString('base64url'),
          tag: tag.toString('base64url'),
          version: 1,
        }),
        credentialKeyVersion: wrapped.keyVersion,
      });
    } catch (error) {
      if (error instanceof CredentialEnvelopeError) throw error;
      throw decryptionFailed();
    } finally {
      dataKey.fill(0);
      plaintextBytes.fill(0);
    }
  }

  public async decrypt(stored: StoredCredential): Promise<string> {
    let dataKey: Buffer | undefined;
    let plaintext: Buffer | undefined;

    try {
      const envelope = parseStoredCredential(stored);
      dataKey = Buffer.from(
        await this.kms.unwrapDataKey(
          Buffer.from(envelope.encrypted_data_key, 'base64url'),
          stored.credentialKeyVersion,
        ),
      );
      if (dataKey.length !== DATA_KEY_BYTES) throw decryptionFailed();
      const decipher = createDecipheriv(ALGORITHM, dataKey, Buffer.from(envelope.iv, 'base64url'));
      decipher.setAAD(ENVELOPE_AAD);
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
      plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
        decipher.final(),
      ]);
      return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    } catch {
      throw decryptionFailed();
    } finally {
      dataKey?.fill(0);
      plaintext?.fill(0);
    }
  }

  /** Rewraps only the random data key; credential plaintext is never decrypted during rotation. */
  public async rotate(stored: StoredCredential): Promise<StoredCredential> {
    let dataKey: Buffer | undefined;
    try {
      const envelope = parseStoredCredential(stored);
      const currentVersion = await this.kms.currentKeyVersion();
      assertKeyVersion(currentVersion);
      if (currentVersion === stored.credentialKeyVersion) return Object.freeze({ ...stored });
      dataKey = Buffer.from(
        await this.kms.unwrapDataKey(
          Buffer.from(envelope.encrypted_data_key, 'base64url'),
          stored.credentialKeyVersion,
        ),
      );
      if (dataKey.length !== DATA_KEY_BYTES) throw decryptionFailed();
      const wrapped = await this.kms.wrapDataKey(dataKey);
      if (wrapped.keyVersion !== currentVersion) throw decryptionFailed();
      return Object.freeze({
        credentialCiphertext: serializeEnvelope({
          ...envelope,
          encrypted_data_key: Buffer.from(wrapped.ciphertext).toString('base64url'),
        }),
        credentialKeyVersion: wrapped.keyVersion,
      });
    } catch {
      throw decryptionFailed();
    } finally {
      dataKey?.fill(0);
    }
  }
}

function parseStoredCredential(stored: StoredCredential): SerializedEnvelope {
  assertKeyVersion(stored.credentialKeyVersion);
  if (!stored.credentialCiphertext.startsWith(ENVELOPE_PREFIX)) throw invalidEnvelope();

  try {
    const encoded = stored.credentialCiphertext.slice(ENVELOPE_PREFIX.length);
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    if (!isEnvelope(parsed)) throw invalidEnvelope();
    const iv = Buffer.from(parsed.iv, 'base64url');
    const tag = Buffer.from(parsed.tag, 'base64url');
    const encryptedDataKey = Buffer.from(parsed.encrypted_data_key, 'base64url');
    if (
      iv.length !== IV_BYTES ||
      tag.length !== TAG_BYTES ||
      encryptedDataKey.length === 0 ||
      !canonicalBase64Url(parsed.iv, iv) ||
      !canonicalBase64Url(parsed.tag, tag) ||
      !canonicalBase64Url(parsed.encrypted_data_key, encryptedDataKey) ||
      !canonicalBase64Url(parsed.ciphertext, Buffer.from(parsed.ciphertext, 'base64url'))
    ) {
      throw invalidEnvelope();
    }
    return parsed;
  } catch (error) {
    if (error instanceof CredentialEnvelopeError) throw error;
    throw invalidEnvelope();
  }
}

function isEnvelope(value: unknown): value is SerializedEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 6 &&
    record['algorithm'] === 'A256GCM' &&
    record['version'] === 1 &&
    typeof record['ciphertext'] === 'string' &&
    typeof record['encrypted_data_key'] === 'string' &&
    typeof record['iv'] === 'string' &&
    typeof record['tag'] === 'string'
  );
}

function canonicalBase64Url(encoded: string, decoded: Uint8Array): boolean {
  return encoded.length > 0 && Buffer.from(decoded).toString('base64url') === encoded;
}

function serializeEnvelope(envelope: SerializedEnvelope): string {
  return `${ENVELOPE_PREFIX}${Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url')}`;
}

function assertKeyVersion(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u.test(value)) throw invalidEnvelope();
}

function invalidEnvelope(): CredentialEnvelopeError {
  return new CredentialEnvelopeError('CREDENTIAL_ENVELOPE_INVALID');
}

function decryptionFailed(): CredentialEnvelopeError {
  return new CredentialEnvelopeError('CREDENTIAL_DECRYPTION_FAILED');
}
