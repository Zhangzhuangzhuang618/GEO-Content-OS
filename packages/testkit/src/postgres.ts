import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

export const POSTGRES_TEST_IMAGE = 'pgvector/pgvector:0.8.1-pg16' as const;

export async function startPostgresTestContainer(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer(POSTGRES_TEST_IMAGE)
    .withDatabase('geo_content_os_test')
    .withUsername('geo_test')
    .withPassword('geo_test_password')
    .withStartupTimeout(120_000)
    .start();
}

export type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
