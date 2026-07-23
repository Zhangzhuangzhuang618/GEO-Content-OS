import { getContentPackageDetail } from '../cont-04/content-package-detail-api';
import type { PackageDetail } from '../cont-04/content-package-detail.schema';
import {
  GenerationRunResponseSchema,
  RunCostResponseSchema,
  type GenerationRun,
  type RunCosts,
} from './generation-run.schema';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/u, '') ?? '';

export interface GenerationRunPageData {
  readonly costs: RunCosts | null;
  readonly packageDetail: PackageDetail | null;
  readonly run: GenerationRun;
}

export async function loadGenerationRunPage(
  id: string,
  canReadCosts: boolean,
  signal?: AbortSignal,
): Promise<GenerationRunPageData> {
  const run = await getGenerationRun(id, signal);
  const [packageDetail, costs] = await Promise.all([
    run.package_id ? getContentPackageDetail(run.package_id, signal) : Promise.resolve(null),
    canReadCosts ? getRunCosts(run.id, signal) : Promise.resolve(null),
  ]);
  return { costs, packageDetail, run };
}

export async function cancelGenerationRun(
  run: GenerationRun,
  reason: string,
  csrf: string,
): Promise<GenerationRun> {
  const response = await fetch(`${API_ORIGIN}/api/v1/generation-runs/${run.id}/cancel`, {
    body: JSON.stringify({ reason }),
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'if-match': `"${run.version}"`,
      'x-csrf-token': csrf,
    },
    method: 'POST',
  });
  return parseRun(response);
}

async function getGenerationRun(id: string, signal?: AbortSignal): Promise<GenerationRun> {
  const response = await request(`/api/v1/generation-runs/${id}`, signal);
  return parseRun(response);
}

async function getRunCosts(id: string, signal?: AbortSignal): Promise<RunCosts> {
  const query = new URLSearchParams({
    from: '1970-01-01',
    generation_run_id: id,
    to: new Date().toISOString().slice(0, 10),
  });
  const response = await request(`/api/v1/analytics/costs?${query}`, signal);
  const parsed = RunCostResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new GenerationRunRequestError(502);
  return parsed.data.data;
}

async function request(path: string, signal?: AbortSignal) {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    credentials: 'include',
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new GenerationRunRequestError(response.status);
  return response;
}

async function parseRun(response: Response) {
  if (!response.ok) throw new GenerationRunRequestError(response.status);
  const parsed = GenerationRunResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new GenerationRunRequestError(502);
  return parsed.data.data;
}

export class GenerationRunRequestError extends Error {
  public constructor(public readonly status: number) {
    super('Generation run request failed');
    this.name = 'GenerationRunRequestError';
  }
}
