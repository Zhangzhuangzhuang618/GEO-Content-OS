import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  DisabledStorageAdapter,
  InMemoryStorageAdapter,
  S3StorageAdapter,
} from './storage.adapter.js';
import type { StorageConfiguration } from './storage.config.js';

const BODY = new TextEncoder().encode('trusted source');
const HASH = createHash('sha256').update(BODY).digest('hex');

describe('object storage adapters', () => {
  it('stores private bytes with immutable metadata and supports lookup and deletion', async () => {
    const storage = new InMemoryStorageAdapter('sources');
    const stored = await storage.putObject({
      body: BODY,
      contentHash: HASH,
      contentType: 'text/plain',
      key: `tenant/workspace/sources/${HASH}.txt`,
      metadata: { tenant_id: 'tenant' },
    });
    expect(stored).toMatchObject({
      bucket: 'sources',
      etag: HASH,
      uri: `memory://sources/tenant/workspace/sources/${HASH}.txt`,
    });
    expect(await storage.headObject(stored.key)).toMatchObject({
      contentLength: BODY.byteLength,
      contentType: 'text/plain',
      etag: HASH,
      metadata: { tenant_id: 'tenant' },
    });
    expect(storage.readObject(stored.key)).toEqual(BODY);
    expect(await storage.createDownloadUrl(stored.key, 60)).not.toContain('secret');
    await storage.deleteObject(stored.key);
    expect(await storage.headObject(stored.key)).toBeUndefined();
  });

  it('rejects traversal keys, invalid hashes, empty objects, and excessive signed URL TTL', async () => {
    const storage = new InMemoryStorageAdapter();
    await expect(
      storage.putObject({
        body: BODY,
        contentHash: HASH,
        contentType: 'text/plain',
        key: '../source.txt',
      }),
    ).rejects.toThrow(/key is invalid/u);
    await expect(
      storage.putObject({
        body: new Uint8Array(),
        contentHash: HASH,
        contentType: 'text/plain',
        key: 'source.txt',
      }),
    ).rejects.toThrow(/must not be empty/u);
    await expect(
      storage.putObject({
        body: BODY,
        contentHash: 'invalid',
        contentType: 'text/plain',
        key: 'source.txt',
      }),
    ).rejects.toThrow(/SHA-256/u);
    await expect(storage.createDownloadUrl('source.txt', 3_601)).rejects.toThrow(/between 1/u);
  });

  it('maps uploads to PutObject without exposing credentials in errors', async () => {
    const sent: unknown[] = [];
    const client = {
      send: vi.fn(async (command: unknown) => {
        sent.push(command);
        return { ETag: '"opaque-etag"' };
      }),
    } as unknown as S3Client;
    const storage = new S3StorageAdapter(s3Configuration(), client);
    const result = await storage.putObject({
      body: BODY,
      contentHash: HASH,
      contentType: 'text/plain',
      key: `sources/${HASH}.txt`,
    });
    expect(sent[0]).toBeInstanceOf(PutObjectCommand);
    expect((sent[0] as PutObjectCommand).input).toMatchObject({
      Bucket: 'geo-source-test',
      ContentLength: BODY.byteLength,
      ContentType: 'text/plain',
      Key: `sources/${HASH}.txt`,
      Metadata: { sha256: HASH },
    });
    expect(result).toMatchObject({ bucket: 'geo-source-test', etag: 'opaque-etag' });

    const failingClient = {
      send: vi.fn(() => Promise.reject(new Error('secret=minio-password'))),
    } as unknown as S3Client;
    await expect(
      new S3StorageAdapter(s3Configuration(), failingClient).putObject({
        body: BODY,
        contentHash: HASH,
        contentType: 'text/plain',
        key: `sources/${HASH}.txt`,
      }),
    ).rejects.toThrow(/^Object storage upload failed$/u);
  });

  it('fails explicitly when storage is disabled', async () => {
    await expect(
      new DisabledStorageAdapter().putObject({
        body: BODY,
        contentHash: HASH,
        contentType: 'text/plain',
        key: 'source.txt',
      }),
    ).rejects.toThrow(/disabled/u);
  });
});

function s3Configuration(): StorageConfiguration {
  return {
    autoCreateBucket: false,
    bucket: 'geo-source-test',
    credentials: { accessKeyId: 'minio-user', secretAccessKey: 'minio-password' },
    driver: 's3',
    endpoint: 'http://127.0.0.1:9000',
    forcePathStyle: true,
    region: 'us-east-1',
    serverSideEncryption: false,
  };
}
