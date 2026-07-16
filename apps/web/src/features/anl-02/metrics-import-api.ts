import { ImportJobResponseSchema, type ImportJob } from './metrics-import.schema';
const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';
export async function uploadMetrics(
  file: File,
  workspaceId: string,
  csrf: string,
): Promise<ImportJob> {
  const body = new FormData();
  body.set('file', file);
  body.set('workspace_id', workspaceId);
  const response = await fetch(`${API_ORIGIN}/api/v1/metrics/import`, {
    body,
    credentials: 'include',
    headers: { 'idempotency-key': `metrics-import-${crypto.randomUUID()}`, 'x-csrf-token': csrf },
    method: 'POST',
  });
  return parse(response);
}
export async function getImportJob(id: string, signal?: AbortSignal): Promise<ImportJob> {
  const response = await fetch(`${API_ORIGIN}/api/v1/metrics/import-jobs/${id}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  return parse(response);
}
export async function rollbackImport(
  job: ImportJob,
  reason: string,
  csrf: string,
): Promise<ImportJob> {
  const response = await fetch(`${API_ORIGIN}/api/v1/metrics/import-jobs/${job.id}/rollback`, {
    body: JSON.stringify({ reason }),
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `metrics-rollback-${job.id}-${crypto.randomUUID()}`,
      'x-csrf-token': csrf,
    },
    method: 'POST',
  });
  return parse(response);
}
async function parse(response: Response) {
  if (!response.ok) throw new MetricsImportRequestError(response.status);
  const parsed = ImportJobResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new MetricsImportRequestError(502);
  return parsed.data.data;
}
export class MetricsImportRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Metrics import request failed');
    this.name = 'MetricsImportRequestError';
  }
}
