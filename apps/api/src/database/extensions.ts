import type { DatabaseClient } from './connection.js';

export const REQUIRED_POSTGRES_EXTENSIONS = ['citext', 'pgcrypto', 'vector'] as const;

export async function assertRequiredExtensions(client: DatabaseClient): Promise<void> {
  const rows = await client<{ extname: string }[]>`
    SELECT extname
    FROM pg_extension
    WHERE extname IN ${client(REQUIRED_POSTGRES_EXTENSIONS)}
    ORDER BY extname
  `;
  const installedExtensions = rows.map(({ extname }) => extname);

  if (installedExtensions.join(',') !== REQUIRED_POSTGRES_EXTENSIONS.join(',')) {
    const missingExtensions = REQUIRED_POSTGRES_EXTENSIONS.filter(
      (extension) => !installedExtensions.includes(extension),
    );
    throw new Error(`Missing required PostgreSQL extensions: ${missingExtensions.join(', ')}`);
  }
}
