import { z } from 'zod';

export const ImportJobSchema = z
  .object({
    content_hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .nullable(),
    created_at: z.iso.datetime(),
    error_json: z.record(z.string(), z.unknown()).nullable(),
    id: z.string().uuid(),
    row_count: z.number().int().nonnegative().nullable(),
    source: z.enum(['api', 'csv', 'manual']),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'rolled_back']),
    updated_at: z.iso.datetime(),
    workspace_id: z.string().uuid(),
  })
  .strict();
const MetaSchema = z.object({ request_id: z.string().min(1) }).passthrough();
export const ImportJobResponseSchema = z
  .object({ data: ImportJobSchema, meta: MetaSchema })
  .strict();
export type ImportJob = z.infer<typeof ImportJobSchema>;
export interface CsvPreview {
  readonly errors: readonly { readonly line: number; readonly message: string }[];
  readonly file: File | null;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}
