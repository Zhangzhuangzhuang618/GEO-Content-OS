import { migrateDatabase } from '../migrate.js';

try {
  await migrateDatabase();
  console.warn('Database migrations applied successfully.');
} catch (error) {
  console.error('Database migration failed.', error);
  process.exitCode = 1;
}
