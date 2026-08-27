import type { WENTIAN_GEO_CONNECTOR_CONTRACT_VERSION } from '@geo-content-os/contracts';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { WentianConnectorConfiguration } from './wentian-connector.config.js';

const BindingSchema = z
  .object({
    connector_instance_id: z.uuid(),
    decision_reason: z.string().max(500).nullable(),
    geo_project_display_name: z.string().min(1).max(200),
    geo_project_ref: z.string().min(1).max(160),
    geo_workspace_ref: z.string().min(1).max(160),
    id: z.uuid(),
    requested_at: z.iso.datetime({ offset: true }),
    scope_id: z.uuid().nullable(),
    status: z.enum(['pending_wentian', 'active', 'suspended', 'rejected', 'disconnected']),
    updated_at: z.iso.datetime({ offset: true }),
    version: z.number().int().positive(),
  })
  .strict();

const SsoTicketSchema = z
  .object({
    expires_at: z.iso.datetime({ offset: true }),
    launch_url: z.url(),
  })
  .strict();

const QuerySyncSchema = z
  .object({
    created: z.boolean(),
    query_count: z.number().int().min(1).max(100),
    snapshot_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    snapshot_id: z.uuid(),
  })
  .strict();

export type WentianRemoteBinding = z.infer<typeof BindingSchema>;
export type WentianRemoteQuerySync = z.infer<typeof QuerySyncSchema>;
export type WentianRemoteSsoTicket = z.infer<typeof SsoTicketSchema>;

type FetchImplementation = typeof fetch;

export class WentianSignedClient {
  public constructor(
    private readonly configuration: WentianConnectorConfiguration,
    private readonly fetchImplementation: FetchImplementation = fetch,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = randomUUID,
  ) {}

  public requestBinding(
    input: {
      readonly geoProjectDisplayName: string;
      readonly geoProjectRef: string;
      readonly geoWorkspaceRef: string;
    },
    idempotencyKey: string,
  ): Promise<WentianRemoteBinding> {
    return this.request(
      'POST',
      '/api/v1/integrations/geo/project-binding-requests',
      {
        geo_project_display_name: input.geoProjectDisplayName,
        geo_project_ref: input.geoProjectRef,
        geo_workspace_ref: input.geoWorkspaceRef,
      },
      idempotencyKey,
      BindingSchema,
    ).then((binding) => this.requireOwnBinding(binding));
  }

  public bindingStatus(
    geoProjectRef: string,
    idempotencyKey: string,
  ): Promise<WentianRemoteBinding> {
    return this.request(
      'POST',
      '/api/v1/integrations/geo/project-binding-status',
      { geo_project_ref: geoProjectRef },
      idempotencyKey,
      BindingSchema,
    ).then((binding) => this.requireOwnBinding(binding));
  }

  public withdrawBinding(bindingId: string, idempotencyKey: string): Promise<WentianRemoteBinding> {
    return this.request(
      'DELETE',
      `/api/v1/integrations/geo/project-binding-requests/${bindingId}`,
      undefined,
      idempotencyKey,
      BindingSchema,
    ).then((binding) => this.requireOwnBinding(binding));
  }

  public disconnectBinding(
    bindingId: string,
    idempotencyKey: string,
  ): Promise<WentianRemoteBinding> {
    return this.request(
      'POST',
      `/api/v1/integrations/geo/project-bindings/${bindingId}/disconnect`,
      {},
      idempotencyKey,
      BindingSchema,
    ).then((binding) => this.requireOwnBinding(binding));
  }

  public issueSsoTicket(
    input: {
      readonly displayName: string;
      readonly geoProjectRef: string;
      readonly geoUserRef: string;
      readonly roleCodes: readonly string[];
    },
    idempotencyKey: string,
  ): Promise<WentianRemoteSsoTicket> {
    return this.request(
      'POST',
      '/api/v1/integrations/geo/sso-tickets',
      {
        display_name: input.displayName,
        geo_project_ref: input.geoProjectRef,
        geo_user_ref: input.geoUserRef,
        role_codes: input.roleCodes,
      },
      idempotencyKey,
      SsoTicketSchema,
    ).then((ticket) => {
      const configuration = this.requireConfigured();
      const launchUrl = new URL(ticket.launch_url);
      if (
        launchUrl.origin !== configuration.baseUrl ||
        launchUrl.pathname !== '/connect/geo' ||
        launchUrl.username ||
        launchUrl.password ||
        launchUrl.hash ||
        launchUrl.searchParams.getAll('code').length !== 1 ||
        !launchUrl.searchParams.get('code')
      ) {
        throw new WentianConnectorResponseError();
      }
      return ticket;
    });
  }

  public syncQuerySet(
    bindingId: string,
    input: {
      readonly geoQuerySetRef: string;
      readonly geoRevision: string;
      readonly locale: string;
      readonly market: string | null;
      readonly queries: readonly {
        readonly commercial_value: 'high' | 'low' | 'medium';
        readonly external_key: string;
        readonly intent:
          | 'brand_recognition'
          | 'comparison'
          | 'education'
          | 'exploration'
          | 'procurement'
          | 'recommendation';
        readonly text: string;
      }[];
      readonly title: string;
    },
    idempotencyKey: string,
  ): Promise<WentianRemoteQuerySync> {
    return this.request(
      'PUT',
      `/api/v1/integrations/geo/project-bindings/${bindingId}/query-set-snapshots`,
      {
        geo_query_set_ref: input.geoQuerySetRef,
        geo_revision: input.geoRevision,
        locale: input.locale,
        market: input.market,
        queries: input.queries,
        title: input.title,
      },
      idempotencyKey,
      QuerySyncSchema,
    );
  }

  private async request<T>(
    method: string,
    path: string,
    body: Readonly<Record<string, unknown>> | undefined,
    idempotencyKey: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const configuration = this.requireConfigured();
    const issuedAt = new Date(this.now()).toISOString();
    const nonce = randomBytes(18).toString('base64url');
    const requestId = this.newId();
    const rawBody = body === undefined ? '' : JSON.stringify(body);
    const signature = createSignature({
      contractVersion: configuration.contractVersion,
      idempotencyKey,
      issuedAt,
      method,
      nonce,
      path,
      rawBody,
      requestId,
      secret: configuration.clientSecret,
    });
    let response: Response;
    try {
      response = await this.fetchImplementation(`${configuration.baseUrl}${path}`, {
        ...(body === undefined ? {} : { body: rawBody }),
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          'idempotency-key': idempotencyKey,
          'x-wentian-connector-id': configuration.connectorId,
          'x-wentian-contract-version': configuration.contractVersion,
          'x-wentian-issued-at': issuedAt,
          'x-wentian-nonce': nonce,
          'x-wentian-request-id': requestId,
          'x-wentian-signature': signature,
        },
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new WentianConnectorUnavailableError();
    }
    const rawResponse = await response.text();
    let parsed: unknown;
    try {
      parsed = rawResponse ? JSON.parse(rawResponse) : null;
    } catch {
      throw new WentianConnectorResponseError();
    }
    if (!response.ok) {
      const code = readErrorCode(parsed);
      throw new WentianRemoteRequestError(response.status, code);
    }
    const result = schema.safeParse(parsed);
    if (!result.success) throw new WentianConnectorResponseError();
    return result.data;
  }

  private requireConfigured(): Extract<WentianConnectorConfiguration, { status: 'configured' }> {
    if (this.configuration.status !== 'configured') {
      throw new WentianConnectorNotConfiguredError();
    }
    return this.configuration;
  }

  private requireOwnBinding(binding: WentianRemoteBinding): WentianRemoteBinding {
    if (binding.connector_instance_id !== this.requireConfigured().connectorId) {
      throw new WentianConnectorResponseError();
    }
    return binding;
  }
}

export class WentianConnectorNotConfiguredError extends Error {}
export class WentianConnectorUnavailableError extends Error {}
export class WentianConnectorResponseError extends Error {}
export class WentianRemoteRequestError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string | null,
  ) {
    super(code ?? `WENTIAN_HTTP_${status}`);
  }
}

function createSignature(input: {
  readonly contractVersion: typeof WENTIAN_GEO_CONNECTOR_CONTRACT_VERSION;
  readonly idempotencyKey: string;
  readonly issuedAt: string;
  readonly method: string;
  readonly nonce: string;
  readonly path: string;
  readonly rawBody: string;
  readonly requestId: string;
  readonly secret: string;
}): string {
  const bodyHash = createHash('sha256').update(input.rawBody, 'utf8').digest('hex');
  const canonical = [
    input.method.toUpperCase(),
    input.path,
    bodyHash,
    input.issuedAt,
    input.nonce,
    input.requestId,
    input.idempotencyKey,
    input.contractVersion,
  ].join('\n');
  return createHmac('sha256', input.secret).update(canonical, 'utf8').digest('base64url');
}

function readErrorCode(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const code = (value as Record<string, unknown>)['error'];
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,159}$/u.test(code) ? code : null;
}
