import { describe, expect, it } from 'vitest';

import { readWentianConnectorConfiguration } from './wentian-connector.config.js';

const CONNECTOR_ID = '00000000-0000-4000-8000-000000000101';
const TENANT_ID = '00000000-0000-4000-8000-000000000102';

describe('Wentian connector configuration', () => {
  it('is disabled when all connector values are absent', () => {
    expect(readWentianConnectorConfiguration({})).toEqual({
      contractVersion: 'wentian-geo-connector@1',
      status: 'not_configured',
    });
  });

  it('accepts HTTPS and explicit localhost development endpoints', () => {
    expect(readWentianConnectorConfiguration(environment('https://wentian.example.com'))).toEqual({
      baseUrl: 'https://wentian.example.com',
      clientSecret: 's'.repeat(32),
      connectorId: CONNECTOR_ID,
      contractVersion: 'wentian-geo-connector@1',
      geoTenantId: TENANT_ID,
      status: 'configured',
    });
    expect(readWentianConnectorConfiguration(environment('http://localhost:8787'))).toMatchObject({
      baseUrl: 'http://localhost:8787',
      status: 'configured',
    });
  });

  it('fails closed for partial, weak or non-TLS production configuration', () => {
    expect(
      readWentianConnectorConfiguration({ WENTIAN_BASE_URL: 'https://wentian.example.com' }),
    ).toMatchObject({ status: 'invalid' });
    expect(
      readWentianConnectorConfiguration({
        ...environment('https://wentian.example.com'),
        WENTIAN_GEO_CONNECTOR_SECRET: 'short',
      }),
    ).toMatchObject({ status: 'invalid' });
    expect(
      readWentianConnectorConfiguration(environment('http://wentian.example.com')),
    ).toMatchObject({ status: 'invalid' });
    expect(
      readWentianConnectorConfiguration(environment('https://wentian.example.com/base-path')),
    ).toMatchObject({ status: 'invalid' });
  });
});

function environment(baseUrl: string): NodeJS.ProcessEnv {
  return {
    WENTIAN_BASE_URL: baseUrl,
    WENTIAN_GEO_CONNECTOR_ID: CONNECTOR_ID,
    WENTIAN_GEO_CONNECTOR_SECRET: 's'.repeat(32),
    WENTIAN_GEO_TENANT_ID: TENANT_ID,
  };
}
