import 'reflect-metadata';

import { bootstrap } from './bootstrap.js';

void bootstrap().catch((error: unknown) => {
  console.error('API startup failed.', error);
  process.exitCode = 1;
});
