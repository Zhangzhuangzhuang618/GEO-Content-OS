import { describe, expect, it } from 'vitest';

import { readStorageConfiguration } from './storage.config.js';

describe('storage configuration', () => {
  it('stays disabled by default outside production', () => {
    expect(readStorageConfiguration({ NODE_ENV: 'test' })).toMatchObject({
      autoCreateBucket: false,
      bucket: 'geo-content-os-dev',
      driver: 'disabled',
      forcePathStyle: false,
      region: 'us-east-1',
      serverSideEncryption: false,
    });
  });

  it('accepts an explicit private MinIO-compatible configuration', () => {
    expect(
      readStorageConfiguration({
        NODE_ENV: 'development',
        S3_ACCESS_KEY_ID: 'minio-user',
        S3_AUTO_CREATE_BUCKET: 'true',
        S3_BUCKET: 'geo-source-test',
        S3_ENDPOINT: 'http://127.0.0.1:9000',
        S3_SECRET_ACCESS_KEY: 'minio-password',
        STORAGE_DRIVER: 's3',
      }),
    ).toMatchObject({
      autoCreateBucket: true,
      bucket: 'geo-source-test',
      credentials: { accessKeyId: 'minio-user', secretAccessKey: 'minio-password' },
      driver: 's3',
      endpoint: 'http://127.0.0.1:9000',
      forcePathStyle: true,
    });
  });

  it('allows an in-memory adapter only outside production', () => {
    expect(readStorageConfiguration({ NODE_ENV: 'test', STORAGE_DRIVER: 'memory' }).driver).toBe(
      'memory',
    );
    expect(() =>
      readStorageConfiguration({ NODE_ENV: 'production', STORAGE_DRIVER: 'memory' }),
    ).toThrow(/STORAGE_DRIVER=s3/u);
  });

  it('fails closed for production and malformed or embedded credentials', () => {
    expect(() => readStorageConfiguration({ NODE_ENV: 'production' })).toThrow(
      /STORAGE_DRIVER=s3/u,
    );
    expect(() =>
      readStorageConfiguration({
        NODE_ENV: 'production',
        S3_AUTO_CREATE_BUCKET: 'true',
        STORAGE_DRIVER: 's3',
      }),
    ).toThrow(/S3_AUTO_CREATE_BUCKET/u);
    expect(() =>
      readStorageConfiguration({
        S3_ENDPOINT: 'http://user:secret@storage.internal',
        STORAGE_DRIVER: 's3',
      }),
    ).toThrow(/without embedded credentials/u);
    expect(() =>
      readStorageConfiguration({ S3_ACCESS_KEY_ID: 'only-one', STORAGE_DRIVER: 's3' }),
    ).toThrow(/configured together/u);
  });
});
