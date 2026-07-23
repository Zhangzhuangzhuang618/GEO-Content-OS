import 'reflect-metadata';

import { redactSensitiveData } from '@geo-content-os/security';

import { bootstrap } from './bootstrap.js';

void bootstrap().catch((error: unknown) => {
  console.error('API startup failed.', redactSensitiveData(error));
  process.exitCode = 1;
});
