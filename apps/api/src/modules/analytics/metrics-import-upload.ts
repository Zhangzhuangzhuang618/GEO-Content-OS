import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import type { FastifyRequest } from 'fastify';

import { AnalyticsApiValidationError } from './analytics-api.errors.js';

const MAX_CSV_BYTES = 10 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ParsedMetricsImportUpload {
  readonly body: Uint8Array;
  readonly contentHash: string;
  readonly workspaceId: string;
}

export async function parseMetricsImportUpload(
  request: FastifyRequest,
): Promise<ParsedMetricsImportUpload> {
  if (!request.isMultipart()) throw new AnalyticsApiValidationError();
  let body: Uint8Array | undefined;
  let workspaceId: string | undefined;
  try {
    for await (const part of request.parts({
      limits: {
        fieldNameSize: 64,
        fieldSize: 128,
        fields: 1,
        fileSize: MAX_CSV_BYTES,
        files: 1,
        parts: 2,
      },
    })) {
      if (part.type === 'file') {
        if (body || part.fieldname !== 'file' || !part.filename.toLowerCase().endsWith('.csv')) {
          part.file.resume();
          throw new AnalyticsApiValidationError();
        }
        const file = await part.toBuffer();
        if (part.file.truncated || file.byteLength === 0 || file.byteLength > MAX_CSV_BYTES) {
          throw new AnalyticsApiValidationError();
        }
        body = Uint8Array.from(file);
        continue;
      }
      if (
        part.fieldname !== 'workspace_id' ||
        workspaceId ||
        part.valueTruncated ||
        typeof part.value !== 'string'
      ) {
        throw new AnalyticsApiValidationError();
      }
      workspaceId = part.value.trim().toLowerCase();
    }
  } catch (error) {
    if (error instanceof AnalyticsApiValidationError) throw error;
    throw new AnalyticsApiValidationError();
  }
  if (!body || !workspaceId || !UUID.test(workspaceId)) throw new AnalyticsApiValidationError();
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new AnalyticsApiValidationError();
  }
  return Object.freeze({
    body,
    contentHash: createHash('sha256').update(body).digest('hex'),
    workspaceId,
  });
}
