import { createHash } from 'node:crypto';

import type { ObjectStorageAdapter } from '@geo-content-os/adapter-storage';
import type { WebFetchAdapter } from '@geo-content-os/adapter-web-fetch';

import { IngestWorkerError } from './ingest.errors.js';
import type {
  IngestSource,
  KnowledgeIngestData,
  LoadedMaterial,
  MaterialLoaderPort,
} from './ingest.types.js';

const DEFAULT_MAX_BYTES = 25 * 1_024 * 1_024;

export class AdapterMaterialLoader implements MaterialLoaderPort {
  public constructor(
    private readonly storage: ObjectStorageAdapter,
    private readonly webFetch: WebFetchAdapter,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 100 * 1_024 * 1_024) {
      throw new TypeError('Material loader byte limit is invalid');
    }
  }

  public async load(
    source: IngestSource,
    data: KnowledgeIngestData,
    signal?: AbortSignal,
  ): Promise<LoadedMaterial> {
    requireNotAborted(signal);
    if (source.sourceType === 'url') {
      if (!data.sourceUrl) throw invalidLocation();
      if (data.objectKey) {
        const stored = await this.loadObject(source, data.objectKey, signal);
        return Object.freeze({ ...stored, url: data.sourceUrl });
      }
      const result = await this.webFetch.fetch(data.sourceUrl);
      requireNotAborted(signal);
      validateBody(result.body, this.maxBytes, result.contentHash);
      if (
        result.contentHash !== source.contentHash ||
        result.contentType !== source.mimeType ||
        result.finalUrl !== data.sourceUrl
      ) {
        throw new IngestWorkerError(
          'SOURCE_CONTENT_CHANGED',
          'Web source content changed after registration',
          { retryable: false },
        );
      }
      return Object.freeze({
        body: Uint8Array.from(result.body),
        contentHash: result.contentHash,
        mimeType: result.contentType,
        url: result.finalUrl,
      });
    }
    if (!data.objectKey || data.sourceUrl) throw invalidLocation();
    return this.loadObject(source, data.objectKey, signal);
  }

  private async loadObject(
    source: IngestSource,
    objectKey: string,
    signal?: AbortSignal,
  ): Promise<LoadedMaterial> {
    const metadata = await this.storage.headObject(objectKey);
    if (!metadata || metadata.contentLength < 1 || metadata.contentLength > this.maxBytes) {
      throw new IngestWorkerError('SOURCE_OBJECT_INVALID', 'Source object metadata is invalid', {
        retryable: metadata === undefined,
      });
    }
    if (metadata.contentType && metadata.contentType !== source.mimeType) {
      throw new IngestWorkerError(
        'SOURCE_MIME_MISMATCH',
        'Source object MIME type does not match',
        {
          retryable: false,
        },
      );
    }
    const body = await this.storage.getObject(objectKey);
    requireNotAborted(signal);
    validateBody(body, this.maxBytes, source.contentHash);
    return Object.freeze({
      body: Uint8Array.from(body),
      contentHash: source.contentHash,
      mimeType: source.mimeType,
    });
  }
}

function validateBody(body: Uint8Array, maxBytes: number, expectedHash: string): void {
  if (body.byteLength < 1 || body.byteLength > maxBytes) {
    throw new IngestWorkerError('SOURCE_SIZE_INVALID', 'Source body is outside the size limit', {
      retryable: false,
    });
  }
  if (createHash('sha256').update(body).digest('hex') !== expectedHash) {
    throw new IngestWorkerError('SOURCE_HASH_MISMATCH', 'Source body hash does not match', {
      retryable: false,
    });
  }
}

function invalidLocation(): IngestWorkerError {
  return new IngestWorkerError('SOURCE_LOCATION_INVALID', 'Source event location is invalid', {
    retryable: false,
  });
}

function requireNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}
