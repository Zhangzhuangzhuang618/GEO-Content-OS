import { describe, expect, it } from 'vitest';

import { assertFreshDatabaseAllowed, readDatabaseUrl } from './config.js';

describe('database configuration', () => {
  it('requires an explicit PostgreSQL URL', () => {
    expect(() => readDatabaseUrl({})).toThrow('DATABASE_URL is required');
    expect(() => readDatabaseUrl({ DATABASE_URL: 'mysql://localhost/app_test' })).toThrow(
      'must use the postgres:// or postgresql:// protocol',
    );
  });

  it('allows an explicitly forced local test database', () => {
    expect(
      assertFreshDatabaseAllowed('postgresql://geo:geo@127.0.0.1:5432/geo_t004_test', {
        force: true,
        environment: {},
      }).pathname,
    ).toBe('/geo_t004_test');
  });

  it('rejects resets without force and protected database names', () => {
    expect(() =>
      assertFreshDatabaseAllowed('postgresql://localhost/geo_t004_test', {
        force: false,
        environment: {},
      }),
    ).toThrow('explicit --force');
    expect(() =>
      assertFreshDatabaseAllowed('postgresql://localhost/postgres', {
        force: true,
        environment: {},
      }),
    ).toThrow('protected PostgreSQL database');
  });

  it('rejects remote and unsafe database resets by default', () => {
    expect(() =>
      assertFreshDatabaseAllowed('postgresql://db.example.com/geo_t004_test', {
        force: true,
        environment: {},
      }),
    ).toThrow('remote database');
    expect(() =>
      assertFreshDatabaseAllowed('postgresql://localhost/geo_content_os', {
        force: true,
        environment: {},
      }),
    ).toThrow('limited to');
  });
});
