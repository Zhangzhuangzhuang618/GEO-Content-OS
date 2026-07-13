import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

export const REDIS_TEST_IMAGE = 'redis:7.4.7-alpine' as const;

export async function startRedisTestContainer(): Promise<StartedTestContainer> {
  return new GenericContainer(REDIS_TEST_IMAGE)
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .withStartupTimeout(120_000)
    .start();
}

export function redisUrl(container: StartedTestContainer): string {
  return `redis://${container.getHost()}:${container.getMappedPort(6379)}/0`;
}

export type { StartedTestContainer } from 'testcontainers';
