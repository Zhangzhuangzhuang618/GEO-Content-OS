import { createCipheriv, createHash, randomBytes } from 'node:crypto';

const KEY_BYTES = 32;
const IV_BYTES = 12;

export interface EncryptedManifest {
  readonly body: Uint8Array;
  readonly ciphertextHash: string;
  readonly manifestHash: string;
}

export interface TenantManifestCipher {
  encrypt(manifest: unknown): EncryptedManifest;
}

export class AesGcmTenantManifestCipher implements TenantManifestCipher {
  private readonly key: Buffer;

  public constructor(key: Uint8Array) {
    if (key.byteLength !== KEY_BYTES) throw new TypeError('Tenant manifest key must be 32 bytes');
    this.key = Buffer.from(key);
  }

  public encrypt(manifest: unknown): EncryptedManifest {
    const plaintext = Buffer.from(stableJson(manifest), 'utf8');
    const iv = randomBytes(IV_BYTES);
    try {
      const cipher = createCipheriv('aes-256-gcm', this.key, iv);
      cipher.setAAD(Buffer.from('geo-content-os:tenant-export-manifest:v1', 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const body = Buffer.from(
        JSON.stringify({
          algorithm: 'A256GCM',
          ciphertext: ciphertext.toString('base64url'),
          iv: iv.toString('base64url'),
          tag: cipher.getAuthTag().toString('base64url'),
          version: 1,
        }),
        'utf8',
      );
      return Object.freeze({
        body: Uint8Array.from(body),
        ciphertextHash: sha256(body),
        manifestHash: sha256(plaintext),
      });
    } finally {
      plaintext.fill(0);
    }
  }

  public destroy(): void {
    this.key.fill(0);
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
