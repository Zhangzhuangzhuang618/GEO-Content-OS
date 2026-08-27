import { WENTIAN_GEO_CONNECTOR_CONTRACT_VERSION } from '@geo-content-os/contracts';

export type WentianConnectorConfiguration =
  | {
      readonly status: 'not_configured' | 'invalid';
      readonly contractVersion: typeof WENTIAN_GEO_CONNECTOR_CONTRACT_VERSION;
    }
  | {
      readonly status: 'configured';
      readonly baseUrl: string;
      readonly clientSecret: string;
      readonly connectorId: string;
      readonly contractVersion: typeof WENTIAN_GEO_CONNECTOR_CONTRACT_VERSION;
      readonly geoTenantId: string;
    };

export const WENTIAN_CONNECTOR_CONFIGURATION = Symbol('WENTIAN_CONNECTOR_CONFIGURATION');

export function readWentianConnectorConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): WentianConnectorConfiguration {
  const values = {
    baseUrl: environment.WENTIAN_BASE_URL?.trim() ?? '',
    clientSecret: environment.WENTIAN_GEO_CONNECTOR_SECRET?.trim() ?? '',
    connectorId: environment.WENTIAN_GEO_CONNECTOR_ID?.trim() ?? '',
    geoTenantId: environment.WENTIAN_GEO_TENANT_ID?.trim() ?? '',
  };
  const present = Object.values(values).filter(Boolean).length;
  if (present === 0) {
    return {
      contractVersion: WENTIAN_GEO_CONNECTOR_CONTRACT_VERSION,
      status: 'not_configured',
    };
  }
  if (present !== 4 || !isUuid(values.connectorId) || !isUuid(values.geoTenantId)) {
    return {
      contractVersion: WENTIAN_GEO_CONNECTOR_CONTRACT_VERSION,
      status: 'invalid',
    };
  }
  let baseUrl: string;
  try {
    const url = new URL(values.baseUrl);
    const local =
      url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname.toLowerCase());
    if (
      (url.protocol !== 'https:' && !local) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    ) {
      throw new Error('invalid');
    }
    baseUrl = url.origin;
  } catch {
    return {
      contractVersion: WENTIAN_GEO_CONNECTOR_CONTRACT_VERSION,
      status: 'invalid',
    };
  }
  if (Buffer.byteLength(values.clientSecret, 'utf8') < 32) {
    return {
      contractVersion: WENTIAN_GEO_CONNECTOR_CONTRACT_VERSION,
      status: 'invalid',
    };
  }
  return Object.freeze({
    baseUrl,
    clientSecret: values.clientSecret,
    connectorId: values.connectorId,
    contractVersion: WENTIAN_GEO_CONNECTOR_CONTRACT_VERSION,
    geoTenantId: values.geoTenantId,
    status: 'configured' as const,
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
