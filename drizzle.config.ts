import { defineConfig } from 'drizzle-kit';

const developmentDatabaseUrl = 'postgresql://geo:geo@127.0.0.1:5432/geo_content_os_dev';

export default defineConfig({
  dialect: 'postgresql',
  // drizzle-kit runs from apps/api through the workspace script.
  schema: './src/database/schema/index.ts',
  out: './src/database/migrations',
  dbCredentials: {
    // drizzle-kit requires a URL even for schema generation. Runtime commands never use this fallback.
    url: process.env.DATABASE_URL ?? developmentDatabaseUrl,
  },
  migrations: {
    table: '__drizzle_migrations',
    schema: 'public',
  },
  strict: true,
  verbose: true,
});
