import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { StorageConfiguration } from './storage.config.js';

const MAX_SIGNED_URL_SECONDS = 3_600;
const STORAGE_REQUEST_TIMEOUT_MS = 30_000;

export interface PutObjectInput {
  readonly body: Uint8Array;
  readonly contentHash: string;
  readonly contentType: string;
  readonly key: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface StoredObject {
  readonly bucket: string;
  readonly etag?: string;
  readonly key: string;
  readonly uri: string;
}

export interface StoredObjectMetadata {
  readonly contentLength: number;
  readonly contentType?: string;
  readonly etag?: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ObjectStorageAdapter {
  createDownloadUrl(key: string, expiresInSeconds?: number): Promise<string>;
  deleteObject(key: string): Promise<void>;
  getObject(key: string): Promise<Uint8Array>;
  headObject(key: string): Promise<StoredObjectMetadata | undefined>;
  objectUri(key: string): string;
  putObject(input: PutObjectInput): Promise<StoredObject>;
}

export function createStorageAdapter(configuration: StorageConfiguration): ObjectStorageAdapter {
  if (configuration.driver === 'disabled') return new DisabledStorageAdapter();
  if (configuration.driver === 'memory') return new InMemoryStorageAdapter(configuration.bucket);
  return new S3StorageAdapter(configuration);
}

export class DisabledStorageAdapter implements ObjectStorageAdapter {
  public createDownloadUrl(key: string, expiresInSeconds?: number): Promise<string> {
    void key;
    void expiresInSeconds;
    return Promise.reject(new Error('Object storage is disabled'));
  }

  public deleteObject(key: string): Promise<void> {
    void key;
    return Promise.reject(new Error('Object storage is disabled'));
  }

  public getObject(key: string): Promise<Uint8Array> {
    void key;
    return Promise.reject(new Error('Object storage is disabled'));
  }

  public headObject(key: string): Promise<StoredObjectMetadata | undefined> {
    void key;
    return Promise.reject(new Error('Object storage is disabled'));
  }

  public objectUri(key: string): string {
    void key;
    throw new Error('Object storage is disabled');
  }

  public putObject(input: PutObjectInput): Promise<StoredObject> {
    void input;
    return Promise.reject(new Error('Object storage is disabled'));
  }
}

export class InMemoryStorageAdapter implements ObjectStorageAdapter {
  private readonly objects = new Map<
    string,
    {
      readonly body: Uint8Array;
      readonly contentHash: string;
      readonly contentType: string;
      readonly metadata: Readonly<Record<string, string>>;
    }
  >();

  public constructor(private readonly bucket = 'memory-storage') {}

  public async createDownloadUrl(key: string, expiresInSeconds = 900): Promise<string> {
    requireSafeKey(key);
    requireSignedUrlExpiry(expiresInSeconds);
    if (!this.objects.has(key)) throw new Error('Object not found');
    return `memory://${this.bucket}/${key}?expires_in=${expiresInSeconds}`;
  }

  public async deleteObject(key: string): Promise<void> {
    requireSafeKey(key);
    this.objects.delete(key);
  }

  public async headObject(key: string): Promise<StoredObjectMetadata | undefined> {
    requireSafeKey(key);
    const object = this.objects.get(key);
    if (!object) return undefined;
    return {
      contentLength: object.body.byteLength,
      contentType: object.contentType,
      etag: object.contentHash,
      metadata: object.metadata,
    };
  }

  public async getObject(key: string): Promise<Uint8Array> {
    requireSafeKey(key);
    const body = this.objects.get(key)?.body;
    if (!body) throw new Error('Object not found');
    return Uint8Array.from(body);
  }

  public objectUri(key: string): string {
    requireSafeKey(key);
    return `memory://${this.bucket}/${key}`;
  }

  public async putObject(input: PutObjectInput): Promise<StoredObject> {
    validatePutObject(input);
    this.objects.set(input.key, {
      body: Uint8Array.from(input.body),
      contentHash: input.contentHash,
      contentType: input.contentType,
      metadata: Object.freeze({ ...(input.metadata ?? {}) }),
    });
    return {
      bucket: this.bucket,
      etag: input.contentHash,
      key: input.key,
      uri: this.objectUri(input.key),
    };
  }

  public readObject(key: string): Uint8Array | undefined {
    const body = this.objects.get(key)?.body;
    return body ? Uint8Array.from(body) : undefined;
  }

  public clear(): void {
    this.objects.clear();
  }
}

export class S3StorageAdapter implements ObjectStorageAdapter {
  private bucketReady: Promise<void> | undefined;
  private readonly client: S3Client;

  public constructor(
    private readonly configuration: StorageConfiguration,
    client?: S3Client,
  ) {
    this.client =
      client ??
      new S3Client({
        ...(configuration.credentials ? { credentials: { ...configuration.credentials } } : {}),
        ...(configuration.endpoint ? { endpoint: configuration.endpoint } : {}),
        forcePathStyle: configuration.forcePathStyle,
        region: configuration.region,
      });
  }

  public async createDownloadUrl(key: string, expiresInSeconds = 900): Promise<string> {
    requireSafeKey(key);
    requireSignedUrlExpiry(expiresInSeconds);
    await this.ensureBucket();
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.configuration.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }

  public async deleteObject(key: string): Promise<void> {
    requireSafeKey(key);
    await this.ensureBucket();
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.configuration.bucket, Key: key }),
      requestOptions(),
    );
  }

  public async headObject(key: string): Promise<StoredObjectMetadata | undefined> {
    requireSafeKey(key);
    await this.ensureBucket();
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.configuration.bucket, Key: key }),
        requestOptions(),
      );
      return {
        contentLength: result.ContentLength ?? 0,
        ...(result.ContentType ? { contentType: result.ContentType } : {}),
        ...(result.ETag ? { etag: stripQuotes(result.ETag) } : {}),
        metadata: Object.freeze({ ...(result.Metadata ?? {}) }),
      };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw new Error('Object storage metadata lookup failed');
    }
  }

  public async getObject(key: string): Promise<Uint8Array> {
    requireSafeKey(key);
    await this.ensureBucket();
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.configuration.bucket, Key: key }),
        requestOptions(),
      );
      if (!result.Body) throw new Error('Object body is missing');
      return Uint8Array.from(await result.Body.transformToByteArray());
    } catch (error) {
      if (isNotFound(error)) throw new Error('Object not found');
      throw new Error('Object storage download failed', { cause: error });
    }
  }

  public objectUri(key: string): string {
    requireSafeKey(key);
    return `s3://${this.configuration.bucket}/${key}`;
  }

  public async putObject(input: PutObjectInput): Promise<StoredObject> {
    validatePutObject(input);
    await this.ensureBucket();
    try {
      const result = await this.client.send(
        new PutObjectCommand({
          Body: input.body,
          Bucket: this.configuration.bucket,
          ContentLength: input.body.byteLength,
          ContentType: input.contentType,
          Key: input.key,
          Metadata: { ...input.metadata, sha256: input.contentHash },
          ...(this.configuration.serverSideEncryption ? { ServerSideEncryption: 'AES256' } : {}),
        }),
        requestOptions(),
      );
      return {
        bucket: this.configuration.bucket,
        ...(result.ETag ? { etag: stripQuotes(result.ETag) } : {}),
        key: input.key,
        uri: this.objectUri(input.key),
      };
    } catch (error) {
      throw new Error('Object storage upload failed', { cause: error });
    }
  }

  private async ensureBucket(): Promise<void> {
    if (!this.configuration.autoCreateBucket) return;
    this.bucketReady ??= this.createBucketIfMissing().catch((error: unknown) => {
      this.bucketReady = undefined;
      throw error;
    });
    return this.bucketReady;
  }

  private async createBucketIfMissing(): Promise<void> {
    try {
      await this.client.send(
        new HeadBucketCommand({ Bucket: this.configuration.bucket }),
        requestOptions(),
      );
      return;
    } catch (error) {
      if (!isNotFound(error)) {
        throw new Error('Object storage bucket check failed', { cause: error });
      }
    }
    try {
      await this.client.send(
        new CreateBucketCommand({ Bucket: this.configuration.bucket }),
        requestOptions(),
      );
    } catch (error) {
      if (!isBucketAlreadyOwned(error)) {
        throw new Error('Object storage bucket creation failed', { cause: error });
      }
    }
  }
}

function validatePutObject(input: PutObjectInput): void {
  requireSafeKey(input.key);
  if (input.body.byteLength === 0) throw new Error('Object body must not be empty');
  if (!/^[0-9a-f]{64}$/u.test(input.contentHash)) {
    throw new Error('Object contentHash must be a lowercase SHA-256 digest');
  }
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]+\/[a-z0-9][a-z0-9!#$&^_.+-]+$/u.test(input.contentType)) {
    throw new Error('Object contentType must be a valid lowercase MIME type');
  }
  for (const [key, value] of Object.entries(input.metadata ?? {})) {
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(key) || !value || value.length > 1_024) {
      throw new Error('Object metadata contains an invalid key or value');
    }
  }
}

function requireSafeKey(value: string): void {
  if (
    value.length < 1 ||
    value.length > 1_024 ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('..') ||
    !/^[A-Za-z0-9][A-Za-z0-9/_=.-]*$/u.test(value)
  ) {
    throw new Error('Object key is invalid');
  }
}

function requireSignedUrlExpiry(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_SIGNED_URL_SECONDS) {
    throw new Error(`Signed URL expiry must be between 1 and ${MAX_SIGNED_URL_SECONDS} seconds`);
  }
}

function stripQuotes(value: string): string {
  return value.replace(/^"|"$/gu, '');
}

function isNotFound(error: unknown): boolean {
  const candidate = error as {
    readonly $metadata?: { readonly httpStatusCode?: number };
    readonly name?: string;
  };
  return (
    candidate.$metadata?.httpStatusCode === 404 ||
    candidate.name === 'NotFound' ||
    candidate.name === 'NoSuchKey'
  );
}

function isBucketAlreadyOwned(error: unknown): boolean {
  const name = (error as { readonly name?: string }).name;
  return name === 'BucketAlreadyOwnedByYou';
}

function requestOptions(): { readonly abortSignal: AbortSignal } {
  return { abortSignal: AbortSignal.timeout(STORAGE_REQUEST_TIMEOUT_MS) };
}
