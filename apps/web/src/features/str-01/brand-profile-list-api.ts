import { BrandProfileResponseSchema } from '../str-02/brand-profile.schema';
import {
  BrandProfilePageSchema,
  type BrandProfileListItem,
  type BrandProfileStatus,
} from './brand-profile-list.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export async function listBrandProfiles(status?: BrandProfileStatus, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: '100' });
  if (status) query.set('status', status);
  const response = await fetch(`${API_ORIGIN}/api/v1/brand-profiles?${query}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new BrandProfileListRequestError(response.status);
  const parsed = BrandProfilePageSchema.safeParse(await response.json());
  if (!parsed.success) throw new BrandProfileListRequestError(502);
  return parsed.data.data;
}

export async function publishProfile(profile: BrandProfileListItem, csrf: string) {
  return mutate(profile, 'publish', { version: profile.version }, csrf);
}

export async function retireProfile(profile: BrandProfileListItem, reason: string, csrf: string) {
  return mutate(profile, 'retire', { reason }, csrf);
}

async function mutate(
  profile: BrandProfileListItem,
  action: 'publish' | 'retire',
  body: object,
  csrf: string,
) {
  const response = await fetch(`${API_ORIGIN}/api/v1/brand-profiles/${profile.id}/${action}`, {
    body: JSON.stringify(body),
    credentials: 'include',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `brand-profile-${action}-${crypto.randomUUID()}`,
      'if-match': `"${profile.version}"`,
      'x-csrf-token': csrf,
    },
  });
  if (!response.ok) throw new BrandProfileListRequestError(response.status);
  const parsed = BrandProfileResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new BrandProfileListRequestError(502);
  return parsed.data.data;
}

export class BrandProfileListRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Brand profile list request failed');
    this.name = 'BrandProfileListRequestError';
  }
}
