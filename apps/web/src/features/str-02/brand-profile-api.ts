import {
  BrandProfileResponseSchema,
  WorkspacePageSchema,
  type BrandProfileForm,
  type BrandProfileView,
  type WorkspaceChoice,
} from './brand-profile.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export async function getBrandProfile(id: string, signal?: AbortSignal): Promise<BrandProfileView> {
  const response = await fetch(`${API_ORIGIN}/api/v1/brand-profiles/${id}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  return parseProfileResponse(response);
}

export async function listActiveWorkspaces(signal?: AbortSignal): Promise<WorkspaceChoice[]> {
  const response = await fetch(`${API_ORIGIN}/api/v1/workspaces?limit=100&status=active`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new BrandProfileRequestError(response.status);
  const parsed = WorkspacePageSchema.safeParse(await response.json());
  if (!parsed.success) throw new BrandProfileRequestError(502);
  return parsed.data.data;
}

export async function createBrandProfile(
  form: BrandProfileForm,
  csrf: string,
): Promise<BrandProfileView> {
  const response = await fetch(`${API_ORIGIN}/api/v1/brand-profiles`, {
    body: JSON.stringify({
      profile: {
        audience: splitLines(form.audience),
        banned: splitLines(form.banned),
        compliance: splitLines(form.compliance),
        cta: form.cta.trim() || null,
        differentiators: splitLines(form.differentiators),
        positioning: form.positioning.trim(),
        tone: form.tone.trim(),
      },
      schema_version: 'brand-profile@1',
      workspace_id: form.workspace_id,
    }),
    credentials: 'include',
    headers: writeHeaders(csrf, 'brand-profile-create'),
    method: 'POST',
  });
  return parseProfileResponse(response);
}

export async function publishBrandProfile(
  profile: BrandProfileView,
  csrf: string,
): Promise<BrandProfileView> {
  const response = await fetch(`${API_ORIGIN}/api/v1/brand-profiles/${profile.id}/publish`, {
    body: JSON.stringify({ version: profile.version }),
    credentials: 'include',
    headers: {
      ...writeHeaders(csrf, 'brand-profile-publish'),
      'if-match': `"${profile.version}"`,
    },
    method: 'POST',
  });
  return parseProfileResponse(response);
}

export class BrandProfileRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Brand profile request failed');
    this.name = 'BrandProfileRequestError';
  }
}

async function parseProfileResponse(response: Response): Promise<BrandProfileView> {
  if (!response.ok) throw new BrandProfileRequestError(response.status);
  const parsed = BrandProfileResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new BrandProfileRequestError(502);
  return parsed.data.data;
}

function splitLines(value: string): string[] {
  return [
    ...new Set(
      value
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function writeHeaders(csrf: string, operation: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'idempotency-key': `${operation}-${crypto.randomUUID()}`,
    'x-csrf-token': csrf,
  };
}
