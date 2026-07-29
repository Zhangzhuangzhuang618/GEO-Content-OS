import { z } from 'zod';

import { apiGet, invalidateApiGetCache } from '@/lib/api-fetch';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

const SessionResponseSchema = z
  .object({
    data: z
      .object({
        active_tenant_id: z.string().uuid().nullable(),
        expires_at: z.iso.datetime(),
        user: z
          .object({
            display_name: z.string().min(1),
            email: z.email(),
            id: z.string().uuid(),
          })
          .strict(),
      })
      .strict(),
  })
  .passthrough();

export type AccountSession = z.infer<typeof SessionResponseSchema>['data'];

export async function getAccountSession(signal?: AbortSignal): Promise<AccountSession> {
  const response = await apiGet(`${API_ORIGIN}/api/v1/auth/session`, {
    cacheTtlMs: 30_000,
    signal,
  });
  if (!response.ok) throw new AccountRequestError(response.status);
  const parsed = SessionResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new AccountRequestError(502);
  return parsed.data.data;
}

export async function logoutCurrentSession(csrf: string): Promise<void> {
  const response = await fetch(`${API_ORIGIN}/api/v1/auth/logout`, {
    credentials: 'include',
    headers: { 'x-csrf-token': csrf },
    method: 'POST',
  });
  if (!response.ok && response.status !== 401) throw new AccountRequestError(response.status);
  invalidateApiGetCache();
}

export class AccountRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Account request failed');
    this.name = 'AccountRequestError';
  }
}
