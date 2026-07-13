import { redactSensitiveData } from '@geo-content-os/security';

import { createDatabaseConnection } from '../../../database/index.js';
import { seedIdentity } from './identity.seed.js';

const connection = createDatabaseConnection();

try {
  await seedIdentity(connection.client);
  console.warn('Identity seed completed successfully.');
} catch (error) {
  console.error('Identity seed failed.', redactSensitiveData(error));
  process.exitCode = 1;
} finally {
  await connection.client.end();
}
