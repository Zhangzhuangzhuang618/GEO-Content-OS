import { redactSensitiveData } from '@geo-content-os/security';

import { createDatabaseConnection } from '../connection.js';
import { seedFreezeV21 } from './freeze-v21.seed.js';

const connection = createDatabaseConnection();

try {
  await seedFreezeV21(connection.client);
  console.warn('Freeze v2.1 demo seed completed successfully.');
} catch (error) {
  console.error('Freeze v2.1 demo seed failed.', redactSensitiveData(error));
  process.exitCode = 1;
} finally {
  await connection.client.end();
}
