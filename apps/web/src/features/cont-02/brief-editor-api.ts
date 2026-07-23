import { createRequestUuid } from '@/lib/request-uuid';

import type { Brief } from '../cont-01/brief-list.schema';
import {
  BriefResponseSchema,
  ContentPackageResponseSchema,
  type BriefSaveInput,
} from './brief-editor.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export async function getBrief(id: string, signal?: AbortSignal): Promise<Brief> {
  const response = await fetch(`${API_ORIGIN}/api/v1/briefs/${id}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  return parseBrief(response);
}

export async function saveBrief(
  input: BriefSaveInput,
  csrf: string,
  current?: Brief,
): Promise<Brief> {
  const updateInput = {
    audience: input.audience,
    constraints: input.constraints,
    due_at: input.due_at,
    keyword_ids: input.keyword_ids,
    objective: input.objective,
    platform_codes: input.platform_codes,
    primary_keyword_id: input.primary_keyword_id,
    source_ids: input.source_ids,
    title: input.title,
  };
  const response = await fetch(
    current ? `${API_ORIGIN}/api/v1/briefs/${current.id}` : `${API_ORIGIN}/api/v1/briefs`,
    {
      body: JSON.stringify(current ? updateInput : input),
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `brief-save-${createRequestUuid()}`,
        ...(current ? { 'if-match': `"${current.version}"` } : {}),
        'x-csrf-token': csrf,
      },
      method: current ? 'PATCH' : 'POST',
    },
  );
  return parseBrief(response);
}

export async function createContentPackage(brief: Brief, csrf: string): Promise<string> {
  const response = await fetch(`${API_ORIGIN}/api/v1/content-packages`, {
    body: JSON.stringify({
      brief_id: brief.id,
      project_id: brief.project_id,
      workspace_id: brief.workspace_id,
    }),
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `content-package-create-${createRequestUuid()}`,
      'x-csrf-token': csrf,
    },
    method: 'POST',
  });
  if (!response.ok) throw new BriefEditorRequestError(response.status);
  const parsed = ContentPackageResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new BriefEditorRequestError(502);
  return parsed.data.data.id;
}

async function parseBrief(response: Response): Promise<Brief> {
  if (!response.ok) throw new BriefEditorRequestError(response.status);
  const parsed = BriefResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new BriefEditorRequestError(502);
  return parsed.data.data;
}

export class BriefEditorRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Brief editor request failed');
    this.name = 'BriefEditorRequestError';
  }
}
