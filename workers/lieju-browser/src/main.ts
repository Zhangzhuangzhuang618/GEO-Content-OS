import { createStorageAdapter, readStorageConfiguration } from '@geo-content-os/adapter-storage';
import postgres from 'postgres';

import { createBrowserCredentialService, readLiejuBrowserConfig } from './config.js';
import { PlaywrightLiejuPageDriver } from './page-driver.js';
import { createGatewayServer } from './server.js';
import { LiejuBrowserService } from './service.js';
import { PostgresLiejuBrowserStore } from './store.js';

async function main(): Promise<void> {
  const config = readLiejuBrowserConfig();
  const database = postgres(config.databaseUrl, { max: 5, prepare: false });
  const driver = new PlaywrightLiejuPageDriver(config);
  const service = new LiejuBrowserService(
    config,
    new PostgresLiejuBrowserStore(database),
    driver,
    createBrowserCredentialService(),
    createStorageAdapter(readStorageConfiguration()),
  );
  let ready = false;
  const server = createGatewayServer(service, () => ready);
  server.listen(config.healthPort, '0.0.0.0');
  try {
    await database`SELECT 1`;
    ready = true;
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  } finally {
    ready = false;
    await Promise.all([
      service.close(),
      database.end({ timeout: 5 }),
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
    ]);
  }
}

await main();
