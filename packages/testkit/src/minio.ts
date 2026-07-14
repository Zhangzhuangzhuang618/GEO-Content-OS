import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

export const MINIO_TEST_IMAGE = 'minio/minio:RELEASE.2025-09-07T16-13-09Z' as const;
export const MINIO_TEST_ACCESS_KEY = 'geo_minio_test' as const;
export const MINIO_TEST_SECRET_KEY = 'geo_minio_test_password' as const;

export async function startMinioTestContainer(): Promise<StartedTestContainer> {
  return new GenericContainer(MINIO_TEST_IMAGE)
    .withCommand(['server', '/data'])
    .withEnvironment({
      MINIO_ROOT_PASSWORD: MINIO_TEST_SECRET_KEY,
      MINIO_ROOT_USER: MINIO_TEST_ACCESS_KEY,
    })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/ready', 9000))
    .withStartupTimeout(120_000)
    .start();
}

export function minioEndpoint(container: StartedTestContainer): string {
  return `http://${container.getHost()}:${container.getMappedPort(9000)}`;
}

export type { StartedTestContainer } from 'testcontainers';
