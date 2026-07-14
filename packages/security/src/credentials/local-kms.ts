import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import {
  CredentialEnvelopeError,
  type CredentialKeyManagementService,
  type WrappedDataKey,
} from './credential-envelope.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const WRAPPED_DATA_KEY_BYTES = IV_BYTES + TAG_BYTES + KEY_BYTES;

/** In-process development/test KMS. Production must inject a managed-KMS implementation. */
export class LocalCredentialKms implements CredentialKeyManagementService {
  private currentVersion: string;
  private readonly keys = new Map<string, Buffer>();

  public constructor(currentVersion: string, keys: Readonly<Record<string, Uint8Array>>) {
    for (const [version, key] of Object.entries(keys)) this.addKey(version, key);
    if (!this.keys.has(currentVersion)) throw kmsFailure();
    this.currentVersion = currentVersion;
  }

  public async currentKeyVersion(): Promise<string> {
    return this.currentVersion;
  }

  public rotateTo(keyVersion: string, key: Uint8Array): void {
    this.addKey(keyVersion, key);
    this.currentVersion = keyVersion;
  }

  public async wrapDataKey(dataKey: Uint8Array): Promise<WrappedDataKey> {
    if (dataKey.length !== KEY_BYTES) throw kmsFailure();
    const keyVersion = this.currentVersion;
    const wrappingKey = this.requireKey(keyVersion);
    const iv = randomBytes(IV_BYTES);
    try {
      const cipher = createCipheriv(ALGORITHM, wrappingKey, iv);
      cipher.setAAD(aad(keyVersion));
      const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
      return Object.freeze({
        ciphertext: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]),
        keyVersion,
      });
    } catch {
      throw kmsFailure();
    }
  }

  public async unwrapDataKey(ciphertext: Uint8Array, keyVersion: string): Promise<Uint8Array> {
    if (ciphertext.length !== WRAPPED_DATA_KEY_BYTES) throw kmsFailure();
    const wrappingKey = this.requireKey(keyVersion);
    try {
      const wrapped = Buffer.from(ciphertext);
      const decipher = createDecipheriv(ALGORITHM, wrappingKey, wrapped.subarray(0, IV_BYTES));
      decipher.setAAD(aad(keyVersion));
      decipher.setAuthTag(wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      const dataKey = Buffer.concat([
        decipher.update(wrapped.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]);
      if (dataKey.length !== KEY_BYTES) throw kmsFailure();
      return dataKey;
    } catch {
      throw kmsFailure();
    }
  }

  public destroy(): void {
    for (const key of this.keys.values()) key.fill(0);
    this.keys.clear();
  }

  private addKey(keyVersion: string, key: Uint8Array): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u.test(keyVersion) || key.length !== KEY_BYTES) {
      throw kmsFailure();
    }
    this.keys.get(keyVersion)?.fill(0);
    this.keys.set(keyVersion, Buffer.from(key));
  }

  private requireKey(keyVersion: string): Buffer {
    const key = this.keys.get(keyVersion);
    if (!key) throw kmsFailure();
    return key;
  }
}

function aad(keyVersion: string): Buffer {
  return Buffer.from(`geo-content-os:local-kms:${keyVersion}`, 'utf8');
}

function kmsFailure(): CredentialEnvelopeError {
  return new CredentialEnvelopeError('CREDENTIAL_DECRYPTION_FAILED');
}
