import {
  ImportResponseSchema,
  ObservationResponseSchema,
  TrendResponseSchema,
  type Observation,
  type VisibilityFilters,
  type VisibilityInput,
} from './visibility.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';
export async function loadVisibilityTrend(filters: VisibilityFilters, signal?: AbortSignal) {
  const query = new URLSearchParams({
    from: filters.from,
    to: filters.to,
    workspace_id: filters.workspaceId,
  });
  if (filters.platformCode) query.set('platform_code', filters.platformCode);
  if (filters.queryText) query.set('query_text', filters.queryText);
  const response = await fetch(`${API_ORIGIN}/api/v1/visibility-observations/trend?${query}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  return parse(response, TrendResponseSchema);
}
export async function createVisibilityObservation(
  workspaceId: string,
  input: VisibilityInput,
  screenshot: File | null,
  csrf: string,
): Promise<Observation> {
  const body: Record<string, unknown> = { ...input, workspace_id: workspaceId };
  if (screenshot) {
    body['screenshot'] = {
      body_base64: await fileBase64(screenshot),
      mime_type: screenshot.type,
    };
  }
  const response = await fetch(`${API_ORIGIN}/api/v1/visibility-observations`, {
    body: JSON.stringify(body),
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `visibility-create-${crypto.randomUUID()}`,
      'x-csrf-token': csrf,
    },
    method: 'POST',
  });
  return (await parse(response, ObservationResponseSchema)).data;
}
export async function importVisibilityObservations(
  workspaceId: string,
  rows: readonly VisibilityInput[],
  csrf: string,
): Promise<readonly Observation[]> {
  const response = await fetch(`${API_ORIGIN}/api/v1/visibility-observations/import`, {
    body: JSON.stringify({ rows, workspace_id: workspaceId }),
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `visibility-import-${crypto.randomUUID()}`,
      'x-csrf-token': csrf,
    },
    method: 'POST',
  });
  return (await parse(response, ImportResponseSchema)).data;
}
async function parse<T>(
  response: Response,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): Promise<T> {
  if (!response.ok) throw new VisibilityRequestError(response.status);
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new VisibilityRequestError(502);
  return parsed.data;
}
async function fileBase64(file: File) {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Unable to read screenshot'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
  const separator = dataUrl.indexOf(',');
  if (separator < 0) throw new Error('Invalid screenshot');
  return dataUrl.slice(separator + 1);
}
export class VisibilityRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Visibility request failed');
    this.name = 'VisibilityRequestError';
  }
}
