import { createDatabaseConnection } from '../connection.js';
import { assertRequiredExtensions } from '../extensions.js';

const connection = createDatabaseConnection();

try {
  await assertRequiredExtensions(connection.client);
  console.warn('Required PostgreSQL extensions are installed.');
} catch (error) {
  console.error('PostgreSQL extension check failed.', error);
  process.exitCode = 1;
} finally {
  await connection.client.end();
}
