import { migrateFreshDatabase } from '../fresh.js';

const force = process.argv.includes('--force');

try {
  await migrateFreshDatabase(force);
  console.warn('Database reset and migrations completed successfully.');
} catch (error) {
  console.error('Fresh database migration failed.', error);
  process.exitCode = 1;
}
