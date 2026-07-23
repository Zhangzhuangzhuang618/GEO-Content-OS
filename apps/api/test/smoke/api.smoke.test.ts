import { API_BASE_PATH } from '@geo-content-os/contracts';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApplication } from '../../src/application.js';

describe('API Supertest smoke', () => {
  let application: NestFastifyApplication;

  beforeAll(async () => {
    application = await createApplication({ enableShutdownHooks: false, logger: false });
    await application.listen({ host: '127.0.0.1', port: 0 });
  });

  afterAll(async () => {
    await application.close();
  });

  it('serves the prefixed liveness route over a real HTTP socket', async () => {
    const response = await request(application.getHttpServer())
      .get(`${API_BASE_PATH}/health/live`)
      .expect(200)
      .expect('Cache-Control', 'no-store');

    expect(response.body).toMatchObject({ service: 'api', status: 'ok' });
  });
});
